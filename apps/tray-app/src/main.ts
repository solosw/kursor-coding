import { app, Tray, Menu, BrowserWindow, ipcMain, shell } from "electron"
import * as path from "path"
import { spawn, ChildProcess } from "child_process"
import * as os from "os"
import * as fs from "fs"

let tray: Tray | null = null
let serverProcess: ChildProcess | null = null
let mainWindow: BrowserWindow | null = null
let isServerRunning = false

const PROTOCOL_BRIDGE_PATH = path.join(
  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || __dirname,
  "protocol-bridge",
  "dist",
  "main.js"
)

// 开发模式路径
const DEV_PROTOCOL_BRIDGE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "protocol-bridge",
  "dist",
  "main.js"
)

function getProtocolBridgePath(): string {
  if (fs.existsSync(PROTOCOL_BRIDGE_PATH)) {
    return PROTOCOL_BRIDGE_PATH
  }
  return DEV_PROTOCOL_BRIDGE_PATH
}

function log(...args: unknown[]): void {
  console.log("[Tray]", ...args)
}

function createTray(): void {
  // 使用简单的颜色方块作为托盘图标
  const iconPath = path.join(__dirname, "..", "assets", "tray-icon.png")

  // 如果没有图标文件，创建一个简单的 16x16 图标
  if (!fs.existsSync(iconPath)) {
    const assetsDir = path.join(__dirname, "..", "assets")
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true })
    }
    // 创建一个简单的 1x1 透明像素作为占位符
    const pngBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABh0RVh0U29mdHdhcmUAcGFpbnQubmV0IDQuMC4zjOaXUAAAAE1JREFUOE9j/P///38GMgAx4+Li4mJgYGAw0tHR0STHAFtbW5P///8zMPz//5+Bjo6OJlkGWFtbmxL0//+fgY6OjiZZBgAA0S0n7Y7Q8CkAAAAASUVORK5CYII=",
      "base64"
    )
    fs.writeFileSync(iconPath, pngBuffer)
  }

  tray = new Tray(iconPath)
  updateTrayMenu()

  tray.setToolTip("Agent Vibes - 直连模式管理")
  tray.on("click", () => {
    openAdminPage()
  })
}

function updateTrayMenu(): void {
  const contextMenu = Menu.buildFromTemplate([
    {
      label: isServerRunning ? "🟢 服务运行中" : "🔴 服务已停止",
      enabled: false,
    },
    { type: "separator" },
    {
      label: isServerRunning ? "停止服务" : "启动服务",
      click: () => {
        if (isServerRunning) {
          stopServer()
        } else {
          startServer()
        }
      },
    },
    {
      label: "打开管理页面",
      click: () => openAdminPage(),
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        stopServer()
        app.quit()
      },
    },
  ])

  tray?.setContextMenu(contextMenu)
}

function startServer(): void {
  if (serverProcess) {
    log("Server is already running")
    return
  }

  const serverPath = getProtocolBridgePath()

  if (!fs.existsSync(serverPath)) {
    log("Server not found at:", serverPath)
    showError("服务器文件不存在，请先构建 protocol-bridge")
    return
  }

  log("Starting server from:", serverPath)

  const env = {
    ...process.env,
    AGENT_VIBES_ROUTING_MODE: "direct",
  }

  serverProcess = spawn(process.execPath, [serverPath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  })

  serverProcess.stdout?.on("data", (data: Buffer) => {
    const output = data.toString()
    log("[Server]", output)

    // 检测服务器启动成功
    if (output.includes("Agent Vibes server started") ||
        output.includes("Application is running")) {
      isServerRunning = true
      updateTrayMenu()
    }
  })

  serverProcess.stderr?.on("data", (data: Buffer) => {
    log("[Server Error]", data.toString())
  })

  serverProcess.on("close", (code: number | null) => {
    log("Server process exited with code", code)
    isServerRunning = false
    serverProcess = null
    updateTrayMenu()
  })

  serverProcess.on("error", (err: Error) => {
    log("Failed to start server:", err)
    showError(`启动服务失败: ${err.message}`)
    isServerRunning = false
    serverProcess = null
    updateTrayMenu()
  })

  // 给服务器一些时间启动
  setTimeout(() => {
    if (serverProcess && !isServerRunning) {
      // 假设启动成功
      isServerRunning = true
      updateTrayMenu()
    }
  }, 3000)
}

function stopServer(): void {
  if (!serverProcess) {
    return
  }

  log("Stopping server...")

  // Windows 上需要强制终止
  if (os.platform() === "win32") {
    spawn("taskkill", ["/pid", serverProcess.pid?.toString() || "", "/f", "/t"])
  } else {
    serverProcess.kill("SIGTERM")
  }

  serverProcess = null
  isServerRunning = false
  updateTrayMenu()
}

function openAdminPage(): void {
  const adminUrl = "https://localhost:2026/admin"

  // 如果服务器没运行，先启动
  if (!isServerRunning) {
    startServer()
    // 等待服务器启动
    setTimeout(() => {
      shell.openExternal(adminUrl)
    }, 2000)
  } else {
    shell.openExternal(adminUrl)
  }
}

function showError(message: string): void {
  log("Error:", message)
}

// 应用生命周期
app.whenReady().then(() => {
  createTray()
  log("Tray app started")
})

app.on("window-all-closed", () => {
  // 保持托盘运行
})

app.on("before-quit", () => {
  stopServer()
})

// 确保只有一个实例
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    // 用户尝试打开第二个实例时，显示管理页面
    openAdminPage()
  })
}
