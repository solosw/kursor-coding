import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import * as fs from "fs"
import * as path from "path"
import { parse as parseYaml } from "yaml"
import type { CursorDisplayModel } from "./model-registry"
import { detectModelFamily, doesModelSupportThinking } from "./model-registry"
import {
  getAgentVibesDataDir,
  resolveProtocolBridgePath,
} from "../shared/protocol-bridge-paths"

export type RoutingMode = "standard" | "direct"
export type DirectApiFormat = "anthropic" | "openai" | "codex"

interface DirectApisConfigFile {
  apis?: DirectApiConfigEntryInput[]
}

interface DirectApiConfigEntryInput {
  name?: unknown
  format?: unknown
  endpoint?: unknown
  custom_model_id?: unknown
  target_model_id?: unknown
  custom_api_key?: unknown
  active?: unknown
  max_context_tokens?: unknown
  use_responses_api?: unknown
}

export interface DirectApiConfigEntry {
  name: string
  format: DirectApiFormat
  endpoint: string
  customModelId: string
  targetModelId: string
  customApiKey: string
  active: boolean
  maxContextTokens?: number
  useResponsesApi: boolean
}

function toCursorDisplayName(value: string): string {
  return value
    .split(/[/_-]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ")
}

@Injectable()
export class DirectApiConfigService implements OnModuleInit {
  private readonly logger = new Logger(DirectApiConfigService.name)
  private routingMode: RoutingMode = "standard"
  private configPath: string | null = null
  private entries: DirectApiConfigEntry[] = []

  onModuleInit(): void {
    this.routingMode = this.resolveRoutingMode()
    this.loadConfig()
    this.logger.log(
      `Direct API config initialized: mode=${this.routingMode}, activeEntries=${this.getActiveEntries().length}${this.configPath ? `, path=${this.configPath}` : ""}`
    )
  }

  isDirectMode(): boolean {
    return this.routingMode === "direct"
  }

  getRoutingMode(): RoutingMode {
    return this.routingMode
  }

  getConfigPath(): string | null {
    return this.configPath
  }

  getActiveEntries(): DirectApiConfigEntry[] {
    return this.entries.filter((entry) => entry.active)
  }

  getEntriesByFormat(format: DirectApiFormat): DirectApiConfigEntry[] {
    return this.getActiveEntries().filter((entry) => entry.format === format)
  }

  getAnthropicEntries(): DirectApiConfigEntry[] {
    return this.getEntriesByFormat("anthropic")
  }

  getOpenAiEntries(): DirectApiConfigEntry[] {
    return this.getActiveEntries().filter(
      (entry) => entry.format === "openai" || entry.format === "codex"
    )
  }

  findEntryByCustomModel(modelId: string): DirectApiConfigEntry | null {
    const normalized = modelId.trim().toLowerCase()
    if (!normalized) {
      return null
    }

    return (
      this.getActiveEntries().find(
        (entry) => entry.customModelId.toLowerCase() === normalized
      ) || null
    )
  }

  getCursorDisplayModels(): CursorDisplayModel[] {
    return this.getActiveEntries().map((entry) => {
      const family = this.detectFamilyForEntry(entry)

      return {
        name: entry.customModelId,
        displayName: entry.customModelId,
        shortName: entry.customModelId,
        family,
        isThinking: this.detectThinkingForEntry(entry),
        contextTokenLimit: entry.maxContextTokens,
      }
    })
  }

  private resolveRoutingMode(): RoutingMode {
    const raw = (process.env.AGENT_VIBES_ROUTING_MODE || "")
      .trim()
      .toLowerCase()
    return raw === "direct" ? "direct" : "standard"
  }

  private loadConfig(): void {
    this.entries = []
    this.configPath = null

    for (const candidate of this.getConfigPathCandidates()) {
      if (!fs.existsSync(candidate)) {
        continue
      }

      try {
        const parsed = parseYaml(
          fs.readFileSync(candidate, "utf8")
        ) as DirectApisConfigFile
        const entries = this.normalizeEntries(parsed?.apis)
        this.entries = entries
        this.configPath = candidate
        this.logger.log(
          `Loaded ${entries.length} direct API entr${entries.length === 1 ? "y" : "ies"} from ${candidate}`
        )
        return
      } catch (error) {
        this.logger.warn(
          `Failed to parse direct API config ${candidate}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }

  private getConfigPathCandidates(): string[] {
    const configuredPath = (
      process.env.AGENT_VIBES_APIS_CONFIG_PATH || ""
    ).trim()
    if (configuredPath) {
      return [path.resolve(configuredPath)]
    }

    const dataDir = path.resolve(getAgentVibesDataDir(), "data")
    return Array.from(
      new Set([
        path.join(dataDir, "apis.yaml"),
        path.join(dataDir, "apis.yml"),
        resolveProtocolBridgePath("data", "apis.yaml"),
        resolveProtocolBridgePath("data", "apis.yml"),
      ])
    )
  }

  private normalizeEntries(rawEntries: unknown): DirectApiConfigEntry[] {
    if (!Array.isArray(rawEntries)) {
      return []
    }

    const entries: DirectApiConfigEntry[] = []

    for (const rawEntry of rawEntries) {
      if (!rawEntry || typeof rawEntry !== "object") {
        continue
      }

      const entry = rawEntry as DirectApiConfigEntryInput
      const format = this.normalizeFormat(entry.format)
      const endpoint = this.toTrimmedString(entry.endpoint)
      const customModelId = this.toTrimmedString(entry.custom_model_id)
      const targetModelId = this.toTrimmedString(entry.target_model_id)
      const customApiKey = this.toTrimmedString(entry.custom_api_key)
      const name = this.toTrimmedString(entry.name) || customModelId
      const active = entry.active === true
      const maxContextTokens = this.normalizePositiveInteger(
        entry.max_context_tokens
      )
      const useResponsesApi = entry.use_responses_api === true

      if (
        !format ||
        !endpoint ||
        !customModelId ||
        !targetModelId ||
        !customApiKey
      ) {
        continue
      }

      entries.push({
        name,
        format,
        endpoint,
        customModelId,
        targetModelId,
        customApiKey,
        active,
        maxContextTokens,
        useResponsesApi,
      })
    }

    return entries
  }

  private normalizeFormat(value: unknown): DirectApiFormat | null {
    const normalized = this.toTrimmedString(value).toLowerCase()
    if (
      normalized === "anthropic" ||
      normalized === "openai" ||
      normalized === "codex"
    ) {
      return normalized
    }
    return null
  }

  private normalizePositiveInteger(value: unknown): number | undefined {
    const parsed =
      typeof value === "string" ? Number.parseInt(value.trim(), 10) : value
    if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
      return undefined
    }

    return Math.floor(parsed)
  }

  private toTrimmedString(value: unknown): string {
    return typeof value === "string" ? value.trim() : ""
  }

  private detectFamilyForEntry(
    entry: DirectApiConfigEntry
  ): CursorDisplayModel["family"] {
    const detectedCustomFamily = detectModelFamily(entry.customModelId)
    if (detectedCustomFamily !== "unknown") {
      return detectedCustomFamily
    }

    const detectedTargetFamily = detectModelFamily(entry.targetModelId)
    if (detectedTargetFamily !== "unknown") {
      return detectedTargetFamily
    }

    if (entry.format === "anthropic") {
      return "claude"
    }

    if (entry.format === "openai" || entry.format === "codex") {
      return "gpt"
    }

    return "unknown"
  }

  private resolveDisplayName(
    entry: DirectApiConfigEntry,
    family: CursorDisplayModel["family"]
  ): string {
    const preferred = entry.name || entry.customModelId
    const normalizedPreferred = preferred.trim()
    if (normalizedPreferred && normalizedPreferred !== entry.customModelId) {
      return normalizedPreferred
    }

    const label = toCursorDisplayName(entry.customModelId)
    if (!label) {
      return entry.customModelId
    }

    const familyPrefix =
      family === "claude"
        ? "Claude"
        : family === "gpt"
          ? "GPT"
          : family === "gemini"
            ? "Gemini"
            : "Model"

    return label.toLowerCase().startsWith(familyPrefix.toLowerCase())
      ? label
      : `${familyPrefix} ${label}`
  }

  private detectThinkingForEntry(entry: DirectApiConfigEntry): boolean {
    return (
      doesModelSupportThinking(entry.customModelId) ||
      doesModelSupportThinking(entry.targetModelId)
    )
  }
}
