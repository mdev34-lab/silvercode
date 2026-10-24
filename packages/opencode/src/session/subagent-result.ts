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
  for (const source of [...chunks].reverse()) {
    if (typeof source !== "string") continue
    const open = `<${TEXT_RESULT_TAG}>`
    const close = `</${TEXT_RESULT_TAG}>`
    if (!source.includes(open) && !source.includes(close)) continue
    let depth = 0
    let nested = false
    let begin = 0
    let result: string | undefined
    for (const match of source.matchAll(/<\/?silvercode-result>/g)) {
      if (match[0] === open) {
        if (depth > 0) nested = true
        else { begin = match.index! + open.length; nested = false }
        depth++
      } else if (depth > 0) {
        depth--
        if (depth === 0) result = nested ? undefined : source.slice(begin, match.index).trim()
      } else result = undefined
    }
    // A malformed latest result needs correction, but cannot poison a later
    // assistant text part or finish.result containing a complete replacement.
    return depth === 0 && result ? { ok: true as const, text: result } : { ok: false as const }
  }
  return { ok: false as const }
}

export function renderTextResult(text: string) {
  return `<${TEXT_RESULT_TAG}>\n${text}\n</${TEXT_RESULT_TAG}>`
}
