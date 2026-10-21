import type { LLMEvent } from "@opencode-ai/llm"
import { Clock, Duration, Effect, Stream } from "effect"
import { ProviderError } from "@/provider/error"

export const INACTIVITY_TIMEOUT = "1 minute"

type Options = {
  readonly timeout?: Duration.Input
  readonly summarized?: boolean
}

export function guard<E, R>(self: Stream.Stream<LLMEvent, E, R>, options: Options = {}) {
  if (options.summarized) return self

  const timeout = Duration.fromInputUnsafe(options.timeout ?? INACTIVITY_TIMEOUT)
  const timeoutMillis = Duration.toMillis(timeout)

  return Stream.transformPull(Stream.rechunk(self, 1), (pull) =>
    Effect.gen(function* () {
      // General inactivity deadline, armed from stream start: a provider that
      // holds the stream open with zero events, or stalls during text-only
      // generation, now trips the retry pipeline instead of leaving the
      // session busy until the user cancels (#408). Only visible token
      // deltas count as activity; control events never reset the deadline.
      let deadline = (yield* Clock.currentTimeMillis) + timeoutMillis

      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const events = yield* pull.pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(Math.max(0, deadline - now)),
            orElse: () =>
              Effect.fail(
                new ProviderError.ResponseStreamError(
                  `reasoning stream timed out after ${Duration.format(timeout)} without new tokens`,
                ),
              ),
          }),
        )
        const event = events[0]

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
