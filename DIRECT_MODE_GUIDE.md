# Agent Vibes 直连模式使用指南

## 概述

直连模式允许你直接配置第三方 API（OpenAI、Anthropic 等），无需依赖 Google Cloud Code 或 Codex 后端。

## 快速开始

### 第一步：安装 mkcert（首次使用）

mkcert 用于生成本地 HTTPS 证书，让 Cursor 可以安全连接到本地服务。

**Windows:**
```powershell
# 使用 winget 安装
winget install mkcert

# 或使用 Chocolatey
choco install mkcert

# 或使用 Scoop
scoop install mkcert
```

**macOS:**
```bash
brew install mkcert
```

**Linux:**
```bash
# Ubuntu/Debian
sudo apt-get install -y mkcert

# 或从源码安装
curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/amd64"
chmod +x mkcert-v*-linux-amd64
sudo cp mkcert-v*-linux-amd64 /usr/local/bin/mkcert
```

### 第二步：启动托盘应用

```powershell
cd apps/tray-app
npm install
npm run start
```

托盘图标将出现在系统托盘区。

### 第三步：安装本地证书

1. 右键点击托盘图标
2. 选择「打开管理页面」
3. 在管理页面中找到「证书安装」区域
4. 点击「安装证书」按钮

或手动执行：
```bash
# 在项目根目录执行
npx agent-vibes cert
```

### 第四步：配置 API

在管理页面中：
1. 点击「添加模型」
2. 选择协议格式：
   - **Anthropic** - Claude 系列模型
   - **OpenAI** - GPT 系列模型（自动识别 Responses API）
3. 填写 API 端点、模型 ID 和 API Key
4. 保存配置

或手动编辑配置文件：

**配置文件路径：**
- Windows: `%USERPROFILE%\.agent-vibes\data\apis.yaml`
- macOS/Linux: `~/.agent-vibes/data/apis.yaml`

**配置示例：**
```yaml
apis:
  # Claude 模型（Anthropic Messages API）
  - name: Claude Sonnet 4.6
    format: anthropic
    endpoint: https://api.anthropic.com/v1/messages
    custom_model_id: claude-sonnet-4-6
    target_model_id: claude-sonnet-4-6-20251022
    custom_api_key: sk-ant-xxxxx
    active: true

  # GPT-4o（OpenAI Chat Completions API）
  - name: GPT-4o
    format: openai
    endpoint: https://api.openai.com/v1
    custom_model_id: gpt-4o
    target_model_id: gpt-4o
    custom_api_key: sk-xxxxx
    active: true

  # o3-mini（自动使用 OpenAI Responses API）
  - name: o3-mini
    format: openai
    endpoint: https://api.openai.com/v1
    custom_model_id: o3-mini
    target_model_id: o3-mini
    custom_api_key: sk-xxxxx
    active: true
```

### 第五步：启动服务

在托盘菜单中：
1. 右键点击托盘图标
2. 选择「启动服务」

或命令行启动：
```bash
# 在项目根目录
npm run start:direct
```

### 第六步：配置 Cursor

1. 打开 Cursor 设置
2. 找到「AI 设置」或「模型设置」
3. 将 API 端点改为：`https://localhost:2026`
4. 保存设置

## 协议说明

### 支持的协议格式

| 格式 | 协议 | 端点 | 适用模型 |
|------|------|------|----------|
| `anthropic` | Anthropic Messages API | `/v1/messages` | Claude 系列 |
| `openai` | OpenAI Chat Completions | `/v1/chat/completions` | GPT-3.5/4 等 |
| `openai` | OpenAI Responses API | `/v1/responses` | o1/o3/o4/gpt-5（自动） |

### Responses API 自动触发

当模型名以以下前缀开头时，自动使用 Responses API：
- `o1*` - o1-preview, o1-mini 等
- `o3*` - o3-mini 等
- `o4*` - o4 系列
- `gpt-5*` - GPT-5 系列
- `codex*` - Codex 系列

### 强制协议选择

通过环境变量控制：
```bash
# 强制使用 Responses API
set OPENAI_COMPAT_USE_RESPONSES_API=always

# 强制使用 Chat Completions
set OPENAI_COMPAT_USE_RESPONSES_API=never

# 自动选择（默认）
set OPENAI_COMPAT_USE_RESPONSES_API=auto
```

## 管理页面功能

托盘应用提供 Web 管理界面：`https://localhost:2026/admin`

功能包括：
- 📊 服务状态监控
- ➕ 添加/编辑模型配置
- 🚀 启动/停止服务
- 📜 查看日志
- 🔧 证书管理

## 故障排除

### 端口被占用

如果 2026 端口被占用：
```bash
# Windows
netstat -ano | findstr 2026
taskkill /PID <PID> /F

# macOS/Linux
lsof -i :2026
kill -9 <PID>
```

### 证书错误

1. 确保证书已正确安装
2. 尝试重新生成证书：
```bash
npx agent-vibes cert --force
```

### 模型不显示

1. 检查 `apis.yaml` 格式是否正确
2. 确认 `active: true`
3. 查看服务日志排查错误

### 连接失败

1. 确认服务已启动（托盘显示 🟢）
2. 检查防火墙设置
3. 验证 API Key 是否正确

## 高级配置

### 自定义配置路径

```bash
set AGENT_VIBES_APIS_CONFIG_PATH=C:\custom\path\apis.yaml
```

### 调试模式

```bash
set DEBUG=agent-vibes:*
npm run start:direct
```

## 命令行参考

```bash
# 启动直连模式
npm run start:direct

# 安装证书
npx agent-vibes cert

# 强制重新生成证书
npx agent-vibes cert --force

# 查看帮助
npx agent-vibes --help
```

## 更新日志

### v1.0.0
- 初始版本
- 支持 Anthropic Messages API
- 支持 OpenAI Chat Completions API
- 支持 OpenAI Responses API（自动）
- 托盘应用管理界面
