export const CURSOR_REASONING_PARAMETER_ID = "reasoning"
export const CURSOR_LEGACY_REASONING_PARAMETER_ID = "reasoning_effort"
export const CURSOR_FAST_PARAMETER_ID = "fast"
export const CURSOR_FAST_MODE_ENABLED = "true"
export const CURSOR_FAST_MODE_DISABLED = "false"

export interface ParsedCursorVariantSelection {
  baseModel: string
  parameterValues?: Record<string, string>
  maxMode?: boolean
}

const CURSOR_LEGACY_VARIANT_SUFFIXES = [
  "-high-thinking",
  "-xhigh-fast",
  "-high-fast",
  "-low-fast",
  "-thinking",
  "-text",
  "-fast",
  "-xhigh",
  "-high",
  "-low",
  "-medium",
] as const

function normalizeVariantToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
}

function normalizeVariantBoolean(value: string): boolean | undefined {
  switch (normalizeVariantToken(value)) {
    case "1":
    case "true":
    case "enabled":
    case "on":
    case "yes":
      return true
    case "0":
    case "false":
    case "disabled":
    case "off":
    case "no":
      return false
    default:
      return undefined
  }
}

function normalizeVariantReasoningEffort(value: string): string | undefined {
  switch (normalizeVariantToken(value)) {
    case "auto":
      return "auto"
    case "none":
    case "off":
    case "disabled":
      return "none"
    case "minimal":
    case "min":
      return "minimal"
    case "low":
      return "low"
    case "medium":
    case "med":
    case "normal":
    case "standard":
      return "medium"
    case "high":
      return "high"
    case "xhigh":
    case "extra_high":
    case "extra":
      return "xhigh"
    case "max":
      return "max"
    default:
      return undefined
  }
}

function normalizeVariantFastMode(value: string): string | undefined {
  const booleanValue = normalizeVariantBoolean(value)
  if (booleanValue !== undefined) {
    return booleanValue ? CURSOR_FAST_MODE_ENABLED : CURSOR_FAST_MODE_DISABLED
  }

  switch (normalizeVariantToken(value)) {
    case "priority":
    case "fast":
      return CURSOR_FAST_MODE_ENABLED
    case "standard":
    case "default":
      return CURSOR_FAST_MODE_DISABLED
    default:
      return undefined
  }
}

function toCursorReasoningValue(value: string): string {
  switch (value) {
    case "xhigh":
      return "extra-high"
    default:
      return value
  }
}

function parseBracketCursorVariantString(modelId: string): {
  baseModel: string
  parameterValues?: Record<string, string>
  maxMode?: boolean
} | null {
  const trimmedModelId = modelId.trim()
  let baseModel = ""
  let rawSuffix = ""

  const lastParenOpen = trimmedModelId.lastIndexOf("(")
  if (lastParenOpen > 0 && trimmedModelId.endsWith(")")) {
    baseModel = trimmedModelId.slice(0, lastParenOpen).trim()
    rawSuffix = trimmedModelId.slice(lastParenOpen + 1, -1).trim()
  } else {
    const lastBracketOpen = trimmedModelId.lastIndexOf("[")
    if (lastBracketOpen <= 0 || !trimmedModelId.endsWith("]")) {
      return null
    }
    baseModel = trimmedModelId.slice(0, lastBracketOpen).trim()
    rawSuffix = trimmedModelId.slice(lastBracketOpen + 1, -1).trim()
  }

  if (!baseModel || !rawSuffix) {
    return null
  }

  const parts = rawSuffix
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  if (parts.length === 0) {
    return null
  }

  const parameterValues: Record<string, string> = {}
  let maxMode: boolean | undefined

  for (const part of parts) {
    const separatorIndex = part.indexOf("=")
    if (separatorIndex <= 0) {
      const effort = normalizeVariantReasoningEffort(part)
      if (effort) {
        parameterValues[CURSOR_REASONING_PARAMETER_ID] =
          toCursorReasoningValue(effort)
      }
      continue
    }

    const key = normalizeVariantToken(part.slice(0, separatorIndex))
    const rawValue = part.slice(separatorIndex + 1).trim()
    if (!key || !rawValue) {
      continue
    }

    if (
      key === CURSOR_REASONING_PARAMETER_ID ||
      key === CURSOR_LEGACY_REASONING_PARAMETER_ID ||
      key === "reasoning_level" ||
      key === "effort" ||
      key === "thinking_effort"
    ) {
      const effort = normalizeVariantReasoningEffort(rawValue)
      if (effort) {
        parameterValues[CURSOR_REASONING_PARAMETER_ID] =
          toCursorReasoningValue(effort)
      }
      continue
    }

    if (
      key === CURSOR_FAST_PARAMETER_ID ||
      key === "service_tier" ||
      key === "tier" ||
      key === "fast_mode"
    ) {
      const fastMode = normalizeVariantFastMode(rawValue)
      if (fastMode) {
        parameterValues[CURSOR_FAST_PARAMETER_ID] = fastMode
      }
      continue
    }

    if (key === "max" || key === "max_mode") {
      const normalized = normalizeVariantBoolean(rawValue)
      if (normalized !== undefined) {
        maxMode = normalized
      }
    }
  }

  return {
    baseModel,
    parameterValues:
      Object.keys(parameterValues).length > 0 ? parameterValues : undefined,
    maxMode,
  }
}

function parseLegacyCursorVariantModelName(modelId: string): {
  baseModel: string
  parameterValues?: Record<string, string>
  maxMode?: boolean
} | null {
  const normalizedModelId = modelId.trim().toLowerCase()

  for (const suffix of CURSOR_LEGACY_VARIANT_SUFFIXES) {
    if (!normalizedModelId.endsWith(suffix)) {
      continue
    }

    const baseModel = modelId.slice(0, modelId.length - suffix.length).trim()
    if (!baseModel) {
      return null
    }

    const parameterValues: Record<string, string> = {}

    switch (suffix) {
      case "-medium":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "medium"
        break
      case "-low":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "low"
        break
      case "-high":
      case "-high-thinking":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "high"
        break
      case "-xhigh":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "extra-high"
        break
      case "-thinking":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "medium"
        break
      case "-xhigh-fast":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "extra-high"
        parameterValues[CURSOR_FAST_PARAMETER_ID] = CURSOR_FAST_MODE_ENABLED
        break
      case "-high-fast":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "high"
        parameterValues[CURSOR_FAST_PARAMETER_ID] = CURSOR_FAST_MODE_ENABLED
        break
      case "-low-fast":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "low"
        parameterValues[CURSOR_FAST_PARAMETER_ID] = CURSOR_FAST_MODE_ENABLED
        break
      case "-fast":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "medium"
        parameterValues[CURSOR_FAST_PARAMETER_ID] = CURSOR_FAST_MODE_ENABLED
        break
      case "-text":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "none"
        break
      default:
        break
    }

    if (
      !Object.prototype.hasOwnProperty.call(
        parameterValues,
        CURSOR_FAST_PARAMETER_ID
      )
    ) {
      parameterValues[CURSOR_FAST_PARAMETER_ID] = CURSOR_FAST_MODE_DISABLED
    }

    return {
      baseModel,
      parameterValues,
      maxMode: false,
    }
  }

  return null
}

export function parseCursorVariantString(modelId: string): {
  baseModel: string
  parameterValues?: Record<string, string>
  maxMode?: boolean
} | null {
  const trimmed = (modelId || "").trim()
  if (!trimmed) {
    return null
  }

  const bracketSelection = parseBracketCursorVariantString(trimmed)
  if (bracketSelection) {
    return bracketSelection
  }

  return parseLegacyCursorVariantModelName(trimmed)
}
