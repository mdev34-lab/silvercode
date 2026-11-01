/**
 * Typed errors for the Qwen Web provider.
 *
 * The transport/session layers throw these; the AI SDK boundary (`sdk.ts`)
 * converts them into `APICallError` so SilverCode's existing error handling,
 * retry classification and TUI rendering keep working unchanged.
 */

export type QwenWebErrorCode =
  | "login_required"
  | "session_expired"
  | "rate_limited"
  | "upstream_error"
  | "upstream_unavailable"
  | "network_error"
  | "challenge"
  | "browser_error"
  | "timeout"
  | "aborted"
  | "invalid_response"
  | "unsupported"

/** Safe operation boundary carried into the SDK's API error response. */
export type QwenWebErrorPhase = "chat-create" | "setup" | "stream" | "stop" | "auth"

const MAX_ERROR_DETAIL_CHARS = 240
const MAX_ERROR_MESSAGE_CHARS = 600
const AUTHORIZATION_FIELD_PATTERN =
  /(["']?(?:authorization|proxy-authorization)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:bearer|basic)\s+[^\s,;}\]]+|[^\s,;}\]]+)/gi
const SENSITIVE_FIELD_PATTERN =
  /(["']?(?:cookie|set-cookie|bx[-_]?(?:ua|umidtoken|v)|x-[\w-]*(?:auth|token|key)|(?:access|refresh|id)[_-]?token|token|password|passwd|secret|credential|api[_-]?key|session[_-]?(?:id|token)|sid|prompt|messages|request[_-]?(?:body|payload))["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi
const SENSITIVE_HEADER_PATTERN =
  /(^|[\r\n])(\s*(?:cookie|set-cookie|authorization|proxy-authorization|bx[-_]?(?:ua|umidtoken|v)|x-[\w-]*(?:auth|token|key))\s*:\s*)[^\r\n]*/gim
const PROMPT_LABEL_PATTERN = /(\b(?:full\s+)?prompt\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n}]+)/gi
const BEARER_PATTERN = /(\bbearer\s+)[A-Za-z0-9._~+/-]+=*/gi
const SENSITIVE_QUERY_PATTERN =
  /([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|session(?:[_-]?(?:id|token))?|sid|api[_-]?key|token|secret|password)=)[^&#\s]*/gi
const URL_CREDENTIAL_PATTERN = /(https?:\/\/)[^/\s@]+@/gi
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g

/**
 * Keep diagnostics useful while ensuring upstream error text cannot copy
 * session credentials, WAF signals, or prompt/request payload fields into a
 * user-visible error or debug field. The returned text is always bounded.
 */
export function sanitizeQwenErrorText(
  input: string | undefined,
  maxChars = MAX_ERROR_DETAIL_CHARS,
  redactValues: readonly string[] = [],
): string | undefined {
  if (!input) return undefined
  const sanitized = redactValues
    .filter((value) => value.trim().length >= 8)
    .sort((left, right) => right.length - left.length)
    .reduce((text, value) => text.replaceAll(value, "[redacted]"), input)
    .replace(SENSITIVE_HEADER_PATTERN, "$1$2[redacted]")
    .replace(AUTHORIZATION_FIELD_PATTERN, "$1[redacted]")
    .replace(SENSITIVE_FIELD_PATTERN, "$1[redacted]")
    .replace(PROMPT_LABEL_PATTERN, "$1[redacted]")
    .replace(BEARER_PATTERN, "$1[redacted]")
    .replace(SENSITIVE_QUERY_PATTERN, "$1[redacted]")
    .replace(URL_CREDENTIAL_PATTERN, "$1[redacted]@")
    .replace(CONTROL_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!sanitized) return undefined
  const limit = Math.max(0, maxChars)
  if (sanitized.length <= limit) return sanitized
  return `${sanitized.slice(0, Math.max(0, limit - 1))}…`
}

export function isQwenWebErrorPhase(input: unknown): input is QwenWebErrorPhase {
  return input === "chat-create" || input === "setup" || input === "stream" || input === "stop" || input === "auth"
}

function safeUpstreamCode(input?: string): string | undefined {
  const code = sanitizeQwenErrorText(input, 80)
  if (!code || code.includes("[redacted]") || !/^[A-Za-z0-9_.:-]+$/.test(code)) return undefined
  if (/^[A-Za-z0-9_-]{40,}$/.test(code)) return undefined
  return code
}

function isAuthCode(code: QwenWebErrorCode): boolean {
  return code === "login_required" || code === "session_expired" || code === "challenge"
}

export class QwenWebError extends Error {
  override name = "QwenWebError"
  readonly code: QwenWebErrorCode
  readonly retryable: boolean
  /** Operation boundary where this failure occurred. */
  phase?: QwenWebErrorPhase
  /** Safe, bounded diagnostic detail from the upstream response, if available. */
  readonly detail?: string
  /** Upstream error code, when one was reported. */
  readonly upstreamCode?: string
  /** HTTP status, when the failure came from an HTTP response. */
  readonly status?: number
  /** Suggested wait before retrying, when the upstream provided one. */
  readonly retryAfterMs?: number

  constructor(input: {
    code: QwenWebErrorCode
    message: string
    retryable?: boolean
    phase?: QwenWebErrorPhase
    detail?: string
    upstreamCode?: string
    status?: number
    retryAfterMs?: number
    cause?: unknown
  }) {
    super(
      sanitizeQwenErrorText(input.message, MAX_ERROR_MESSAGE_CHARS) ?? "Qwen Web request failed.",
      input.cause !== undefined ? { cause: input.cause } : undefined,
    )
    this.code = input.code
    this.retryable = input.retryable ?? false
    this.phase = isQwenWebErrorPhase(input.phase) ? input.phase : isAuthCode(input.code) ? "auth" : undefined
    this.detail = sanitizeQwenErrorText(input.detail)
    this.upstreamCode = safeUpstreamCode(input.upstreamCode)
    this.status = input.status
    this.retryAfterMs = input.retryAfterMs
  }

  static isInstance(input: unknown): input is QwenWebError {
    return input instanceof QwenWebError
  }
}

/** Add an operation phase without replacing a more specific phase already assigned. */
export function withQwenWebErrorPhase(input: unknown, phase: QwenWebErrorPhase): QwenWebError {
  const error = QwenWebError.isInstance(input) ? input : classifyTransportFailure(input, phase)
  if (error.phase) return error
  error.phase = isAuthCode(error.code) ? "auth" : phase
  return error
}

export function loginRequiredError(detail?: string): QwenWebError {
  return new QwenWebError({
    code: "login_required",
    phase: "auth",
    retryable: false,
    status: 401,
    detail,
    message:
      "Qwen Web login required. Run `/connect`, choose `qwen-web`, and complete the login in the browser window. " +
      (detail ?? "No authenticated Qwen session was found."),
  })
}

export function sessionExpiredError(
  detail?: string,
  status = 401,
  options?: { upstreamCode?: string },
): QwenWebError {
  return new QwenWebError({
    code: "session_expired",
    phase: "auth",
    retryable: false,
    status,
    upstreamCode: options?.upstreamCode,
    detail,
    message:
      "Qwen Web session expired. Run `/connect`, choose `qwen-web`, and log in again. " +
      (detail ?? "The stored browser session is no longer valid."),
  })
}

/** Detail when a visible challenge window was opened for the user. */
export const CHALLENGE_WINDOW_OPEN_DETAIL =
  "A visible browser window has been opened — solve the challenge there, then retry."
/** Detail when no visible window can open (explicit headless, no display). */
export const CHALLENGE_NO_WINDOW_DETAIL =
  "No browser window could be opened (headless mode with no display, or QWEN_WEB_HEADLESS is set). " +
  "Open chat.qwen.ai in your own browser to check for verification prompts, then retry."

export function challengeError(
  detail?: string,
  status = 403,
  options?: { upstreamCode?: string },
): QwenWebError {
  return new QwenWebError({
    code: "challenge",
    phase: "auth",
    retryable: false,
    status,
    upstreamCode: options?.upstreamCode,
    detail,
    message:
      "Qwen is showing a human-verification challenge, which paused this run. " +
      "SilverCode never solves challenges automatically. " +
      (detail ?? CHALLENGE_NO_WINDOW_DETAIL),
  })
}

export function abortedError(phase?: QwenWebErrorPhase): QwenWebError {
  const error = new QwenWebError({
    code: "aborted",
    phase,
    message: "Qwen Web request was aborted",
    retryable: false,
    status: 499,
  })
  error.name = "AbortError"
  return error
}

export function isAbortLike(input: unknown): boolean {
  if (input instanceof DOMException) return input.name === "AbortError"
  if (QwenWebError.isInstance(input)) return input.code === "aborted"
  if (!input || typeof input !== "object") return false
  const maybe = input as { name?: unknown; code?: unknown; message?: unknown }
  if (maybe.name === "AbortError" || maybe.code === "ABORT_ERR") return true
  // Only the DOMException's own "operation was aborted" text counts. A loose
  // substring match would also swallow Playwright navigation aborts
  // (`net::ERR_ABORTED`, "aborted by user"), which are browser/navigation
  // failures and must classify as retryable, not as a request abort.
  return typeof maybe.message === "string" && /operation was aborted/i.test(maybe.message)
}

/** Classify a mid-stream `data: {"error": ...}` payload. */
export function classifyStreamError(code: string, message: string, status?: number): QwenWebError {
  const normalized = `${code} ${message}`.slice(0, 300)
  const safeCode = safeUpstreamCode(code)
  const detail = sanitizeQwenErrorText(message)
  // Code first: a chat-specific upstream code outranks message heuristics.
  if (isStaleChatCode(code)) return staleChatError({ status, upstreamCode: code, detail, phase: "stream" })
  if (isStaleAnchorCode(code)) return staleAnchorError({ status, upstreamCode: code, detail, phase: "stream" })
  if (isQuotaMessage(normalized)) {
    return new QwenWebError({
      code: "rate_limited",
      phase: "stream",
      retryable: true,
      status,
      upstreamCode: code,
      detail,
      message: `Qwen usage limit reached mid-stream${detail ? `: ${detail}` : "."} Wait a little and retry, or switch to a smaller task.`,
    })
  }
  if (code === "waf_challenge" || isChallengeMessage(normalized)) {
    return new QwenWebError({
      code: "challenge",
      phase: "auth",
      retryable: false,
      status,
      upstreamCode: code,
      detail,
      message:
        "Qwen interrupted the stream with a human-verification challenge. Complete it in the Qwen browser profile, then retry.",
    })
  }
  if (isChatMissingMessage(normalized)) return staleChatError({ status, upstreamCode: code, detail, phase: "stream" })
  if (isStaleAnchorMessage(normalized)) return staleAnchorError({ status, upstreamCode: code, detail, phase: "stream" })
  return new QwenWebError({
    code: "upstream_error",
    phase: "stream",
    retryable: true,
    status,
    upstreamCode: code,
    detail,
    message: `Qwen stream error${detail ? `: ${detail}` : safeCode ? ` (${safeCode})` : ": unknown"}`,
  })
}

/** A stream that went quiet without a terminating event (`QwenWebError` code `"timeout"`). */
export function isStallTimeout(input: unknown): boolean {
  return QwenWebError.isInstance(input) && input.code === "timeout"
}

const QUOTA_PATTERNS = [
  "allocated quota exceeded",
  "quota exceeded",
  "increase your quota",
  "token-limit",
  "insufficient quota",
  "insufficient_quota",
  "rate limit",
  "ratelimited",
  "rate_limited",
  "too many requests",
  "overloaded",
]

export function isQuotaMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return QUOTA_PATTERNS.some((pattern) => normalized.includes(pattern))
}

/** Canonical `upstreamCode` stamped on a "chat is still generating" rejection. */
export const CHAT_IN_PROGRESS_UPSTREAM_CODE = "chat_in_progress"

/** True when an error reports that the upstream chat is still generating. */
export function isChatInProgressError(input: unknown): boolean {
  return QwenWebError.isInstance(input) && input.upstreamCode === CHAT_IN_PROGRESS_UPSTREAM_CODE
}

/**
 * Terminal state once the bounded wait for an in-progress chat ran out. Not
 * retryable: an outer retry would resubmit the same request while the earlier
 * generation may still be running.
 */
export function chatInProgressExhaustedError(input: { status?: number; attempts: number }): QwenWebError {
  return new QwenWebError({
    code: "upstream_error",
    phase: "setup",
    retryable: false,
    status: input.status,
    upstreamCode: CHAT_IN_PROGRESS_UPSTREAM_CODE,
    detail: "The upstream chat stayed busy after bounded waits.",
    message: `Qwen is still generating a previous response in this chat. The request was re-sent ${input.attempts} time(s) and rejected each time; it was not accepted upstream. Wait for the generation to finish (or stop it in the Qwen web UI), then send the message again.`,
  })
}

/**
 * Canonical `upstreamCode` stamped on every stale/missing-chat error: the
 * upstream *chat* is gone, so the only recovery is a fresh chat.
 */
export const STALE_CHAT_UPSTREAM_CODE = "chat_not_exist"

/**
 * Canonical `upstreamCode` stamped on a stale *anchor* error: the chat is
 * still alive but the `parent_id` / response we tried to chain onto is not.
 * Recovery drops the anchor and re-anchors the same chat; it must not throw
 * away a live chat and its history for what may be a single bad response id.
 */
export const STALE_ANCHOR_UPSTREAM_CODE = "anchor_not_exist"

// ---------------------------------------------------------------------------
// Binding detection: chat id vs. response/parent anchor
// ---------------------------------------------------------------------------
//
// The chat id and the response anchor are a validated pair. Both can go stale,
// and they need different recoveries, so detection keeps them apart:
//   - chat wording ("chat not found", "start a new chat") -> dead chat.
//   - anchor wording ("parent id not found", "response does not exist")
//     -> dead anchor, chat presumed live.
//
// Deliberately conservative: a bare `Not_Found`, an ambiguous 404 or generic
// missing-item wording ("model does not exist", "attachment file does not
// exist") is none of the two and must not trigger any recovery.

const CHAT_MISSING_PATTERNS = [
  /\b(?:the\s+|this\s+|requested\s+|upstream\s+)?chat(?:\s+id)?\s+(?:(?:is|does)\s+)?(?:not\s+exist|not\s+found)\b/i,
  /\b(?:the\s+|this\s+|requested\s+|upstream\s+)?chat(?:\s+id)?\s+(?:has\s+been|was|is)\s+deleted\b/i,
  /\bno\s+such\s+chat\b/i,
  /\bstart\s+a\s+new\s+chat\b/i,
]

/**
 * Anchor wording. Every pattern names the parent/response explicitly: generic
 * "not found"/"invalid" text about *something else* (a model, a file, a
 * parameter) must not be read as a stale anchor.
 */
const ANCHOR_MISSING_PATTERNS = [
  /\b(?:the\s+|this\s+|requested\s+|upstream\s+)?parent(?:\s+id)?\s+(?:(?:is|does)\s+)?(?:not\s+exist|not\s+found|missing|invalid|stale)\b/i,
  /\b(?:the\s+|this\s+|requested\s+|upstream\s+)?parent(?:\s+id)?\s+(?:has\s+been|was|is)\s+deleted\b/i,
  /\bno\s+such\s+parent\b/i,
  /\bparent_id\s+(?:is\s+)?(?:not\s+found|not\s+exist|missing|invalid|stale)\b/i,
  /\b(?:the\s+|this\s+|requested\s+|upstream\s+)?response(?:\s+id)?\s+(?:(?:is|does)\s+)?(?:not\s+exist|not\s+found|missing|invalid|stale)\b/i,
  /\b(?:the\s+|this\s+|requested\s+|upstream\s+)?response(?:\s+id)?\s+(?:has\s+been|was|is)\s+deleted\b/i,
  /\bno\s+such\s+response\b/i,
  /\bresponse_id\s+(?:is\s+)?(?:not\s+found|not\s+exist|missing|invalid|stale)\b/i,
  // Narrower than the plain "invalid response" transport text: the ids must be
  // named, or a malformed upstream payload would look like a stale anchor.
  /\b(?:invalid|stale|unknown)\s+(?:parent|response)\s+(?:id|message|node)\b/i,
]

/** Message-side detection requires chat-specific wording; generic missing-item text is not enough. */
export function isChatMissingMessage(message: string): boolean {
  return CHAT_MISSING_PATTERNS.some((pattern) => pattern.test(message))
}

/** Message-side detection of a stale response/parent anchor inside a live chat. */
export function isStaleAnchorMessage(message: string): boolean {
  return ANCHOR_MISSING_PATTERNS.some((pattern) => pattern.test(message))
}

const CHAT_MISSING_CODE_PATTERNS = [
  "chat not found",
  "chat not exist",
  "chat does not exist",
  "chat is not exist",
  "no such chat",
  "chat deleted",
  "chat has been deleted",
]

const ANCHOR_MISSING_CODE_PATTERNS = [
  "parent not found",
  "parent not exist",
  "parent does not exist",
  "parent is not exist",
  "no such parent",
  "parent deleted",
  "parent has been deleted",
  "parent missing",
  "parent invalid",
  "invalid parent",
  "stale parent",
  "response not found",
  "response not exist",
  "response does not exist",
  "response is not exist",
  "no such response",
  "response deleted",
  "response has been deleted",
  "response missing",
  "response invalid",
  "invalid response id",
  "stale response",
  "parent id not found",
  "response id not found",
  "parent id not exist",
  "response id not exist",
]

/** Normalize an upstream error code for matching (`CHAT_NOT_FOUND` -> `chat not found`). */
export function normalizeUpstreamCode(code: string): string {
  return code.toLowerCase().replace(/[_-]+/g, " ").trim()
}

/**
 * Code-first detection of a dead upstream chat. Codes must be chat-specific:
 * a bare `Not_Found` is usually a retired *model* id (see the catalog
 * translation in the SDK), not a stale chat, and must not trigger a chat
 * recovery.
 */
export function isStaleChatCode(code: string): boolean {
  const normalized = normalizeUpstreamCode(code)
  return CHAT_MISSING_CODE_PATTERNS.some((pattern) => normalized.includes(pattern))
}

/** Code-first detection of a stale response/parent anchor (chat presumed live). */
export function isStaleAnchorCode(code: string): boolean {
  const normalized = normalizeUpstreamCode(code)
  return ANCHOR_MISSING_CODE_PATTERNS.some((pattern) => normalized.includes(pattern))
}

/** A dead upstream chat: the local chat id addresses nothing upstream. */
export function staleChatError(input: {
  status?: number
  upstreamCode?: string
  detail?: string
  phase?: QwenWebErrorPhase
}): QwenWebError {
  const origin = safeUpstreamCode(input.upstreamCode) ?? STALE_CHAT_UPSTREAM_CODE
  const detail = sanitizeQwenErrorText(input.detail)
  return new QwenWebError({
    code: "upstream_error",
    phase: input.phase,
    retryable: true,
    status: input.status,
    upstreamCode: STALE_CHAT_UPSTREAM_CODE,
    detail,
    message: detail
      ? `Qwen chat is no longer valid (${origin}): ${detail}`
      : `Qwen chat is no longer valid (${origin}). A new chat will be started.`,
  })
}

/**
 * A stale continuation anchor: the chat is reachable but the `parent_id` /
 * response this turn tried to chain onto is gone. Retryable — the session
 * drops the anchor and re-anchors the same chat with the full prompt, because
 * a re-anchored branch carries no upstream transcript of its own.
 */
export function staleAnchorError(input: {
  status?: number
  upstreamCode?: string
  detail?: string
  phase?: QwenWebErrorPhase
}): QwenWebError {
  const origin = safeUpstreamCode(input.upstreamCode) ?? STALE_ANCHOR_UPSTREAM_CODE
  const detail = sanitizeQwenErrorText(input.detail)
  return new QwenWebError({
    code: "upstream_error",
    phase: input.phase,
    retryable: true,
    status: input.status,
    upstreamCode: STALE_ANCHOR_UPSTREAM_CODE,
    detail,
    message: detail
      ? `Qwen continuation anchor is no longer valid (${origin}): ${detail}`
      : `Qwen continuation anchor is no longer valid (${origin}). The turn will be re-sent without it.`,
  })
}

/** True when an error reports a dead upstream chat (fresh-chat recovery marker). */
export function isStaleChatError(input: unknown): boolean {
  return QwenWebError.isInstance(input) && input.upstreamCode === STALE_CHAT_UPSTREAM_CODE
}

/** True when an error reports a stale anchor inside a live chat (anchor recovery marker). */
export function isStaleAnchorError(input: unknown): boolean {
  return QwenWebError.isInstance(input) && input.upstreamCode === STALE_ANCHOR_UPSTREAM_CODE
}

/**
 * True for either binding failure. Use this where the response is "the local
 * binding is unusable" (never address it again this turn); use the narrower
 * predicates where the two outcomes differ.
 */
export function isStaleBindingError(input: unknown): boolean {
  return isStaleChatError(input) || isStaleAnchorError(input)
}

/** An upstream turn that completed without producing anything usable. */
export function emptyResponseError(): QwenWebError {
  return new QwenWebError({
    code: "invalid_response",
    phase: "stream",
    retryable: false,
    detail: "The stream completed without text, reasoning, or tool calls.",
    message:
      "Qwen returned an empty response: the turn completed without text, reasoning, or tool calls. The prompt was rolled back from local thread history; no automatic retry was attempted.",
  })
}

/**
 * Classify a JSON-looking body that failed to parse — typically an error
 * payload larger than the bounded preview, arriving truncated. Field-level
 * salvage keeps the report honest about what the upstream actually said;
 * an unparseable body is never evidence that a login is required.
 */
export function classifyTruncatedJson(
  raw: string,
  status: number,
  phase: QwenWebErrorPhase = "setup",
): QwenWebError {
  const code = /"code"\s*:\s*"([^"]{1,80})"/.exec(raw)?.[1]
  const detail = /"(?:details|message)"\s*:\s*"([^"]{1,300})/.exec(raw)?.[1]
  const safeDetail = sanitizeQwenErrorText(detail)
  const safeCode = safeUpstreamCode(code)
  if (isChallengeMessage(raw))
    return challengeError(`Qwen returned a human-verification response (HTTP ${status}).`, status)
  if (code && isStaleChatCode(code)) return staleChatError({ status, upstreamCode: code, detail: safeDetail, phase })
  if (code && isStaleAnchorCode(code)) return staleAnchorError({ status, upstreamCode: code, detail: safeDetail, phase })
  if (detail && isChatMissingMessage(detail)) return staleChatError({ status, upstreamCode: code, detail: safeDetail, phase })
  if (detail && isStaleAnchorMessage(detail)) return staleAnchorError({ status, upstreamCode: code, detail: safeDetail, phase })
  if (code === "RateLimited" || status === 429 || (detail && isQuotaMessage(detail))) {
    return new QwenWebError({
      code: "rate_limited",
      phase,
      retryable: true,
      status,
      upstreamCode: code,
      detail: safeDetail ?? "Response body was truncated before a safe detail could be read.",
      message: `Qwen rate limit reached: ${safeDetail ?? "response body was truncated before a safe detail could be read."}`,
    })
  }
  const diagnostic = safeDetail ?? "Response body was truncated before a safe detail could be read."
  return new QwenWebError({
    code: "invalid_response",
    phase,
    retryable: status >= 500,
    status,
    upstreamCode: code,
    detail: diagnostic,
    message: `Qwen returned a malformed or truncated JSON error response (HTTP ${status})${safeCode ? ` [${safeCode}]` : ""}: ${diagnostic}`,
  })
}

/** A non-stream response where an event stream was expected. */
export function nonStreamResponseError(
  preview: string,
  status: number,
  phase: QwenWebErrorPhase = "setup",
): QwenWebError {
  const detail = sanitizeQwenErrorText(preview)
  return new QwenWebError({
    code: "invalid_response",
    phase,
    retryable: status >= 500,
    status,
    detail,
    message: `Qwen returned a non-stream response where an event stream was expected (HTTP ${status}): ${detail ?? "<empty body>"}`,
  })
}

const WAF_PATTERNS = [
  "fail_sys_user_validate",
  "rgv587_error",
  "denyfromx5",
  "aliyun_waf",
  "_____tmd_____",
  "security verification",
  "user validate",
]

export function isWafMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return WAF_PATTERNS.some((pattern) => normalized.includes(pattern))
}

export function isHtmlBody(value: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html\b)/i.test(value)
}

const CHALLENGE_PATTERNS = [
  ...WAF_PATTERNS,
  "captcha",
  "human verification",
  "human-verification",
  "verify you are human",
  "security check",
  "complete the verification",
  "verification required",
  "are you a robot",
  "robot check",
]

export function isChallengeMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return CHALLENGE_PATTERNS.some((pattern) => normalized.includes(pattern))
}

const NO_DISPLAY_PATTERNS = [
  "missing x server",
  "unable to open x display",
  "could not open x display",
  "no display",
  "display=",
  "headless shell",
  "xvfb",
]

/** True when a browser launch failed because there is no display available. */
export function isNoDisplayError(input: unknown): boolean {
  const message = input instanceof Error ? input.message : String(input)
  const normalized = message.toLowerCase()
  return NO_DISPLAY_PATTERNS.some((pattern) => normalized.includes(pattern))
}

/**
 * Classify an upstream JSON error payload into a typed error.
 *
 * Qwen reports failures in several shapes; this mirrors the shapes observed
 * in the web client: `{success:false,...}`, `{ret:[...]}`, `{error:...}`,
 * and `{data:{details,...}}`.
 */
export function classifyJsonError(
  raw: string,
  status: number,
  phase: QwenWebErrorPhase = "setup",
): QwenWebError | undefined {
  // Challenge markers can occur in success-shaped JSON as well as explicit
  // error envelopes. Classify the body before interpreting HTTP 401/403 as auth.
  if (isChallengeMessage(raw)) {
    return new QwenWebError({
      code: "challenge",
      retryable: false,
      status,
      upstreamCode: "waf_challenge",
      detail: "Human-verification challenge returned by upstream.",
      message: "Qwen returned a human-verification challenge. SilverCode paused this run; complete verification manually, then retry.",
    })
  }
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined

  const ret = parsed.ret
  if (Array.isArray(ret)) {
    const joined = ret.join(",")
    if (joined.includes("FAIL_SYS_USER_VALIDATE") || joined.includes("RGV587_ERROR")) {
      return new QwenWebError({
        code: "challenge",
        retryable: false,
        status,
        upstreamCode: "waf_challenge",
        detail: sanitizeQwenErrorText(joined),
        message: `Qwen anti-bot validation failed (${sanitizeQwenErrorText(joined, 160) ?? "waf_challenge"}). Complete the verification in the browser window, then retry.`,
      })
    }
  }

  const dataObj =
    parsed?.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
      ? (parsed.data as Record<string, unknown>)
      : {}
  const errorObj =
    parsed?.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)
      ? (parsed.error as Record<string, unknown>)
      : {}
  const resultObj =
    parsed?.result && typeof parsed.result === "object" && !Array.isArray(parsed.result)
      ? (parsed.result as Record<string, unknown>)
      : {}

  const detailCandidates: unknown[] = [
    dataObj.details,
    dataObj.message,
    dataObj.msg,
    dataObj.detail,
    parsed?.message,
    parsed?.msg,
    parsed?.detail,
    parsed?.details,
    errorObj.message,
    errorObj.details,
    errorObj.msg,
    resultObj.message,
    resultObj.details,
    parsed?.error,
  ]
  const detailValue = detailCandidates.find((value) => typeof value === "string")
  const detailText = typeof detailValue === "string" ? detailValue : ""

  const codeCandidates: unknown[] = [
    dataObj.code,
    dataObj.errorCode,
    parsed?.code,
    parsed?.errorCode,
    errorObj.code,
    resultObj.code,
  ]
  const codeValue = codeCandidates.find((value) => typeof value === "string")
  const code: string | undefined = typeof codeValue === "string" ? codeValue : undefined
  const safeDetail = sanitizeQwenErrorText(detailText || undefined)

  // Code first: `CHAT_NOT_FOUND`-style codes identify a dead chat even when
  // the message text is generic (or worded differently, e.g. "deleted").
  if (code && isStaleChatCode(code)) {
    return staleChatError({ status, upstreamCode: code, detail: safeDetail, phase })
  }
  // Anchor codes are chat-adjacent but distinct: the chat may still be live.
  if (code && isStaleAnchorCode(code)) {
    return staleAnchorError({ status, upstreamCode: code, detail: safeDetail, phase })
  }

  if (detailText && isWafMessage(detailText)) {
    return new QwenWebError({
      code: "challenge",
      retryable: false,
      status,
      upstreamCode: "waf_challenge",
      detail: safeDetail,
      message: `Qwen anti-bot validation failed. Complete the verification in the browser window, then retry.`,
    })
  }

  if (detailText && isChatMissingMessage(detailText)) {
    return staleChatError({ status, upstreamCode: code, detail: safeDetail, phase })
  }

  if (detailText && isStaleAnchorMessage(detailText)) {
    return staleAnchorError({ status, upstreamCode: code, detail: safeDetail, phase })
  }

  if (detailText && /chat is in progress|the chat is in progress/i.test(detailText)) {
    return new QwenWebError({
      code: "upstream_error",
      phase,
      retryable: true,
      status,
      upstreamCode: CHAT_IN_PROGRESS_UPSTREAM_CODE,
      detail: safeDetail,
      message: "Qwen reports the chat is still generating. Retry shortly.",
    })
  }

  if (parsed?.success === false) {
    const normalizedCode = code ?? "UpstreamError"
    if (
      status === 401 ||
      normalizedCode === "Unauthorized" ||
      (detailText && /login|session|unauthorized|authenticate/i.test(detailText))
    ) {
      return sessionExpiredError(safeDetail, status, { upstreamCode: code })
    }
    if (normalizedCode === "RateLimited" || status === 429 || (detailText && isQuotaMessage(detailText))) {
      const wait =
        typeof parsed?.data?.num === "number" ? ` Wait about ${parsed.data.num} hour(s) before trying again.` : ""
      return new QwenWebError({
        code: "rate_limited",
        phase,
        retryable: true,
        status,
        upstreamCode: normalizedCode,
        detail: safeDetail,
        message: `Qwen rate limit reached${safeDetail ? `: ${safeDetail}` : "."}${wait}`,
      })
    }
    const safeCode = safeUpstreamCode(normalizedCode)
    return new QwenWebError({
      code: "upstream_error",
      phase,
      retryable: status >= 500,
      status,
      upstreamCode: normalizedCode,
      detail: safeDetail,
      message: `Qwen upstream error${safeCode ? ` (${safeCode})` : ""}${safeDetail ? `: ${safeDetail}` : ": unknown error"}`,
    })
  }

  if (parsed?.error) {
    const rawMessage =
      typeof parsed.error === "string" ? parsed.error : (parsed.error.message ?? JSON.stringify(parsed.error))
    const message = typeof rawMessage === "string" ? rawMessage : String(rawMessage)
    const safeMessage = sanitizeQwenErrorText(message)
    if (isQuotaMessage(message)) {
      return new QwenWebError({
        code: "rate_limited",
        phase,
        retryable: true,
        status,
        upstreamCode: code,
        detail: safeMessage,
        message: `Qwen rate limit reached${safeMessage ? `: ${safeMessage}` : "."}`,
      })
    }
    const safeCode = safeUpstreamCode(code)
    return new QwenWebError({
      code: "upstream_error",
      phase,
      retryable: status >= 500,
      status,
      upstreamCode: code,
      detail: safeMessage,
      message: `Qwen upstream error${safeCode ? ` (${safeCode})` : ""}${safeMessage ? `: ${safeMessage}` : ": unknown error"}`,
    })
  }

  return undefined
}

/** Classify an HTTP status into a typed error (no body inspection). */
export function classifyStatus(
  status: number,
  statusText?: string,
  phase: QwenWebErrorPhase = "setup",
): QwenWebError | undefined {
  if (status >= 200 && status < 300) return undefined
  const detail = sanitizeQwenErrorText(statusText, 120)
  if (status === 401 || status === 403)
    return sessionExpiredError(detail ? `Upstream responded with HTTP ${status}: ${detail}` : undefined, status)
  if (status === 429) {
    return new QwenWebError({
      code: "rate_limited",
      phase,
      retryable: true,
      status,
      detail,
      message: `Qwen rate limit reached (HTTP ${status})${detail ? `: ${detail}` : "."}`,
    })
  }
  if (status === 502 || status === 503 || status === 504) {
    return new QwenWebError({
      code: "upstream_unavailable",
      phase,
      retryable: true,
      status,
      detail,
      message: `Qwen is temporarily unavailable (HTTP ${status})${detail ? `: ${detail}` : "."}`,
    })
  }
  return new QwenWebError({
    code: "upstream_error",
    phase,
    retryable: status >= 500,
    status,
    detail,
    message: `Qwen request failed (HTTP ${status}${detail ? ` ${detail}` : ""}).`,
  })
}

/** Classify status and body together so a WAF response is never mislabeled as login. */
export function classifyHttpResponse(
  raw: string,
  status: number,
  statusText?: string,
  phase: QwenWebErrorPhase = "setup",
): QwenWebError | undefined {
  return classifyJsonError(raw, status, phase) ?? classifyStatus(status, statusText, phase)
}

/** Network-level failures (DNS, reset, timeout) are retryable; aborts are not. */
export function classifyTransportFailure(input: unknown, phase?: QwenWebErrorPhase): QwenWebError {
  if (QwenWebError.isInstance(input)) return phase ? withQwenWebErrorPhase(input, phase) : input
  if (isAbortLike(input)) return abortedError(phase)
  const message = input instanceof Error ? input.message : String(input)
  const detail = sanitizeQwenErrorText(message)
  if (/timeout|timed out|stall|econnreset|enotfound|econnrefused|fetch failed|network/i.test(message)) {
    return new QwenWebError({
      code: "network_error",
      phase,
      retryable: true,
      detail,
      message: `Qwen network failure${detail ? `: ${detail}` : "."}`,
      cause: input,
    })
  }
  return new QwenWebError({
    code: "browser_error",
    phase,
    retryable: true,
    detail,
    message: `Qwen browser transport failure${detail ? `: ${detail}` : "."}`,
    cause: input,
  })
}
