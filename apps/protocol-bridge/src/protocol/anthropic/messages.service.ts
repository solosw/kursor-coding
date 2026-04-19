import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import {
  type ContextAttachmentSnapshot,
  ContextManagerService,
  TokenCounterService,
  UnifiedMessage,
} from "../../context"
import { TokenizerService } from "../../context/tokenizer.service"
import { CodexService } from "../../llm/codex/codex.service"
import {
  ClaudeApiService,
  DEFAULT_CLAUDE_API_CONTEXT_LIMIT_TOKENS,
} from "../../llm/claude-api/claude-api.service"
import { GoogleModelCacheService } from "../../llm/google/google-model-cache.service"
import { GoogleService } from "../../llm/google/google.service"
import {
  canPublicClaudeModelUseGoogle,
  getCodexPublicModelIds,
  getPublicModelMetadata,
  resolveCloudCodeModel,
} from "../../llm/model-registry"
import { DirectApiConfigService, type DirectApiConfigEntry } from "../../llm/direct-api-config.service"
import {
  ModelRouteResult,
  ModelRouterService,
} from "../../llm/model-router.service"
import { OpenaiCompatService } from "../../llm/openai-compat/openai-compat.service"
import { BackendApiError } from "../../llm/shared/backend-errors"
import type { AnthropicResponse } from "../../shared/anthropic"
import { CountTokensDto } from "./dto/count-tokens.dto"
import { CreateMessageDto } from "./dto/create-message.dto"

/**
 * MessagesService - Routes requests to Google or Codex backend.
 */
@Injectable()
export class MessagesService implements OnModuleInit {
  private readonly logger = new Logger(MessagesService.name)
  private readonly DEFAULT_HISTORY_MAX_TOKENS = 166_000
  private readonly CLOUD_CODE_CONTEXT_LIMIT_TOKENS = 200_000
  private readonly CLOUD_CODE_EXTRA_OVERHEAD_TOKENS = 1_536
  private readonly GENERIC_EXTRA_OVERHEAD_TOKENS = 768
  private readonly GOOGLE_CONTEXT_TAGS = [
    "user_information",
    "mcp_servers",
    "artifacts",
    "user_rules",
    "workflows",
    "ADDITIONAL_METADATA",
    "EPHEMERAL_MESSAGE",
  ] as const
  private readonly AUTO_CONTINUE_PROMPT =
    "继续上次回答，从中断处直接接着输出，不要重复前文，不要做总结，不要重写开头。"
  private readonly MAX_AUTO_CONTINUE_ROUNDS = 8
  private readonly EMPTY_ATTACHMENT_SNAPSHOT: ContextAttachmentSnapshot = {
    readPaths: [],
    fileStates: [],
    todos: [],
  }

  constructor(
    private readonly googleService: GoogleService,
    private readonly googleModelCache: GoogleModelCacheService,
    private readonly modelRouter: ModelRouterService,
    private readonly tokenizer: TokenizerService,
    private readonly tokenCounter: TokenCounterService,
    private readonly contextManager: ContextManagerService,
    private readonly codexService: CodexService,
    private readonly openaiCompatService: OpenaiCompatService,
    private readonly claudeApiService: ClaudeApiService,
    private readonly directApiConfig: DirectApiConfigService
  ) {}

  private isGptBackendAvailable(): boolean {
    return (
      this.openaiCompatService.isAvailable() || this.codexService.isAvailable()
    )
  }

  private getAdvertisedGptModelTier(): string | null {
    if (this.openaiCompatService.isAvailable()) {
      return null
    }

    return this.codexService.getModelTier()
  }

  /**
   * Initialize backend availability checks.
   */
  async onModuleInit(): Promise<void> {
    if (this.directApiConfig.isDirectMode()) {
      this.modelRouter.updateGoogleAvailability(false)
      this.modelRouter.setGptAvailabilityProviders({
        codex: () => false,
        openaiCompat: () => this.directApiConfig.getOpenAiEntries().length > 0,
      })
      this.modelRouter.setClaudeAvailabilityProvider(
        (model) =>
          this.directApiConfig.findEntryByCustomModel(model)?.format ===
          "anthropic"
      )
      this.logger.log(
        "Direct mode enabled: skipped legacy backend availability tests"
      )
      return
    }

    await this.modelRouter.initializeRouting(
      () => this.googleService.checkAvailability(),
      () => this.codexService.checkAvailability(),
      () => this.openaiCompatService.checkAvailability(),
      () => this.claudeApiService.checkAvailability()
    )
    this.modelRouter.setGptAvailabilityProviders({
      codex: () => this.codexService.isAvailable(),
      openaiCompat: () => this.openaiCompatService.isAvailable(),
    })
    this.modelRouter.setClaudeAvailabilityProvider((model) =>
      this.claudeApiService.supportsModel(model)
    )
    this.logger.log("Backend availability tests completed")
  }

  /**
   * Extract text content from message content
   */
  private extractTextContent(content: unknown): string {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .filter(
          (block): block is { type: string; text: string } =>
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>).type === "text"
        )
        .map((block) => block.text)
        .join("\n")
    }
    return ""
  }

  private extractGoogleContextBlocks(systemText: string): string[] {
    const tagAlternation = this.GOOGLE_CONTEXT_TAGS.join("|")
    const blockPattern = new RegExp(
      `<(?:${tagAlternation})>[\\s\\S]*?<\\/(?:${tagAlternation})>`,
      "g"
    )
    const matches = Array.from(systemText.matchAll(blockPattern))

    if (matches.length > 0) {
      const blocks: string[] = []
      let cursor = 0

      for (const match of matches) {
        const block = match[0]?.trim()
        const index = match.index ?? cursor
        const prefix = systemText.slice(cursor, index).trim()

        if (prefix) {
          blocks.push(prefix)
        }
        if (block) {
          blocks.push(block)
        }

        cursor = index + (match[0]?.length || 0)
      }

      const suffix = systemText.slice(cursor).trim()
      if (suffix) {
        blocks.push(suffix)
      }

      return this.dedupePreserveOrder(blocks)
    }

    const trimmed = systemText.trim()
    if (!trimmed) return []
    return [`<user_rules>\n${trimmed}\n</user_rules>`]
  }

  private dedupePreserveOrder(values: string[]): string[] {
    const seen = new Set<string>()
    const result: string[] = []

    for (const value of values) {
      const normalized = value.trim()
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      result.push(normalized)
    }

    return result
  }

  /**
   * Prepare DTO for Google Cloud Code backend routing.
   * GoogleService replaces dto.system entirely with the official Antigravity prompt.
   * To preserve user customizations (CLAUDE.md rules, project settings, etc.),
   * extract them from dto.system and inject as user messages in dto.messages.
   *
   * This matches Antigravity's behavior: user context goes in contents (user messages),
   * not in systemInstruction.
   */
  private prepareForGoogle(dto: CreateMessageDto): CreateMessageDto {
    if (!dto.system) return dto

    // Extract raw system text
    let systemText: string
    if (typeof dto.system === "string") {
      systemText = dto.system
    } else if (Array.isArray(dto.system)) {
      systemText = dto.system
        .filter(
          (block): block is { type: string; text: string } =>
            typeof block === "object" && block !== null && block.type === "text"
        )
        .map((block) => block.text)
        .join("\n")
    } else {
      systemText = this.extractTextContent(dto.system)
    }

    if (!systemText) return dto

    const contextMessages = this.extractGoogleContextBlocks(systemText).map(
      (content) => ({
        role: "user",
        content,
      })
    )

    if (contextMessages.length === 0) return dto

    this.logger.log(
      `[prepareForGoogle] Moved ${contextMessages.length} user context block(s) from system to messages`
    )

    return {
      ...dto,
      messages: [...(contextMessages as typeof dto.messages), ...dto.messages],
      _protectedContextMessageCount: contextMessages.length,
      system: undefined,
    }
  }

  private isGoogleBackend(route: ModelRouteResult): boolean {
    return route.backend === "google" || route.backend === "google-claude"
  }

  private normalizePositiveInteger(value: unknown): number | undefined {
    if (typeof value !== "number") return undefined
    if (!Number.isFinite(value) || value <= 0) return undefined
    return Math.floor(value)
  }

  private countSystemPromptTokens(dto: CreateMessageDto): number {
    if (!dto.system) return 0

    return this.tokenCounter.countMessages([
      { role: "user", content: dto.system } as UnifiedMessage,
    ])
  }

  private getBackendContextLimit(route: ModelRouteResult): number | undefined {
    if (this.modelRouter.isDirectMode) {
      const directEntry = this.directApiConfig.findEntryByCustomModel(route.model)
      if (directEntry?.maxContextTokens) {
        return directEntry.maxContextTokens
      }
    }

    if (this.isGoogleBackend(route)) {
      return this.CLOUD_CODE_CONTEXT_LIMIT_TOKENS
    }
    if (route.backend === "claude-api") {
      return (
        this.claudeApiService.getConfiguredMaxContextTokens(route.model) ??
        DEFAULT_CLAUDE_API_CONTEXT_LIMIT_TOKENS
      )
    }
    if (route.backend === "openai-compat" || route.backend === "codex") {
      return this.openaiCompatService.getConfiguredMaxContextTokens(route.model)
    }
    return undefined
  }

  private resolveContextBudget(
    dto: CreateMessageDto,
    route: ModelRouteResult
  ): {
    maxTokens: number
    systemPromptTokens: number
  } {
    let maxTokens =
      this.normalizePositiveInteger(dto._contextTokenBudget) ||
      this.DEFAULT_HISTORY_MAX_TOKENS
    const backendLimit = this.getBackendContextLimit(route)
    if (backendLimit && maxTokens > backendLimit) {
      this.logger.warn(
        `Request context budget ${maxTokens} exceeds backend cap ${backendLimit}, clamping`
      )
      maxTokens = backendLimit
    }

    const systemPromptTokens =
      this.countSystemPromptTokens(dto) +
      this.tokenCounter.countJsonValue(dto.tools) +
      (this.isGoogleBackend(route)
        ? this.googleService.getSystemPromptTokenEstimate() +
          this.CLOUD_CODE_EXTRA_OVERHEAD_TOKENS
        : this.GENERIC_EXTRA_OVERHEAD_TOKENS)

    return {
      maxTokens,
      systemPromptTokens,
    }
  }

  private applyContextCompaction(
    dto: CreateMessageDto,
    route: ModelRouteResult
  ): CreateMessageDto {
    const originalTokens = this.contextManager.countMessages(
      dto.messages as UnifiedMessage[]
    )
    const budget = this.resolveContextBudget(dto, route)
    const result = this.contextManager.buildBackendMessagesFromMessages(
      dto.messages as UnifiedMessage[],
      this.EMPTY_ATTACHMENT_SNAPSHOT,
      {
        maxTokens: budget.maxTokens,
        systemPromptTokens: budget.systemPromptTokens,
        pendingToolUseIds: dto._pendingToolUseIds,
        strategy: "auto",
      }
    )

    if (result.wasCompacted) {
      this.logger.log(
        `Applied context compaction for ${route.backend}: ${originalTokens} -> ` +
          `${result.estimatedTokens} tokens (${dto.messages.length} -> ${result.messages.length} messages)`
      )
    }

    return {
      ...dto,
      messages: result.messages as typeof dto.messages,
    }
  }

  private shouldAutoContinueDirectEntry(
    entry: DirectApiConfigEntry | null
  ): boolean {
    return entry?.autoContinue === true && !!entry.maxOutputTokens
  }

  private applyDirectOutputLimit(
    dto: CreateMessageDto,
    entry: DirectApiConfigEntry | null
  ): CreateMessageDto {
    if (!entry?.maxOutputTokens) {
      return dto
    }

    const requested = this.normalizePositiveInteger(dto.max_tokens)
    const resolvedMaxTokens = requested
      ? Math.min(requested, entry.maxOutputTokens)
      : entry.maxOutputTokens

    return {
      ...dto,
      max_tokens: resolvedMaxTokens,
    }
  }

  private buildAutoContinueDto(
    dto: CreateMessageDto,
    assistantContent: string
  ): CreateMessageDto {
    const assistantBlocks = assistantContent
      ? [{ type: "text", text: assistantContent }]
      : []

    return {
      ...dto,
      messages: [
        ...dto.messages,
        {
          role: "assistant",
          content: assistantBlocks,
        },
        {
          role: "user",
          content: this.AUTO_CONTINUE_PROMPT,
        },
      ],
    }
  }

  private parseSseChunk(
    chunk: string
  ): { event: string; data: Record<string, unknown> } | null {
    try {
      const lines = chunk.split("\n")
      let event = ""
      let data = ""

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          event = line.slice(7).trim()
        } else if (line.startsWith("data: ")) {
          data = line.slice(6).trim()
        }
      }

      if (!event || !data) {
        return null
      }

      return {
        event,
        data: JSON.parse(data) as Record<string, unknown>,
      }
    } catch {
      return null
    }
  }

  private async *executeDirectAutoContinueStream(
    dto: CreateMessageDto,
    directEntry: DirectApiConfigEntry,
    route: ModelRouteResult,
    forwardHeaders?: Record<string, string>
  ): AsyncGenerator<string, void, unknown> {
    let currentDto = this.applyDirectOutputLimit(dto, directEntry)
    let round = 0

    while (true) {
      let stopReason: string | null = null
      let assistantText = ""

      const handleChunk = (chunk: string): string | null => {
        const parsed = this.parseSseChunk(chunk)
        if (!parsed) {
          return chunk
        }

        if (parsed.event === "content_block_delta") {
          const delta = parsed.data.delta
          if (delta && typeof delta === "object") {
            const text = (delta as { text?: unknown }).text
            if (typeof text === "string") {
              assistantText += text
            }
          }
          return chunk
        }

        if (parsed.event === "message_delta") {
          const delta = parsed.data.delta
          if (delta && typeof delta === "object") {
            const value = (delta as { stop_reason?: unknown }).stop_reason
            stopReason = typeof value === "string" ? value : stopReason
          }
          if (stopReason === "max_tokens") {
            return null
          }
        }

        if (parsed.event === "message_stop" && stopReason === "max_tokens") {
          return null
        }

        return chunk
      }

      if (route.backend === "claude-api") {
        for await (const chunk of this.claudeApiService.sendDirectClaudeMessageStream(
          currentDto,
          {
            accountLabel: directEntry.name,
            apiKey: directEntry.customApiKey,
            baseUrl: directEntry.endpoint,
            model: directEntry.targetModelId,
            maxOutputTokens: directEntry.maxOutputTokens,
            autoContinue: directEntry.autoContinue,
          },
          forwardHeaders
        )) {
          const output = handleChunk(chunk)
          if (output) {
            yield output
          }
        }
      } else {
        for await (const chunk of this.openaiCompatService.sendDirectClaudeMessageStream(
          currentDto,
          {
            accountLabel: directEntry.name,
            apiKey: directEntry.customApiKey,
            baseUrl: directEntry.endpoint,
            model: directEntry.targetModelId,
            preferResponsesApi:
              route.backend === "codex" || directEntry.useResponsesApi,
            maxContextTokens: directEntry.maxContextTokens,
            maxOutputTokens: directEntry.maxOutputTokens,
            autoContinue: directEntry.autoContinue,
          }
        )) {
          const output = handleChunk(chunk)
          if (output) {
            yield output
          }
        }
      }

      if (stopReason !== "max_tokens") {
        return
      }

      round += 1
      if (round >= this.MAX_AUTO_CONTINUE_ROUNDS) {
        this.logger.warn(
          `[Direct AutoContinue] Reached continuation limit for model ${dto.model}`
        )
        yield `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0 } })}\n\n`
        yield `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
        return
      }

      if (!assistantText.trim()) {
        this.logger.warn(
          `[Direct AutoContinue] Stop reason is max_tokens but no assistant text was produced for model ${dto.model}`
        )
        yield `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0 } })}\n\n`
        yield `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
        return
      }

      this.logger.log(
        `[Direct AutoContinue] Continuing model=${dto.model}, round=${round}`
      )
      currentDto = this.buildAutoContinueDto(currentDto, assistantText)
      currentDto = this.applyDirectOutputLimit(currentDto, directEntry)
    }
  }

  private prepareDtoForRoute(
    dto: CreateMessageDto,
    route: ModelRouteResult
  ): CreateMessageDto {
    const routedDto = { ...dto, model: route.model }
    const compactedDto = this.applyContextCompaction(routedDto, route)

    return this.isGoogleBackend(route)
      ? this.prepareForGoogle(compactedDto)
      : compactedDto
  }

  /**
   * Whether doc creation prohibition policy should be injected.
   * Disabled by default for open-source friendliness.
   */
  private shouldEnforceDocProhibition(): boolean {
    const raw = process.env.ENFORCE_DOC_PROHIBITION?.toLowerCase()
    return raw === "true" || raw === "1"
  }

  /**
   * Inject documentation prohibition into system prompt
   * This applies to all request entry points.
   */
  private injectDocProhibition(dto: CreateMessageDto): CreateMessageDto {
    const docProhibition =
      "\n\n[CRITICAL SYSTEM RULE] You are ABSOLUTELY FORBIDDEN from " +
      "creating any documentation files (*.md, *.txt, README, CHANGELOG, etc.) unless the user " +
      "EXPLICITLY requests it. Do NOT create documentation proactively. Ask for permission first."

    // Handle system prompt - can be string or array of content blocks
    let systemText: string
    if (typeof dto.system === "string") {
      systemText = dto.system
    } else if (Array.isArray(dto.system)) {
      systemText = dto.system
        .filter(
          (block): block is { type: string; text: string } =>
            typeof block === "object" && block !== null && block.type === "text"
        )
        .map((block) => block.text)
        .join("\n")
    } else {
      systemText = ""
    }

    const newSystem = systemText + docProhibition

    return {
      ...dto,
      system: newSystem,
    }
  }

  private summarizeBackendError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return message.length > 200 ? `${message.slice(0, 200)}…` : message
  }

  private async executeRoutedMessage(
    dto: CreateMessageDto,
    route: ModelRouteResult,
    forwardHeaders?: Record<string, string>,
    attemptedBackends: Set<string> = new Set()
  ): Promise<AnthropicResponse> {
    attemptedBackends.add(route.backend)

    try {
      if (
        route.backend === "codex" &&
        !this.codexService.supportsModel(route.model)
      ) {
        throw new BackendApiError(
          `Model ${route.model} is not supported by the configured Codex account(s).`,
          {
            backend: "codex",
            statusCode: 400,
            permanent: true,
          }
        )
      }

      const routedDto = this.prepareDtoForRoute(dto, route)

      if (route.backend === "claude-api") {
        this.logger.log(`[ROUTE] Claude API backend | model: ${route.model}`)
        return await this.claudeApiService.sendClaudeMessage(
          routedDto,
          forwardHeaders
        )
      }

      if (route.backend === "openai-compat") {
        this.logger.log(`[ROUTE] OpenAI-compat backend | model: ${route.model}`)
        return await this.openaiCompatService.sendClaudeMessage(routedDto)
      }

      if (route.backend === "codex") {
        this.logger.log(`[ROUTE] Codex backend | model: ${route.model}`)
        return await this.codexService.sendClaudeMessage(routedDto)
      }

      this.logger.log(`[ROUTE] Google backend | model: ${route.model}`)
      return await this.googleService.sendClaudeMessage(routedDto)
    } catch (error) {
      const fallback = this.modelRouter.getFallbackRoute(
        dto.model,
        route.backend
      )
      const canFallback =
        !!fallback &&
        !attemptedBackends.has(fallback.backend) &&
        this.modelRouter.shouldFallbackFromBackend(
          error,
          route.backend,
          fallback.backend
        )

      if (canFallback && fallback) {
        this.logger.warn(
          `[ROUTE] ${route.backend} failed for ${dto.model}: ${this.summarizeBackendError(
            error
          )}; falling back to ${fallback.backend}`
        )
        return this.executeRoutedMessage(
          dto,
          fallback,
          forwardHeaders,
          attemptedBackends
        )
      }

      throw error
    }
  }

  private async *executeRoutedMessageStream(
    dto: CreateMessageDto,
    route: ModelRouteResult,
    forwardHeaders?: Record<string, string>,
    attemptedBackends: Set<string> = new Set()
  ): AsyncGenerator<string, void, unknown> {
    attemptedBackends.add(route.backend)
    let emittedAny = false
    let buffer: string[] = []

    const handleEvent = function* (event: string) {
      if (!emittedAny) {
        if (
          event.includes('"type":"message_start"') ||
          event.includes('"type":"ping"') ||
          event.includes('"type":"content_block_start"') ||
          event.includes('"type":"content_block_stop"')
        ) {
          buffer.push(event)
        } else {
          emittedAny = true
          for (const b of buffer) yield b
          buffer = []
          yield event
        }
      } else {
        yield event
      }
    }

    try {
      if (
        route.backend === "codex" &&
        !this.codexService.supportsModel(route.model)
      ) {
        throw new BackendApiError(
          `Model ${route.model} is not supported by the configured Codex account(s).`,
          {
            backend: "codex",
            statusCode: 400,
            permanent: true,
          }
        )
      }

      const routedDto = this.prepareDtoForRoute(dto, route)

      if (route.backend === "claude-api") {
        this.logger.log(
          `[ROUTE] Claude API backend | model: ${route.model} | stream: true`
        )
        for await (const event of this.claudeApiService.sendClaudeMessageStream(
          routedDto,
          forwardHeaders
        )) {
          yield* handleEvent(event)
        }
        if (!emittedAny) {
          for (const b of buffer) yield b
        }
        return
      }

      if (route.backend === "openai-compat") {
        this.logger.log(
          `[ROUTE] OpenAI-compat backend | model: ${route.model} | stream: true`
        )
        for await (const event of this.openaiCompatService.sendClaudeMessageStream(
          routedDto
        )) {
          yield* handleEvent(event)
        }
        if (!emittedAny) {
          for (const b of buffer) yield b
        }
        return
      }

      if (route.backend === "codex") {
        this.logger.log(
          `[ROUTE] Codex backend | model: ${route.model} | stream: true`
        )
        for await (const event of this.codexService.sendClaudeMessageStream(
          routedDto
        )) {
          yield* handleEvent(event)
        }
        if (!emittedAny) {
          for (const b of buffer) yield b
        }
        return
      }

      this.logger.log(
        `[ROUTE] Google backend | model: ${route.model} | stream: true`
      )
      for await (const event of this.googleService.sendClaudeMessageStream(
        routedDto
      )) {
        yield* handleEvent(event)
      }
      if (!emittedAny) {
        for (const b of buffer) yield b
      }
    } catch (error) {
      const fallback = this.modelRouter.getFallbackRoute(
        dto.model,
        route.backend
      )
      const canFallback =
        !emittedAny &&
        !!fallback &&
        !attemptedBackends.has(fallback.backend) &&
        this.modelRouter.shouldFallbackFromBackend(
          error,
          route.backend,
          fallback.backend
        )

      if (canFallback && fallback) {
        this.logger.warn(
          `[ROUTE] ${route.backend} stream failed for ${dto.model}: ${this.summarizeBackendError(
            error
          )}; falling back to ${fallback.backend}`
        )
        yield* this.executeRoutedMessageStream(
          dto,
          fallback,
          forwardHeaders,
          attemptedBackends
        )
        return
      }

      throw error
    }
  }

  async createMessage(
    dto: CreateMessageDto,
    forwardHeaders?: Record<string, string>
  ): Promise<AnthropicResponse> {
    this.logger.log(
      `Request for model: ${dto.model}, stream: ${dto.stream || false}`
    )

    if (this.shouldEnforceDocProhibition()) {
      dto = this.injectDocProhibition(dto)
    }

    const route = this.modelRouter.resolveModel(dto.model)
    const directEntry = this.modelRouter.isDirectMode
      ? this.directApiConfig.findEntryByCustomModel(dto.model)
      : null
    const routedDto = this.prepareDtoForRoute(
      this.applyDirectOutputLimit(dto, directEntry),
      route
    )

    if (this.modelRouter.isDirectMode) {
      if (!directEntry) {
        throw new Error(
          `Direct mode: model ${dto.model} is not defined in apis.yaml.`
        )
      }

      if (route.backend === "claude-api") {
        return this.claudeApiService.sendDirectClaudeMessage(
          routedDto,
          {
            accountLabel: directEntry.name,
            apiKey: directEntry.customApiKey,
            baseUrl: directEntry.endpoint,
            model: directEntry.targetModelId,
          },
          forwardHeaders
        )
      }

      if (route.backend === "openai-compat" || route.backend === "codex") {
        return this.openaiCompatService.sendDirectClaudeMessage(routedDto, {
          accountLabel: directEntry.name,
          apiKey: directEntry.customApiKey,
          baseUrl: directEntry.endpoint,
          model: directEntry.targetModelId,
          preferResponsesApi:
            route.backend === "codex" || directEntry.useResponsesApi,
          maxContextTokens: directEntry.maxContextTokens,
        })
      }

      throw new Error(
        `Direct mode: unsupported backend "${route.backend}" for model ${dto.model}`
      )
    }

    return this.executeRoutedMessage(dto, route, forwardHeaders)
  }

  /**
   * Create streaming message response
   */
  async *createMessageStream(
    dto: CreateMessageDto,
    forwardHeaders?: Record<string, string>
  ): AsyncGenerator<string, void, unknown> {
    this.logger.log(`Streaming request for model: ${dto.model}`)

    if (this.shouldEnforceDocProhibition()) {
      dto = this.injectDocProhibition(dto)
    }

    const route = this.modelRouter.resolveModel(dto.model)
    const directEntry = this.modelRouter.isDirectMode
      ? this.directApiConfig.findEntryByCustomModel(dto.model)
      : null
    const routedDto = this.prepareDtoForRoute(
      this.applyDirectOutputLimit(dto, directEntry),
      route
    )

    if (this.modelRouter.isDirectMode) {
      if (!directEntry) {
        throw new Error(
          `Direct mode: model ${dto.model} is not defined in apis.yaml.`
        )
      }

      if (route.backend === "claude-api") {
        if (this.shouldAutoContinueDirectEntry(directEntry)) {
          yield* this.executeDirectAutoContinueStream(
            routedDto,
            directEntry,
            route,
            forwardHeaders
          )
          return
        }

        yield* this.claudeApiService.sendDirectClaudeMessageStream(
          routedDto,
          {
            accountLabel: directEntry.name,
            apiKey: directEntry.customApiKey,
            baseUrl: directEntry.endpoint,
            model: directEntry.targetModelId,
            maxOutputTokens: directEntry.maxOutputTokens,
            autoContinue: directEntry.autoContinue,
          },
          forwardHeaders
        )
        return
      }

      if (route.backend === "openai-compat" || route.backend === "codex") {
        if (this.shouldAutoContinueDirectEntry(directEntry)) {
          yield* this.executeDirectAutoContinueStream(
            routedDto,
            directEntry,
            route,
            forwardHeaders
          )
          return
        }

        yield* this.openaiCompatService.sendDirectClaudeMessageStream(
          routedDto,
          {
            accountLabel: directEntry.name,
            apiKey: directEntry.customApiKey,
            baseUrl: directEntry.endpoint,
            model: directEntry.targetModelId,
            preferResponsesApi:
              route.backend === "codex" || directEntry.useResponsesApi,
            maxContextTokens: directEntry.maxContextTokens,
            maxOutputTokens: directEntry.maxOutputTokens,
            autoContinue: directEntry.autoContinue,
          }
        )
        return
      }
    }

    yield* this.executeRoutedMessageStream(dto, route, forwardHeaders)
  }

  /**
   * Count tokens in a request.
   *
   * Strategy:
   * 1. Try upstream /v1/messages/count_tokens for exact results.
   * 2. Fall back to local estimation if upstream is unavailable or fails.
   *
   * Reference: https://docs.anthropic.com/en/api/messages-count-tokens
   */
  async countTokens(dto: CountTokensDto): Promise<{ input_tokens: number }> {
    this.logger.log(`Count tokens request for model: ${dto.model}`)

    if (this.modelRouter.isDirectMode) {
      return { input_tokens: this.countTokensLocal(dto) }
    }

    // ── Upstream first ──
    try {
      const upstreamResult = await this.claudeApiService.countTokensUpstream(
        dto as unknown as Record<string, unknown>
      )
      if (upstreamResult) {
        this.logger.debug(
          `Count tokens (upstream): ${upstreamResult.input_tokens}`
        )
        return upstreamResult
      }
    } catch (error) {
      this.logger.debug(
        `Count tokens upstream failed, falling back to local estimation: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

    // ── Local fallback ──
    const localTokens = this.countTokensLocal(dto)
    this.logger.debug(`Count tokens (local estimate): ${localTokens}`)
    return { input_tokens: localTokens }
  }

  /**
   * Local token count estimation.
   * Less accurate than the upstream API but zero-latency and always available.
   */
  private countTokensLocal(dto: CountTokensDto): number {
    let totalTokens = 0

    // Count system prompt tokens
    if (dto.system) {
      if (typeof dto.system === "string") {
        totalTokens += this.tokenizer.countTokens(dto.system)
      } else if (Array.isArray(dto.system)) {
        for (const block of dto.system) {
          if (block.type === "text" && block.text) {
            totalTokens += this.tokenizer.countTokens(block.text)
          }
        }
      }
    }

    // Count message tokens
    for (const message of dto.messages) {
      // Base tokens per message (role, separators)
      totalTokens += 4

      // Role token
      totalTokens += this.tokenizer.countTokens(message.role, false)

      // Content tokens
      if (message.content) {
        if (typeof message.content === "string") {
          totalTokens += this.tokenizer.countTokens(message.content)
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === "text" && block.text) {
              totalTokens += this.tokenizer.countTokens(block.text)
            } else if (block.type === "tool_use" && block.input) {
              // Tool use blocks: count the JSON input
              totalTokens += this.tokenizer.countTokens(
                JSON.stringify(block.input)
              )
              totalTokens += 10 // overhead for tool_use structure
            } else if (block.type === "tool_result") {
              // Tool result blocks
              if (block.text) {
                totalTokens += this.tokenizer.countTokens(block.text)
              }
              totalTokens += 5 // overhead for tool_result structure
            }
          }
        }
      }
    }

    // Count tool definition tokens
    if (dto.tools && dto.tools.length > 0) {
      for (const tool of dto.tools) {
        if (tool.name) {
          totalTokens += this.tokenizer.countTokens(tool.name, false)
        }
        if (tool.description) {
          totalTokens += this.tokenizer.countTokens(tool.description, false)
        }
        if (tool.input_schema) {
          totalTokens += this.tokenizer.countTokens(
            JSON.stringify(tool.input_schema),
            false
          )
        }
        // Overhead per tool
        totalTokens += 10
      }
    }

    // Add message separator tokens
    totalTokens += 3

    return totalTokens
  }

  listModels() {
    const now = Math.floor(Date.now() / 1000)

    if (this.modelRouter.isDirectMode) {
      const data = this.directApiConfig.getActiveEntries().map((entry) => ({
        id: entry.customModelId,
        object: "model",
        created_at: now,
        owned_by: entry.format === "anthropic" ? "anthropic" : "openai",
        type: "model",
        display_name: entry.customModelId,
      }))

      return {
        data,
        has_more: false,
        first_id: data[0]?.id || "",
        last_id: data[data.length - 1]?.id || "",
      }
    }
    const canRouteViaGoogle = (modelId: string): boolean => {
      if (!this.modelRouter.isGoogleAvailable) {
        return false
      }

      const resolved = resolveCloudCodeModel(modelId)
      if (!resolved) {
        return false
      }

      return (
        (resolved.family !== "claude" ||
          canPublicClaudeModelUseGoogle(modelId)) &&
        this.googleModelCache.isValidModel(resolved.cloudCodeId)
      )
    }
    const isModelAdvertisable = (modelId: string): boolean => {
      const resolved = resolveCloudCodeModel(modelId)
      if (!resolved) {
        return false
      }

      if (resolved.family === "gpt") {
        if (this.openaiCompatService.isAvailable()) {
          return true
        }

        return this.codexService.supportsModel(modelId)
      }

      if (resolved.family === "gemini") {
        return canRouteViaGoogle(modelId)
      }

      return (
        this.claudeApiService.supportsModel(modelId) ||
        canRouteViaGoogle(modelId)
      )
    }
    const modelMap = new Map<
      string,
      {
        id: string
        object: string
        created_at: number
        owned_by: string
        type: string
        display_name?: string
      }
    >()

    const addModel = (id: string, owner?: string) => {
      if (modelMap.has(id)) return
      const metadata = getPublicModelMetadata(id)
      const resolved = resolveCloudCodeModel(id)
      const derivedOwner =
        owner ||
        metadata?.ownedBy ||
        (resolved?.family === "gpt"
          ? "openai"
          : resolved?.family === "claude"
            ? "anthropic"
            : "google")
      modelMap.set(id, {
        id,
        object: "model",
        created_at: metadata?.createdAt || now,
        owned_by: derivedOwner,
        type: "model",
        display_name: metadata?.displayName || resolved?.displayName,
      })
    }

    // 1) Dynamic models discovered from Google backend
    for (const modelId of this.googleModelCache.getAllModelIds()) {
      addModel(modelId)
    }

    // 2) Compatibility aliases we intentionally keep for existing clients
    for (const model of this.claudeApiService.getPublicModels()) {
      if (modelMap.has(model.id)) {
        continue
      }

      modelMap.set(model.id, {
        id: model.id,
        object: "model",
        created_at: model.createdAt || now,
        owned_by: "anthropic",
        type: "model",
        display_name: model.displayName,
      })
    }

    const compatibilityModels = [
      "gemini-2.5-flash",
      "gemini-3-flash",
      "gemini-3.1-pro-high",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
      "claude-3-7-sonnet-20250219",
      "claude-opus-4-6-thinking",
      "claude-4.6-opus",
      "claude-4.6-opus-thinking",
      "claude-sonnet-4-5",
      "claude-sonnet-4-5-thinking",
      "claude-4.5-opus-high-thinking",
    ]
    for (const modelId of compatibilityModels) {
      if (isModelAdvertisable(modelId)) {
        addModel(modelId)
      }
    }

    // 3) Codex models (if backend is available)
    if (this.isGptBackendAvailable()) {
      const codexModels = getCodexPublicModelIds({
        codexModelTier: this.getAdvertisedGptModelTier(),
      })
      for (const modelId of codexModels) {
        if (isModelAdvertisable(modelId)) {
          addModel(modelId, "openai")
        }
      }
    }

    const data = Array.from(modelMap.values()).sort((left, right) => {
      if (left.created_at !== right.created_at) {
        return right.created_at - left.created_at
      }
      return left.id.localeCompare(right.id)
    })

    return {
      data,
      has_more: false,
      first_id: data[0]?.id || "",
      last_id: data[data.length - 1]?.id || "",
    }
  }
}
