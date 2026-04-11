# Agent Vibes 直连模式使用指南

## 概述

直连模式允许你直接配置第三方 API（OpenAI、Anthropic、兼容 OpenAI 的自定义接口等），无需依赖 Google Cloud Code 或 Codex 后端。

当前版本的本地 HTTPS 证书已经改为由 `agent-vibes cert` 直接生成与安装，不再依赖 `mkcert -install`。

## 配置文件位置

直连模式的模型配置文件位于：
- Windows: `%USERPROFILE%\.agent-vibes\data\apis.yaml`
- macOS/Linux: `~/.agent-vibes/data/apis.yaml`

你可以直接编辑这个文件来定义可用模型。

**配置示例：**
```yaml
  - name: gpt-5.4
    format: codex
    endpoint: http://xxxx/v1
    custom_model_id: gpt-5.4
    target_model_id: gpt-5.4
    custom_api_key: "123"
    use_responses_api: true
    active: true

  - name: auto
    format: anthropic
    endpoint: http://xxxxxxx/v1
    custom_model_id: auto
    target_model_id: auto
    custom_api_key: "123"
    active: true

  - name: claude-opus-4-6
    format: openai
    endpoint: http://xxxxx/v1
    custom_model_id: claude-opus-4-6
    target_model_id: claude-opus-4-6
    custom_api_key: "12345"
    active: true

  - name: MiniMax-M2.7
    format: anthropic
    endpoint: https://api.minimaxi.com/anthropic
    custom_model_id: MiniMax-M2.7
    target_model_id: MiniMax-M2.7
    custom_api_key: "xxxxxxx"
    max_context_tokens: 200000
    active: true
```

配置要点：
1. `format` 用于指定协议类型，如 `anthropic` 或 `openai` 或 `codex`
2. `endpoint` 填写上游 API 地址
3. `custom_model_id` 是你在本地看到的模型名
4. `target_model_id` 是实际上游模型名
5. `custom_api_key` 填写对应服务的密钥
6. `active: true` 表示启用该模型
7  `max_context_tokens:2000000`上下文大小
## 基础配置

### 环境准备
进入项目根目录
```bash
npm install
npm run build
npm link
```

### 证书安装命令

```bash
agent-vibes cert
```

`agent-vibes cert` 会直接生成本地 CA 与服务证书，并自动安装系统信任；已经不再依赖 `mkcert -install`。

### Cursor 基础设置

1. 打开 Cursor 设置，确保使用Http2

## 使用说明

### 方式一：命令行启动

适合习惯直接在终端中启动直连模式的场景。

1. 先准备配置文件 `apis.yaml`
2. 在项目根目录启动服务：
```bash
agent-vibes --mode direct
```

### 方式二：托盘启动

适合希望通过图形界面管理模型、证书和服务状态的场景。

1. 启动托盘应用：
```powershell
cd apps/tray-app
npm install
npm run start
```
2. 右键点击托盘图标
3. 打开管理页面
4. 在管理页面中安装证书
5. 在管理页面中添加或修改模型配置
6. 在托盘菜单中点击「启动服务」


## 协议说明

### 支持的协议格式

| 格式 | 协议 | 端点 | 适用模型 |
|------|------|------|----------|
| `anthropic` | Anthropic Messages API | `/v1/messages` | Claude 系列 |
| `openai` | OpenAI Chat Completions | `/v1/chat/completions` |
| `codex` | OpenAI Responses API | `/v1/responses` | 






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
npx agent-vibes cert
```
3. 如需重新覆盖现有证书文件，可先删除 `~/.agent-vibes/certs`（Windows 为 `%USERPROFILE%\.agent-vibes\certs`）后再次执行

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

# 查看帮助
npx agent-vibes --help
```

## 更新日志

### v1.0.0
- 初始版本
- 支持 Anthropic Messages API
- 支持 OpenAI Chat Completions API
- 支持 OpenAI Responses API
- 托盘应用管理界面
