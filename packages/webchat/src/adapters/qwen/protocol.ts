/**
 * Pure protocol helpers for the Qwen Web API (`chat.qwen.ai`).
 *
 * Everything in this module is deterministic and side-effect free so it can
 * be unit tested without a browser or a Qwen account.
 *
 * Protocol notes (observed from the web client; the web UI may change them):
 * - Model catalog: `GET /api/models` -> `{ data: [...] }`.
 * - Chat creation: `POST /api/v2/chats/new`.
 * - Generation: `POST /api/v2/chat/completions?chat_id=...` (SSE).
 * - Cancellation: `POST /api/v2/chat/completions/stop?chat_id=...`.
 * - Uploads: `POST /api/v2/files/getstsToken` -> Alibaba OSS credentials.
 * - The completions stream sends *cumulative* `content` when
 *   `incremental_output` is true, so consumers must prefix-diff.
 * - Reasoning arrives as `delta.phase === "thinking_summary"` with
 *   `extra.summary_title` / `extra.summary_thought` string arrays.
 * - Streams terminate with `data: [DONE]` or a
 *   `{ phase: "answer", status: "finished" }` delta (no `[DONE]` then).
 */
import {
  QWEN_WEB_CHAT_TYPE_TEXT,
  QWEN_WEB_COMPLETION_VERSION,
  QWEN_WEB_DEFAULT_BASE_URL,
  QWEN_WEB_ENV,
  type QwenWebChatMode,
  type QwenWebReasoningMode,
  type QwenWebToolMode,
} from "./constants"
import { isChallengeMessage } from "./errors"

// ---------------------------------------------------------------------------
// URLs & headers
// ---------------------------------------------------------------------------

export function qwenWebBaseUrl(): string {
  return (process.env[QWEN_WEB_ENV.baseUrl] ?? QWEN_WEB_DEFAULT_BASE_URL).trim().replace(/\/+$/, "")
}

export function qwenWebUrl(path: string): string {
  const base = qwenWebBaseUrl()
  const normalized = path.replace(/^\/+/, "")
  return normalized ? `${base}/${normalized}` : base
}

export function qwenWebOrigin(): string {
  return new URL(qwenWebBaseUrl()).origin
}

export function timezoneHeader(): string {
  return new Date().toString().split(" (")[0]
}

/**
 * Headers set explicitly inside the page context.
 *
 * The browser owns Cookie/Origin/Referer/User-Agent/sec-ch-ua*; only
 * application headers are set, mirroring what the web client sends.
 */
export function pageRequestHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    source: "web",
    timezone: timezoneHeader(),
    "x-request-id": randomId(),
    ...extra,
  }
}

export function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16)
  })
}

// ---------------------------------------------------------------------------
// Model ids
// ---------------------------------------------------------------------------

const VARIANT_SUFFIX = /-(?:fast|thinking|no-thinking)$/

/**
 * Map a public model id to the upstream id.
 *
 * Reasoning mode is selected via `feature_config`, never by a synthetic
 * suffix, so suffixes are stripped before sending anything upstream.
 */
export function toUpstreamModelId(modelId: string): string {
  return modelId.replace(VARIANT_SUFFIX, "")
}

// ---------------------------------------------------------------------------
// Chat creation
// ---------------------------------------------------------------------------

export function buildChatNewBody(model: string, _chatMode: QwenWebChatMode = "temp"): Record<string, unknown> {
  return {
    chatId: "",
    models: [model],
    project_id: "",
    timestamp: Date.now(),
    chat_type: QWEN_WEB_CHAT_TYPE_TEXT,
    // The web client always creates persisted (`normal`) chats; the legacy
    // `local` mode is no longer accepted for generations and yields chats the
    // account session cannot see, so the mode no longer matters here.
    chat_mode: "normal",
  }
}

/** Extract the chat id from the several shapes the endpoint may return. */
export function parseChatNewResponse(payload: unknown): string | undefined {
  const outcome = parseChatNewOutcome(payload)
  return outcome.kind === "ok" ? outcome.chatId : undefined
}

/**
 * Why a create response carried no usable chat id.
 *
 * `empty` — nothing came back at all (empty body / `{}` / `[]`); `blank` — an
 * id field was present but blank; `unrecognized` — a body arrived but no id
 * lives in any of the known shapes. None of them is evidence of a dead chat:
 * a create call proves nothing about an *existing* binding, so the caller
 * reports `invalid_response` instead of recovering.
 */
export type ChatNewOutcome =
  | { kind: "ok"; chatId: string }
  | { kind: "missing-id"; reason: "empty" | "blank" | "unrecognized" }

export function parseChatNewOutcome(payload: unknown): ChatNewOutcome {
  const extracted = extractChatId(payload)
  if (extracted !== undefined && extracted.trim()) return { kind: "ok", chatId: extracted.trim() }
  const empty =
    payload === undefined ||
    payload === null ||
    (typeof payload === "object" && !Array.isArray(payload) && Object.keys(payload as object).length === 0) ||
    (Array.isArray(payload) && payload.length === 0)
  if (empty) return { kind: "missing-id", reason: "empty" }
  return { kind: "missing-id", reason: extracted === undefined ? "unrecognized" : "blank" }
}

/**
 * The first id-shaped field in any of the known create-response shapes.
 *
 * Returns the raw string even when blank: an id field that arrived empty is
 * different evidence from a payload that never mentioned one, and the caller
 * reports the difference.
 */
function extractChatId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const root = payload as Record<string, unknown>
  for (const key of ["chat_id", "id"]) {
    const value = root[key]
    if (typeof value === "string") return value
  }
  const data = root["data"]
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>
    for (const key of ["chat_id", "id"]) {
      const value = record[key]
      if (typeof value === "string") return value
    }
    const chat = record["chat"]
    if (chat && typeof chat === "object") {
      const id = (chat as Record<string, unknown>)["id"]
      if (typeof id === "string") return id
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Completions payload
// ---------------------------------------------------------------------------

export interface QwenWebFileEntry {
  type: string
  id: string
  url: string
  name: string
  [key: string]: unknown
}

export interface CompletionPayloadInput {
  prompt: string
  model: string
  chatId: string | null
  parentId: string | null
  files?: QwenWebFileEntry[]
  reasoningMode?: QwenWebReasoningMode
  chatMode?: QwenWebChatMode
  /** Native (local_mcp) tool declarations. Only used with `toolMode: "native"`. */
  nativeTools?: QwenNativeTool[]
  toolMode?: QwenWebToolMode
  /** Test seam: deterministic ids/timestamps. */
  ids?: { fid?: string; childId?: string; timestamp?: number }
}

/**
 * Native tool descriptor for the upstream `local_mcp` feature, enabled via
 * `QWEN_WEB_TOOL_MODE=native`. The block protocol is the working default;
 * this seam exists so the exact wire shape can be validated with a live
 * account before flipping the default.
 */
export interface QwenNativeTool {
  name: string
  description: string
  parameters: unknown
}

function featureConfig(
  reasoningMode: QwenWebReasoningMode,
  input: Pick<CompletionPayloadInput, "toolMode" | "nativeTools">,
): Record<string, unknown> {
  const thinkingMode = reasoningMode === "thinking" ? "Thinking" : reasoningMode === "fast" ? "Fast" : "Auto"
  const enabled = reasoningMode !== "fast"
  const localMcp =
    input.toolMode === "native" && input.nativeTools && input.nativeTools.length > 0
      ? buildLocalMCPFeature(input.nativeTools)
      : undefined
  return {
    thinking_enabled: enabled,
    output_schema: "phase",
    research_mode: "normal",
    auto_thinking: reasoningMode === "auto",
    thinking_mode: thinkingMode,
    ...(enabled ? { thinking_format: "summary" } : {}),
    auto_search: false,
    ...(localMcp ? { local_mcp: localMcp } : {}),
  }
}

/**
 * Build the provisional `local_mcp` feature payload hosting the turn's tools.
 *
 * The upstream schema is unverified; treated strictly as a seam behind
 * `QWEN_WEB_TOOL_MODE=native`. A single local MCP server record advertises
 * the declared functions, and completion emits streamed `tool_calls` deltas
 * that `parseQwenEvent` surfaces as `QwenWebStreamEvent.kind === "tool-calls"`.
 */
export function buildLocalMCPFeature(tools: QwenNativeTool[]): Record<string, unknown>[] {
  return [
    {
      server: {
        type: "local_mcp",
      },
      tools: tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? { type: "object", properties: {} },
      })),
    },
  ]
}

export function buildCompletionPayload(input: CompletionPayloadInput): Record<string, unknown> {
  const reasoningMode = input.reasoningMode ?? "auto"
  const timestamp = input.ids?.timestamp ?? Math.floor(Date.now() / 1000)
  const fid = input.ids?.fid ?? randomId()
  const childId = input.ids?.childId ?? randomId()
  const parentId = input.parentId ?? ""
  const messageParentId = input.parentId ?? null
  return {
    stream: true,
    version: QWEN_WEB_COMPLETION_VERSION,
    incremental_output: true,
    chatId: input.chatId,
    parentId,
    chat_id: input.chatId,
    // The web client always streams into persisted (`normal`) chats. The
    // legacy `local` mode makes the API reject the request, so it is not used.
    chat_mode: "normal",
    model: input.model,
    parent_id: messageParentId,
    messages: [
      {
        id: null,
        fid,
        parentId: messageParentId,
        childrenIds: [childId],
        role: "user",
        content: input.prompt,
        user_action: "chat",
        files: input.files ?? [],
        timestamp,
        models: [input.model],
        model: "",
        chat_type: QWEN_WEB_CHAT_TYPE_TEXT,
        feature_config: featureConfig(reasoningMode, input),
        extra: { meta: { subChatType: QWEN_WEB_CHAT_TYPE_TEXT } },
        sub_chat_type: QWEN_WEB_CHAT_TYPE_TEXT,
        parent_id: messageParentId,
      },
    ],
    timestamp: timestamp + 1,
  }
}

export function buildStopBody(chatId: string, responseId: string): Record<string, string> {
  return { chat_id: chatId, response_id: responseId }
}

export function buildStsBody(filename: string, filesize: number, filetype: string): Record<string, string> {
  return { filename, filesize: String(filesize), filetype }
}

// ---------------------------------------------------------------------------
// Incremental (cumulative) deltas
// ---------------------------------------------------------------------------

export interface IncrementalDelta {
  /** Newly arrived text ("" when nothing new). */
  delta: string
  /** Authoritative accumulated content after applying the update. */
  matched: string
}

const SUFFIX_CHECK_BYTES = 32

/**
 * Diff a cumulative upstream update against the previously seen content.
 *
 * The common case is a pure append; a short suffix check validates the
 * boundary in O(1) instead of scanning the whole prefix. Falls back to a
 * bounded common-prefix scan, and finally treats the update as strictly
 * incremental (append) to avoid corrupting output on unexpected shapes.
 */
export function incrementalDelta(previous: string, next: string): IncrementalDelta {
  if (!previous) return { delta: next, matched: next }
  if (next === previous) return { delta: "", matched: previous }

  if (next.length > previous.length && previous.length > 0) {
    const checkLength = Math.min(SUFFIX_CHECK_BYTES, previous.length)
    if (previous.slice(-checkLength) === next.slice(previous.length - checkLength, previous.length)) {
      return { delta: next.slice(previous.length), matched: next }
    }
  }

  if (next.length >= previous.length && next.startsWith(previous)) {
    return { delta: next.slice(previous.length), matched: next }
  }

  const scanWindow = Math.min(2000, previous.length)
  const maxLength = Math.min(scanWindow, next.length)
  let common = 0
  const segment = 64
  while (common + segment <= maxLength) {
    if (previous.slice(common, common + segment) !== next.slice(common, common + segment)) break
    common += segment
  }
  while (common < maxLength && previous[common] === next[common]) common++

  if (common >= Math.min(scanWindow, 4)) {
    return { delta: next.slice(common), matched: next }
  }
  return { delta: next, matched: previous + next }
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

export type QwenWebStreamEvent =
  | { kind: "done" }
  | { kind: "text"; content: string; responseId?: string; chatId?: string }
  | { kind: "thinking"; delta: Record<string, unknown>; responseId?: string; chatId?: string }
  | { kind: "answer-finished"; responseId?: string; chatId?: string }
  | { kind: "response-created"; responseId: string; chatId?: string }
  | { kind: "tool-calls"; responseId?: string; chatId?: string; calls: QwenStreamToolCall[] }
  | { kind: "error"; code: string; message: string }
  | {
      kind: "usage"
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
      cachedTokens?: number
      reasoningTokens?: number
      textTokens?: number
    }
  | { kind: "unknown" }

/** Native tool call emitted by a streamed delta (`tool_calls` in `choices`). */
export interface QwenStreamToolCall {
  id?: string
  name?: string
  /** Raw JSON-encoded arguments string. */
  arguments?: string
}

/**
 * Incremental SSE parser.
 *
 * Feed arbitrary transport chunks; complete `data:` payloads are returned as
 * parsed events. Never assumes one transport chunk equals one logical event.
 */
export class QwenWebSSEParser {
  private buffer = ""

  feed(chunk: string): QwenWebStreamEvent[] {
    this.buffer += chunk
    const events: QwenWebStreamEvent[] = []
    let boundary = this.buffer.indexOf("\n")
    while (boundary !== -1) {
      const line = this.buffer.slice(0, boundary).replace(/\r$/, "")
      this.buffer = this.buffer.slice(boundary + 1)
      const payload = parseSSELine(line)
      if (payload !== undefined) events.push(parseQwenEvent(payload))
      boundary = this.buffer.indexOf("\n")
    }
    return events
  }

  /** Flush a trailing line that was never newline-terminated. */
  flush(): QwenWebStreamEvent[] {
    if (!this.buffer) return []
    const payload = parseSSELine(this.buffer.replace(/\r$/, ""))
    this.buffer = ""
    return payload === undefined ? [] : [parseQwenEvent(payload)]
  }
}

function parseSSELine(line: string): string | undefined {
  if (!line || line.startsWith(":")) return undefined
  if (line.startsWith("data:")) return line.slice("data:".length).trimStart()
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function isChallengeText(data: string): boolean {
  return isChallengeMessage(data)
}

export function parseQwenEvent(data: string): QwenWebStreamEvent {
  if (!data) return { kind: "unknown" }
  if (data === "[DONE]") return { kind: "done" }

  let chunk: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(data)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      // A non-JSON SSE payload is never a normal event. When it is a WAF
      // challenge the upstream still serves it as `text/event-stream`, so the
      // stream would otherwise look like an endless run of `unknown` events.
      if (isChallengeText(data)) return { kind: "error", code: "waf_challenge", message: data.slice(0, 300) }
      return { kind: "unknown" }
    }
    chunk = parsed as Record<string, unknown>
  } catch {
    if (isChallengeText(data)) return { kind: "error", code: "waf_challenge", message: data.slice(0, 300) }
    return { kind: "unknown" }
  }

  const errorValue = chunk["error"]
  if (errorValue) {
    if (typeof errorValue === "string") return { kind: "error", code: "upstream_error", message: errorValue }
    const record = asRecord(errorValue)
    const message =
      typeof record["message"] === "string"
        ? record["message"]
        : typeof record["details"] === "string"
          ? record["details"]
          : JSON.stringify(errorValue)
    const code = typeof record["code"] === "string" ? record["code"] : "upstream_error"
    return { kind: "error", code, message }
  }

  // The authoritative chat id may ride at the chunk root as well as inside
  // `response.created`: a rotated chat id that only shows up here must still
  // reach the session, or the local binding stays stale for the rest of the
  // conversation. Only non-empty strings are ever surfaced.
  const chunkChatId = typeof chunk["chat_id"] === "string" && chunk["chat_id"] ? chunk["chat_id"] : undefined
  const withChatId = <T extends object>(event: T): T & { chatId?: string } =>
    chunkChatId ? { ...event, chatId: chunkChatId } : event

  const created = asRecord(chunk["response"])
  const createdResponseId = created["id"]
  const createdResponseKeyType = chunk["type"]
  if (createdResponseKeyType === "response.created" && typeof createdResponseId === "string" && createdResponseId) {
    const chatId = created["chat_id"]
    return {
      kind: "response-created",
      responseId: createdResponseId,
      // Fall back to the chunk-level id so a rotation is adopted even when
      // `response.created` omits it.
      ...(typeof chatId === "string" && chatId ? { chatId } : chunkChatId ? { chatId: chunkChatId } : {}),
    }
  }

  const responseId = typeof chunk["response_id"] === "string" ? chunk["response_id"] : undefined
  const choices = chunk["choices"]
  if (Array.isArray(choices) && choices.length > 0) {
    const delta = asRecord(asRecord(choices[0])["delta"])
    if (Object.keys(delta).length > 0) {
      const phase = delta["phase"]
      if (phase === "answer" && delta["status"] === "finished")
        return withChatId({ kind: "answer-finished", responseId })
      if (phase === "thinking_summary") return withChatId({ kind: "thinking", delta, responseId })
      if (phase === "answer" || phase === undefined) {
        const toolCallsValue = delta["tool_calls"]
        if (Array.isArray(toolCallsValue) && toolCallsValue.length > 0) {
          const calls = toolCallsValue
            .map((entry): QwenStreamToolCall | undefined => {
              const functionValue = asRecord(asRecord(entry)["function"])
              const name = typeof functionValue["name"] === "string" ? functionValue["name"] : undefined
              const args = typeof functionValue["arguments"] === "string" ? functionValue["arguments"] : undefined
              if (!name && args === undefined) return undefined
              const entryRecord = asRecord(entry)
              const id = typeof entryRecord["id"] === "string" ? entryRecord["id"] : undefined
              return { id, name, arguments: args }
            })
            .filter((call): call is QwenStreamToolCall => call !== undefined)
          if (calls.length > 0) return withChatId({ kind: "tool-calls", responseId, calls })
        }
        const content = delta["content"]
        if (typeof content === "string") return withChatId({ kind: "text", content, responseId })
        if (content === undefined && phase === "answer") return withChatId({ kind: "text", content: "", responseId })
      }
    }
  }

  const usage = chunk["usage"]
  if (usage && typeof usage === "object") {
    const record = asRecord(usage)
    const promptDetails = asRecord(record["prompt_tokens_details"] ?? record["input_tokens_details"])
    const outputDetails = asRecord(record["output_tokens_details"])
    return withChatId({
      kind: "usage",
      inputTokens: asFiniteNumber(record["input_tokens"] ?? record["prompt_tokens"]),
      outputTokens: asFiniteNumber(record["output_tokens"] ?? record["completion_tokens"]),
      totalTokens: asFiniteNumber(record["total_tokens"]),
      cachedTokens: asFiniteNumber(promptDetails["cached_tokens"]),
      reasoningTokens: asFiniteNumber(outputDetails["reasoning_tokens"]),
      textTokens: asFiniteNumber(outputDetails["text_tokens"]),
    })
  }

  if (isChallengeText(data)) return { kind: "error", code: "waf_challenge", message: data.slice(0, 300) }

  return { kind: "unknown" }
}

/**
 * Format a `thinking_summary` delta into markdown.
 *
 * Titles and thoughts arrive as parallel string arrays and are cumulative
 * across deltas, exactly like answer content.
 */
export function formatThinkingSummary(delta: Record<string, unknown>): string {
  const extra = asRecord(delta["extra"])
  const titles = stringArray(asRecord(extra["summary_title"])["content"])
  const thoughts = stringArray(asRecord(extra["summary_thought"])["content"])
  const sections: string[] = []
  for (let index = 0; index < Math.max(titles.length, thoughts.length); index++) {
    const title = titles[index]?.trim() ?? ""
    const thought = thoughts[index]?.trim() ?? ""
    if (title && thought) sections.push(`**${title}**\n\n${thought}`)
    else if (title) sections.push(`**${title}**`)
    else if (thought) sections.push(thought)
  }
  return sections.join("\n\n")
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

export interface QwenWebModelRecord {
  id: string
  name: string
  created: number
  contextWindow?: number
  isActive?: boolean
  modalities?: string[]
  chatTypes?: string[]
  capabilities: Record<string, unknown>
  metadata: Record<string, unknown>
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Normalize one raw entry of `GET /api/models`. */
export function normalizeModelRecord(model: unknown): QwenWebModelRecord | undefined {
  const root = recordOf(model)
  const id = root["id"]
  if (typeof id !== "string" || !id.trim()) return undefined
  const info = recordOf(root["info"])
  const metadata = { ...recordOf(root["metadata"]), ...recordOf(root["meta"]), ...recordOf(info["meta"]) }
  const capabilities = {
    ...recordOf(recordOf(metadata["capabilities"])),
    ...recordOf(recordOf(info["capabilities"])),
    ...recordOf(root["capabilities"]),
  }
  const name =
    (typeof root["name"] === "string" && root["name"]) || (typeof info["name"] === "string" && info["name"]) || id
  const createdValue = info["created_at"] ?? root["created"]
  const created = typeof createdValue === "number" && Number.isFinite(createdValue) ? createdValue : Date.now() / 1000
  const contextValue = metadata["max_context_length"]
  const isActive =
    typeof info["is_active"] === "boolean"
      ? info["is_active"]
      : typeof root["is_active"] === "boolean"
        ? root["is_active"]
        : undefined
  const modalityValue = metadata["modality"]
  const chatTypeValue = metadata["chat_type"]
  return {
    id,
    name,
    created,
    contextWindow: typeof contextValue === "number" && Number.isFinite(contextValue) ? contextValue : undefined,
    isActive,
    modalities: Array.isArray(modalityValue)
      ? modalityValue.filter((item): item is string => typeof item === "string")
      : undefined,
    chatTypes: Array.isArray(chatTypeValue)
      ? chatTypeValue.filter((item): item is string => typeof item === "string")
      : undefined,
    capabilities,
    metadata,
  }
}

/** Parse the `GET /api/models` response body into normalized records. */
export function parseModelsResponse(payload: unknown): QwenWebModelRecord[] {
  const root = recordOf(payload)
  const data = root["data"]
  if (!Array.isArray(data)) return []
  const records: QwenWebModelRecord[] = []
  for (const entry of data) {
    const record = normalizeModelRecord(entry)
    if (record) records.push(record)
  }
  return records
}
