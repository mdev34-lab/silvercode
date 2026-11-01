export type GenerationStreamEvent = {
  readonly type: string
  readonly text?: string
  readonly usage?: {
    readonly outputTokens?: number
  }
}

export type GenerationMetrics = {
  ttft?: number
  tokensPerSecond?: number
}

// TTFT is the time to the first generated token of any kind: reasoning, text or
// streamed tool arguments. The provider's output token count includes all of
// them, so the tok/s window has to open on the first of them too. Counting only
// from the first text token divides thinking tokens by a window that does not
// contain the thinking time.
export function isReceivedToken(event: GenerationStreamEvent) {
  const generated = event.type === "text-delta" || event.type === "reasoning-delta" || event.type === "tool-input-delta"
  return generated && typeof event.text === "string" && event.text.length > 0
}

function reportedOutputTokens(event: GenerationStreamEvent) {
  const tokens = event.usage?.outputTokens
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return undefined
  return tokens
}

export function computeGenerationMetrics(input: {
  requestedAt?: number
  firstOutputAt?: number
  generationMs: number
  outputTokens?: number
}): GenerationMetrics {
  const metrics: GenerationMetrics = {}
  if (
    input.requestedAt !== undefined &&
    input.firstOutputAt !== undefined &&
    Number.isFinite(input.requestedAt) &&
    Number.isFinite(input.firstOutputAt) &&
    input.firstOutputAt >= input.requestedAt
  ) {
    metrics.ttft = input.firstOutputAt - input.requestedAt
  }
  if (
    input.outputTokens !== undefined &&
    Number.isFinite(input.outputTokens) &&
    input.outputTokens > 0 &&
    Number.isFinite(input.generationMs) &&
    input.generationMs > 0
  ) {
    metrics.tokensPerSecond = (input.outputTokens * 1000) / input.generationMs
  }
  return metrics
}

export function createGenerationClock() {
  let requestedAt: number | undefined
  let firstOutputAt: number | undefined
  let generatingSince: number | undefined
  let generationMs = 0
  let outputTokens: number | undefined
  let sawStepUsage = false

  const pause = (at: number) => {
    if (generatingSince === undefined) return
    // Pause at step-finish so tool execution between steps is not counted.
    generationMs += Math.max(0, at - generatingSince)
    generatingSince = undefined
  }

  return {
    startRequest(at: number) {
      requestedAt = at
      firstOutputAt = undefined
      generatingSince = undefined
      generationMs = 0
      outputTokens = undefined
      sawStepUsage = false
    },
    observe(event: GenerationStreamEvent, at: number) {
      if (isReceivedToken(event)) {
        if (firstOutputAt === undefined) firstOutputAt = at
        if (generatingSince === undefined) generatingSince = at
      }
      if (event.type === "step-finish") {
        const wasGenerating = generatingSince !== undefined
        pause(at)
        if (!wasGenerating) return
        const tokens = reportedOutputTokens(event)
        if (tokens !== undefined) {
          outputTokens = (outputTokens ?? 0) + tokens
          sawStepUsage = true
        }
        return
      }
      if (event.type !== "finish" || sawStepUsage) return
      const tokens = reportedOutputTokens(event)
      if (tokens !== undefined) outputTokens = tokens
    },
    finish(at: number) {
      pause(at)
      return computeGenerationMetrics({
        requestedAt,
        firstOutputAt,
        generationMs,
        outputTokens,
      })
    },
  }
}
