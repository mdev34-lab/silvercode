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

// Runner-owned auto-compaction followup. It continues the execution that asked
// for compaction; it is not a new caller and not a finish-nudge budget slot.
export const COMPACTION_CONTINUATION = "compactionContinuation"

export function compactionContinuationPromptID(message: SessionV1.WithParts): string | undefined {
  if (message.info.role !== "user") return undefined
  for (const part of message.parts) {
    if (part.type !== "text") continue
    const marker = part.metadata?.[COMPACTION_CONTINUATION]
    if (isRecord(marker) && typeof marker.promptID === "string") return marker.promptID
  }
  return undefined
}

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
  return (
    finishContinuationPromptID(message) ?? repetitionRecoveryPromptID(message) ?? compactionContinuationPromptID(message)
  )
}

function continuationMarker(message: SessionV1.WithParts) {
  if (message.info.role !== "user" || message.parts.length !== 1) return undefined
  const part = message.parts[0]!
  if (part.type !== "text" || part.synthetic !== true) return undefined
  const marker = part.metadata?.[FINISH_CONTINUATION] ?? part.metadata?.[REPETITION_RECOVERY]
  return isRecord(marker) ? marker : undefined
}

/** Causal runner-continuation index. IDs are only a legacy fallback. */
export function continuationSequence(message: SessionV1.WithParts) {
  const marker = continuationMarker(message)
  return typeof marker?.sequence === "number" && Number.isSafeInteger(marker.sequence) && marker.sequence > 0
    ? marker.sequence
    : undefined
}

/** Assistants that causally precede a runner continuation, in execution order. */
export function continuationAssistantIDs(message: SessionV1.WithParts): readonly string[] | undefined {
  const marker = continuationMarker(message)
  if (!Array.isArray(marker?.assistantIDs)) return undefined
  return marker.assistantIDs.every((id) => typeof id === "string") ? marker.assistantIDs : undefined
}

/** Resolve mixed continuations to their own root; missing roots keep their declared identity. */
export function turnLineage(messages: readonly SessionV1.WithParts[], userID: string): string {
  return lineageResolver(messages)(userID)
}

/** One indexed resolver for a transcript. Reuse it instead of rebuilding a map per query. */
export function lineageResolver(messages: readonly SessionV1.WithParts[]) {
  const byID = new Map<string, SessionV1.WithParts>(messages.map((message) => [message.info.id, message]))
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
// a continuation. A persisted no-reply note is different: it is a silent annotation of the current
// execution, not a caller boundary, and the runner already keeps it out of caller ownership.
const isNudge = (message: SessionV1.WithParts) =>
  message.info.role === "user" &&
  message.parts.length === 1 &&
  message.parts[0]!.type === "text" &&
  message.parts[0]!.synthetic === true &&
  (NUDGES.has(message.parts[0]!.text.trim()) ||
    repetitionRecoveryPromptID(message) !== undefined ||
    finishContinuationPromptID(message) !== undefined ||
    compactionContinuationPromptID(message) !== undefined)

const isSilentNote = (message: SessionV1.WithParts) => message.info.role === "user" && message.info.noReply === true

const isCompactionTask = (message: SessionV1.WithParts) =>
  message.info.role === "user" && message.parts.some((part) => part.type === "compaction")

const isBoundaryUser = (message: SessionV1.WithParts) =>
  message.info.role === "user" && !isNudge(message) && !isSilentNote(message) && !isCompactionTask(message)

const finished = (message: SessionV1.WithParts) =>
  message.parts.some((part) => part.type === "tool" && part.tool === "finish" && part.state.status === "completed")

const toolStep = (message: SessionV1.WithParts) =>
  message.info.role === "assistant" &&
  message.info.finish !== "stop" &&
  message.info.finish !== "error" &&
  !finished(message) &&
  message.parts.some((part) => part.type === "tool" && !part.metadata?.providerExecuted)

/**
 * A real user message queued behind an unfinished tool step does not supersede
 * that execution; the runner still owes the tool follow-up. Once the execution
 * settles, a later real user is a boundary again.
 */
function executionBoundary(
  ordered: readonly SessionV1.WithParts[],
  start: number,
  end: number,
  root: string,
  lineage: (userID: string) => string,
) {
  let working = false
  for (const message of ordered.slice(start, end)) {
    if (message.info.role === "assistant" && message.info.parentID !== undefined && lineage(message.info.parentID) === root) {
      if (finished(message)) return true
      working = toolStep(message)
    }
    if (isBoundaryUser(message) && !working) return true
  }
  return false
}

/**
 * The user-message anchors of the prompt execution `current` belongs to, nearest first, or undefined when
 * `current`'s parent is not a message that precedes it with no caller boundary in between. Silent no-reply
 * annotations are transparent; a later real user boundary makes the parent stale. Each runner nudge links
 * to the previous user anchor only when no completed finish happened since: a nudge never follows a finish.
 */
function anchorsOf(
  ordered: readonly SessionV1.WithParts[],
  current: SessionV1.WithParts,
  lineage: (userID: string) => string,
) {
  const info = current.info
  if (info.role !== "assistant") return undefined
  const parentID = info.parentID
  if (parentID === undefined) return undefined
  const rootID = lineage(parentID)
  const root = ordered.find((message) => message.info.id === rootID)
  if (root && continuationPromptID(root) !== undefined) return undefined
  const end = ordered.findIndex((message) => message.info.id === info.id)
  let at = ordered.findIndex((message) => message.info.id === parentID && message.info.role === "user")
  if (at < 0 || at >= end) return undefined
  if (executionBoundary(ordered, at + 1, end, rootID, lineage)) return undefined
  const anchors: number[] = [at]
  while (isNudge(ordered[at]!)) {
    const previous = ordered
      .slice(0, at)
      .findLastIndex((message) => message.info.role === "user" && !isSilentNote(message) && !isCompactionTask(message))
    if (previous < 0) break
    // New markers name the root; older markers may name the preceding nudge.
    const declared = continuationPromptID(ordered[at]!)
    if (declared !== undefined && ordered[previous]!.info.id !== declared && lineage(ordered[previous]!.info.id) !== declared)
      break
    if (ordered.slice(previous + 1, at).some(finished)) break
    at = previous
    anchors.push(at)
  }
  return anchors
}

/**
 * Put a declared execution at its root even when a clock rollback gave its
 * continuations smaller IDs. Runner continuations carry a causal sequence and
 * the assistants that preceded them; IDs are only a legacy fallback. A stale
 * parent or a marker that jumped a real user boundary keeps its stored position
 * and cannot borrow the earlier prompt.
 */
export function executionOrder(messages: readonly SessionV1.WithParts[]) {
  const all = [...new Map(messages.map((message) => [message.info.id, message])).values()].sort((a, b) =>
    a.info.id.localeCompare(b.info.id),
  )
  const byID = new Map<string, SessionV1.WithParts>(all.map((message) => [message.info.id, message]))
  const lineage = lineageResolver(all)
  const boundaries = all.filter(isBoundaryUser)
  const boundaryIDs = boundaries.map((boundary) => boundary.info.id)
  const crossed = (root: string, id: string) => {
    if (id <= root) return false
    let low = 0
    let high = boundaryIDs.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (boundaryIDs[middle]! <= root) low = middle + 1
      else high = middle
    }
    return low < boundaryIDs.length && boundaryIDs[low]! < id
  }
  const continuations = all.filter((message) => {
    const root = lineage(message.info.id)
    const owner = byID.get(root)
    return (
      continuationPromptID(message) !== undefined &&
      (owner === undefined || continuationPromptID(owner) === undefined) &&
      !crossed(root, message.info.id)
    )
  })
  const continuationIDs = new Set(continuations.map((message) => message.info.id))
  const roots = new Set(continuations.map((message) => lineage(message.info.id)))
  const nudgesByRoot = new Map<string, SessionV1.WithParts[]>()
  for (const message of continuations) {
    const root = lineage(message.info.id)
    nudgesByRoot.set(root, [...(nudgesByRoot.get(root) ?? []), message])
  }
  for (const [root, nudges] of nudgesByRoot) {
    nudges.sort((a, b) => {
      const sa = continuationSequence(a)
      const sb = continuationSequence(b)
      if (sa !== undefined && sb !== undefined && sa !== sb) return sa - sb
      if (sa !== undefined && sb === undefined) return -1
      if (sa === undefined && sb !== undefined) return 1
      return a.info.id.localeCompare(b.info.id)
    })
    nudgesByRoot.set(root, nudges)
  }
  const first = new Map<string, SessionV1.WithParts>()
  for (const [root, nudges] of nudgesByRoot) first.set(root, nudges[0]!)
  const claimed = new Map<string, Set<string>>()
  for (const [root, nudges] of nudgesByRoot) {
    const ids = new Set<string>()
    for (const nudge of nudges) for (const id of continuationAssistantIDs(nudge) ?? []) ids.add(id)
    claimed.set(root, ids)
  }
  const groups = new Map<string, SessionV1.WithParts[]>()
  for (const message of all) {
    const parent = message.info.role === "assistant" ? message.info.parentID : message.info.id
    const root = parent === undefined ? message.info.id : lineage(parent)
    const start = first.get(root)
    const rootNudges = nudgesByRoot.get(root) ?? []
    const lastNudge = rootNudges.at(-1)
    let direct = false
    if (message.info.role === "assistant" && parent === root && start !== undefined) {
      const known = claimed.get(root)
      if (known !== undefined && known.size > 0) direct = known.has(message.info.id)
      else {
        // Legacy markers have no causal assistant list. Keep the old adjacent
        // fallback, but never pull a later direct child back over the nudge.
        direct = start.info.id < root ? !crossed(root, message.info.id) : message.info.id < start.info.id
      }
    }
    const continued = message.info.role === "user" && continuationIDs.has(message.info.id)
    let child = false
    if (message.info.role === "assistant" && parent !== undefined && continuationIDs.has(parent) && !crossed(root, message.info.id)) {
      const known = claimed.get(root)
      // An assistant claimed by a later nudge belongs before that nudge. An
      // unclaimed child of the final nudge is the final answer; an unclaimed
      // child of an earlier nudge is stale and must not be regrouped.
      child = known !== undefined && known.size > 0 ? known.has(message.info.id) || parent === lastNudge?.info.id : true
    }
    const key = roots.has(root) && (message.info.id === root || direct || continued || child) ? root : message.info.id
    groups.set(key, [...(groups.get(key) ?? []), message])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, group]) => {
      const root = group.find((message) => message.info.id === key && continuationPromptID(message) === undefined)
      if (!root) return group.sort((a, b) => a.info.id.localeCompare(b.info.id))
      const nudges = (nudgesByRoot.get(root.info.id) ?? []).filter((nudge) => group.includes(nudge))
      if (nudges.length === 0) return group.sort((a, b) => a.info.id.localeCompare(b.info.id))
      const children = (parentID: string) =>
        group.filter((message) => message.info.role === "assistant" && message.info.parentID === parentID)
      const placed = new Set<string>([root.info.id])
      const ordered: SessionV1.WithParts[] = [root]
      const appendAssistant = (id: string) => {
        if (placed.has(id)) return
        const message = byID.get(id)
        if (!message || !group.includes(message) || message.info.role !== "assistant") return
        ordered.push(message)
        placed.add(id)
      }
      for (const nudge of nudges) {
        const known = continuationAssistantIDs(nudge)
        if (known !== undefined) {
          for (const id of known) appendAssistant(id)
        } else {
          const previous = ordered.at(-1)
          const parentID = previous?.info.role === "user" ? previous.info.id : root.info.id
          for (const child of children(parentID)) appendAssistant(child.info.id)
          if (previous?.info.id !== root.info.id) for (const child of children(root.info.id)) appendAssistant(child.info.id)
        }
        ordered.push(nudge)
        placed.add(nudge.info.id)
      }
      const last = nudges.at(-1)!
      for (const child of children(last.info.id)) appendAssistant(child.info.id)
      for (const message of group) if (!placed.has(message.info.id)) ordered.push(message)
      return ordered
    })
}

const order = (messages: readonly SessionV1.WithParts[], current: SessionV1.WithParts) =>
  executionOrder([...messages.filter((message) => message.info.id !== current.info.id), current])

/**
 * True when the current assistant answers `promptID` directly or through runner nudges that continue it.
 * The messages between the prompt and the assistant must hold no real user message and no completed
 * finish. Silent no-reply annotations are transparent. When the transcript lacks the prompt (minimal
 * fixture), the same rules apply to every message after `promptID`; an empty history is a direct match.
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
  const lineage = lineageResolver(ordered)
  const end = ordered.findIndex((message) => message.info.id === current.info.id)
  let between: readonly SessionV1.WithParts[]
  if (ordered.some((message) => message.info.id === promptID)) {
    const anchors = anchorsOf(ordered, current, lineage)
    const found = anchors?.find((at) => ordered[at]!.info.id === promptID)
    if (!anchors || found === undefined) return false
    between = ordered.slice(anchors[anchors.length - 1]! + 1, end)
  } else {
    // The parent must exist chronologically before the assistant it answers.
    if (current.info.parentID !== promptID || promptID > current.info.id) return false
    between = ordered.slice(0, end).filter((message) => message.info.id > promptID)
  }
  if (ordered.some((message) => message.info.id === promptID)) {
    const anchors = anchorsOf(ordered, current, lineage)!
    return !executionBoundary(ordered, anchors[anchors.length - 1]! + 1, end, promptID, lineage)
  }
  return !between.some((message) => isBoundaryUser(message) || finished(message))
}

/** Visible assistant text from this prompt execution, never reasoning or tool output. */
export function resultChunks(messages: readonly SessionV1.WithParts[], current: SessionV1.WithParts) {
  if (current.info.role !== "assistant") return []
  const ordered = order(messages, current)
  const lineage = lineageResolver(ordered)
  const end = ordered.findIndex((message) => message.info.id === current.info.id)
  const text = (message: SessionV1.WithParts) =>
    message.parts.flatMap((part) => (part.type === "text" && !part.ignored && !part.synthetic ? [part.text] : []))
  const found = anchorsOf(ordered, current, lineage)
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
