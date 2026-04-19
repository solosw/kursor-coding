import { Controller, Get, Post, Body, Res } from "@nestjs/common"
import { FastifyReply } from "fastify"
import { DirectApiConfigService } from "../llm/direct-api-config.service"
import * as fs from "fs"
import * as path from "path"
import { getAgentVibesDataDir } from "../shared/protocol-bridge-paths"

interface ModelFormData {
  name: string
  format: "anthropic" | "openai" | "codex"
  endpoint: string
  customModelId: string
  targetModelId: string
  customApiKey: string
  active: boolean
  maxContextTokens?: number
  maxOutputTokens?: number
  autoContinue?: boolean
  useResponsesApi?: boolean
}

@Controller("admin")
export class AdminController {
  constructor(private readonly directApiConfig: DirectApiConfigService) {}

  @Get()
  getAdminPage(@Res() res: FastifyReply): void {
    const html = this.buildHtmlPage()
    res.header("Content-Type", "text/html; charset=utf-8")
    res.send(html)
  }

  @Get("models")
  getModels(): { models: ModelFormData[]; configPath: string | null } {
    const entries = this.directApiConfig.getActiveEntries()
    const configPath = this.directApiConfig.getConfigPath()
    return {
      models: entries.map((e) => ({
        name: e.name,
        format: e.format,
        endpoint: e.endpoint,
        customModelId: e.customModelId,
        targetModelId: e.targetModelId,
        customApiKey: e.customApiKey,
        active: e.active,
        maxContextTokens: e.maxContextTokens,
        maxOutputTokens: e.maxOutputTokens,
        autoContinue: e.autoContinue,
        useResponsesApi: e.useResponsesApi,
      })),
      configPath,
    }
  }

  @Post("models")
  saveModels(@Body() body: { models: ModelFormData[] }): { success: boolean; message: string } {
    try {
      const configPath = this.getConfigPath()
      const yamlContent = this.buildYamlContent(body.models)
      fs.writeFileSync(configPath, yamlContent, "utf8")
      return { success: true, message: `配置已保存到 ${configPath}` }
    } catch (error) {
      return {
        success: false,
        message: `保存失败: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  private getConfigPath(): string {
    const dataDir = path.resolve(getAgentVibesDataDir(), "data")
    return path.join(dataDir, "apis.yaml")
  }

  private buildYamlContent(models: ModelFormData[]): string {
    const lines = ["apis:"]
    for (const m of models) {
      lines.push("  - name: " + m.name)
      lines.push("    format: " + m.format)
      lines.push("    endpoint: " + m.endpoint)
      lines.push("    custom_model_id: " + m.customModelId)
      lines.push("    target_model_id: " + m.targetModelId)
      lines.push("    custom_api_key: \"" + m.customApiKey + "\"")
      if (typeof m.maxContextTokens === "number" && Number.isFinite(m.maxContextTokens) && m.maxContextTokens > 0) {
        lines.push("    max_context_tokens: " + Math.floor(m.maxContextTokens))
      }
      if (typeof m.maxOutputTokens === "number" && Number.isFinite(m.maxOutputTokens) && m.maxOutputTokens > 0) {
        lines.push("    max_output_tokens: " + Math.floor(m.maxOutputTokens))
      }
      if (m.autoContinue === true) {
        lines.push("    auto_continue: true")
      }
      if (m.useResponsesApi === true) {
        lines.push("    use_responses_api: true")
      }
      lines.push("    active: " + m.active)
      lines.push("")
    }
    return lines.join("\n")
  }

  private buildHtmlPage(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Vibes 直连模式管理</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      line-height: 1.6;
      padding: 20px;
    }
    .container { max-width: 900px; margin: 0 auto; }
    h1 {
      color: #58a6ff;
      margin-bottom: 10px;
      font-size: 24px;
    }
    .subtitle { color: #8b949e; margin-bottom: 30px; }
    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .card-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 15px;
      color: #f0f6fc;
    }
    .form-group { margin-bottom: 15px; }
    label {
      display: block;
      margin-bottom: 5px;
      color: #8b949e;
      font-size: 14px;
    }
    input, select {
      width: 100%;
      padding: 10px 12px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #c9d1d9;
      font-size: 14px;
    }
    input:focus, select:focus {
      outline: none;
      border-color: #58a6ff;
    }
    .row { display: flex; gap: 15px; }
    .col { flex: 1; }
    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.9; }
    .btn-primary {
      background: #238636;
      color: white;
    }
    .btn-secondary {
      background: #1f6feb;
      color: white;
    }
    .btn-danger {
      background: #da3633;
      color: white;
    }
    .btn-group {
      display: flex;
      gap: 10px;
      margin-top: 20px;
    }
    .model-item {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 15px;
    }
    .model-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .model-name {
      font-weight: 600;
      color: #f0f6fc;
    }
    .badge {
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 12px;
    }
    .badge-anthropic { background: #e85d04; color: white; }
    .badge-openai { background: #10a37f; color: white; }
    .status {
      padding: 10px;
      border-radius: 6px;
      margin-bottom: 15px;
      display: none;
    }
    .status.success { background: #23863633; border: 1px solid #238636; display: block; }
    .status.error { background: #da363333; border: 1px solid #da3633; display: block; }
    .help-text {
      font-size: 12px;
      color: #8b949e;
      margin-top: 3px;
    }
    .config-path {
      font-family: monospace;
      font-size: 12px;
      color: #58a6ff;
      word-break: break-all;
    }
    .startup-section {
      background: #23863622;
      border: 1px solid #238636;
    }
    code {
      background: #0d1117;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: monospace;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>⚡ Agent Vibes 直连模式管理</h1>
    <p class="subtitle">简单配置，直接连接 OpenAI / Anthropic API</p>

    <div id="status" class="status"></div>

    <div class="card">
      <div class="card-title">📍 配置文件位置</div>
      <p class="config-path" id="configPath">加载中...</p>
    </div>

    <div class="card">
      <div class="card-title">🤖 已配置模型</div>
      <div id="modelList">加载中...</div>
      <div class="btn-group">
        <button class="btn btn-secondary" onclick="addModel()">+ 添加模型</button>
      </div>
    </div>

    <div class="card startup-section">
      <div class="card-title">🚀 启动直连模式</div>
      <p style="margin-bottom: 15px;">保存配置后，使用以下命令启动：</p>
      <code style="display: block; padding: 15px; margin-bottom: 15px;">
        bin\\agent-vibes --mode direct
      </code>
      <p class="help-text">或者直接点击下面的按钮启动（需要 Node.js 环境）</p>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="saveAndStart()">💾 保存并启动</button>
      </div>
    </div>
  </div>

  <script>
    let models = [];

    async function loadModels() {
      try {
        const res = await fetch('/admin/models');
        const data = await res.json();
        models = data.models;
        document.getElementById('configPath').textContent = data.configPath || '未找到配置文件';
        renderModels();
      } catch (e) {
        showStatus('加载失败: ' + e.message, 'error');
      }
    }

    function renderModels() {
      const container = document.getElementById('modelList');
      if (models.length === 0) {
        container.innerHTML = '<p style="color: #8b949e;">暂无模型，点击"添加模型"开始配置</p>';
        return;
      }
      container.innerHTML = models.map((m, i) => \`
        <div class="model-item">
          <div class="model-header">
            <span class="model-name">\${m.name || m.customModelId}</span>
            <span class="badge badge-\${m.format}">\${m.format}</span>
          </div>
          <div class="row">
            <div class="col">
              <div class="form-group">
                <label>显示名称</label>
                <input type="text" value="\${m.name}" onchange="updateModel(\${i}, 'name', this.value)" placeholder="例如: Claude Sonnet">
              </div>
            </div>
            <div class="col">
              <div class="form-group">
                <label>API 格式</label>
                <select onchange="updateModel(\${i}, 'format', this.value)">
                  <option value="anthropic" \${m.format === 'anthropic' ? 'selected' : ''}>Anthropic</option>
                  <option value="openai" \${m.format === 'openai' ? 'selected' : ''}>OpenAI</option>
                  <option value="codex" \${m.format === 'codex' ? 'selected' : ''}>Codex</option>
                </select>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>API 端点</label>
            <input type="text" value="\${m.endpoint}" onchange="updateModel(\${i}, 'endpoint', this.value)" placeholder="https://api.anthropic.com/v1">
          </div>
          <div class="row">
            <div class="col">
              <div class="form-group">
                <label>模型 ID (显示给 Cursor)</label>
                <input type="text" value="\${m.customModelId}" onchange="updateModel(\${i}, 'customModelId', this.value)" placeholder="claude-sonnet-4-6">
              </div>
            </div>
            <div class="col">
              <div class="form-group">
                <label>目标模型 ID (上游 API)</label>
                <input type="text" value="\${m.targetModelId}" onchange="updateModel(\${i}, 'targetModelId', this.value)" placeholder="claude-sonnet-4-6">
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>API Key</label>
            <input type="password" value="\${m.customApiKey}" onchange="updateModel(\${i}, 'customApiKey', this.value)" placeholder="sk-...">
          </div>
          <div class="row">
            <div class="col">
              <div class="form-group">
                <label>最大上下文窗口</label>
                <input type="number" value="\${m.maxContextTokens || ''}" onchange="updateNumberModel(\${i}, 'maxContextTokens', this.value)" placeholder="例如: 200000">
              </div>
            </div>
            <div class="col">
              <div class="form-group">
                <label>最大输出长度</label>
                <input type="number" value="\${m.maxOutputTokens || ''}" onchange="updateNumberModel(\${i}, 'maxOutputTokens', this.value)" placeholder="例如: 8192">
              </div>
            </div>
          </div>
          <div class="row">
            <div class="col">
              <div class="form-group">
                <label>自动续写</label>
                <select onchange="updateModel(\${i}, 'autoContinue', this.value === 'true')">
                  <option value="false" \${m.autoContinue ? '' : 'selected'}>关闭</option>
                  <option value="true" \${m.autoContinue ? 'selected' : ''}>开启</option>
                </select>
              </div>
            </div>
            <div class="col">
              <div class="form-group">
                <label>协议模式</label>
                <select onchange="updateModel(\${i}, 'useResponsesApi', this.value === 'true')">
                  <option value="false" \${m.useResponsesApi ? '' : 'selected'}>默认</option>
                  <option value="true" \${m.useResponsesApi ? 'selected' : ''}>Codex / Responses</option>
                </select>
              </div>
            </div>
          </div>
          <div style="margin-top: 10px;">
            <button class="btn btn-danger" onclick="deleteModel(\${i})">删除</button>
          </div>
        </div>
      \`).join('');
    }

    function updateModel(index, field, value) {
      models[index][field] = value;
    }

    function updateNumberModel(index, field, value) {
      const parsed = Number.parseInt(value, 10);
      models[index][field] = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    }

    function addModel() {
      models.push({
        name: '',
        format: 'anthropic',
        endpoint: 'https://api.anthropic.com/v1',
        customModelId: '',
        targetModelId: '',
        customApiKey: '',
        active: true,
        maxContextTokens: undefined,
        maxOutputTokens: undefined,
        autoContinue: false,
        useResponsesApi: false
      });
      renderModels();
    }

    function deleteModel(index) {
      models.splice(index, 1);
      renderModels();
    }

    async function saveModels() {
      try {
        const res = await fetch('/admin/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ models })
        });
        const data = await res.json();
        if (data.success) {
          showStatus(data.message, 'success');
          return true;
        } else {
          showStatus(data.message, 'error');
          return false;
        }
      } catch (e) {
        showStatus('保存失败: ' + e.message, 'error');
        return false;
      }
    }

    async function saveAndStart() {
      const saved = await saveModels();
      if (saved) {
        showStatus('配置已保存！请在终端运行: bin\\agent-vibes --mode direct', 'success');
      }
    }

    function showStatus(message, type) {
      const el = document.getElementById('status');
      el.textContent = message;
      el.className = 'status ' + type;
      setTimeout(() => { el.className = 'status'; }, 5000);
    }

    loadModels();
  </script>
</body>
</html>`
  }
}
