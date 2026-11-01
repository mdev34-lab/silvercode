import type { NamedError } from "@opencode-ai/core/util/error"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Clock, Data, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { GenerationLimit } from "./llm/generation-limit"
import { RepetitionGuard } from "./llm/repetition-guard"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"

export type Err = ReturnType<NamedError["toObject"]>

export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go"
export const GO_UPSELL_URL = "https://opencode.ai/go"
export type RetryReason = "free_tier_limit" | "account_rate_limit" | (string & {})

export type Retryable = {
  message: string
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_JITTER_FACTOR = 0.25
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_HEADLESS_MAX_DELAY = 60_000 // 60 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
export const RETRY_MAX_RETRIES = 5

const RETRYABLE_MESSAGE_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: SessionV1.APIError, random = Math.random()) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(exponential(attempt, random))
    }
  }

  return cap(Math.min(exponential(attempt, random), RETRY_MAX_DELAY_NO_HEADERS))
}

function exponential(attempt: number, random: number) {
  const base = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
  return Math.ceil(base + base * RETRY_JITTER_FACTOR * random)
}

export function retryable(error: Err, provider: string) {
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  // A tripped generation cap must never be retried: retrying would replay
  // the same runaway stream. The message carries the character counts, which
  // can contain digit sequences matching the retryable patterns below, so
  // this exclusion must stay above the pattern checks (see issue #89).
  if (isGenerationLimit(error)) return undefined
  // Same for a tripped repetition guard: the retry would deterministically
  // regenerate the same looping output (issue #94). The quoted line preview
  // can itself match a retryable pattern, so this also stays above them.
  if (isRepetitionDetected(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (
      !error.data.isRetryable &&
      !(status !== undefined && status >= 500) &&
      !matchesRetryableMessage(error.data.message) &&
      !matchesRetryableMessage(error.data.responseBody)
    )
      return undefined
    if (error.data.responseBody?.includes("FreeUsageLimitError")) {
      return {
        message: GO_UPSELL_MESSAGE,
        action: {
          reason: "free_tier_limit",
          provider,
          title: "Free limit reached",
          message: "Subscribe to opencode Go for reliable access to the best open-source models, starting at $5/month.",
          label: "subscribe",
          link: GO_UPSELL_URL,
        },
      }
    }
    if (error.data.responseBody?.includes("GoUsageLimitError")) {
      const body = parseJSON(error.data.responseBody)
      const workspace = str(body?.metadata?.workspace)
      const limitName = str(body?.metadata?.limitName)
      const retryAfter = num(error.data.responseHeaders?.["retry-after"])
      const resetIn = iife(() => {
        if (retryAfter === undefined) return ""
        const seconds = Math.max(0, Math.ceil(retryAfter))
        const days = Math.floor(seconds / 86_400)
        const hours = Math.floor((seconds % 86_400) / 3_600)
        const minutes = Math.ceil((seconds % 3_600) / 60)
        const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`

        if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")
        if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")
        return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
      })

      const message = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`

      const link = `https://opencode.ai/workspace/${workspace}/go`
      return {
        message: `${message} - ${link}`,
        action: {
          reason: "account_rate_limit",
          provider,
          title: "Go limit reached",
          message,
          label: "open settings",
          link,
        },
      }
    }
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  const message = isRecord(error.data) ? error.data.message : undefined
  if (typeof message !== "string") return undefined
  const lower = message.toLowerCase()
  if (lower.includes("too_many_requests")) return { message: "Too Many Requests" }
  if (lower.includes("exhausted") || lower.includes("unavailable")) return { message: "Provider is overloaded" }
  if (matchesRetryableMessage(message)) return { message }
  return undefined
}

function matchesRetryableMessage(value: unknown) {
  return typeof value === "string" && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
}

function isGenerationLimit(error: Err) {
  const message = isRecord(error.data) ? error.data.message : undefined
  return typeof message === "string" && message.includes(GenerationLimit.GENERATION_LIMIT_MESSAGE)
}

function isRepetitionDetected(error: Err) {
  const message = isRecord(error.data) ? error.data.message : undefined
  return typeof message === "string" && message.includes(RepetitionGuard.REPETITION_MESSAGE)
}

function str(value: unknown) {
  if (value === undefined || value === null) return ""
  return String(value)
}

function num(value: unknown) {
  const parsed = Number.parseFloat(str(value))
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

/**
 * Sentinel error used to terminate the retry schedule when the caller's
 * invalidation check signals that the retry context has been superseded
 * (e.g. the user switched to a different model mid-backoff). The processor
 * catches this error and returns "continue" so the outer runLoop picks up
 * the new model selection on the next turn.
 */
export class RetryInvalidated extends Data.TaggedError("RetryInvalidated")<{}> {}

export function isRetryInvalidated(error: unknown): error is RetryInvalidated {
  return error instanceof RetryInvalidated
}

/**
 * Polling interval (ms) used when splitting the retry backoff sleep into
 * interruptible chunks. A model switch will be observed within this
 * many milliseconds of occurring, rather than only after the full
 * exponential-backoff delay completes.
 */
export const RETRY_INVALIDATE_POLL_MS = 200

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  /**
   * Optional upper bound (ms) on a single retry wait. When a provider asks for
   * a longer backoff (e.g. multi-hour quota window resets in headless `run`),
   * the schedule stops immediately so the original provider error surfaces
   * instead of hanging the caller.
   */
  maxDelay?: number
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
  /**
   * Optional check run before and periodically during each retry delay.
   * If the returned Effect resolves to `true`, the retry schedule
   * terminates immediately via a `RetryInvalidated` error so the caller
   * can detect that the pending retry was superseded (e.g. the session
   * model changed mid-backoff).
   *
   * When provided, the delay is split into `RETRY_INVALIDATE_POLL_MS`
   * chunks so a model switch during a long backoff is observed promptly,
   * not only after the full delay elapses.
   */
  invalidate?: () => Effect.Effect<boolean>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const retry = retryable(error, opts.provider)
      if (!retry) return Cause.done(meta.attempt)
      if (meta.attempt > RETRY_MAX_RETRIES) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        // If a caller-supplied invalidation check signals that the retry
        // context has been superseded (e.g. the user switched models),
        // fail with RetryInvalidated so the processor can distinguish
        // this from a normal retry exhaustion.
        if (opts.invalidate) {
          const stale = yield* opts.invalidate()
          if (stale) return yield* Effect.fail(new RetryInvalidated())
        }
        const wait = delay(meta.attempt, SessionV1.APIError.isInstance(error) ? error : undefined)
        if (opts.maxDelay !== undefined && wait > opts.maxDelay) return yield* Cause.done(meta.attempt)
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: retry.message,
          action: retry.action,
          next: now + wait,
        })
        if (opts.invalidate) {
          // Sleep in small chunks so a model switch during a long
          // backoff is observed promptly, not only after the full
          // delay elapses. If invalidation fires mid-sleep, fail
          // immediately with RetryInvalidated.
          //
          // The check runs after EVERY chunk, including the final one,
          // so the invariant holds: a retry can only proceed after a
          // successful post-delay invalidation check.
          let remaining = wait
          while (remaining > 0) {
            const chunk = Math.min(RETRY_INVALIDATE_POLL_MS, remaining)
            yield* Effect.sleep(Duration.millis(chunk))
            remaining -= chunk
            const stale = yield* opts.invalidate()
            if (stale) return yield* Effect.fail(new RetryInvalidated())
          }
          // We handled the delay ourselves; tell Effect.retry to
          // retry immediately rather than adding its own sleep.
          return [meta.attempt, Duration.zero] as [number, Duration.Duration]
        }
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
