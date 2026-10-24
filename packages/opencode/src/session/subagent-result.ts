import type { SessionV1 } from "@opencode-ai/core/v1/session"

export const TEXT_RESULT_TAG = "silvercode-result"

/** Visible assistant text from this prompt execution, never reasoning or tool output. */
export function resultChunks(messages: readonly SessionV1.WithParts[], current: SessionV1.WithParts) {
  const ordered = [...messages.filter((message) => message.info.id !== current.info.id), current].sort((a, b) =>
    a.info.id.localeCompare(b.info.id),
  )
  const end = ordered.findIndex((message) => message.info.id === current.info.id)
  if (current.info.role !== "assistant") return []
  const promptID = current.info.parentID
  const start = ordered.findIndex((message) => message.info.id === promptID && message.info.role === "user")
  if (start < 0) return current.parts.flatMap((part) => (part.type === "text" && !part.ignored && !part.synthetic ? [part.text] : []))
  const prior = ordered.slice(start + 1, end)
  const finished = prior.findLastIndex((message) =>
    message.parts.some((part) => part.type === "tool" && part.tool === "finish" && part.state.status === "completed"),
  )
  const boundary = finished < 0 ? start + 1 : start + 2 + finished
  return ordered
    .slice(boundary, end + 1)
    .flatMap((message) =>
      message.info.role === "assistant" && message.info.parentID === promptID
        ? message.parts.flatMap((part) => (part.type === "text" && !part.ignored && !part.synthetic ? [part.text] : []))
        : [],
    )
}

/** A text envelope has no JSON escaping burden; the last complete result must be non-empty. */
export function textResult(chunks: readonly (string | undefined)[]) {
  const source = chunks.filter((text): text is string => typeof text === "string").join("\n")
  const start = source.lastIndexOf(`<${TEXT_RESULT_TAG}>`)
  const close = source.lastIndexOf(`</${TEXT_RESULT_TAG}>`)
  if (start < 0 || close < start) return { ok: false as const }
  const prefix = source.slice(0, start)
  // No nested opening tag may remain unclosed before the final result.
  if ((prefix.match(/<silvercode-result>/g)?.length ?? 0) !== (prefix.match(/<\/silvercode-result>/g)?.length ?? 0))
    return { ok: false as const }
  const text = source.slice(start + TEXT_RESULT_TAG.length + 2, close).trim()
  if (text.includes(`</${TEXT_RESULT_TAG}>`)) return { ok: false as const }
  return text ? { ok: true as const, text } : { ok: false as const }
}

export function renderTextResult(text: string) {
  return `<${TEXT_RESULT_TAG}>\n${text}\n</${TEXT_RESULT_TAG}>`
}
