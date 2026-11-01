import type { AssistantMessage, Message, SessionNextContextPrepared } from "@opencode-ai/sdk/v2"

export interface ContextUsage {
  /** Tokens the context carries. */
  readonly tokens: number
  /** Percentage of the context window, when one is known. */
  readonly percent: number | undefined
  /** Tokens the runtime reclaimed from the canonical history for the last request. */
  readonly reclaimed: number
  /** Tokens the last request spends on the system prompt and tool definitions. */
  readonly overhead: number
  /** True when the runtime had to reduce, or could not reduce enough. */
  readonly urgent: boolean
  /** True when every reduction ran and the request is still over the reduction threshold. */
  readonly exhausted: boolean
}

/**
 * The one derivation of the context indicator, shared by every surface that renders it.
 *
 * The runtime's report is authoritative: it measures the request that was actually sent, prompt
 * envelope included, and it is the same figure reduction was decided from. Before the first provider
 * request of a session there is no report, and the fallback is the provider's own token accounting
 * for the last assistant turn — a different quantity, used only so the indicator is not empty, never
 * mixed into the report's numbers.
 */
export function contextUsage(input: {
  readonly report: SessionNextContextPrepared["data"] | undefined
  readonly messages: ReadonlyArray<Message>
  readonly contextLimit: (providerID: string, modelID: string) => number | undefined
}): ContextUsage | undefined {
  if (input.report)
    return {
      tokens: input.report.tokens,
      percent: input.report.limit === undefined ? undefined : Math.round(input.report.utilization * 100),
      reclaimed: input.report.reclaimedTokens,
      overhead: input.report.overheadTokens,
      urgent: input.report.outcome !== "untouched",
      exhausted: input.report.outcome === "exhausted",
    }
  // Input, reasoning and cache usage are measured even when output is zero. Do not treat an
  // all-zero placeholder as a measured empty context.
  const last = input.messages.findLast(
    (item): item is AssistantMessage =>
      item.role === "assistant" &&
      [
        item.tokens.input,
        item.tokens.output,
        item.tokens.reasoning,
        item.tokens.cache.read,
        item.tokens.cache.write,
      ].some((tokens) => tokens > 0),
  )
  if (!last) return undefined
  const tokens =
    last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
  const limit = input.contextLimit(last.providerID, last.modelID)
  return {
    tokens,
    percent: limit ? Math.round((tokens / limit) * 100) : undefined,
    reclaimed: 0,
    overhead: 0,
    urgent: false,
    exhausted: false,
  }
}
