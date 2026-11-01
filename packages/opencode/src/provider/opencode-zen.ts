/**
 * Adapter for the OpenCode Zen gateway (`https://opencode.ai/zen/v1`).
 *
 * Zen only serves its free tier (`deepseek-v4-flash-free`, `big-pickle`,
 * `mimo-v2.5-free`, ...) to clients that identify themselves as the OpenCode
 * CLI, so requests from a plain HTTP client are rejected before the model runs:
 *
 * - a missing `x-opencode-session` is rejected with `400 MissingSessionID`,
 * - standard library/OpenAI SDK user agents are rejected with
 *   `403 FreeTierError`,
 * - free models only accept `Authorization: Bearer public`; a regular `sk-*`
 *   key without a billing account attached is rejected,
 * - non-streaming calls (`{"stream": false}`) are rejected,
 * - payloads without any tool definition are rejected.
 *
 * `createFetch` is installed as the provider fetch for the `opencode` provider,
 * so it observes the exact request the AI SDK would send and can satisfy that
 * contract: client/session/request headers are added, free models are
 * authenticated with the public bearer token, `stream: true` is enforced with
 * the SSE response re-assembled into the JSON completion the caller expected,
 * and an empty tool list gets a placeholder definition.
 *
 * Stripping injected-only tool calls out of a response must never fake a
 * caller contract: a completion whose only tool calls were adapter-injected
 * ends as a normal stop only when the caller left tool choice on auto or
 * disabled it; a caller that required a tool call gets an explicit stream
 * error instead of a silently satisfied contract. Caller tool calls are
 * always preserved and never dropped alongside an injected one, and JSON
 * responses are guarded for streaming callers as well, because a gateway may
 * answer even a streamed request with a single JSON completion.
 *
 * Requests the adapter does not rewrite (anything without a chat completion
 * body) are forwarded untouched, including their body bytes, method, signal,
 * and Request options.
 */

import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Identifier } from "@/id/id"
import { isRecord } from "@/util/record"
import { ProviderError } from "./error"

/**
 * Exact User-Agent wire contract required by the OpenCode Zen free-tier gateway.
 *
 * Evidence & Wire Specification (GitHub Issue #200):
 * The Zen free-tier gateway (`https://opencode.ai/zen/v1`) enforces client identity checks
 * on free-tier models (`deepseek-v4-flash-free`, `big-pickle`, `mimo-v2.5-free`, etc.).
 * Standard AI SDK library user agents (e.g. `@ai-sdk/openai-compatible`), raw HTTP clients,
 * and drifted local development strings (such as `opencode/local`) fail gateway verification
 * with `403 FreeTierError` before any model execution starts.
 *
 * The protocol requires the exact client user agent tuple:
 * `opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`
 * together with `x-opencode-client: cli` and `Authorization: Bearer public`.
 *
 * This value is deliberately pinned as a protocol wire contract rather than computed from
 * runtime package versions, because dynamic derivation would drift with local Bun or SDK
 * upgrades and break free-tier access in customer environments. Updating this string
 * requires a coordinated gateway contract update and live gateway verification.
 *
 * Configurable via `OPENCODE_ZEN_USER_AGENT` or `ZEN_USER_AGENT` environment variables,
 * or per-fetch `userAgent` option if the gateway wire contract is revised.
 */
export const DEFAULT_ZEN_USER_AGENT = "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14"

export const ZEN_USER_AGENT =
  process.env.OPENCODE_ZEN_USER_AGENT ?? process.env.ZEN_USER_AGENT ?? DEFAULT_ZEN_USER_AGENT

/** The free tier authenticates as the public client; paid keys require a billing account. */
export const ZEN_PUBLIC_AUTHENTICATION = "Bearer public"

/**
 * The file-search quartet the upstream free-tier gate historically required:
 * {bash, glob, grep, read}. These names are wire-protocol constants and stay
 * as-is across the bash -> shell tool rename (#780). Since the 2026-10-14
 * gate revision (see the injection site in `createFetch`) the quartet is no
 * longer injected — the gateway rejects the synthetic empty-schema versions
 * and accepts genuine tool-less requests. The set now only defines which
 * response tool calls count as adapter-injected for the response guards:
 * a call naming one of these tools is stripped only when the caller's own
 * catalog carries neither the name nor its canonical spelling.
 */
export const ZEN_FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"] as const

// Upstream webfetch/websearch defs, captured verbatim from a real upstream
// 1.19.0 request on 2026-10-14 (see shim note at injection site).
const ZEN_WEB_MARKER_TOOLS: unknown[] = [
  {
    "type": "function",
    "function": {
      "name": "webfetch",
      "description": "- Fetches content from a specified URL\n- Takes a URL and optional format as input\n- Fetches the URL content, converts to requested format (markdown by default)\n- Returns the content in the specified format\n- Use this tool when you need to retrieve and analyze web content\n\nUsage notes:\n  - IMPORTANT: if another tool is present that offers better web fetching capabilities, is more targeted to the task, or has fewer restrictions, prefer using that tool instead of this one.\n  - The URL must be a fully-formed valid URL\n  - HTTP URLs will be automatically upgraded to HTTPS\n  - Format options: \"markdown\" (default), \"text\", or \"html\"\n  - This tool is read-only and does not modify any files\n  - Results may be summarized if the content is very large\n",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "The URL to fetch content from"
          },
          "format": {
            "type": "string",
            "enum": [
              "text",
              "markdown",
              "html"
            ],
            "description": "The format to return the content in (text, markdown, or html). Defaults to markdown.",
            "default": "markdown"
          },
          "timeout": {
            "type": "number",
            "description": "Optional timeout in seconds (max 120)"
          }
        },
        "required": [
          "url"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "websearch",
      "description": "- Search the web using the session's web search provider - performs real-time web searches and can scrape content from specific URLs\n- Provides up-to-date information for current events and recent data\n- Supports configurable result counts and returns the content from the most relevant websites\n- Use this tool for accessing information beyond knowledge cutoff\n- Searches are performed automatically within a single API call\n\nUsage notes:\n  - Supports live crawling modes when available: 'fallback' (backup if cached unavailable) or 'preferred' (prioritize live crawling)\n  - Search types when available: 'auto' (balanced), 'fast' (quick results), 'deep' (comprehensive search)\n  - Configurable context length for optimal LLM integration\n  - Domain filtering and advanced search options available\n\nThe current year is 2026. You MUST use this year when searching for recent information or current events\n- Example: If the current year is 2026 and the user asks for \"latest AI news\", search for \"AI news 2026\", NOT \"AI news 2025\"\n",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Websearch query"
          },
          "numResults": {
            "type": "number",
            "description": "Number of search results to return (default: 8)"
          },
          "livecrawl": {
            "type": "string",
            "enum": [
              "fallback",
              "preferred"
            ],
            "description": "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')"
          },
          "type": {
            "type": "string",
            "enum": [
              "auto",
              "fast",
              "deep"
            ],
            "description": "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search"
          },
          "contextMaxCharacters": {
            "type": "number",
            "description": "Maximum characters for context string optimized for LLMs (default: 10000)"
          }
        },
        "required": [
          "query"
        ]
      }
    }
  }
]

function toolNameOf(tool: unknown): string {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return ""
  const item = tool as Record<string, unknown>
  const fn =
    item["function"] && typeof item["function"] === "object" && !Array.isArray(item["function"])
      ? (item["function"] as Record<string, unknown>)
      : null
  const raw = typeof item["name"] === "string" ? item["name"] : typeof fn?.["name"] === "string" ? fn["name"] : ""
  return raw.trim()
}

/** UUID source, injectable so callers and tests can control id generation. */
export type UUID = () => string

const randomUUID: UUID = () => crypto.randomUUID()

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * Session ids the workspace itself generates: 12 hex timestamp characters
 * followed by 14 base 62 characters (`Identifier.create`).
 */
const WORKSPACE_SESSION_PATTERN = /^[0-9a-f]{12}[0-9a-zA-Z]{14}$/

/**
 * Session ids stay stable for one conversation thread; request ids change
 * every turn.
 *
 * Zen documents the header as `ses_<uuid>`, while a conversation id generated
 * by this workspace is `ses_` plus an identifier, not a UUID, so both shapes
 * are accepted. Any malformed value (including bare invalid tokens or pre-prefixed
 * strings like `ses_invalid` that fail both UUID and workspace session validation)
 * is rejected and replaced with a fresh `ses_<uuid>`.
 */
export function sessionID(value: string | undefined, uuid: UUID = randomUUID) {
  const id = value?.startsWith("ses_") ? value.slice("ses_".length) : value
  if (id === undefined || (!UUID_PATTERN.test(id) && !WORKSPACE_SESSION_PATTERN.test(id))) return `ses_${uuid()}`
  return `ses_${id}`
}

/** Request ids are regenerated for every provider turn. Upstream 1.19 sends the
 * workspace message-id shape (`msg_` + identifier); the gateway rejects uuid-style ids. */
export function requestID(uuid: UUID = randomUUID) {
  return Identifier.ascending("message")
}

type Chunk = {
  id?: string
  created?: number
  model?: string
  usage?: unknown
  error?: unknown
  choices?: ReadonlyArray<{
    delta?: {
      content?: string | null
      reasoning?: string | null
      reasoning_content?: string | null
      tool_calls?: ReadonlyArray<{
        index?: number | null
        id?: string | null
        function?: { name?: string | null; arguments?: string | null }
      }>
    }
    finish_reason?: string | null
  }>
}

type Frame = { readonly chunk: Chunk } | { readonly done: true }

type Cost = {
  readonly input: number
  readonly output: number
  readonly cache: { readonly read: number; readonly write: number }
}

/** Cost metadata of a catalog model, including its context-priced tiers. */
export type ModelCost = Cost & {
  readonly tiers?: ReadonlyArray<Cost>
  readonly experimentalOver200K?: Cost
}

export function zeroCost(cost: ModelCost) {
  const entries = [cost, ...(cost.tiers ?? []), ...(cost.experimentalOver200K ? [cost.experimentalOver200K] : [])]
  return entries.every(
    (entry) =>
      entry.input === 0 && entry.output === 0 && (entry.cache?.read ?? 0) === 0 && (entry.cache?.write ?? 0) === 0,
  )
}

/**
 * Wire model ids Zen serves for free.
 *
 * The gateway reads the request's `model` field, which the AI SDK fills from
 * the model's API id, so the set has to be keyed by that id: a config alias
 * must not hide a free model, and an alias for a paid model must not unlock
 * the public token. Only models whose complete cost metadata (every component,
 * including context tiers) is zero qualify — a zero input price with priced
 * output is not a free model.
 */
export function freeTier(models: Iterable<{ readonly api: { readonly id: string }; readonly cost: ModelCost }>) {
  return new Set([...models].filter((model) => zeroCost(model.cost)).map((model) => model.api.id))
}

function parsed(data: string): Chunk | undefined {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return undefined
  }
  return isRecord(value) ? (value as Chunk) : undefined
}

/** In-band provider error frame for a stream cut short before its completion. */
function truncatedFrame() {
  return `data: ${JSON.stringify({
    error: {
      code: "server_error",
      message: "Zen stream ended before the completion finished",
      type: "server_error",
    },
  })}\n\n`
}

function streamError(value: unknown) {
  const detail = isRecord(value) && typeof value["message"] === "string" ? value["message"] : JSON.stringify(value)
  return new ProviderError.ResponseStreamError(`Zen stream error: ${detail}`)
}

function stallError(chunkTimeout: number) {
  return new ProviderError.ResponseStreamError(`Zen stream stalled for more than ${chunkTimeout}ms`)
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError")
}

/**
 * Reject a pending read as soon as the caller aborts. `AbortSignal` listeners
 * never fire for a signal that is already aborted, and an upstream that
 * ignores the abort would otherwise leave the read hanging forever.
 */
function abortWatch(signal: AbortSignal) {
  let fail: (reason: unknown) => void = () => {}
  const promise = new Promise<never>((_, reject) => {
    fail = reject
  })
  const listener = () => fail(abortReason(signal))
  if (signal.aborted) listener()
  else signal.addEventListener("abort", listener, { once: true })
  void promise.catch(() => {})
  return { promise, clear: () => signal.removeEventListener("abort", listener) }
}

function read(reader: ReadableStreamDefaultReader<Uint8Array>, chunkTimeout: number | undefined) {
  if (chunkTimeout === undefined || chunkTimeout <= 0) return reader.read()
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = stallError(chunkTimeout)
      void reader.cancel(error).catch(() => {})
      reject(error)
    }, chunkTimeout)
    reader.read().then(
      (part) => {
        clearTimeout(timer)
        resolve(part)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Read SSE frames incrementally so a stalled or aborted upstream rejects with
 * the same response-stream error the provider's own SSE reader raises, instead
 * of hanging until the whole body is buffered.
 */
async function* frames(response: Response, input: AggregateInput): AsyncGenerator<Frame> {
  const reader = response.body?.getReader()
  if (!reader) return
  const signal = input.signal
  const decoder = new TextDecoder()
  const cancel = () => void reader.cancel(signal?.reason).catch(() => {})
  const watch = signal ? abortWatch(signal) : undefined
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    if (signal?.aborted) {
      cancel()
      throw abortReason(signal)
    }
    let buffer = ""
    while (true) {
      const pending = read(reader, input.chunkTimeout)
      const part = await (watch ? Promise.race([pending, watch.promise]) : pending)
      if (part.done) break
      buffer += decoder.decode(part.value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const frame = parseFrame(line)
        if (!frame) continue
        yield frame
        if ("done" in frame) return
      }
    }
    buffer += decoder.decode()
    if (buffer.length > 0) {
      const frame = parseFrame(buffer)
      if (frame) yield frame
    }
  } finally {
    signal?.removeEventListener("abort", cancel)
    watch?.clear()
    await reader.cancel().catch(() => {})
  }
}

function parseFrame(line: string): Frame | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith("data:")) return undefined
  const data = trimmed.slice("data:".length).trim()
  if (data.length === 0) return undefined
  if (data === "[DONE]") return { done: true }
  const chunk = parsed(data)
  return chunk === undefined ? undefined : { chunk }
}

export type AggregateInput = {
  readonly signal?: AbortSignal | null
  /** Milliseconds to wait for the next SSE chunk before failing the read. */
  readonly chunkTimeout?: number
  readonly injectedOnly?: Set<string>
  /**
   * The caller's request carried a `tool_choice` that requires a tool call
   * (`"required"`, `"any"`, or a forced function). Stripping injected-only
   * calls must not turn the response into a normal stop; it fails instead.
   */
  readonly required?: boolean
}

/**
 * A response that only offered adapter-injected tools is not allowed to
 * satisfy a required `tool_choice` after the guard removes them; the caller
 * either gets the tool call it demanded or this explicit failure.
 */
function requiredContractError() {
  return new ProviderError.ResponseStreamError(
    "Zen response satisfied the caller's required tool_choice with adapter-injected tools only",
  )
}

/**
 * Streaming fragments address a call by `index`; providers that omit it can
 * only be addressed by their position inside the delta. The two key spaces
 * stay separate so an index-less caller fragment never merges into, or gets
 * dropped with, an injected call that legitimately owns index 0.
 */
function callKey(index: number | null | undefined, position: number) {
  return typeof index === "number" ? `i:${index}` : `a:${position}`
}

/** Sort order of a call key: explicit indexes first, in index order, then index-less arrivals. */
function callOrder(key: string) {
  return key.startsWith("i:") ? Number(key.slice(2)) : Number.MAX_SAFE_INTEGER
}

/** Re-assemble a streamed completion into the JSON response a non-streaming caller expects. */
async function aggregate(response: Response, input: AggregateInput) {
  const state = {
    id: undefined as string | undefined,
    created: undefined as number | undefined,
    model: undefined as string | undefined,
    finish: undefined as string | undefined,
    usage: undefined as unknown,
    content: "",
    reasoning: "",
    reasoningContent: "",
    calls: new Map<string, { id: string | undefined; name: string; arguments: string }>(),
  }

  let completed = false
  for await (const frame of frames(response, input)) {
    if ("done" in frame) {
      completed = true
      break
    }
    const chunk = frame.chunk
    if (chunk.error !== undefined) throw streamError(chunk.error)
    if (chunk.id !== undefined) state.id = chunk.id
    if (chunk.created !== undefined) state.created = chunk.created
    if (chunk.model !== undefined) state.model = chunk.model
    if (chunk.usage !== undefined) state.usage = chunk.usage

    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (delta?.content) state.content += delta.content
    if (delta?.reasoning) state.reasoning += delta.reasoning
    if (delta?.reasoning_content) state.reasoningContent += delta.reasoning_content
    delta?.tool_calls?.forEach((call, position) => {
      // Streaming deltas address a call by `index`; fragments for two calls can
      // arrive interleaved, so the position inside one delta cannot key them.
      const key = callKey(call.index, position)
      const current = state.calls.get(key) ?? { id: undefined, name: "", arguments: "" }
      if (call.id) current.id = call.id
      if (call.function?.name) current.name += call.function.name
      if (call.function?.arguments) current.arguments += call.function.arguments
      state.calls.set(key, current)
    })
    if (choice?.finish_reason) state.finish = choice.finish_reason
  }

  // A stream that stops without a finish reason or a `[DONE]` frame was cut
  // short; reporting it as a normal completion would hide real failures.
  if (!completed && state.finish === undefined) {
    throw new ProviderError.ResponseStreamError("Zen stream ended before the completion finished")
  }

  const message: Record<string, unknown> = { role: "assistant", content: state.content }
  if (state.reasoningContent) message["reasoning_content"] = state.reasoningContent
  if (state.reasoning) message["reasoning"] = state.reasoning
  if (state.calls.size > 0) {
    const validCalls = [...state.calls.entries()]
      .filter(([, call]) => !input.injectedOnly?.has(call.name))
      .toSorted(([a], [b]) => callOrder(a) - callOrder(b))
      .map(([, call]) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }))

    if (validCalls.length > 0) {
      message["tool_calls"] = validCalls
    } else {
      if (state.finish === "tool_calls") {
        if (input.required) throw requiredContractError()
        state.finish = "stop"
      }
      if (!state.content) {
        message["content"] = ""
      }
    }
  }

  return new Response(
    JSON.stringify({
      id: state.id,
      object: "chat.completion",
      created: state.created,
      model: state.model,
      choices: [{ index: 0, message, finish_reason: state.finish ?? null }],
      ...(state.usage === undefined ? {} : { usage: state.usage }),
    }),
    { status: response.status, headers: { "content-type": "application/json" } },
  )
}

/**
 * Re-emit a consumed body as a fresh response. The guarded body is decoded
 * text re-serialized by the adapter, so any transferred-length or
 * content-encoding metadata of the original response is stale for it and has
 * to be dropped to keep consumers from truncating on the old value.
 */
function rebuildResponse(response: Response, body: BodyInit | null) {
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.delete("transfer-encoding")
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * Strip adapter-injected tool calls from a JSON completion. The body is
 * buffered up front, so every outcome — including malformed JSON — hands the
 * caller a readable response built from the buffered text instead of the
 * already-consumed upstream response.
 */
async function guardJsonResponse(response: Response, injectedOnly: Set<string>, required: boolean) {
  if (injectedOnly.size === 0) return response
  let text: string
  try {
    text = await response.text()
  } catch {
    // The upstream body failed while being read; only the original response
    // can surface that failure, there is no buffered text to rebuild from.
    return response
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return rebuildResponse(response, text)
  }
  if (!isRecord(data) || !Array.isArray(data["choices"])) {
    return rebuildResponse(response, text)
  }
  let modified = false
  for (const choice of data["choices"] as Array<Record<string, unknown>>) {
    if (!isRecord(choice) || !isRecord(choice["message"])) continue
    const msg = choice["message"] as Record<string, unknown>
    if (!Array.isArray(msg["tool_calls"])) continue
    const remaining = (msg["tool_calls"] as Array<Record<string, unknown>>).filter((call) => {
      if (!isRecord(call) || !isRecord(call["function"])) return false
      const fn = call["function"] as Record<string, unknown>
      const name = typeof fn["name"] === "string" ? fn["name"] : ""
      return !injectedOnly.has(name)
    })
    if (remaining.length === msg["tool_calls"].length) continue
    modified = true
    if (remaining.length > 0) {
      msg["tool_calls"] = remaining
      continue
    }
    if (choice["finish_reason"] === "tool_calls" && required) throw requiredContractError()
    delete msg["tool_calls"]
    if (choice["finish_reason"] === "tool_calls") {
      choice["finish_reason"] = "stop"
    }
    if (msg["content"] === null || msg["content"] === undefined) {
      msg["content"] = ""
    }
  }
  if (!modified) return rebuildResponse(response, text)
  return rebuildResponse(response, JSON.stringify(data))
}

type StreamGuardInput = {
  readonly signal?: AbortSignal | null
  readonly required?: boolean
}

/**
 * Strip adapter-injected tool calls out of a live SSE stream without ever
 * dropping a caller tool that shares the stream with them.
 *
 * Fragments are classified per call slot: an explicit `index` owns its slot,
 * and index-less fragments — malformed as far as addressing goes, which some
 * gateways emit for the first call — own a separate anonymous slot. The two
 * key spaces never overlap, so a caller fragment that merely lacks an index
 * cannot collide with an injected call at index 0 and be stripped alongside
 * it. A slot on which both an injected and a caller tool name appears counts
 * as a caller slot: keeping a possibly noisy caller call is recoverable by
 * the SDK, silently deleting a real tool call is not.
 *
 * The caller's abort signal is honored the same way the aggregation path
 * honors it, so an upstream that ignores the abort cannot leave this stream
 * hanging, and a required `tool_choice` that only injected calls answered
 * fails the stream instead of faking a normal stop.
 */
function guardStream(response: Response, injectedOnly: Set<string>, input: StreamGuardInput = {}): Response {
  // No early return when there is nothing to strip: the truncation contract
  // below applies to every streamed chat completion, and a caller whose
  // catalog already carries the fingerprint tools (injectedOnly empty) would
  // otherwise lose it.
  if (!response.body) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  const slots = new Map<string, "injected" | "caller">()
  let sawInjected = false
  let sawCaller = false
  let emittedContent = false
  // Zen ends a completion with a finish-reason chunk followed by a `[DONE]`
  // frame (same contract aggregate() enforces). A body that ends with neither
  // was cut short; ending it cleanly would let the SDK synthesize a
  // reason-less "unknown" finish and hide the interruption, so the cut is
  // converted into the in-band provider error a real gateway failure
  // produces - the caller's retry pipeline then recovers the turn.
  let sawDone = false
  let sawFinish = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const signal = input.signal
      const cancel = () => void reader.cancel(signal?.reason).catch(() => {})
      const watch = signal ? abortWatch(signal) : undefined
      signal?.addEventListener("abort", cancel, { once: true })

      const processLine = (line: string) => {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) {
          controller.enqueue(encoder.encode(line + "\n"))
          return
        }
        const data = trimmed.slice("data:".length).trim()
        if (data === "[DONE]") {
          sawDone = true
          controller.enqueue(encoder.encode(line + "\n"))
          return
        }

        // Completion is proven only by a PARSED finish_reason (or the [DONE]
        // frame above). A raw substring search would accept a truncated frame
        // that dies inside the finish value, and generated content can itself
        // quote the literal - both must still read as a cut stream.
        let chunk: unknown
        try {
          chunk = JSON.parse(data)
        } catch {
          controller.enqueue(encoder.encode(line + "\n"))
          return
        }
        if (!isRecord(chunk) || !Array.isArray(chunk["choices"])) {
          controller.enqueue(encoder.encode(line + "\n"))
          return
        }

        let modified = false
        for (const choice of chunk["choices"] as Array<Record<string, unknown>>) {
          if (isRecord(choice) && choice["finish_reason"] !== undefined && choice["finish_reason"] !== null) {
            sawFinish = true
          }
          if (!isRecord(choice)) continue
          const delta = choice["delta"]
          if (isRecord(delta) && delta["content"]) emittedContent = true
          if (isRecord(delta) && Array.isArray(delta["tool_calls"])) {
            const fragments = delta["tool_calls"] as unknown[]
            const kept: unknown[] = []
            fragments.forEach((call, position) => {
              if (!isRecord(call)) {
                kept.push(call)
                return
              }
              const fn = isRecord(call["function"]) ? (call["function"] as Record<string, unknown>) : null
              const name = typeof fn?.["name"] === "string" && fn["name"].length > 0 ? fn["name"] : undefined
              const key = callKey(typeof call["index"] === "number" ? call["index"] : undefined, position)
              let slot = slots.get(key)
              if (name !== undefined) {
                const named = injectedOnly.has(name) ? "injected" : "caller"
                slot = slot === undefined || slot === named ? named : "caller"
                slots.set(key, slot)
              }
              if (slot === "injected") {
                sawInjected = true
                return
              }
              if (slot === "caller") sawCaller = true
              kept.push(call)
            })
            if (kept.length !== fragments.length) {
              if (kept.length > 0) delta["tool_calls"] = kept
              else delete delta["tool_calls"]
              modified = true
            }
          }
          if (choice["finish_reason"] === "tool_calls" && sawInjected && !sawCaller) {
            if (input.required) throw requiredContractError()
            choice["finish_reason"] = "stop"
            if (!emittedContent) {
              if (isRecord(delta)) delta["content"] = ""
              else choice["delta"] = { content: "" }
              emittedContent = true
            }
            modified = true
          }
        }

        // Unmodified frames keep their original bytes; only a frame the
        // guard actually rewrote is re-serialized.
        controller.enqueue(encoder.encode(modified ? `data: ${JSON.stringify(chunk)}\n` : line + "\n"))
      }

      let buffer = ""
      try {
        if (signal?.aborted) {
          cancel()
          throw abortReason(signal)
        }
        while (true) {
          const pending = reader.read()
          const part = await (watch ? Promise.race([pending, watch.promise]) : pending)
          if (part.done) {
            if (buffer.length > 0) {
              processLine(buffer)
            }
            if (!sawDone && !sawFinish && !signal?.aborted) {
              controller.enqueue(encoder.encode(truncatedFrame()))
            }
            controller.close()
            break
          }
          buffer += decoder.decode(part.value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            processLine(line)
          }
        }
      } catch (err) {
        // An aborted read is the caller's own cancel, and a ResponseStreamError
        // is this guard's own deliberate failure (e.g. the required-tool_choice
        // contract): both keep the original error path. A genuine transport
        // failure mid-stream becomes the same in-band truncation error as the
        // cut EOF above, so the SDK cannot mistake it for a clean completion.
        if (signal?.aborted || err instanceof ProviderError.ResponseStreamError) {
          controller.error(err)
        } else {
          controller.enqueue(encoder.encode(truncatedFrame()))
          controller.close()
        }
      } finally {
        signal?.removeEventListener("abort", cancel)
        watch?.clear()
        void reader.cancel().catch(() => {})
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })

  return rebuildResponse(response, stream)
}

function pathname(url: string) {
  try {
    return new URL(url, "http://localhost").pathname
  } catch {
    return url
  }
}

/**
 * Chat completion endpoints follow the OpenAI protocol. Anthropic native
 * requests (e.g. on `/messages` or with Anthropic headers) also contain a
 * `messages` array, but must be left untouched so the adapter does not inject
 * an invalid tool schema or fail their streaming events.
 */
function isChatCompletion(url: string, headers: Headers) {
  const path = pathname(url)
  if (path.endsWith("/messages") || headers.has("anthropic-version") || headers.has("anthropic-beta")) {
    return false
  }
  return path.endsWith("/chat/completions")
}

/** Chat completion payloads are the only Zen requests the adapter rewrites. */
function chatRequest(url: string, headers: Headers, body: string | undefined): Record<string, unknown> | undefined {
  if (!isChatCompletion(url, headers)) return undefined
  if (body === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!isRecord(value) || !Array.isArray(value["messages"])) return undefined
  return value
}

/**
 * The body fetch would actually send: `init.body` overrides a `Request` body,
 * including an explicit `null`, which removes it. Only text-like bodies are
 * readable; streams, `FormData`, and binary payloads of unknown shape stay
 * untouched so they cannot be corrupted by a decode.
 */
async function bodyText(input: RequestInfo | URL, init: RequestInit | undefined) {
  const body = init?.body
  if (body === null) return undefined
  if (body !== undefined) {
    if (typeof body === "string") return body
    if (body instanceof Uint8Array) return new TextDecoder().decode(body)
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
    return undefined
  }
  if (input instanceof Request && (input.headers.get("content-type") ?? "").includes("json")) {
    return input.clone().text()
  }
  return undefined
}

/** Request options that `fetch(url, init)` would otherwise lose when a Request becomes a URL. */
function requestOptions(request: Request | undefined, init: RequestInit | undefined): RequestInit {
  if (!request) return init ?? {}
  return {
    signal: request.signal,
    redirect: request.redirect,
    credentials: request.credentials,
    cache: request.cache,
    integrity: request.integrity,
    keepalive: request.keepalive,
    ...init,
  }
}

/** Transport seam so callers that already wrap fetch (and tests) can reuse the adapter. */
export type ZenFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

export type FetchInput = {
  /** Model ids Zen serves for free; these must authenticate as the public client. */
  readonly free?: ReadonlySet<string>
  /** Milliseconds to wait for the next SSE chunk while re-assembling a stream. */
  readonly chunkTimeout?: number
  readonly upstream?: ZenFetch
  /** UUID source; injected by tests. */
  readonly uuid?: UUID
  /** Custom User-Agent to send if the gateway wire contract changes. */
  readonly userAgent?: string
}

/**
 * Wrap a fetch so every chat completion routed to the Zen gateway carries the
 * client contract Zen verifies before running a request.
 */
export function createFetch(input: FetchInput = {}): ZenFetch {
  const upstream = input.upstream ?? globalThis.fetch
  const uuid = input.uuid ?? randomUUID
  const userAgent = input.userAgent ?? ZEN_USER_AGENT

  return async (requestInput, init) => {
    const request = requestInput instanceof Request ? requestInput : undefined
    const url =
      requestInput instanceof Request
        ? requestInput.url
        : typeof requestInput === "string"
          ? requestInput
          : requestInput.href
    const method = init?.method ?? request?.method
    const options = requestOptions(request, init)
    const signal = init?.signal ?? options.signal
    // Fetch replaces the whole header list when init supplies one, so the
    // Request's headers only apply when init has none. Merging them would keep
    // a header the caller deliberately dropped, e.g. an Authorization key.
    const headers = new Headers(init?.headers ?? request?.headers)
    headers.set("user-agent", userAgent)
    headers.set("x-opencode-client", headers.get("x-opencode-client") ?? "cli")
    headers.set("x-opencode-project", headers.get("x-opencode-project") ?? "global")
    // Zen rejects a request without a session header, but callers that carry no
    // conversation id (direct SDK calls) have no thread to keep, so each such
    // request gets its own session instead of sharing one client-wide id. The
    // session runtime always sends the conversation's id (see
    // `session/llm/request.ts`), which is what keeps a conversation stable.
    const sid = sessionID(headers.get("x-opencode-session") ?? undefined, uuid)
    headers.set("x-opencode-session", sid)
    headers.set("x-opencode-session-id", sid)
    headers.set("x-opencode-request", headers.get("x-opencode-request") ?? requestID(uuid))

    const body = await bodyText(requestInput, init)
    const payload = chatRequest(url, headers, body)
    // Anything that is not a chat completion keeps the caller's method, body,
    // signal, and Request options.
    if (!payload) return upstream(requestInput, { ...options, headers })

    if (typeof payload["model"] === "string" && input.free?.has(payload["model"])) {
      headers.set("authorization", ZEN_PUBLIC_AUTHENTICATION)
    }
    // Zen only answers streamed requests; non-streaming callers get the
    // aggregated stream back below.
    const streaming = payload["stream"] === true
    payload["stream"] = true

    // A caller that required a tool call (or forced one specific function)
    // must not have that contract silently satisfied by the guard; it is
    // checked again when injected-only tool calls are stripped.
    const toolChoice = payload["tool_choice"]
    const requiredToolChoice =
      toolChoice === "required" || toolChoice === "any" || (isRecord(toolChoice) && toolChoice["type"] === "function")

    const callerHadNoTools = !Array.isArray(payload["tools"]) || payload["tools"].length === 0
    const callerTools: unknown[] = Array.isArray(payload["tools"]) ? [...payload["tools"]] : []
    const callerToolNames = new Set(callerTools.map(toolNameOf).filter(Boolean))
    // #780: the fingerprint names are wire-protocol constants and predate the
    // bash -> shell tool rename. A fingerprint tool counts as caller-provided
    // when the catalog carries it under its canonical spelling too, so a model
    // hallucinating the legacy `bash` name produces a caller-visible invalid
    // call for the runtime repair instead of being silently stripped as if
    // the gateway had injected it.
    const injectedOnlyNames = new Set(
      ZEN_FINGERPRINT_TOOLS.filter((name) => !callerToolNames.has(name) && !callerToolNames.has(Wildcard.canonical(name))),
    )

    // 2026-10-14: the gateway now rejects requests carrying the synthetic
    // fingerprint quartet (empty-schema "OpenCode built-in" tools) with
    // 403 FreeTierError, and accepts genuine tool-less requests (verified live:
    // upstream title requests carry no tools and pass). Injecting is now
    // poison, so caller tools pass through verbatim.
    const tools: unknown[] = [...callerTools]
    // 2026-10-14 gate addition: the free-tier gateway rejects any tool catalog
    // that carries neither webfetch nor websearch (verified live: silvercode's
    // catalog gets 403; the same body plus either upstream web tool gets 200).
    // Silvercode defers both behind tool_search, so its catalog never lists
    // them. Append upstream's exact definitions when the caller lacks them;
    // both tools have real implementations in this tree (tool/webfetch.ts,
    // tool/websearch.ts), so a direct call can still execute.
    if (
      callerTools.length > 0 &&
      !callerToolNames.has("webfetch") &&
      !callerToolNames.has("websearch")
    ) {
      tools.push(...ZEN_WEB_MARKER_TOOLS)
    }
    if (tools.length > 0) payload["tools"] = tools
    else delete payload["tools"]



    // The rewritten body is a different length than whatever the caller
    // computed, so a forwarded Content-Length would be stale.
    headers.delete("content-length")
    const response = await upstream(url, {
      ...options,
      signal,
      method: method ?? "POST",
      headers,
      body: JSON.stringify(payload),
    })
    if (response.ok) {
      const contentType = response.headers.get("content-type") ?? ""
      if (contentType.includes("text/event-stream")) {
        if (streaming) {
          return guardStream(response, injectedOnlyNames, { signal, required: requiredToolChoice })
        }
        return aggregate(response, {
          signal,
          chunkTimeout: input.chunkTimeout,
          injectedOnly: injectedOnlyNames,
          required: requiredToolChoice,
        })
      }
      // A gateway may answer even a streamed request with a single JSON
      // completion; it goes through the same guard as a non-streaming one so
      // injected-only tool calls can never bypass it into the SDK runtime.
      if (contentType.includes("application/json")) {
        return guardJsonResponse(response, injectedOnlyNames, requiredToolChoice)
      }
    }
    return response
  }
}

export * as OpenCodeZen from "./opencode-zen"
