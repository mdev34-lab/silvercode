import type { SessionV1 } from "@opencode-ai/core/v1/session"

import { isRecord } from "@/util/record"
import FINISH_NUDGE from "./prompt/finish-nudge.txt"
import REVIEW_STAGNATION_NUDGE from "./prompt/review-stagnation-nudge.txt"

export const TEXT_RESULT_TAG = "silvercode-result"

const NUDGES = new Set([FINISH_NUDGE, REVIEW_STAGNATION_NUDGE].map((text) => text.trim()))

// Issue #738: metadata key on the synthetic user message that resumes a guard-aborted generation.
// It records the prompt the continuation belongs to, so the recovery is recognised as part of the
// same prompt execution instead of a new user boundary, and so its budget is scoped to that lineage
// rather than to one runLoop invocation.
export const REPETITION_RECOVERY = "repetitionRecovery"

/** The prompt a repetition-recovery message continues, or undefined for any other message. */
export function repetitionRecoveryPromptID(message: SessionV1.WithParts): string | undefined {
  if (message.info.role !== "user" || message.parts.length !== 1) return undefined
  const part = message.parts[0]!
  if (part.type !== "text" || part.synthetic !== true) return undefined
  const marker = part.metadata?.[REPETITION_RECOVERY]
  return isRecord(marker) && typeof marker.promptID === "string" ? marker.promptID : undefined
}

// Issue #783: metadata key on the runner's finish/stagnation nudge. The nudge
// continues the turn of the prompt it follows, and the answer that obeys it
// answers that prompt. Recording the prompt the nudge belongs to is what lets
// the caller settle on that answer instead of the pre-nudge one, and what keeps
// the nudge from being mistaken for input a caller submitted. Optional: nudges
// persisted before this marker existed keep working, and ownership then falls
// back to the stored transcript as before.
export const FINISH_CONTINUATION = "finishContinuation"

/** The prompt a runner finish/stagnation nudge continues, or undefined for any other message. */
export function finishContinuationPromptID(message: SessionV1.WithParts): string | undefined {
  if (message.info.role !== "user" || message.parts.length !== 1) return undefined
  const part = message.parts[0]!
  if (part.type !== "text" || part.synthetic !== true) return undefined
  if (!NUDGES.has(part.text.trim())) return undefined
  const marker = part.metadata?.[FINISH_CONTINUATION]
  return isRecord(marker) && typeof marker.promptID === "string" ? marker.promptID : undefined
}

/** The runner continuation this user message declares, if any. */
export function continuationPromptID(message: SessionV1.WithParts) {
  return finishContinuationPromptID(message) ?? repetitionRecoveryPromptID(message)
}

/** Resolve mixed continuations to their own root; missing roots keep their declared identity. */
export function turnLineage(messages: readonly SessionV1.WithParts[], userID: string): string {
  return lineageResolver(messages)(userID)
}

function lineageResolver(messages: readonly SessionV1.WithParts[]) {
  const byID = new Map(messages.map((message) => [message.info.id, message]))
  const resolved = new Map<string, string>()
  return (userID: string) => {
    const seen = new Set<string>()
    let current = userID
    while (!seen.has(current) && !resolved.has(current)) {
      seen.add(current)
      const message = byID.get(current)
      const parent = message && continuationPromptID(message)
      if (parent === undefined) {
        for (const id of seen) resolved.set(id, current)
        return current
      }
      if (seen.has(parent)) {
        // A cycle has no caller root. Fail closed to each queried identity.
        for (const id of seen) resolved.set(id, id)
        return userID
      }
      current = parent
    }
    const root = resolved.get(current) ?? userID
    for (const id of seen) resolved.set(id, root)
    return root
  }
}

// Only the runner's own finish/stagnation reminder and bounded repetition recovery continue a prompt.
// Any other synthetic-only user message (shell marker, task summary, bridge text) is a boundary, not
// a continuation.
const isNudge = (message: SessionV1.WithParts) =>
  message.info.role === "user" &&
  message.parts.length === 1 &&
  message.parts[0]!.type === "text" &&
  message.parts[0]!.synthetic === true &&
  (NUDGES.has(message.parts[0]!.text.trim()) ||
    repetitionRecoveryPromptID(message) !== undefined ||
    finishContinuationPromptID(message) !== undefined)

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
  if (parentID === undefined) return undefined
  const rootID = lineageResolver(ordered)(parentID)
  const root = ordered.find((message) => message.info.id === rootID)
  if (root && continuationPromptID(root) !== undefined) return undefined
  const end = ordered.findIndex((message) => message.info.id === info.id)
  let at = ordered.findIndex((message) => message.info.id === parentID && message.info.role === "user")
  if (at < 0 || at >= end) return undefined
  if (ordered.slice(at + 1, end).some((message) => message.info.role === "user")) return undefined
  const anchors: number[] = [at]
  while (isNudge(ordered[at]!)) {
    const previous = ordered.slice(0, at).findLastIndex((message) => message.info.role === "user")
    if (previous < 0) break
    // New markers name the root; older markers may name the preceding nudge.
    const declared = continuationPromptID(ordered[at]!)
    if (
      declared !== undefined &&
      ordered[previous]!.info.id !== declared &&
      turnLineage(ordered, ordered[previous]!.info.id) !== declared
    )
      break
    if (ordered.slice(previous + 1, at).some(finished)) break
    at = previous
    anchors.push(at)
  }
  return anchors
}

/**
 * Put a declared execution at its root even when a clock rollback gave its
 * continuations smaller IDs. Only runner-marked executions are regrouped; a
 * stale parent or a marker that jumped a real user boundary keeps its stored
 * position and cannot borrow the earlier prompt. Legacy unmarked nudges retain
 * their adjacent-message behavior.
 */
export function executionOrder(messages: readonly SessionV1.WithParts[]) {
  const all = [...new Map(messages.map((message) => [message.info.id, message])).values()].sort((a, b) =>
    a.info.id.localeCompare(b.info.id),
  )
  const byID = new Map(all.map((message) => [message.info.id, message]))
  const lineage = lineageResolver(all)
  const boundaries = all.filter(
    (message) => message.info.role === "user" && continuationPromptID(message) === undefined,
  )
  const crossed = (root: string, id: string) =>
    id > root &&
    boundaries.some((boundary) => boundary.info.id !== root && boundary.info.id > root && boundary.info.id < id)
  const continuations = all.filter((message) => {
    const root = lineage(message.info.id)
    const owner = byID.get(root)
    return (
      continuationPromptID(message) !== undefined &&
      (owner === undefined || continuationPromptID(owner) === undefined) &&
      !crossed(root, message.info.id)
    )
  })
  const roots = new Set(continuations.map((message) => lineage(message.info.id)))
  const first = new Map<string, string>()
  for (const message of continuations) {
    const root = lineage(message.info.id)
    const previous = first.get(root)
    if (previous === undefined || message.info.id < previous) first.set(root, message.info.id)
  }
  const groups = new Map<string, SessionV1.WithParts[]>()
  for (const message of all) {
    const parent = message.info.role === "assistant" ? message.info.parentID : message.info.id
    const root = parent === undefined ? message.info.id : lineage(parent)
    const start = first.get(root)
    // Before the first nudge, direct children are the pre-nudge tool steps.
    // In a rollback the nudge sorts before its root, so those steps sort after
    // the root instead. Never pull a later direct child back over the nudge.
    const direct =
      message.info.role === "assistant" &&
      parent === root &&
      start !== undefined &&
      (start < root ? !crossed(root, message.info.id) : message.info.id < start)
    const continued = message.info.role === "user" && continuations.includes(message)
    const child =
      message.info.role === "assistant" &&
      parent !== undefined &&
      continuations.some((continuation) => continuation.info.id === parent) &&
      !crossed(root, message.info.id)
    const key = roots.has(root) && (message.info.id === root || direct || continued || child) ? root : message.info.id
    groups.set(key, [...(groups.get(key) ?? []), message])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, group]) => {
      const root = group.find(
        (message) =>
          continuationPromptID(message) === undefined &&
          group.some((candidate) => candidate.info.role === "assistant" && candidate.info.parentID === message.info.id),
      )
      if (!root) return group.sort((a, b) => a.info.id.localeCompare(b.info.id))
      const children = (parentID: string) =>
        group.filter((message) => message.info.role === "assistant" && message.info.parentID === parentID)
      const nudges = group.filter((message) => continuationPromptID(message) !== undefined)
      return [root, ...children(root.info.id), ...nudges.flatMap((nudge) => [nudge, ...children(nudge.info.id)])]
    })
}

const order = (messages: readonly SessionV1.WithParts[], current: SessionV1.WithParts) =>
  executionOrder([...messages.filter((message) => message.info.id !== current.info.id), current])

/**
 * True when the current assistant answers `promptID` directly or through runner nudges that continue it.
 * The messages between the prompt and the assistant must hold no real user message and no completed
 * finish. When the transcript lacks the prompt (minimal fixture), the same two rules apply to every
 * message after `promptID`; an empty history is a direct match.
 */
export function continuesPrompt(
  messages: readonly SessionV1.WithParts[],
  current: SessionV1.WithParts,
  promptID: string,
) {
  if (current.info.role !== "assistant") return false
  const prompt = messages.find((message) => message.info.id === promptID)
  if (prompt && continuationPromptID(prompt) !== undefined) return false
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
        else {
          begin = match.index! + open.length
          nested = false
        }
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
