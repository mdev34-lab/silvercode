import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { isRecord } from "@/util/record"

type Segment =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }

const THINK_OPEN = "<think>"
const THINK_CLOSE = "</think>"

type Counter = { next: number }

// Some Pollinations backends (observed: GLM-5.3-Flash-T, GPT-6-Luna via Poe)
// return reasoning and tool calls as plain text: <think>...</think> blocks
// followed by {"name":"tool","arguments":{...}} or {"name":null,"message":"..."}
// envelopes. This middleware promotes that protocol to native reasoning and
// tool-call content so the agent loop actually executes the calls.
//
// Scoping is anchored and deterministic: content is protocol only when it
// STARTS (after whitespace) with a think block or an envelope-shaped object.
// Text that merely quotes a think block or envelope-shaped JSON anywhere
// else, including documentation examples naming offered tools, is always
// preserved as ordinary text and never executed.
//
// Robustness rules (regressions fixed from the first version):
// - An unterminated leading think block is salvaged as reasoning instead of
//   throwing and killing the turn.
// - An envelope naming a tool that was not offered is demoted to visible
//   text instead of throwing and killing the turn.
// - Plain text streams live instead of being buffered until the stream ends,
//   and protocol reasoning is emitted as soon as its think block closes.
// - Both observed envelope dialects decode: parameters nested under
//   "arguments" and the flat form {"name":"shell","command":"pwd"} seen
//   when the real agent loop drives these backends.
export function parsePollinationsProtocol(
  content: string,
  options: LanguageModelV3CallOptions,
  counter: Counter = { next: 0 },
): Segment[] {
  const tools = new Set(options.tools?.filter((tool) => tool.type === "function").map((tool) => tool.name))
  const start = content.search(/\S/)
  if (start < 0) return [{ type: "text", text: content }]
  if (!content.startsWith(THINK_OPEN, start)) {
    if (content[start] !== "{") return [{ type: "text", text: content }]
    const scan = scanJSONObject(content, start)
    if (scan.status !== "complete" || !isEnvelopeShape(scan.value)) return [{ type: "text", text: content }]
  }

  const segments: Segment[] = []
  let cursor = start

  while (cursor < content.length) {
    if (content.startsWith(THINK_OPEN, cursor)) {
      const end = content.indexOf(THINK_CLOSE, cursor + THINK_OPEN.length)
      if (end < 0) {
        // Salvage: truncated reasoning still reaches the user as reasoning.
        segments.push({ type: "reasoning", text: content.slice(cursor + THINK_OPEN.length) })
        cursor = content.length
        continue
      }
      segments.push({ type: "reasoning", text: content.slice(cursor + THINK_OPEN.length, end) })
      cursor = end + THINK_CLOSE.length
      continue
    }

    if (content[cursor] === "{") {
      const scan = scanJSONObject(content, cursor)
      if (scan.status === "complete") {
        const envelope = decodeEnvelope(scan.value, tools, counter)
        if (envelope) {
          segments.push(envelope)
          cursor = scan.end
          continue
        }
        // A complete non-envelope object (or a demoted unknown-tool envelope)
        // is ordinary output. Consume it as a unit so protocol-shaped objects
        // nested inside it cannot be promoted.
        segments.push({ type: "text", text: content.slice(cursor, scan.end) })
        cursor = scan.end
        continue
      }
      if (scan.status === "incomplete") {
        // Truncated object at the end: keep the remainder visible as text.
        segments.push({ type: "text", text: content.slice(cursor) })
        cursor = content.length
        continue
      }
    }

    const startOfText = cursor
    cursor++
    while (cursor < content.length && !content.startsWith(THINK_OPEN, cursor) && content[cursor] !== "{") cursor++
    segments.push({ type: "text", text: content.slice(startOfText, cursor) })
  }

  return coalesce(segments).reduce<Segment[]>((result, segment) => {
    if (segment.type !== "text") return [...result, segment]
    const text = segment.text.trim()
    return text ? [...result, { ...segment, text }] : result
  }, [])
}

export const pollinationsProtocolMiddleware: LanguageModelV3Middleware = {
  specificationVersion: "v3",
  async wrapGenerate(options) {
    const result = await options.doGenerate()
    const counter: Counter = { next: 0 }
    let sawToolCall = false
    const content = result.content.flatMap((part) => {
      if (part.type !== "text") return [part]
      const segments = parsePollinationsProtocol(part.text, options.params, counter)
      segments.forEach((segment) => {
        if (segment.type === "tool-call") sawToolCall = true
      })
      return toContent(segments)
    })
    // The mapped content is returned even without a tool call so reasoning
    // and answer envelopes are still decoded; only the finishReason differs.
    return {
      ...result,
      content,
      finishReason: sawToolCall ? { unified: "tool-calls", raw: result.finishReason.raw } : result.finishReason,
    }
  },

  async wrapStream(options) {
    const result = await options.doStream()
    return { ...result, stream: transformStream(result.stream, options.params) }
  },
}

function transformStream(stream: ReadableStream<LanguageModelV3StreamPart>, options: LanguageModelV3CallOptions) {
  const reader = stream.getReader()
  const counter: Counter = { next: 0 }
  const tools = new Set(options.tools?.filter((tool) => tool.type === "function").map((tool) => tool.name))
  let partCounter = 0
  let sawToolCall = false
  let emitted = false

  function out(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>, part: LanguageModelV3StreamPart) {
    emitted = true
    controller.enqueue(part)
  }

  // Per upstream text part state.
  let textID: string | undefined
  let started = false // the real text-start was forwarded (plain mode)
  let mode: "undecided" | "plain" | "protocol" = "undecided"
  let pending = ""
  let openText: string | undefined // synthetic text part currently open (protocol mode)

  const newPartId = (kind: string) => `pollinations-${kind}-${partCounter++}`

  function openTextPart(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) {
    if (openText) return
    openText = newPartId("text")
    out(controller, { type: "text-start", id: openText } as LanguageModelV3StreamPart)
  }

  function closeTextPart(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) {
    if (!openText) return
    out(controller, { type: "text-end", id: openText } as LanguageModelV3StreamPart)
    openText = undefined
  }

  function emitTextDelta(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>, delta: string) {
    if (!delta) return
    openTextPart(controller)
    out(controller, { type: "text-delta", id: openText, delta } as LanguageModelV3StreamPart)
  }

  function emitSegment(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>, segment: Segment) {
    closeTextPart(controller)
    if (segment.type === "tool-call") {
      sawToolCall = true
      out(controller, segment)
      return
    }
    const id = newPartId(segment.type)
    out(controller, { type: `${segment.type}-start`, id } as LanguageModelV3StreamPart)
    out(controller, { type: `${segment.type}-delta`, id, delta: segment.text } as LanguageModelV3StreamPart)
    out(controller, { type: `${segment.type}-end`, id } as LanguageModelV3StreamPart)
  }

  // Emit every element of pending that is complete; hold the undecidable tail.
  // Mirrors parsePollinationsProtocol's scan so stream and generate classify
  // identically. With flush, the remainder is forced out (salvage rules).
  function processProtocol(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>, flush: boolean) {
    while (pending.length > 0) {
      if (pending.startsWith(THINK_OPEN)) {
        const end = pending.indexOf(THINK_CLOSE, THINK_OPEN.length)
        if (end < 0) {
          if (!flush) return
          emitSegment(controller, { type: "reasoning", text: pending.slice(THINK_OPEN.length) })
          pending = ""
          return
        }
        emitSegment(controller, { type: "reasoning", text: pending.slice(THINK_OPEN.length, end) })
        pending = pending.slice(end + THINK_CLOSE.length)
        continue
      }
      if (pending[0] === "<") {
        // A "<" that cannot start a think block is ordinary text.
        if (THINK_OPEN.startsWith(pending)) {
          if (!flush) return
          emitTextDelta(controller, pending)
          pending = ""
          return
        }
        emitTextDelta(controller, "<")
        pending = pending.slice(1)
        continue
      }
      if (pending[0] === "{") {
        const scan = scanJSONObject(pending, 0)
        if (scan.status === "incomplete" && !flush) return
        if (scan.status === "complete") {
          const envelope = decodeEnvelope(scan.value, tools, counter)
          if (envelope) {
            emitSegment(controller, envelope)
          } else {
            emitTextDelta(controller, pending.slice(0, scan.end))
          }
          pending = pending.slice(scan.end)
          continue
        }
        // Malformed or truncated-at-flush object: keep it visible as text.
        emitTextDelta(controller, pending)
        pending = ""
        return
      }
      // Text run: everything up to the next element candidate.
      let i = 0
      while (i < pending.length && pending[i] !== "<" && pending[i] !== "{") i++
      let run = pending.slice(0, i)
      pending = pending.slice(i)
      if (flush) {
        // The batch parse trims text segments; match that at part end.
        run = run.replace(/^\s+/, "").replace(/\s+$/, "")
      } else {
        // Hold trailing whitespace so text segments stay trimmed like the
        // batch parse; it is dropped if an element follows.
        const trimmed = run.replace(/\s+$/, "")
        pending = run.slice(trimmed.length) + pending
        run = trimmed
      }
      if (run) emitTextDelta(controller, run)
      if (pending === "") return
      if (pending.trim() === "") {
        // Only held whitespace remains: wait for the next delta to learn
        // whether it is interior spacing or boundary trim.
        if (flush) pending = ""
        return
      }
      if (run === "") {
        // The run was pure whitespace before an element: boundary trim,
        // which the batch parse drops with the segment ends.
        pending = pending.replace(/^\s+/, "")
      }
      // Whitespace followed by more text stays: it is interior spacing.
      continue
    }
  }

  function startPlain(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) {
    if (!started && textID) {
      out(controller, { type: "text-start", id: textID } as LanguageModelV3StreamPart)
      started = true
    }
    if (pending) {
      out(controller, { type: "text-delta", id: textID, delta: pending } as LanguageModelV3StreamPart)
      pending = ""
    }
  }

  // Decide plain vs protocol from the first non-whitespace content. The rule
  // is the anchored one from parsePollinationsProtocol, so both paths agree.
  function decide(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>, flush: boolean) {
    const trimmed = pending.trimStart()
    if (trimmed === "") {
      if (!flush) return
      mode = "plain"
      startPlain(controller)
      return
    }
    if (trimmed.startsWith(THINK_OPEN)) {
      mode = "protocol"
      pending = trimmed
      processProtocol(controller, flush)
      return
    }
    if (THINK_OPEN.startsWith(trimmed)) {
      if (!flush) return
      mode = "plain"
      startPlain(controller)
      return
    }
    if (trimmed[0] === "{") {
      const scan = scanJSONObject(trimmed, 0)
      if (scan.status === "incomplete" && !flush) return
      if (scan.status === "complete" && isEnvelopeShape(scan.value)) {
        mode = "protocol"
        pending = trimmed
        processProtocol(controller, flush)
        return
      }
      mode = "plain"
      startPlain(controller)
      return
    }
    mode = "plain"
    startPlain(controller)
  }

  function finishText(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) {
    if (mode === "undecided") decide(controller, true)
    if (mode === "protocol") {
      processProtocol(controller, true)
      closeTextPart(controller)
      // The real text wrappers are swallowed in protocol mode; the synthetic
      // parts above carry the content in clean sequential order.
    } else if (textID) {
      startPlain(controller)
      out(controller, { type: "text-end", id: textID } as LanguageModelV3StreamPart)
    }
    textID = undefined
    started = false
    mode = "undecided"
    pending = ""
  }

  return new ReadableStream<LanguageModelV3StreamPart>({
    async pull(controller) {
      emitted = false
      while (true) {
        const item = await reader.read()
        if (item.done) {
          if (textID) finishText(controller)
          controller.close()
          return
        }
        const part = item.value
        if (part.type === "text-start") {
          // Held until the mode resolves so protocol content never nests
          // synthetic parts inside the real text part.
          textID = part.id
          mode = "undecided"
          pending = ""
          started = false
          continue
        }
        if (part.type === "text-delta" && part.id === textID) {
          if (mode === "plain") {
            out(controller, part)
            return
          }
          pending += part.delta
          if (mode === "undecided") decide(controller, false)
          else processProtocol(controller, false)
          if (emitted) return
          continue
        }
        if (part.type === "text-end" && part.id === textID) {
          finishText(controller)
          if (emitted) return
          continue
        }
        if (part.type === "finish") {
          if (textID) finishText(controller)
          out(controller, {
            ...part,
            finishReason: sawToolCall ? { unified: "tool-calls", raw: part.finishReason.raw } : part.finishReason,
          })
          sawToolCall = false
          return
        }
        if (part.type === "tool-call") sawToolCall = true
        out(controller, part)
        return
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

function toContent(segments: Segment[]): LanguageModelV3Content[] {
  return segments.map((segment) => segment)
}

function isEnvelopeShape(value: unknown): boolean {
  if (!isRecord(value) || !("name" in value)) return false
  const keys = Object.keys(value).sort().join(",")
  if (value.name === null && keys === "message,name" && typeof value.message === "string") return true
  if (typeof value.name !== "string") return false
  if (keys === "arguments,name") return isRecord(value.arguments)
  // Flat dialect observed in the real agent loop (e.g. GLM calling shell):
  // {"name":"shell","command":"pwd"} instead of nesting under "arguments".
  return !("arguments" in value)
}

function decodeEnvelope(value: unknown, tools: Set<string>, counter: Counter): Segment | undefined {
  if (!isEnvelopeShape(value)) return undefined
  const record = value as { name: string | null; message?: string; arguments?: unknown }
  if (record.name === null) return { type: "text", text: record.message as string }
  if (!tools.has(record.name)) {
    // Demote: an envelope for a tool that was not offered stays visible as
    // text instead of erroring the turn or executing by accident.
    return undefined
  }
  // Nested dialect passes "arguments" through; the flat dialect collects
  // every key except "name" as the call input.
  const input = "arguments" in record ? JSON.stringify(record.arguments) : flatArgumentsInput(record)
  return {
    type: "tool-call",
    toolCallId: `pollinations-call-${counter.next++}`,
    toolName: record.name,
    input,
  }
}

function flatArgumentsInput(record: Record<string, unknown>): string {
  const { name: _, ...rest } = record
  return JSON.stringify(rest)
}

type JsonScan =
  | { status: "complete"; value: unknown; end: number }
  | { status: "incomplete" }
  | { status: "invalid"; end: number }

// Balanced-brace scan that reports incomplete input separately from malformed
// input, so streaming can wait for more chunks instead of misclassifying.
function scanJSONObject(text: string, start: number): JsonScan {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const character = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (quoted) {
      if (character === "\\") escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') {
      quoted = true
      continue
    }
    if (character === "{") depth++
    else if (character === "}") {
      depth--
      if (depth === 0) {
        try {
          return { status: "complete", value: JSON.parse(text.slice(start, i + 1)), end: i + 1 }
        } catch {
          return { status: "invalid", end: i + 1 }
        }
      }
    }
  }
  return { status: "incomplete" }
}

function coalesce(segments: Segment[]) {
  return segments.reduce<Segment[]>((result, segment) => {
    const previous = result[result.length - 1]
    if (previous?.type === "text" && segment.type === "text") {
      return [...result.slice(0, -1), { type: "text", text: previous.text + segment.text }]
    }
    return [...result, segment]
  }, [])
}
