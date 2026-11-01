/**
 * Streaming tool-call parser.
 *
 * Qwen Web has no native tool API, so tools are offered through prompt
 * instructions and the model emits JSON blocks wrapped in marker tags
 * (see `constants.ts`). This parser incrementally extracts those blocks from
 * streamed text while passing ordinary text through untouched.
 *
 * Accepted shapes inside a block:
 * - `{"name": "...", "arguments": {...}}`
 * - `{"function": {"name": "...", "arguments": {...}}}`
 * - `<name ...>` open tag attribute with a JSON body
 *
 * `arguments` may be an object or a JSON-encoded string. Malformed blocks are
 * recovered on a best-effort basis; unrecoverable ones are preserved as text
 * so no model output is ever silently dropped.
 */
import {
  QWEN_WEB_TOOL_CLOSE,
  QWEN_WEB_TOOL_CLOSE_NAMES,
  QWEN_WEB_TOOL_OPEN,
  QWEN_WEB_TOOL_OPEN_NAMES,
} from "./constants"
import { randomId } from "./protocol"

export interface ParsedToolCall {
  id: string
  name: string
  /** Stringified JSON arguments. */
  input: string
}

export interface ToolParserResult {
  /** Ordinary text with tool blocks removed. */
  text: string
  /** Tool calls completed by this push. */
  toolCalls: ParsedToolCall[]
}

export interface ToolParserOptions {
  /** Max tool calls accepted per parser lifetime (turn). Default 32. */
  maxToolCalls?: number
  /** Declared tool names; unknown names are still parsed (the AI SDK repairs them). */
  declared?: Set<string>
}

const MAX_TOOL_CALLS_DEFAULT = 32

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function openTagPattern(names: readonly string[]): RegExp {
  return new RegExp(`<(${names.map(escapeRegExp).join("|")})\\b[^>]*>`, "i")
}

function findOpen(buffer: string): { index: number; length: number; tag: string; nameAttr?: string } | null {
  const pattern = openTagPattern(QWEN_WEB_TOOL_OPEN_NAMES)
  const match = pattern.exec(buffer)
  if (!match || match.index === undefined) return null
  const tag = match[0]
  const nameAttr = /name\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
  return { index: match.index, length: tag.length, tag, nameAttr }
}

function matchCloseAt(buffer: string, index: number): number | null {
  for (const name of QWEN_WEB_TOOL_CLOSE_NAMES) {
    const prefix = `</${name}`
    if (buffer.length < index + prefix.length) continue
    if (buffer.slice(index, index + prefix.length).toLowerCase() !== prefix) continue
    let end = index + prefix.length
    while (end < buffer.length && /\s/.test(buffer[end]!)) end++
    if (buffer[end] === ">") return end + 1 - index
  }
  return null
}

function findClose(buffer: string, from: number): { index: number; length: number } | null {
  let cursor = from
  while (cursor < buffer.length) {
    const next = buffer.indexOf("<", cursor)
    if (next === -1) return null
    const length = matchCloseAt(buffer, next)
    if (length !== null) return { index: next, length }
    cursor = next + 1
  }
  return null
}

/** Length of a trailing partial open/close tag prefix that must be held back. */
function trailingPartialTagLength(buffer: string): number {
  const tail = buffer.slice(-24)
  const candidates = [
    ...QWEN_WEB_TOOL_OPEN_NAMES.map((name) => `<${name}`),
    ...QWEN_WEB_TOOL_CLOSE_NAMES.map((name) => `</${name}`),
  ]
  let best = 0
  for (let length = 1; length <= tail.length; length++) {
    const suffix = tail.slice(-length)
    if (candidates.some((candidate) => candidate.toLowerCase().startsWith(suffix.toLowerCase()))) best = length
  }
  return best
}

const ANY_STRAY_CLOSE_PATTERN = new RegExp(
  `\\s*<\\/(?:${QWEN_WEB_TOOL_CLOSE_NAMES.map(escapeRegExp).join("|")})\\s*>`,
  "ig",
)

function stripStrayCloses(value: string): string {
  return value.replace(ANY_STRAY_CLOSE_PATTERN, "")
}

/**
 * Recover a tool call whose opening tag the model omitted: a JSON tool-call
 * object followed by a stray close tag (observed when batch emissions degrade
 * mid-turn). Returns the text prefix, the parsed call, and the offset past the
 * close tag so the caller can slice the block out of the buffer.
 */
function tryOpenlessBlock(
  buffer: string,
  declared?: Set<string>,
): { prefix: string; call: ParsedToolCall; closeEnd: number } | undefined {
  const close = findClose(buffer, 0)
  if (!close) return undefined
  const text = buffer.slice(0, close.index)
  // Walk `{` candidates outermost-first: arguments may contain a nested
  // `"name"` key (e.g. a filename), and an innermost-first walk would
  // fabricate a call from that nested object and leak the outer JSON as text.
  const starts: number[] = []
  for (let index = text.indexOf("{"); index !== -1; index = text.indexOf("{", index + 1)) starts.push(index)
  for (const jsonStart of starts) {
    const call = toToolCall(repairJsonPayload(text.slice(jsonStart)), undefined, declared)
    if (call) return { prefix: text.slice(0, jsonStart), call, closeEnd: close.index + close.length }
  }
  return undefined
}

/**
 * Built per call: the `exec` loop in `tryParameterBlock` moves `lastIndex`,
 * so a shared module-level instance would carry state between calls.
 */
const parameterPattern = () => /<parameter=([A-Za-z_][\w-]*)>([\s\S]*?)<\/parameter>/g
const XML_CALL_START = /<function=([^>\s]+)>\s*(?=<parameter=)/g
const HYBRID_CALL_START = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*\{\s*"([A-Za-z_][\w-]*)"\s*:\s*"/g
const FUNCTION_OPEN = "<function="
const PARAMETER_OPEN = "<parameter="

/**
 * Where a parameter-style call may start. Contract: it is recognized only
 * outside a markdown code fence (``` or ~~~), at the start of a line (at most
 * 3 spaces of indentation: deeper is indented code), and
 * (when the caller declared its tools) with a declared tool name. This keeps
 * an example of the format, quoted or explained in prose or a code block,
 * from becoming a call.
 */
export interface ParameterContext {
  /** Fence/line state of the text already emitted before this buffer. */
  state: FenceState
  declared?: Set<string>
}

interface FenceState {
  open: { ch: string; len: number } | null
  /** Content of the current (unfinished) output line. */
  line: string
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/

function fenceStep(open: FenceState["open"], line: string): FenceState["open"] {
  const m = FENCE_LINE.exec(line)
  if (!open) {
    if (!m) return null
    // The info string of a backtick fence cannot contain a backtick.
    if (m[1]![0] === "`" && m[2]!.includes("`")) return null
    return { ch: m[1]![0]!, len: m[1]!.length }
  }
  if (m && m[1]![0] === open.ch && m[1]!.length >= open.len && m[2]!.trim() === "") return null
  return open
}

function advanceFence(state: FenceState, text: string): FenceState {
  const parts = (state.line + text).split("\n")
  const line = parts.pop()!
  let open = state.open
  // CRLF input: the carriage return is part of the line break, not the line.
  for (const part of parts) open = fenceStep(open, part.replace(/\r$/, ""))
  return { open, line }
}

function startAllowed(buffer: string, index: number, ctx: ParameterContext): boolean {
  const state = advanceFence(ctx.state, buffer.slice(0, index))
  // Up to 3 leading spaces are fine. 4+ spaces or a tab is Markdown indented
  // code, so a call written there is an example, not a call.
  return state.open === null && /^ {0,3}$/.test(state.line.replace(/\r$/, ""))
}

function trimOneNewline(value: string): string {
  return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "")
}

function parameterValue(value: string): unknown {
  const trimmed = trimOneNewline(value)
  const structured = /^\s*[\[{]/.test(trimmed) ? tryParse(trimmed) : undefined
  return structured !== undefined && typeof structured === "object" ? structured : trimmed
}

interface ParameterBlock {
  prefix: string
  call: ParsedToolCall
  /** Offset just past the last closed parameter. */
  end: number
}

/**
 * Recover a call written as `<function=NAME><parameter=KEY>VALUE</parameter>...</function>`,
 * or the observed hybrid that starts as JSON (`{"name":"write","arguments":{"content":"`),
 * carries the first value RAW (unescaped, multi-line) and finishes with
 * `</parameter><parameter=KEY>VALUE</parameter></function>`. `prefix` is the
 * text before the call; `end` lets the caller keep any text after it.
 */
function tryParameterBlock(text: string, ctx: ParameterContext): ParameterBlock | undefined {
  const starts: Array<{ index: number; xml: RegExpExecArray | null; hybrid: RegExpExecArray | null }> = []
  for (const m of text.matchAll(XML_CALL_START)) starts.push({ index: m.index!, xml: m, hybrid: null })
  for (const m of text.matchAll(HYBRID_CALL_START)) starts.push({ index: m.index!, xml: null, hybrid: m })
  starts.sort((x, y) => x.index - y.index)
  for (const start of starts) {
    if (!startAllowed(text, start.index, ctx)) continue
    const name = (start.xml ?? start.hybrid)![1]!
    if (ctx.declared && !ctx.declared.has(name)) continue
    const args: Record<string, unknown> = {}
    let end: number
    if (start.xml) {
      end = start.index + start.xml[0].length
    } else {
      const hybrid = start.hybrid!
      const valueStart = start.index + hybrid[0].length
      const firstEnd = text.indexOf("</parameter>", valueStart)
      if (firstEnd === -1) continue
      // The value opens right after the JSON quote, so a leading newline is
      // real content. Only the one newline Qwen writes before `</parameter>`
      // (the same delimiter the XML form uses) is dropped.
      args[hybrid[2]!] = text.slice(valueStart, firstEnd).replace(/\r?\n$/, "")
      end = firstEnd + "</parameter>".length
    }
    const parameters = parameterPattern()
    parameters.lastIndex = end
    let gapFrom = end
    for (let m = parameters.exec(text); m; m = parameters.exec(text)) {
      // Only whitespace may sit between parameters; anything else is not this call.
      if (text.slice(gapFrom, m.index).trim() !== "") break
      args[m[1]!] = parameterValue(m[2]!)
      gapFrom = m.index + m[0].length
    }
    end = gapFrom
    if (Object.keys(args).length === 0) continue
    return { prefix: text.slice(0, start.index), call: { id: `call_${randomId()}`, name, input: JSON.stringify(args) }, end }
  }
  return undefined
}

/** True when `tail` could still grow into `<function=NAME>\s*<parameter=`. */
function viableFunctionPrefix(tail: string): boolean {
  if (tail.length < FUNCTION_OPEN.length) return FUNCTION_OPEN.startsWith(tail)
  if (!tail.startsWith(FUNCTION_OPEN)) return false
  const rest = /^([^>\s]*)(?:>(\s*)(.*))?$/s.exec(tail.slice(FUNCTION_OPEN.length))
  if (!rest) return false
  if (rest[3] === undefined) return rest[2] === undefined
  return PARAMETER_OPEN.startsWith(rest[3])
}

/** Best-effort JSON recovery: fences, trailing commas, truncation. */
export function repairJsonPayload(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const direct = tryParse(trimmed)
  if (direct !== undefined) return direct

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
  if (unfenced !== trimmed) {
    const parsed = tryParse(unfenced)
    if (parsed !== undefined) return parsed
  }

  const noTrailingCommas = unfenced.replace(/,(\s*[}\]])/g, "$1")
  if (noTrailingCommas !== unfenced) {
    const parsed = tryParse(noTrailingCommas)
    if (parsed !== undefined) return parsed
  }

  const balanced = extractBalancedObject(unfenced)
  if (balanced !== undefined) {
    const parsed = tryParse(balanced)
    if (parsed !== undefined) return parsed
  }

  const completed = completeTruncatedJson(unfenced)
  if (completed !== undefined) {
    const parsed = tryParse(completed)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** Extract the first balanced `{...}` object from the text. */
function extractBalancedObject(value: string): string | undefined {
  const start = value.indexOf("{")
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < value.length; index++) {
    const char = value[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) return value.slice(start, index + 1)
    }
  }
  return undefined
}

/** Close unterminated strings/objects/arrays for truncated payloads. */
function completeTruncatedJson(value: string): string | undefined {
  const start = value.indexOf("{")
  if (start === -1) return undefined
  let result = value.slice(start)
  let inString = false
  let escaped = false
  const stack: string[] = []
  for (const char of result) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") stack.push("}")
    else if (char === "[") stack.push("]")
    else if (char === "}" || char === "]") stack.pop()
  }
  if (inString) result += '"'
  const closeStack = (text: string): string => {
    let out = text
    const remaining = [...stack]
    while (remaining.length > 0) out += remaining.pop()
    return out
  }
  // A truncated string value usually just needs its closing quote.
  const closed = closeStack(result)
  if (tryParse(closed) !== undefined) return closed
  // Otherwise drop a dangling partial token (trailing `,`, or an incomplete
  // `"key` with no value yet) and close what remains.
  const stripped = result
    .replace(/,\s*$/, "")
    .replace(/"[^"]*$/, (match) => (match.includes(":") ? match : ""))
    .replace(/,\s*"[^":,]*$/, "")
  return closeStack(stripped)
}

function normalizeArguments(value: unknown): string {
  if (typeof value === "string") {
    const parsed = tryParse(value)
    return JSON.stringify(parsed === undefined ? { _raw: value } : parsed)
  }
  if (value && typeof value === "object") return JSON.stringify(value)
  return JSON.stringify(value ?? {})
}

/** Interpret a parsed block payload as a tool call, if possible. */
function toToolCall(
  payload: unknown,
  nameAttr: string | undefined,
  declared?: Set<string>,
): ParsedToolCall | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  const fn = record["function"]
  const fnRecord = fn && typeof fn === "object" && !Array.isArray(fn) ? (fn as Record<string, unknown>) : undefined
  const nameRaw = fnRecord?.["name"] ?? record["name"]
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : nameAttr?.trim()
  if (!name) return undefined
  if (declared && declared.size > 0 && !declared.has(name)) {
    // Still accept: the AI SDK repair hook converts unknown tools into a
    // visible `invalid` tool error instead of dropping the call silently.
  }
  const args = fnRecord?.["arguments"] ?? record["arguments"] ?? record["args"] ?? record["parameters"] ?? {}
  const idRaw = record["id"]
  return {
    id: typeof idRaw === "string" && idRaw ? idRaw : `call_${randomId()}`,
    name,
    input: normalizeArguments(args),
  }
}

export class StreamingToolParser {
  private buffer = ""
  private calls = 0
  private readonly maxCalls: number
  private readonly declared?: Set<string>
  private capped = false
  /** Fence and line state of everything emitted so far. */
  private fenceState: FenceState = { open: null, line: "" }

  constructor(options?: ToolParserOptions) {
    this.maxCalls = options?.maxToolCalls ?? MAX_TOOL_CALLS_DEFAULT
    this.declared = options?.declared
  }

  private get ctx(): ParameterContext {
    return { state: this.fenceState, declared: this.declared }
  }

  /** Record text as emitted (fence and line state) and pass it through. */
  private note(emitted: string): string {
    this.fenceState = advanceFence(this.fenceState, emitted)
    return emitted
  }

  /**
   * Offset of a parameter-style call that has started (or may still be
   * starting) in the buffer but cannot be resolved yet, or -1.
   */
  private pendingParameterStart(): number {
    const buffer = this.buffer
    const ctx = this.ctx
    const found: number[] = []
    for (const m of buffer.matchAll(XML_CALL_START)) found.push(m.index!)
    for (const m of buffer.matchAll(HYBRID_CALL_START)) found.push(m.index!)
    // A start still arriving: the last `<function` may be a partial prefix.
    const partial = buffer.lastIndexOf("<function")
    if (partial !== -1 && viableFunctionPrefix(buffer.slice(partial))) found.push(partial)
    const trailingFunction = /<(?:f(?:u(?:n(?:c(?:t(?:i(?:o(?:n)?)?)?)?)?)?)?)?$/.exec(buffer)
    if (trailingFunction) found.push(trailingFunction.index)
    return found.sort((x, y) => x - y).find((index) => startAllowed(buffer, index, ctx)) ?? -1
  }

  /**
   * Resolve a parameter-style call at the front of the buffer. A call is
   * complete with its `</function>` close; at end of stream (`final`) it is
   * also complete once its last parameter closed, unless it was cut off
   * inside a parameter. Text after the call stays in the buffer.
   */
  private drainParameterBlock(final: boolean): { text: string; call: ParsedToolCall } | undefined {
    const block = tryParameterBlock(this.buffer, this.ctx)
    if (!block) return undefined
    const after = this.buffer.slice(block.end)
    const close = /^\s*<\/function>/.exec(after)
    if (!close && (!final || /<parameter=/.test(after))) return undefined
    const text = stripStrayCloses(block.prefix)
    this.buffer = after.slice(close ? close[0].length : 0)
    return { text, call: block.call }
  }

  get toolCallCount(): number {
    return this.calls
  }

  get isCapped(): boolean {
    return this.capped
  }

  push(chunk: string): ToolParserResult {
    this.buffer += chunk
    const toolCalls: ParsedToolCall[] = []
    let text = ""

    for (;;) {
      const open = findOpen(this.buffer)
      if (!open) {
        const parameterCall = this.capped ? undefined : this.drainParameterBlock(false)
        if (parameterCall) {
          text += this.note(parameterCall.text)
          this.calls++
          if (this.calls > this.maxCalls) this.capped = true
          else toolCalls.push(parameterCall.call)
          continue
        }
        // The model sometimes drops the opening tag on a batch of calls
        // (degenerate multi-call output). If a stray close tag follows a
        // tool-call JSON object, reconstruct the block instead of pasting it.
        const repaired = tryOpenlessBlock(this.buffer, this.declared)
        if (repaired && !this.capped) {
          if (stripStrayCloses(repaired.prefix).trim().length > 0) text += stripStrayCloses(repaired.prefix)
          this.buffer = this.buffer.slice(repaired.closeEnd)
          this.calls++
          if (this.calls > this.maxCalls) this.capped = true
          else toolCalls.push(repaired.call)
          continue
        }
        break
      }
      // The prefix before the first open tag may itself hold degenerate
      // openless blocks (a batch whose later blocks kept their tags while an
      // earlier one lost its open tag). Drain those first so they are not
      // emitted as text.
      const openAt = open.index
      let prefix = this.buffer.slice(0, openAt)
      for (;;) {
        const repaired = tryOpenlessBlock(prefix, this.declared)
        if (!repaired || this.capped) break
        const cleaned = stripStrayCloses(repaired.prefix)
        if (cleaned.trim().length > 0) text += cleaned
        prefix = prefix.slice(repaired.closeEnd)
        this.calls++
        if (this.calls > this.maxCalls) this.capped = true
        else toolCalls.push(repaired.call)
      }
      if (prefix.length !== openAt) {
        this.buffer = prefix + this.buffer.slice(openAt)
        continue
      }
      // Emit text preceding the block, holding back a partial tag at the end.
      text += this.note(stripStrayCloses(this.buffer.slice(0, open.index)))
      const afterOpen = open.index + open.length
      const close = findClose(this.buffer, afterOpen)
      if (!close) {
        // Incomplete block: keep everything from the open tag buffered.
        this.buffer = this.buffer.slice(open.index)
        return { text, toolCalls }
      }
      const raw = this.buffer.slice(afterOpen, close.index)
      this.buffer = this.buffer.slice(close.index + close.length)
      const call = toToolCall(repairJsonPayload(stripStrayCloses(raw)), open.nameAttr, this.declared)
      if (call && !this.capped) {
        this.calls++
        if (this.calls > this.maxCalls) {
          this.capped = true
        } else {
          toolCalls.push(call)
        }
      } else if (!call) {
        // Unparseable: preserve the content as text rather than dropping it.
        text += this.note(raw.trim() ? `${raw.trim()}\n` : "")
      }
      // `text` keeps accumulating; loop to find further blocks.
    }

    // A parameter-style call (see `tryParameterBlock`) that has started but not
    // closed yet: keep it buffered so its raw multi-line body is not emitted as text.
    const pending = this.pendingParameterStart()
    if (pending !== -1) {
      text += this.note(stripStrayCloses(this.buffer.slice(0, pending)))
      this.buffer = this.buffer.slice(pending)
      return { text, toolCalls }
    }

    // No (more) open tags: emit everything except a trailing partial tag and a
    // trailing line that may yet become a tool-call JSON (its close tag can
    // arrive in the next chunk and is unrecoverable once the text is emitted).
    const holdBack = trailingPartialTagLength(this.buffer)
    if (holdBack > 0) {
      const head = this.buffer.slice(0, this.buffer.length - holdBack)
      const partial = this.buffer.slice(this.buffer.length - holdBack)
      // A partial close tag may complete in the next chunk; the JSON line
      // before it is unrecoverable once emitted, so hold it back as well.
      const content = head.endsWith("\n") ? head.slice(0, -1) : head
      const contentLf = content.lastIndexOf("\n")
      const candidate = contentLf === -1 ? content : content.slice(contentLf + 1)
      if (candidate.length > 0 && /^[ \t]*[\[{]/.test(candidate)) {
        const holdFrom = content.length - candidate.length
        text += this.note(stripStrayCloses(head.slice(0, holdFrom)))
        this.buffer = head.slice(holdFrom) + partial
      } else {
        text += this.note(stripStrayCloses(head))
        this.buffer = partial
      }
    } else {
      const lastLf = this.buffer.lastIndexOf("\n")
      const lineStart = lastLf === this.buffer.length - 1 ? this.buffer.lastIndexOf("\n", lastLf - 1) : lastLf
      const tail = lineStart === -1 ? this.buffer : this.buffer.slice(lineStart + 1)
      if (tail.length > 0 && /^[ \t]*[\[{]/.test(tail)) {
        text += this.note(stripStrayCloses(this.buffer.slice(0, this.buffer.length - tail.length)))
        this.buffer = tail
      } else {
        text += this.note(stripStrayCloses(this.buffer))
        this.buffer = ""
      }
    }
    return { text, toolCalls }
  }

  /** End of stream: recover an unclosed block, then emit leftovers as text. */
  flush(): ToolParserResult {
    const toolCalls: ParsedToolCall[] = []
    let text = ""

    // Drain degenerate openless blocks first (close tag with no open tag).
    for (;;) {
      if (findOpen(this.buffer) || this.capped) break
      const repaired = tryOpenlessBlock(this.buffer, this.declared)
      if (!repaired) break
      if (stripStrayCloses(repaired.prefix).trim().length > 0) text += stripStrayCloses(repaired.prefix)
      this.buffer = this.buffer.slice(repaired.closeEnd)
      this.calls++
      if (this.calls > this.maxCalls) this.capped = true
      else toolCalls.push(repaired.call)
    }

    while (!findOpen(this.buffer) && !this.capped) {
      const parameterCall = this.drainParameterBlock(true)
      if (!parameterCall) break
      text += this.note(parameterCall.text)
      this.calls++
      if (this.calls > this.maxCalls) this.capped = true
      else toolCalls.push(parameterCall.call)
    }

    let open = findOpen(this.buffer)
    if (open && !this.capped) {
      // Drain degenerate openless blocks from the text preceding the open tag
      // (same as push: they must not be emitted as text).
      const openAt = open.index
      let prefix = this.buffer.slice(0, openAt)
      for (;;) {
        const repaired = tryOpenlessBlock(prefix, this.declared)
        if (!repaired || this.capped) break
        const cleaned = stripStrayCloses(repaired.prefix)
        if (cleaned.trim().length > 0) text += cleaned
        prefix = prefix.slice(repaired.closeEnd)
        this.calls++
        if (this.calls > this.maxCalls) this.capped = true
        else toolCalls.push(repaired.call)
      }
      if (prefix.length !== openAt) {
        this.buffer = prefix + this.buffer.slice(openAt)
        open = findOpen(this.buffer)
      }
    }
    if (open && !this.capped) {
      const raw = stripStrayCloses(this.buffer.slice(open.index + open.length))
        .replace(/<\/?(?:qw_call|tool_calls?)\b[^>]*$/i, "")
        .trim()
      text += this.note(stripStrayCloses(this.buffer.slice(0, open.index)))
      const call = raw ? toToolCall(repairJsonPayload(raw), open.nameAttr, this.declared) : undefined
      if (call) {
        this.calls++
        if (this.calls <= this.maxCalls) toolCalls.push(call)
        else this.capped = true
      } else if (raw) {
        text += this.note(raw)
      }
    } else {
      text += this.note(stripStrayCloses(this.buffer))
    }
    this.buffer = ""
    return { text, toolCalls }
  }
}

/** Convenience: parse a complete (non-streamed) response. */
export function parseCompleteResponse(text: string, options?: ToolParserOptions): ToolParserResult {
  const parser = new StreamingToolParser(options)
  const first = parser.push(text)
  const last = parser.flush()
  return { text: first.text + last.text, toolCalls: [...first.toolCalls, ...last.toolCalls] }
}

export const TOOL_TAG_OPEN = QWEN_WEB_TOOL_OPEN
export const TOOL_TAG_CLOSE = QWEN_WEB_TOOL_CLOSE
