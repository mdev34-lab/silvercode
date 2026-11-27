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

/**
 * Some community endpoints expose their model's text protocol inside the
 * OpenAI `message.content` field. Only decode the documented envelope shapes,
 * and only promote calls to tools that were actually offered in this request.
 */
export function parsePollinationsProtocol(content: string, options: LanguageModelV3CallOptions): Segment[] {
  const leading = content.trimStart()
  if (!leading.startsWith("<think>") && !leading.startsWith("{")) return [{ type: "text", text: content }]
  if (!content.includes("<think>") && !content.includes('"name"')) return [{ type: "text", text: content }]
  const tools = new Set(options.tools?.filter((tool) => tool.type === "function").map((tool) => tool.name))
  const segments: Segment[] = []
  let cursor = 0
  let protocol = false
  let toolIndex = 0

  while (cursor < content.length) {
    if (content.startsWith("<think>", cursor)) {
      const end = content.indexOf("</think>", cursor + 7)
      if (end < 0) throw new Error("Pollinations protocol error: unterminated reasoning block")
      segments.push({ type: "reasoning", text: content.slice(cursor + 7, end) })
      cursor = end + 8
      protocol = true
      continue
    }

    if (content[cursor] === "{") {
      const json = readJSONObject(content, cursor)
      if (json) {
        const envelope = decodeEnvelope(json.value, tools, toolIndex)
        if (envelope) {
          segments.push(envelope)
          if (envelope.type === "tool-call") toolIndex++
          cursor = json.end
          protocol = true
          continue
        }
      }
    }

    const start = cursor
    cursor++
    while (cursor < content.length && !content.startsWith("<think>", cursor) && content[cursor] !== "{") cursor++
    segments.push({ type: "text", text: content.slice(start, cursor) })
  }

  if (!protocol) return [{ type: "text", text: content }]
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
    const content = result.content.flatMap((part) =>
      part.type === "text" ? toContent(parsePollinationsProtocol(part.text, options.params)) : [part],
    )
    const toolCall = content.some((part) => part.type === "tool-call")
    return {
      ...result,
      content,
      finishReason: toolCall ? { unified: "tool-calls", raw: result.finishReason.raw } : result.finishReason,
    }
  },
  async wrapStream(options) {
    const result = await options.doStream()
    return { ...result, stream: transformStream(result.stream, options.params) }
  },
}

function transformStream(stream: ReadableStream<LanguageModelV3StreamPart>, options: LanguageModelV3CallOptions) {
  const reader = stream.getReader()
  const textIDs = new Set<string>()
  let text = ""
  return new ReadableStream<LanguageModelV3StreamPart>({
    async pull(controller) {
      while (true) {
        const item = await reader.read()
        if (item.done) {
          if (text) emitSegments(controller, parsePollinationsProtocol(text, options))
          controller.close()
          return
        }
        const part = item.value
        if (part.type === "text-start") {
          textIDs.add(part.id)
          continue
        }
        if (part.type === "text-delta" && textIDs.has(part.id)) {
          text += part.delta
          continue
        }
        if (part.type === "text-end" && textIDs.has(part.id)) continue
        if (part.type === "finish" && textIDs.size) {
          const segments = parsePollinationsProtocol(text, options)
          emitSegments(controller, segments)
          controller.enqueue({
            ...part,
            finishReason: segments.some((segment) => segment.type === "tool-call")
              ? { unified: "tool-calls", raw: part.finishReason.raw }
              : part.finishReason,
          })
          text = ""
          textIDs.clear()
          return
        }
        controller.enqueue(part)
        return
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

function emitSegments(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>, segments: Segment[]) {
  segments.forEach((segment, index) => {
    const id = `pollinations-${segment.type}-${index}`
    if (segment.type === "tool-call") {
      controller.enqueue(segment)
      return
    }
    controller.enqueue({ type: `${segment.type}-start`, id })
    controller.enqueue({ type: `${segment.type}-delta`, id, delta: segment.text })
    controller.enqueue({ type: `${segment.type}-end`, id })
  })
}

function toContent(segments: Segment[]): LanguageModelV3Content[] {
  return segments.map((segment) => {
    if (segment.type === "text" || segment.type === "reasoning") return segment
    return segment
  })
}

function decodeEnvelope(value: unknown, tools: Set<string>, index: number): Segment | undefined {
  if (!isRecord(value) || !("name" in value)) return undefined
  const keys = Object.keys(value).sort().join(",")
  if (value.name === null && keys === "message,name" && typeof value.message === "string") {
    return { type: "text", text: value.message }
  }
  if (typeof value.name !== "string" || keys !== "arguments,name" || !isRecord(value.arguments)) return undefined
  if (!tools.has(value.name)) {
    throw new Error(`Pollinations protocol error: model requested unavailable tool ${JSON.stringify(value.name)}`)
  }
  return {
    type: "tool-call",
    toolCallId: `pollinations-call-${index}`,
    toolName: value.name,
    input: JSON.stringify(value.arguments),
  }
}

function readJSONObject(text: string, start: number): { value: unknown; end: number } | undefined {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      escaped = !escaped && char === "\\"
      if (!escaped && char === '"') quoted = false
      if (char !== "\\") escaped = false
      continue
    }
    if (char === '"') quoted = true
    if (char === "{") depth++
    if (char === "}" && --depth === 0) {
      const raw = text.slice(start, index + 1)
      try {
        return { value: JSON.parse(raw) as unknown, end: index + 1 }
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

function coalesce(segments: Segment[]) {
  return segments.reduce<Segment[]>((result, segment) => {
    const previous = result.at(-1)
    if (segment.type === "text" && previous?.type === "text") previous.text += segment.text
    else result.push(segment)
    return result
  }, [])
}
