const { app, Tray, Menu, BrowserWindow, ipcMain, dialog, clipboard } = require("electron")
const path = require("path")
const { spawn } = require("child_process")
const os = require("os")
const fs = require("fs")
const forge = require("node-forge")

function buildAuthorityKeyIdentifierExtension(keyIdentifierBytes) {
  return {
    id: "2.5.29.35",
    critical: false,
    value: forge.asn1.toDer(
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.SEQUENCE,
        true,
        [
          forge.asn1.create(
            forge.asn1.Class.CONTEXT_SPECIFIC,
            0,
            false,
            keyIdentifierBytes
          ),
        ]
      )
    ).getBytes(),
  }
}

const DEFAULT_AUTH_FIELDS = [
  { key: "cursorAuth/stripeMembershipType", value: "pro" },
  { key: "cursor.accessToken", value: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlLWN1cnNvci1sb2NhbC11c2VyIiwiZW1haWwiOiJjdXJzb3JAYWkuY29tIiwidHlwZSI6InNlc3Npb24iLCJpc3MiOiJjdXJzb3ItY2xpZW50Iiwic2NvcGUiOiJvcGVuaWQgcHJvZmlsZSBlbWFpbCIsImV4cCI6NDA3MDkwODgwMH0.fake-local-state-token" },
  { key: "cursor.email", value: "free_cursor@ai.com" },
  { key: "cursorAuth/cachedEmail", value: "free_cursor@ai.com" },
]

let tray = null
let controlWindow = null
let logWindow = null
let launchedServerPid = null
let launchedServerProcess = null
let isServerRunning = false
let portCheckInterval = null
let isCertSetupRunning = false
let isQuitting = false
let trayLogs = []

const SERVER_PORT = 2026
const AGENT_VIBES_COMMAND = "agent-vibes"
const CURSOR_CERT_HOSTS = [
  "localhost",
  "*.api5.cursor.sh",
  "*.cursor.sh",
  "api2.cursor.sh",
  "api2geo.cursor.sh",
  "api2direct.cursor.sh",
  "agent.api2.cursor.sh",
  "agentn.api2.cursor.sh",
  "agent.api2geo.cursor.sh",
  "agentn.api2geo.cursor.sh",
  "agent.api2direct.cursor.sh",
  "agentn.api2direct.cursor.sh",
  "agent.api5.cursor.sh",
  "agentn.api5.cursor.sh",
  "agent.api5geo.cursor.sh",
  "agent.api5lat.cursor.sh",
  "agentn.api5geo.cursor.sh",
  "agentn.api5lat.cursor.sh",
  "agent-gcpp-uswest.api5.cursor.sh",
  "agent-gcpp-eucentral.api5.cursor.sh",
  "agent-gcpp-apsoutheast.api5.cursor.sh",
  "agentn-gcpp-uswest.api5.cursor.sh",
  "agentn-gcpp-eucentral.api5.cursor.sh",
  "agentn-gcpp-apsoutheast.api5.cursor.sh",
  "agent.us.api5.cursor.sh",
  "agent.eu.api5.cursor.sh",
  "agent.ap.api5.cursor.sh",
  "agentn.us.api5.cursor.sh",
  "agentn.eu.api5.cursor.sh",
  "agentn.ap.api5.cursor.sh",
  "a.cursor.sh",
  "127.0.0.1",
  "127.0.0.2",
  "127.0.0.3",
  "::1",
]

function log(...args) {
  const line = args
    .map((arg) => {
      if (typeof arg === "string") return arg
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(" ")

  const level = line.toLowerCase().includes("warn") ? "warn" : "info"
  appendTrayLog(line, level)
  console.log("[Tray]", ...args)
}

function appendTrayLog(message, level = "info") {
  const entry = {
    time: new Date().toLocaleTimeString(),
    level,
    message: String(message || ""),
  }
  trayLogs.push(entry)
  if (trayLogs.length > 500) {
    trayLogs = trayLogs.slice(-500)
  }
  refreshControlWindow()
  refreshLogWindow()
}

function getTrayLogsText() {
  return trayLogs.map((entry) => `[${entry.time}]${entry.level === "error" ? " [ERROR]" : entry.level === "warn" ? " [WARN]" : ""} ${entry.message}`).join("\n")
}

function getTrayLogsForView() {
  return trayLogs.map((entry) => ({
    time: entry.time,
    level: entry.level,
    message: entry.message,
  }))
}

function clearTrayLogs() {
  trayLogs = []
  refreshLogWindow()
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function escapeInlineJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

function decodeCommandOutput(data) {
  if (!Buffer.isBuffer(data)) {
    return String(data || "")
  }

  if (process.platform !== "win32") {
    return data.toString("utf8")
  }

  const utf8Text = data.toString("utf8")
  if (!utf8Text.includes("�")) {
    return utf8Text
  }

  try {
    const decoder = new TextDecoder("gbk")
    const gbkText = decoder.decode(data)
    if (gbkText && !gbkText.includes("�")) {
      return gbkText
    }
  } catch {}

  return utf8Text
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      ...(process.platform === "win32"
        ? {
            PYTHONIOENCODING: "utf-8",
            LANG: "en_US.UTF-8",
            LC_ALL: "en_US.UTF-8",
          }
        : {}),
      ...(options.env || {}),
    }

    const child = spawn(command, args, {
      shell: true,
      windowsHide: true,
      ...options,
      env: childEnv,
    })

    let stdout = ""
    let stderr = ""

    child.stdout?.on("data", (data) => {
      stdout += decodeCommandOutput(data)
    })

    child.stderr?.on("data", (data) => {
      stderr += decodeCommandOutput(data)
    })

    child.on("error", reject)
    child.on("close", (code) => {
      resolve({ code, stdout, stderr })
    })
  })
}

function getAgentVibesDataDir() {
  return process.env.AGENT_VIBES_DATA_DIR || path.join(os.homedir(), ".agent-vibes")
}

function getServerConfigDir() {
  return path.join(getAgentVibesDataDir(), "data")
}

function getApisConfigPath() {
  return path.join(getServerConfigDir(), "apis.yaml")
}

function ensureServerConfigDir() {
  fs.mkdirSync(getServerConfigDir(), { recursive: true })
}

function getTrayAssetsPath() {
  return path.join(__dirname, "..", "assets")
}

function getCertDir() {
  return path.join(getAgentVibesDataDir(), "certs")
}

function getServerCertPath() {
  return path.join(getCertDir(), "server.pem")
}

function getServerKeyPath() {
  return path.join(getCertDir(), "server-key.pem")
}

function hasGeneratedCertificates() {
  return fs.existsSync(getServerCertPath()) && fs.existsSync(getServerKeyPath())
}

function parseSimpleYamlValue(raw) {
  const value = String(raw || "").trim()
  if (!value) return ""
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function parseApisConfig(content) {
  const lines = String(content || "").split(/\r?\n/)
  const models = []
  let current = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#") || trimmed === "apis:") {
      continue
    }

    if (trimmed.startsWith("- ")) {
      if (current) {
        models.push(current)
      }
      current = {
        name: "",
        format: "openai",
        endpoint: "",
        customModelId: "",
        targetModelId: "",
        customApiKey: "",
        active: true,
        maxContextTokens: "",
        useResponsesApi: false,
      }
      const rest = trimmed.slice(2)
      const separatorIndex = rest.indexOf(":")
      if (separatorIndex >= 0) {
        const key = rest.slice(0, separatorIndex).trim()
        const value = parseSimpleYamlValue(rest.slice(separatorIndex + 1))
        if (key === "name") current.name = value
      }
      continue
    }

    if (!current) {
      continue
    }

    const separatorIndex = trimmed.indexOf(":")
    if (separatorIndex < 0) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    const value = parseSimpleYamlValue(trimmed.slice(separatorIndex + 1))

    if (key === "name") current.name = value
    if (key === "format") current.format = value || "openai"
    if (key === "endpoint") current.endpoint = value
    if (key === "custom_model_id") current.customModelId = value
    if (key === "target_model_id") current.targetModelId = value
    if (key === "custom_api_key") current.customApiKey = value
    if (key === "active") current.active = value.toLowerCase() !== "false"
    if (key === "max_context_tokens") current.maxContextTokens = value
    if (key === "use_responses_api") current.useResponsesApi = value.toLowerCase() === "true"
  }

  if (current) {
    models.push(current)
  }

  return models
}

function readModelsConfig() {
  const configPath = getApisConfigPath()
  if (!fs.existsSync(configPath)) {
    return []
  }

  try {
    return parseApisConfig(fs.readFileSync(configPath, "utf8"))
  } catch (error) {
    log("Read models config failed:", error instanceof Error ? error.message : String(error))
    return []
  }
}

function escapeYamlString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function buildApisYaml(models) {
  const lines = ["apis:"]

  for (const model of models) {
    lines.push("  - name: " + (model.name || model.customModelId || model.targetModelId || "model"))
    lines.push("    format: " + (model.format || "openai"))
    lines.push("    endpoint: " + (model.endpoint || ""))
    lines.push("    custom_model_id: " + (model.customModelId || ""))
    lines.push("    target_model_id: " + (model.targetModelId || ""))
    lines.push('    custom_api_key: "' + escapeYamlString(model.customApiKey || "") + '"')

    const parsedLimit = Number.parseInt(String(model.maxContextTokens || "").trim(), 10)
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
      lines.push("    max_context_tokens: " + Math.floor(parsedLimit))
    }

    if (model.useResponsesApi) {
      lines.push("    use_responses_api: true")
    }

    lines.push("    active: " + (model.active !== false))
    lines.push("")
  }

  return lines.join("\n")
}

function saveModelsConfig(models) {
  ensureServerConfigDir()
  const configPath = getApisConfigPath()
  fs.writeFileSync(configPath, buildApisYaml(models), "utf8")
  return configPath
}

function normalizeModelFormValue(value) {
  return String(value || "").trim()
}

function getDefaultModelForm() {
  return {
    name: "",
    format: "openai",
    endpoint: "",
    customModelId: "",
    targetModelId: "",
    customApiKey: "",
    active: true,
    maxContextTokens: "",
    useResponsesApi: false,
  }
}

function resolveCursorStateDbPath() {
  const home = os.homedir()
  switch (process.platform) {
    case "win32":
      return path.join(
        process.env.APPDATA || path.join(home, "AppData", "Roaming"),
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb"
      )
    case "darwin":
      return path.join(
        home,
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb"
      )
    default:
      return path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb")
  }
}

function upsertAuthFields(dbPath, fieldMappings) {
  const sqlite3 = require("sqlite3").verbose()
  const db = new sqlite3.Database(dbPath)

  try {
    const upsert = db.prepare(
      `INSERT INTO ItemTable(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    )

    for (const { key, value } of fieldMappings) {
      upsert.run(key, value)
    }

    upsert.finalize()
  } finally {
    db.close()
  }
}

async function applyAccountAuth() {
  try {
    const fieldMappings = DEFAULT_AUTH_FIELDS

    if (!Array.isArray(fieldMappings) || fieldMappings.length === 0) {
      throw new Error("默认认证字段为空")
    }

    const dbPath = resolveCursorStateDbPath()
    if (!fs.existsSync(dbPath)) {
      throw new Error(`本地数据库不存在: ${dbPath}`)
    }

    upsertAuthFields(dbPath, fieldMappings)

    dialog.showMessageBox({
      type: "info",
      title: "账号认证完成",
      message: `已写入 ${fieldMappings.length} 个字段到 Cursor 本地数据库。`,
      detail: `数据库: ${dbPath}`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log("Apply account auth failed:", message)
    dialog.showErrorBox("账号认证失败", message)
  }
}

async function resolveAgentVibesCommandPath() {
  const lookupCommand = process.platform === "win32" ? "where" : "which"
  const result = await runCommand(lookupCommand, [AGENT_VIBES_COMMAND])
  if (result.code !== 0) {
    return null
  }

  const match = (result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)

  return match || null
}

async function ensureAgentVibesAvailable() {
  return (await resolveAgentVibesCommandPath()) !== null
}

function startAgentVibesProcess() {
  const child = spawn(AGENT_VIBES_COMMAND, ["--mode", "direct"], {
    detached: false,
    shell: true,
    windowsHide: true,
    env: {
      ...process.env,
      LOG_DEBUG: "true",
      PYTHONIOENCODING: "utf-8",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      TERM: "dumb",
    },
  })

  child.stdout?.on("data", (data) => {
    const text = decodeCommandOutput(data)
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/[\u2500-\u257f\u2580-\u259f\u25a0-\u25ff]/g, "")
      .trim()

    if (text) {
      appendTrayLog(`[agent-vibes] ${text}`)
      log("[agent-vibes]", text)
    }
  })

  child.stderr?.on("data", (data) => {
    const text = decodeCommandOutput(data)
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/[\u2500-\u257f\u2580-\u259f\u25a0-\u25ff]/g, "")
      .trim()

    if (text) {
      appendTrayLog(`[agent-vibes:error] ${text}`, "error")
      console.error("[Tray][agent-vibes:error]", text)
    }
  })

  child.on("error", (error) => {
    log("agent-vibes process error:", error.message)
  })

  child.on("close", (code, signal) => {
    log(`agent-vibes exited (code=${code}, signal=${signal})`)
    launchedServerPid = null
    launchedServerProcess = null
  })

  return child
}

async function killProcessOnPort(port) {
  if (process.platform === "win32") {
    const result = await runCommand("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join \" \"`,
    ])

    if (result.code !== 0) return

    const pids = result.stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean)

    for (const pid of pids) {
      await runCommand("taskkill", ["/pid", pid, "/f", "/t"])
    }
    return
  }

  const result = await runCommand("bash", ["-lc", `lsof -ti tcp:${port} | xargs -r kill -9`])
  if (result.code !== 0) {
    log("Kill by port failed:", result.stderr || result.stdout)
  }
}

function checkPortInUse(port) {
  return new Promise((resolve) => {
    const platform = os.platform()
    const commands = []

    if (platform === "win32") {
      commands.push({ cmd: "netstat", args: ["-ano"] })
    } else if (platform === "darwin") {
      commands.push({ cmd: "lsof", args: ["-i", `:${port}`] })
      commands.push({ cmd: "netstat", args: ["-anv"] })
    } else {
      commands.push({ cmd: "ss", args: ["-tuln"] })
      commands.push({ cmd: "netstat", args: ["-tuln"] })
    }

    let currentIndex = 0

    const tryNext = () => {
      if (currentIndex >= commands.length) {
        resolve(false)
        return
      }

      const { cmd, args } = commands[currentIndex++]
      const child = spawn(cmd, args, { shell: true })
      let output = ""
      const timeout = setTimeout(() => {
        child.kill()
        tryNext()
      }, 2000)

      child.stdout.on("data", (data) => {
        output += data.toString()
      })

      child.on("close", (code) => {
        clearTimeout(timeout)
        if (code !== 0) {
          tryNext()
          return
        }

        if (platform === "win32") {
          const regex = new RegExp(`:${port}.*LISTENING`, "i")
          resolve(regex.test(output))
        } else if (platform === "darwin") {
          resolve(output.includes(`:${port}`))
        } else {
          const regex = new RegExp(`:${port}`, "i")
          resolve(regex.test(output))
        }
      })

      child.on("error", () => {
        clearTimeout(timeout)
        tryNext()
      })
    }

    tryNext()
  })
}

function startPortCheck() {
  if (portCheckInterval) clearInterval(portCheckInterval)

  const sync = async () => {
    const inUse = await checkPortInUse(SERVER_PORT)
    if (inUse !== isServerRunning) {
      isServerRunning = inUse
      updateTrayMenu()
      log("Port status:", inUse ? "in use" : "available")
    }
  }

  sync()
  portCheckInterval = setInterval(sync, 2000)
}

function stopPortCheck() {
  if (portCheckInterval) {
    clearInterval(portCheckInterval)
    portCheckInterval = null
  }
}


function generateLocalCertificates() {
  const certDir = getCertDir()
  fs.mkdirSync(certDir, { recursive: true })

  const caKeys = forge.pki.rsa.generateKeyPair(2048)
  const caCert = forge.pki.createCertificate()
  caCert.publicKey = caKeys.publicKey
  caCert.serialNumber = String(Date.now())
  caCert.validity.notBefore = new Date()
  caCert.validity.notAfter = new Date()
  caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 10)

  const caAttrs = [
    { name: "commonName", value: "Agent Vibes Local CA" },
    { name: "organizationName", value: "Agent Vibes" },
  ]
  caCert.setSubject(caAttrs)
  caCert.setIssuer(caAttrs)
  caCert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true },
    { name: "subjectKeyIdentifier" },
  ])
  caCert.sign(caKeys.privateKey, forge.md.sha256.create())
  const caSubjectKeyIdentifierExtension = caCert.getExtension("subjectKeyIdentifier")
  const caSubjectKeyIdentifierHex = caSubjectKeyIdentifierExtension?.subjectKeyIdentifier

  if (!caSubjectKeyIdentifierHex) {
    throw new Error("Failed to derive CA subject key identifier")
  }

  const caSubjectKeyIdentifierBytes = forge.util.hexToBytes(caSubjectKeyIdentifierHex)

  const serverKeys = forge.pki.rsa.generateKeyPair(2048)
  const serverCert = forge.pki.createCertificate()
  serverCert.publicKey = serverKeys.publicKey
  serverCert.serialNumber = String(Date.now() + 1)
  serverCert.validity.notBefore = new Date()
  serverCert.validity.notAfter = new Date()
  serverCert.validity.notAfter.setFullYear(serverCert.validity.notBefore.getFullYear() + 2)

  const serverAttrs = [
    { name: "commonName", value: "localhost" },
    { name: "organizationName", value: "Agent Vibes" },
  ]
  const altNames = CURSOR_CERT_HOSTS.map((host) => {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === "::1") {
      return { type: 7, ip: host }
    }
    return { type: 2, value: host }
  })

  serverCert.setSubject(serverAttrs)
  serverCert.setIssuer(caAttrs)
  serverCert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames },
    buildAuthorityKeyIdentifierExtension(caSubjectKeyIdentifierBytes),
    { name: "subjectKeyIdentifier" },
  ])
  serverCert.sign(caKeys.privateKey, forge.md.sha256.create())

  const caCertPath = path.join(certDir, "ca.pem")
  const caKeyPath = path.join(certDir, "ca-key.pem")

  fs.writeFileSync(caCertPath, forge.pki.certificateToPem(caCert))
  fs.writeFileSync(caKeyPath, forge.pki.privateKeyToPem(caKeys.privateKey))
  fs.writeFileSync(getServerCertPath(), forge.pki.certificateToPem(serverCert))
  fs.writeFileSync(getServerKeyPath(), forge.pki.privateKeyToPem(serverKeys.privateKey))

  return { caCertPath }
}

function installCaToSystemTrust(caCertPath) {
  if (process.platform === "win32") {
    return runCommand("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Import-Certificate -FilePath '${caCertPath.replace(/'/g, "''")}' -CertStoreLocation Cert:\\LocalMachine\\Root`,
    ])
  }

  if (process.platform === "darwin") {
    return runCommand("sudo", [
      "security",
      "add-trusted-cert",
      "-d",
      "-r",
      "trustRoot",
      "-k",
      "/Library/Keychains/System.keychain",
      caCertPath,
    ])
  }

  if (fs.existsSync("/usr/local/share/ca-certificates")) {
    return runCommand("sudo", [
      "sh",
      "-c",
      `cp '${caCertPath.replace(/'/g, "'\\''")}' /usr/local/share/ca-certificates/agent-vibes-ca.crt && update-ca-certificates`,
    ])
  }

  if (fs.existsSync("/etc/pki/ca-trust/source/anchors")) {
    return runCommand("sudo", [
      "sh",
      "-c",
      `cp '${caCertPath.replace(/'/g, "'\\''")}' /etc/pki/ca-trust/source/anchors/agent-vibes-ca.pem && update-ca-trust extract`,
    ])
  }

  return Promise.resolve({ code: 1, stdout: "", stderr: "未找到系统证书信任目录" })
}

function ensureNodeExtraCaCertsConfigured(caRootPem) {
  process.env.NODE_EXTRA_CA_CERTS = caRootPem

  if (process.platform === "win32") {
    return runCommand("setx", ["NODE_EXTRA_CA_CERTS", caRootPem])
  }

  const home = os.homedir()
  const profiles = process.platform === "darwin"
    ? [path.join(home, ".zshrc"), path.join(home, ".bashrc"), path.join(home, ".bash_profile")]
    : [path.join(home, ".bashrc"), path.join(home, ".profile"), path.join(home, ".zshrc")]

  const marker = "# Added by Agent Vibes Tray"
  const exportLine = `export NODE_EXTRA_CA_CERTS="${caRootPem}"`
  const existingProfile = profiles.find((profile) => fs.existsSync(profile))
  const targetProfile = existingProfile || profiles[0]
  const currentContent = fs.existsSync(targetProfile)
    ? fs.readFileSync(targetProfile, "utf-8")
    : ""

  const lines = currentContent
    .split(/\r?\n/)
    .filter((line) => !line.includes("NODE_EXTRA_CA_CERTS") && !line.includes(marker))
    .filter((line, index, arr) => !(index === arr.length - 1 && line === ""))

  const nextContent = `${lines.join("\n")}\n${marker}\n${exportLine}\n`
  fs.writeFileSync(targetProfile, nextContent)

  return Promise.resolve({ code: 0, stdout: targetProfile, stderr: "" })
}

async function setupCertificates() {
  if (isCertSetupRunning) {
    return
  }

  isCertSetupRunning = true
  updateTrayMenu()

  try {
    const { caCertPath } = generateLocalCertificates()

    const trustResult = await installCaToSystemTrust(caCertPath)
    if (trustResult.code !== 0) {
      throw new Error(trustResult.stderr || trustResult.stdout || "系统证书信任安装失败")
    }

    const envResult = await ensureNodeExtraCaCertsConfigured(caCertPath)
    if (envResult.code !== 0) {
      throw new Error(envResult.stderr || envResult.stdout || "NODE_EXTRA_CA_CERTS 配置失败")
    }

    dialog.showMessageBox({
      type: "info",
      title: "认证初始化完成",
      message: "证书已生成并完成信任配置，请重启 Cursor 后再连接。",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log("Certificate setup failed:", message)
    dialog.showErrorBox("初始化认证失败", message)
  } finally {
    isCertSetupRunning = false
    updateTrayMenu()
  }
}

function getControlWindowHtml() {
  const statusText = isServerRunning ? "服务运行中" : "服务已停止"
  const certText = hasGeneratedCertificates()
    ? "认证已初始化"
    : isCertSetupRunning
      ? "正在初始化认证"
      : "尚未初始化认证"
  const configPath = getApisConfigPath()
  const models = readModelsConfig()
  const modelsMarkup = models.length
    ? models.map((model, index) => `
      <div class="model-item">
        <div class="model-item__title">${escapeHtml(model.customModelId || model.name || `模型 ${index + 1}`)}</div>
        <div class="model-item__meta">${escapeHtml(model.format || "openai")} · ${escapeHtml(model.targetModelId || "未设置目标模型")}</div>
        <button class="secondary small" onclick="window.trayApi.fillModel(${index})">载入编辑</button>
      </div>
    `).join("")
    : '<div class="empty">还没有模型配置</div>'

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Vibes</title>
  <style>
    body { font-family: "Segoe UI", sans-serif; margin: 0; padding: 20px; background: #111827; color: #f3f4f6; }
    .wrap { display: flex; flex-direction: column; gap: 12px; }
    .card { background: #1f2937; border: 1px solid #374151; border-radius: 12px; padding: 16px; }
    .title { font-size: 20px; font-weight: 600; }
    .muted { color: #9ca3af; font-size: 13px; }
    .status { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .label { color: #9ca3af; font-size: 12px; margin-bottom: 6px; }
    .value { font-size: 16px; font-weight: 600; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .section-title { font-size: 16px; font-weight: 600; margin-bottom: 10px; }
    .config-path { color: #93c5fd; font-size: 12px; word-break: break-all; margin-top: 6px; }
    .model-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; max-height: 180px; overflow: auto; }
    .model-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: #111827; border: 1px solid #374151; border-radius: 10px; padding: 10px; }
    .model-item__title { font-size: 14px; font-weight: 600; }
    .model-item__meta { color: #9ca3af; font-size: 12px; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .field.full { grid-column: 1 / -1; }
    .empty { color: #9ca3af; font-size: 13px; padding: 10px 0; }
    input, select { border: 1px solid #4b5563; border-radius: 10px; padding: 10px; background: #111827; color: #f3f4f6; font-size: 13px; }
    input[type="checkbox"] { width: 16px; height: 16px; }
    .checkbox-row { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
    .log-panel { width: 100%; min-height: 220px; max-height: 320px; overflow: auto; box-sizing: border-box; border: 1px solid #4b5563; border-radius: 10px; padding: 12px; background: #0b1220; font-family: Consolas, monospace; font-size: 12px; line-height: 1.5; }
    .log-entry { white-space: pre-wrap; word-break: break-word; color: #86efac; padding: 2px 0; }
    .log-entry + .log-entry { border-top: 1px dashed rgba(75, 85, 99, 0.35); margin-top: 6px; padding-top: 6px; }
    .log-entry--info { color: #86efac; }
    .log-entry--warn { color: #fbbf24; }
    .log-entry--error { color: #f87171; }
    .log-entry__time { color: #93c5fd; margin-right: 8px; }
    .log-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 12px; }
    .log-hint { color: #9ca3af; font-size: 12px; margin-top: 8px; }
    button { border: 0; border-radius: 10px; padding: 12px; background: #2563eb; color: #fff; font-size: 14px; cursor: pointer; transition: filter 0.15s ease, transform 0.15s ease; }
    button:hover { filter: brightness(1.05); }
    button:active { transform: translateY(1px); }
    button.secondary { background: #374151; }
    button.warn { background: #b45309; }
    button.small { padding: 8px 10px; font-size: 12px; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="title">Agent Vibes 托盘控制台</div>
      <div class="muted">直连模式本地控制，不再依赖外部管理页面</div>
      <div class="config-path">配置文件：${escapeHtml(configPath)}</div>
    </div>
    <div class="card status">
      <div>
        <div class="label">服务状态</div>
        <div class="value">${statusText}</div>
      </div>
      <div>
        <div class="label">认证状态</div>
        <div class="value">${certText}</div>
      </div>
    </div>
    <div class="card">
      <div class="actions">
        <button onclick="window.trayApi.startServer()" ${isServerRunning ? "disabled" : ""}>启动服务</button>
        <button class="secondary" onclick="window.trayApi.stopServer()" ${isServerRunning ? "" : "disabled"}>停止服务</button>
        <button onclick="window.trayApi.setupCertificates()" ${isCertSetupRunning ? "disabled" : ""}>初始化认证</button>
        <button class="secondary" onclick="window.trayApi.applyAccountAuth()">写入账号认证</button>
        <button class="secondary" onclick="window.trayApi.runDiagnostics()">网络诊断</button>
        <button class="warn" onclick="window.trayApi.fixProxyBypassRules()">修复代理规则</button>
        <button class="secondary" onclick="window.trayApi.openLogs()">打开日志窗口</button>
      </div>
    </div>
    <div class="card">
      <div class="section-title">模型管理</div>
      <div class="model-list">${modelsMarkup}</div>
      <div class="form-grid">
        <div class="field">
          <label>名称</label>
          <input id="model-name" placeholder="Claude Sonnet 4.6">
        </div>
        <div class="field">
          <label>格式</label>
          <select id="model-format">
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="codex">Codex</option>
          </select>
        </div>
        <div class="field full">
          <label>接口地址</label>
          <input id="model-endpoint" placeholder="https://api.openai.com/v1">
        </div>
        <div class="field">
          <label>显示模型 ID</label>
          <input id="model-custom-id" placeholder="gpt-4.1">
        </div>
        <div class="field">
          <label>目标模型 ID</label>
          <input id="model-target-id" placeholder="gpt-4.1">
        </div>
        <div class="field full">
          <label>API Key</label>
          <input id="model-api-key" placeholder="sk-...">
        </div>
        <div class="field">
          <label>最大上下文窗口</label>
          <input id="model-max-context" placeholder="可选，例如 200000">
        </div>
        <div class="field">
          <label>索引</label>
          <input id="model-index" placeholder="留空则新增">
        </div>
      </div>
      <div class="checkbox-row">
        <label><input type="checkbox" id="model-active" checked> 启用</label>
        <label><input type="checkbox" id="model-responses"> Responses API</label>
      </div>
      <div class="actions" style="margin-top: 12px;">
        <button onclick="window.trayApi.saveModel()">保存模型</button>
        <button class="secondary" onclick="window.trayApi.resetModelForm()">清空表单</button>
        <button class="warn" onclick="window.trayApi.deleteModel()">删除当前模型</button>
      </div>
    </div>
    <div class="card">
      <div class="section-title">日志</div>
      <div class="muted">日志已拆分到独立窗口中查看，可随时打开、复制、清空或保存。</div>
      <div class="actions" style="margin-top: 12px;">
        <button class="secondary" onclick="window.trayApi.openLogs()">打开日志窗口</button>
      </div>
    </div>
  </div>
  <script>
    const { ipcRenderer } = require("electron")
    const existingModels = ${escapeInlineJson(models)}

    function setModelForm(model, index) {
      const value = model || {}
      document.getElementById("model-name").value = value.name || ""
      document.getElementById("model-format").value = value.format || "openai"
      document.getElementById("model-endpoint").value = value.endpoint || ""
      document.getElementById("model-custom-id").value = value.customModelId || ""
      document.getElementById("model-target-id").value = value.targetModelId || ""
      document.getElementById("model-api-key").value = value.customApiKey || ""
      document.getElementById("model-max-context").value = value.maxContextTokens || ""
      document.getElementById("model-index").value = index ?? ""
      document.getElementById("model-active").checked = value.active !== false
      document.getElementById("model-responses").checked = value.useResponsesApi === true
    }

    function collectModelForm() {
      return {
        index: document.getElementById("model-index").value,
        name: document.getElementById("model-name").value,
        format: document.getElementById("model-format").value,
        endpoint: document.getElementById("model-endpoint").value,
        customModelId: document.getElementById("model-custom-id").value,
        targetModelId: document.getElementById("model-target-id").value,
        customApiKey: document.getElementById("model-api-key").value,
        maxContextTokens: document.getElementById("model-max-context").value,
        active: document.getElementById("model-active").checked,
        useResponsesApi: document.getElementById("model-responses").checked,
      }
    }

    window.trayApi = {
      startServer: () => ipcRenderer.invoke("tray:startServer"),
      stopServer: () => ipcRenderer.invoke("tray:stopServer"),
      setupCertificates: () => ipcRenderer.invoke("tray:setupCertificates"),
      applyAccountAuth: () => ipcRenderer.invoke("tray:applyAccountAuth"),
      runDiagnostics: () => ipcRenderer.invoke("tray:runDiagnostics"),
      fixProxyBypassRules: () => ipcRenderer.invoke("tray:fixProxyBypassRules"),
      openLogs: () => ipcRenderer.invoke("tray:openLogs"),
      saveModel: () => ipcRenderer.invoke("tray:saveModel", collectModelForm()),
      deleteModel: () => ipcRenderer.invoke("tray:deleteModel", document.getElementById("model-index").value),
      fillModel: (index) => setModelForm(existingModels[index], index),
      resetModelForm: () => setModelForm({}, ""),
    }

    setModelForm({}, "")
  </script>
</body>
</html>`
}


function getLogWindowHtml() {
  const logs = getTrayLogsForView()

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Vibes 日志</title>
  <style>
    body { font-family: "Segoe UI", sans-serif; margin: 0; padding: 16px; background: #0f172a; color: #e5e7eb; }
    .wrap { display: flex; flex-direction: column; gap: 12px; height: calc(100vh - 32px); }
    .header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .title { font-size: 20px; font-weight: 600; }
    .muted { color: #94a3b8; font-size: 12px; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .log-panel { flex: 1; overflow: auto; box-sizing: border-box; border: 1px solid #334155; border-radius: 12px; padding: 12px; background: #020617; font-family: Consolas, monospace; font-size: 12px; line-height: 1.5; }
    .log-entry { white-space: pre-wrap; word-break: break-word; color: #86efac; padding: 2px 0; }
    .log-entry + .log-entry { border-top: 1px dashed rgba(71, 85, 105, 0.5); margin-top: 6px; padding-top: 6px; }
    .log-entry--info { color: #86efac; }
    .log-entry--warn { color: #fbbf24; }
    .log-entry--error { color: #f87171; }
    .log-entry__time { color: #93c5fd; margin-right: 8px; }
    .empty { color: #94a3b8; font-size: 13px; padding: 10px 0; }
    button { border: 0; border-radius: 10px; padding: 10px 14px; background: #2563eb; color: #fff; font-size: 13px; cursor: pointer; transition: filter 0.15s ease, transform 0.15s ease; }
    button:hover { filter: brightness(1.05); }
    button:active { transform: translateY(1px); }
    button.secondary { background: #334155; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div>
        <div class="title">运行日志</div>
        <div class="muted">实时显示托盘与 agent-vibes 的最新日志</div>
      </div>
      <div class="actions">
        <button class="secondary" onclick="window.logApi.copyLogs()">复制日志</button>
        <button class="secondary" onclick="window.logApi.clearLogs()">清空日志</button>
        <button class="secondary" onclick="window.logApi.saveLogs()">保存到文件</button>
        <button onclick="window.logApi.refresh()">刷新</button>
      </div>
    </div>
    <div id="tray-logs" class="log-panel"></div>
  </div>
  <script>
    const { ipcRenderer } = require("electron")
    const existingLogs = ${escapeInlineJson(logs)}

    function escapeHtmlText(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;")
    }

    function renderLogs(items) {
      const container = document.getElementById("tray-logs")
      if (!container) {
        return
      }

      if (!Array.isArray(items) || items.length === 0) {
        container.innerHTML = '<div class="empty">还没有日志</div>'
        return
      }

      container.innerHTML = items.map((entry) => {
        const level = ["info", "warn", "error"].includes(entry.level) ? entry.level : "info"
        return '<div class="log-entry log-entry--' + level + '"><span class="log-entry__time">[' + escapeHtmlText(entry.time) + ']</span><span>' + escapeHtmlText(entry.message) + '</span></div>'
      }).join("")

      container.scrollTop = container.scrollHeight
    }

    window.logApi = {
      copyLogs: () => ipcRenderer.invoke("tray:copyLogs"),
      clearLogs: () => ipcRenderer.invoke("tray:clearLogs"),
      saveLogs: () => ipcRenderer.invoke("tray:saveLogs"),
      refresh: () => ipcRenderer.invoke("tray:openLogs"),
    }

    renderLogs(existingLogs)
  </script>
</body>
</html>`
}

function refreshControlWindow() {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(getControlWindowHtml())}`)
  }
}

function refreshLogWindow() {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(getLogWindowHtml())}`)
  }
}

function openLogWindow() {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.show()
    logWindow.focus()
    refreshLogWindow()
    return
  }

  logWindow = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 640,
    minHeight: 420,
    resizable: true,
    autoHideMenuBar: true,
    title: "Agent Vibes 日志",
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  })

  logWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault()
      logWindow.hide()
      return
    }
  })

  logWindow.on("closed", () => {
    logWindow = null
  })

  refreshLogWindow()
}

function openControlWindow() {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.show()
    controlWindow.focus()
    refreshControlWindow()
    return
  }

  controlWindow = new BrowserWindow({
    width: 720,
    height: 760,
    minWidth: 520,
    minHeight: 620,
    resizable: true,
    autoHideMenuBar: true,
    title: "Agent Vibes",
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  })

  controlWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault()
      controlWindow.hide()
      return
    }
  })

  controlWindow.on("closed", () => {
    controlWindow = null
  })

  refreshControlWindow()
}

ipcMain.removeHandler("tray:startServer")
ipcMain.handle("tray:startServer", async () => {
  await startServer()
})
ipcMain.removeHandler("tray:stopServer")
ipcMain.handle("tray:stopServer", async () => {
  await stopServer()
})
ipcMain.removeHandler("tray:setupCertificates")
ipcMain.handle("tray:setupCertificates", async () => {
  await setupCertificates()
})
ipcMain.removeHandler("tray:applyAccountAuth")
ipcMain.handle("tray:applyAccountAuth", async () => {
  await applyAccountAuth()
})
ipcMain.removeHandler("tray:runDiagnostics")
ipcMain.handle("tray:runDiagnostics", async () => {
  await runNetworkDiagnostics()
})
ipcMain.removeHandler("tray:fixProxyBypassRules")
ipcMain.handle("tray:fixProxyBypassRules", async () => {
  await fixProxyBypassRules()
})
ipcMain.removeHandler("tray:openLogs")
ipcMain.handle("tray:openLogs", async () => {
  openLogWindow()
})
ipcMain.removeHandler("tray:saveModel")
ipcMain.handle("tray:saveModel", async (_event, payload) => {
  const form = payload && typeof payload === "object" ? payload : {}
  const name = normalizeModelFormValue(form.name)
  const format = normalizeModelFormValue(form.format) || "openai"
  const endpoint = normalizeModelFormValue(form.endpoint)
  const customModelId = normalizeModelFormValue(form.customModelId)
  const targetModelId = normalizeModelFormValue(form.targetModelId)
  const customApiKey = normalizeModelFormValue(form.customApiKey)
  const maxContextTokens = normalizeModelFormValue(form.maxContextTokens)
  const indexText = normalizeModelFormValue(form.index)
  const active = form.active !== false
  const useResponsesApi = form.useResponsesApi === true

  if (!endpoint || !customModelId || !targetModelId || !customApiKey) {
    dialog.showErrorBox("保存失败", "接口地址、显示模型 ID、目标模型 ID、API Key 不能为空")
    return
  }

  const models = readModelsConfig()
  const nextModel = {
    ...getDefaultModelForm(),
    name: name || customModelId,
    format: ["openai", "anthropic", "codex"].includes(format) ? format : "openai",
    endpoint,
    customModelId,
    targetModelId,
    customApiKey,
    active,
    maxContextTokens,
    useResponsesApi,
  }

  const index = Number.parseInt(indexText, 10)
  if (Number.isInteger(index) && index >= 0 && index < models.length) {
    models[index] = nextModel
  } else {
    models.push(nextModel)
  }

  const configPath = saveModelsConfig(models)
  refreshControlWindow()
  await dialog.showMessageBox({
    type: "info",
    title: "保存成功",
    message: "模型配置已保存",
    detail: configPath,
  })
})
ipcMain.removeHandler("tray:deleteModel")
ipcMain.handle("tray:deleteModel", async (_event, indexValue) => {
  const index = Number.parseInt(normalizeModelFormValue(indexValue), 10)
  const models = readModelsConfig()

  if (!Number.isInteger(index) || index < 0 || index >= models.length) {
    dialog.showErrorBox("删除失败", "请先载入一个已存在的模型")
    return
  }

  models.splice(index, 1)
  const configPath = saveModelsConfig(models)
  refreshControlWindow()
  await dialog.showMessageBox({
    type: "info",
    title: "删除成功",
    message: "模型配置已删除",
    detail: configPath,
  })
})
ipcMain.removeHandler("tray:copyLogs")
ipcMain.handle("tray:copyLogs", async () => {
  const text = getTrayLogsText()
  clipboard.writeText(text)
  await dialog.showMessageBox({
    type: "info",
    title: "复制成功",
    message: text ? "日志已复制到剪贴板" : "当前没有日志，已复制空文本",
  })
})
ipcMain.removeHandler("tray:clearLogs")
ipcMain.handle("tray:clearLogs", async () => {
  clearTrayLogs()
  refreshControlWindow()
})
ipcMain.removeHandler("tray:saveLogs")
ipcMain.handle("tray:saveLogs", async () => {
  const text = getTrayLogsText()
  const result = await dialog.showSaveDialog({
    title: "保存日志",
    defaultPath: path.join(app.getPath("documents"), `agent-vibes-tray-${Date.now()}.log`),
    filters: [
      { name: "日志文件", extensions: ["log", "txt"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  })

  if (result.canceled || !result.filePath) {
    return
  }

  fs.writeFileSync(result.filePath, text, "utf8")
  await dialog.showMessageBox({
    type: "info",
    title: "保存成功",
    message: "日志已保存到文件",
    detail: result.filePath,
  })
})

function createTray() {
  const iconPath = path.join(getTrayAssetsPath(), "tray-icon.png")

  if (!fs.existsSync(iconPath)) {
    const assetsDir = getTrayAssetsPath()
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true })
    const pngBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABh0RVh0U29mdHdhcmUAcGFpbnQubmV0IDQuMC4zjOaXUAAAAE1JREFUOE9j/P///38GMgAx4+Li4mJgYGAw0tHR0STHAFtbW5P///8zMPz//5+Bjo6OJlkGWFtbmxL0//+fgY6OjiZZBgAA0S0n7Y7Q8CkAAAAASUVORK5CYII=",
      "base64"
    )
    fs.writeFileSync(iconPath, pngBuffer)
  }

  tray = new Tray(iconPath)
  updateTrayMenu()
  tray.setToolTip("Agent Vibes - 直连模式管理")
  tray.on("click", openControlWindow)
}

async function runForwardStatusDiagnostics() {
  const result = await runCommand(AGENT_VIBES_COMMAND, ["forward", "status"], {
    windowsHide: true,
  })

  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "agent-vibes forward status 执行失败")
  }

  return (result.stdout || "").trim() || "未返回状态信息"
}

async function runNetworkDiagnostics() {
  try {
    const detail = await runForwardStatusDiagnostics()
    await dialog.showMessageBox({
      type: "info",
      title: "网络诊断",
      message: "agent-vibes forward status 结果：",
      detail,
      buttons: ["确定"],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log("Forward status failed:", message)
    dialog.showErrorBox("网络诊断失败", message)
  }
}

async function fixProxyBypassRules() {
  if (process.platform !== "win32") {
    dialog.showErrorBox("不支持", "代理绕过规则修复仅支持 Windows 系统")
    return
  }

  try {
    const result = await runCommand(AGENT_VIBES_COMMAND, ["forward", "on"], {
      windowsHide: true,
    })

    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "agent-vibes forward on 执行失败")
    }

    dialog.showMessageBox({
      type: "info",
      title: "修复完成",
      message: "已执行 agent-vibes forward on。",
      detail: "建议随后运行一次网络诊断确认 forwarding 状态。",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log("Fix proxy bypass failed:", message)
    dialog.showErrorBox("修复失败", message)
  }
}

function updateTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: isServerRunning ? "🟢 服务运行中" : "🔴 服务已停止", enabled: false },
    {
      label: hasGeneratedCertificates()
        ? "✅ 认证已初始化"
        : isCertSetupRunning
          ? "⏳ 正在初始化认证"
          : "⚠️ 尚未初始化认证",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "打开控制台",
      click: openControlWindow,
    },
    {
      label: "写入账号认证",
      click: () => {
        void applyAccountAuth()
      },
    },
    {
      label: isCertSetupRunning ? "初始化认证中..." : "初始化认证",
      enabled: !isCertSetupRunning,
      click: () => {
        void setupCertificates()
      },
    },
    {
      label: isServerRunning ? "停止服务" : "启动服务",
      click: () => (isServerRunning ? stopServer() : startServer()),
    },
    { type: "separator" },
    { label: "网络诊断", click: () => { void runNetworkDiagnostics() } },
    { label: "查看日志", click: openLogWindow },
    { label: "修复代理规则", click: () => { void fixProxyBypassRules() } },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        stopServer()
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
  refreshControlWindow()
}

async function startServer() {
  if (isServerRunning || launchedServerProcess) return

  const commandAvailable = await ensureAgentVibesAvailable()
  if (!commandAvailable) {
    dialog.showErrorBox(
      "启动失败",
      "未检测到 agent-vibes 命令，请先安装或加入 PATH。"
    )
    return
  }

  await killProcessOnPort(SERVER_PORT)
  isServerRunning = false
  updateTrayMenu()

  log("Starting agent-vibes in background...")

  try {
    const child = startAgentVibesProcess()
    launchedServerProcess = child
    launchedServerPid = child.pid || null
    log("agent-vibes started with pid:", launchedServerPid)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log("Start failed:", message)
    dialog.showErrorBox("启动失败", message)
  }
}

async function stopServer(force = false) {
  const pidToKill = launchedServerPid
  const processRef = launchedServerProcess

  if (processRef && !processRef.killed) {
    if (process.platform === "win32" && pidToKill) {
      await runCommand("taskkill", ["/pid", String(pidToKill), "/f", "/t"])
    } else {
      processRef.kill(force ? "SIGKILL" : "SIGTERM")
    }
  } else if (pidToKill) {
    if (process.platform === "win32") {
      await runCommand("taskkill", ["/pid", String(pidToKill), "/f", "/t"])
    } else {
      await runCommand("kill", [force ? "-KILL" : "-TERM", String(pidToKill)])
    }
  }

  launchedServerPid = null
  launchedServerProcess = null
  await killProcessOnPort(SERVER_PORT)
  isServerRunning = false
  if (!isQuitting) {
    updateTrayMenu()
  }
}

app.whenReady().then(() => {
  createTray()
  startPortCheck()
  log("Tray started")
})

app.on("before-quit", (event) => {
  if (isQuitting) {
    return
  }

  event.preventDefault()
  isQuitting = true
  stopPortCheck()
  Promise.resolve(stopServer(true))
    .catch((error) => {
      log("Stop server on quit failed:", error instanceof Error ? error.message : String(error))
    })
    .finally(() => {
      app.exit()
    })
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", openControlWindow)
}
