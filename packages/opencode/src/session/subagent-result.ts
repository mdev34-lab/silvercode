import type { SessionV1 } from "@opencode-ai/core/v1/session"

import FINISH_NUDGE from "./prompt/finish-nudge.txt"
import REVIEW_STAGNATION_NUDGE from "./prompt/review-stagnation-nudge.txt"

export const TEXT_RESULT_TAG = "silvercode-result"

const NUDGES = new Set([FINISH_NUDGE, REVIEW_STAGNATION_NUDGE].map((text) => text.trim()))

// Only the runner's own finish/stagnation reminder continues a prompt. Any other synthetic-only user
// message (shell marker, task summary, bridge text) is a boundary, not a continuation.
const isNudge = (message: SessionV1.WithParts) =>
  message.info.role === "user" &&
  message.parts.length === 1 &&
  message.parts[0]!.type === "text" &&
  message.parts[0]!.synthetic === true &&
  NUDGES.has(message.parts[0]!.text.trim())

const finished = (message: SessionV1.WithParts) =>
  message.parts.some((part) => part.type === "tool" && part.tool === "finish" && part.state.status === "completed")

/**
 * The user-message anchors of the prompt execution `current` belongs to, nearest first, or undefined when
 * `current`'s parent is not a message that precedes it with no user message in between (a later real user
 * boundary makes the parent stale). Each runner nudge links to the previous user message only when no
 * completed finish happened since: a nudge never follows a finish.
 */
function anchorsOf(ordered: readonly SessionV1.WithParts[], current: SessionV1.WithParts) {
  const info = current.info
  if (info.role !== "assistant") return undefined
  const parentID = info.parentID
  const end = ordered.findIndex((message) => message.info.id === info.id)
  let at = ordered.findIndex((message) => message.info.id === parentID && message.info.role === "user")
  if (at < 0 || at >= end) return undefined
  if (ordered.slice(at + 1, end).some((message) => message.info.role === "user")) return undefined
  const anchors: number[] = [at]
  while (isNudge(ordered[at]!)) {
    const previous = ordered.slice(0, at).findLastIndex((message) => message.info.role === "user")
    if (previous < 0) break
    if (ordered.slice(previous + 1, at).some(finished)) break
    at = previous
    anchors.push(at)
  }
  return anchors
}

const order = (messages: readonly SessionV1.WithParts[], current: SessionV1.WithParts) =>
  [...messages.filter((message) => message.info.id !== current.info.id), current].sort((a, b) =>
    a.info.id.localeCompare(b.info.id),
  )

/**
 * True when the current assistant answers `promptID` directly or through runner nudges that continue it.
 * The messages between the prompt and the assistant must hold no real user message and no completed
 * finish. When the transcript lacks the prompt (minimal fixture), the same two rules apply to every
 * message after `promptID`; an empty history is a direct match.
 */
export function continuesPrompt(messages: readonly SessionV1.WithParts[], current: SessionV1.WithParts, promptID: string) {
  if (current.info.role !== "assistant") return false
  const ordered = order(messages, current)
  const end = ordered.findIndex((message) => message.info.id === current.info.id)
  let between: readonly SessionV1.WithParts[]
  if (ordered.some((message) => message.info.id === promptID)) {
    const anchors = anchorsOf(ordered, current)
    const found = anchors?.find((at) => ordered[at]!.info.id === promptID)
    if (!anchors || found === undefined) return false
    between = ordered.slice(anchors[anchors.length - 1]! + 1, end)
  } else {
    // The parent must exist chronologically before the assistant it answers.
    if (current.info.parentID !== promptID || promptID > current.info.id) return false
    between = ordered.slice(0, end).filter((message) => message.info.id > promptID)
  }
  return !between.some((message) => (message.info.role === "user" && !isNudge(message)) || finished(message))
}

/** Visible assistant text from this prompt execution, never reasoning or tool output. */
export function resultChunks(messages: readonly SessionV1.WithParts[], current: SessionV1.WithParts) {
  if (current.info.role !== "assistant") return []
  const ordered = order(messages, current)
  const end = ordered.findIndex((message) => message.info.id === current.info.id)
  const text = (message: SessionV1.WithParts) =>
    message.parts.flatMap((part) => (part.type === "text" && !part.ignored && !part.synthetic ? [part.text] : []))
  const found = anchorsOf(ordered, current)
  if (!found) return text(current)
  // The nudge chain is one execution anchored at the original prompt.
  const start = found[found.length - 1]!
  const anchors = new Set(found.map((at) => ordered[at]!.info.id))
  const prior = ordered.slice(start + 1, end)
  const last = prior.findLastIndex(finished)
  const boundary = last < 0 ? start + 1 : start + 2 + last
  return ordered
    .slice(boundary, end + 1)
    .flatMap((message) =>
      message.info.role === "assistant" && anchors.has(message.info.parentID) ? text(message) : [],
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
