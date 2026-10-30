import type { LLMEvent } from "@opencode-ai/llm"
import { Clock, Duration, Effect, Stream } from "effect"
import { ProviderError } from "@/provider/error"

// Match the existing token inactivity budget: a minute allows slow providers
// to respond while bounding silent streams, including summarized reasoning.
export const INACTIVITY_TIMEOUT = "1 minute"

type Options = {
  readonly timeout?: Duration.Input
  readonly summarized?: boolean
  readonly executableTools?: ReadonlySet<string>
  /** Abort the underlying request before a pending pull's iterator is finalized. */
  readonly onInterrupt?: () => void
}

export function guard<E, R>(self: Stream.Stream<LLMEvent, E, R>, options: Options = {}) {
  const timeout = Duration.fromInputUnsafe(options.timeout ?? INACTIVITY_TIMEOUT)
  const timeoutMillis = Duration.toMillis(timeout)

  return Stream.transformPull(Stream.rechunk(self, 1), (pull) =>
    Effect.gen(function* () {
      // All streams have an event-inactivity deadline from the first pull.
      // Unsummarized streams also retain the stricter token deadline: control
      // events cannot keep an otherwise stalled reasoning trace alive.
      let deadline = (yield* Clock.currentTimeMillis) + timeoutMillis
      let eventDeadline = deadline
      const executing = new Set<string>()

      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        // Tool execution is owned by the application, not model generation.
        // Keep pulling settlements without charging tool runtime to token inactivity.
        // Async iterator cleanup can wait for an outstanding read. Abort the
        // request when that read is interrupted, before its scope is closed.
        const onInterrupt = options.onInterrupt
        const interruptiblePull = onInterrupt ? pull.pipe(Effect.onInterrupt(() => Effect.sync(onInterrupt))) : pull
        const events = yield* executing.size > 0
          ? interruptiblePull
          : interruptiblePull.pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(
                  Math.max(0, (options.summarized ? eventDeadline : Math.min(deadline, eventDeadline)) - now),
                ),
                orElse: () =>
                  Effect.fail(
                    new ProviderError.ResponseStreamError(
                      options.summarized
                        ? `response stream timed out after ${Duration.format(timeout)} without new events`
                        : `reasoning stream timed out after ${Duration.format(timeout)} without new tokens`,
                    ),
                  ),
              }),
            )
        const event = events[0]
        eventDeadline = (yield* Clock.currentTimeMillis) + timeoutMillis

        if (event.type === "tool-call" && !event.providerExecuted && options.executableTools?.has(event.name)) {
          executing.add(event.id)
        }
        if ((event.type === "tool-result" || event.type === "tool-error") && executing.delete(event.id)) {
          if (executing.size === 0) deadline = (yield* Clock.currentTimeMillis) + timeoutMillis
        }

        const streamedToken =
          (event.type === "reasoning-delta" || event.type === "text-delta" || event.type === "tool-input-delta") &&
          event.text.length > 0
        if (streamedToken) deadline = (yield* Clock.currentTimeMillis) + timeoutMillis

        return events
      })
    }),
  )
}

export function hasSummary(options: Record<string, unknown>, model?: { readonly api: { readonly id: string } }) {
  if (containsSummary(options, new Set())) return true
  if (!model || !isClaude46(model.api.id)) return false
  return containsAdaptiveThinking(options, new Set())
}

function isClaude46(id: string) {
  return /claude-(?:(?:opus|sonnet)-4[.-]6|4[.-]6-(?:opus|sonnet))(?:[^0-9]|$)/i.test(id)
}

function containsAdaptiveThinking(value: unknown, seen: Set<object>): boolean {
  if (typeof value !== "object" || value === null) return false
  if (seen.has(value)) return false
  seen.add(value)

  if (Array.isArray(value)) return value.some((item) => containsAdaptiveThinking(item, seen))

  return Object.entries(value).some(
    ([key, item]) => (key === "type" && item === "adaptive") || containsAdaptiveThinking(item, seen),
  )
}

function containsSummary(value: unknown, seen: Set<object>): boolean {
  if (typeof value !== "object" || value === null) return false
  if (seen.has(value)) return false
  seen.add(value)

  if (Array.isArray(value)) return value.some((item) => containsSummary(item, seen))

  return Object.entries(value).some(([key, item]) => {
    if (key === "display" && item === "summarized") return true
    if (key === "reasoningSummary" && item !== undefined && item !== null && item !== false && item !== "none") {
      return true
    }
    return containsSummary(item, seen)
  })
}

export * as ReasoningWatchdog from "./reasoning-watchdog"
