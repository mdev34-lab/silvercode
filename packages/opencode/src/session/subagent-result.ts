import type { SessionV1 } from "@opencode-ai/core/v1/session"

export const TEXT_RESULT_TAG = "silvercode-result"

const isNudge = (message: SessionV1.WithParts) =>
  message.info.role === "user" &&
  message.parts.length > 0 &&
  message.parts.every((part) => part.type === "text" && part.synthetic === true)

/** True when the current assistant answers `promptID` directly or through runner nudges that continue it. */
export function continuesPrompt(messages: readonly SessionV1.WithParts[], current: SessionV1.WithParts, promptID: string) {
  if (current.info.role !== "assistant") return false
  const parentID = current.info.parentID
  if (parentID === promptID) return true
  const ordered = [...messages.filter((message) => message.info.id !== current.info.id), current].sort((a, b) =>
    a.info.id.localeCompare(b.info.id),
  )
  let at = ordered.findIndex((message) => message.info.id === parentID && message.info.role === "user")
  while (at >= 0) {
    if (ordered[at]!.info.id === promptID) return true
    if (!isNudge(ordered[at]!)) return false
    at = ordered.slice(0, at).findLastIndex((message) => message.info.role === "user")
  }
  return false
}

/** Visible assistant text from this prompt execution, never reasoning or tool output. */
export function resultChunks(messages: readonly SessionV1.WithParts[], current: SessionV1.WithParts) {
  const ordered = [...messages.filter((message) => message.info.id !== current.info.id), current].sort((a, b) =>
    a.info.id.localeCompare(b.info.id),
  )
  const end = ordered.findIndex((message) => message.info.id === current.info.id)
  if (current.info.role !== "assistant") return []
  // A runner nudge (finish reminder) is a synthetic-only user message, so a nudged turn's parent is
  // the nudge, not the prompt it continues. Treat the nudge chain as one execution anchored at the
  // original prompt, otherwise the envelope written before the nudge is dropped.
  const parentID = current.info.parentID
  let start = ordered.findIndex((message) => message.info.id === parentID && message.info.role === "user")
  if (start < 0) return current.parts.flatMap((part) => (part.type === "text" && !part.ignored && !part.synthetic ? [part.text] : []))
  const anchors = new Set<string>([ordered[start]!.info.id])
  while (isNudge(ordered[start]!)) {
    const previous = ordered.slice(0, start).findLastIndex((message) => message.info.role === "user")
    if (previous < 0) break
    start = previous
    anchors.add(ordered[start]!.info.id)
  }
  const prior = ordered.slice(start + 1, end)
  const finished = prior.findLastIndex((message) =>
    message.parts.some((part) => part.type === "tool" && part.tool === "finish" && part.state.status === "completed"),
  )
  const boundary = finished < 0 ? start + 1 : start + 2 + finished
  return ordered
    .slice(boundary, end + 1)
    .flatMap((message) =>
      message.info.role === "assistant" && anchors.has(message.info.parentID)
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
