import type { Part, TextPart, ReasoningPart, ToolState } from "@opencode-ai/sdk/v2"

// This reconciler is coupled to the event-ordering guarantees produced by
// `packages/opencode/src/session/processor.ts` (append-only deltas, a single
// non-cumulative text write at `text-end`, one terminal tool transition,
// immutable `time.start`). There is no revision/sequence number on the wire,
// so those guarantees are the only source of causality. If the processor
// changes them (e.g. adds per-part revisions, re-publishes terminal rows, or
// introduces a new non-cumulative write), this reconciler must be updated and
// its invariants re-tested.

type PartTime = { start: number; end?: number }

function searchPart(parts: Part[], id: string) {
  let left = 0
  let right = parts.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = parts[middle].id
    if (value === id) return { found: true, index: middle }
    if (value < id) left = middle + 1
    else right = middle - 1
  }
  return { found: false, index: left }
}

function isTextLike(part: Part): part is TextPart | ReasoningPart {
  return part.type === "text" || part.type === "reasoning"
}

// `message.part.updated` carries a durable snapshot that can lag the deltas
// already applied to the store: the part's "started" row is persisted with
// empty `text` before its deltas, and a bootstrap/replay (SSE reconnect) can
// redeliver an older row while the part is still streaming. Replacing the part
// wholesale would erase rendered text, so streamed content is preserved.
//
// The protocol gives us causality without a version number
// (`packages/opencode/src/session/processor.ts`):
// - `message.part.delta` text evolves only by append (`text-delta`,
//   `reasoning-delta`), so a snapshot that is a strict prefix of what is
//   already rendered is older — keep the longer streamed text, except for
//   the first terminal text snapshot described below;
// - a snapshot that extends the rendered text accumulated more deltas — adopt;
// - the only legitimate non-cumulative text write is the `text-end` snapshot
//   (the `experimental.text.complete` plugin rewrites the final text) and it
//   is published together with `time.end`; adopt it even if it is a prefix or
//   empty. Reasoning snapshots retain the existing prefix behavior;
// - a part reaches its terminal snapshot exactly once, so once `time.end` is
//   set the part is a sink: a replayed row without `time.end` — even one that
//   "extends" the final text — is older and must not reopen the part, and a
//   second terminal row with different text cannot be causally newer either;
// - any other conflict (same length, different content; reordered rows) has no
//   causal ordering, so never replace text already on screen.
export function mergePartText(current: Part | undefined, incoming: Part): Part {
  if (!current || !isTextLike(current) || !isTextLike(incoming)) return incoming
  const currentText = current.text
  const incomingText = incoming.text
  if (incomingText === currentText) return incoming

  const currentTerminal = current.time?.end !== undefined
  const incomingTerminal = incoming.time?.end !== undefined

  // A finished part is a sink; check terminality before the prefix/extension
  // rules, otherwise a longer non-terminal "extension" of the final text would
  // be adopted and appear to reopen a part that already ended.
  if (currentTerminal) {
    return { ...incoming, text: currentText }
  }

  // text-end may rewrite text to a strict prefix or even an empty string.
  // Reasoning has no corresponding plugin rewrite and keeps prefix protection.
  if (current.type === "text" && incoming.type === "text" && incomingTerminal) return incoming
  if (currentText.startsWith(incomingText)) return { ...incoming, text: currentText }
  if (incomingText.startsWith(currentText)) return incoming
  if (incomingTerminal) return incoming
  return { ...incoming, text: currentText }
}

// `time.start` is fixed when the part is created — the processor never rewrites
// it (a replayed `tool-call` keeps the existing running state, and `text-end`
// only adds `end`) — so the first value seen wins. `time.end` is monotonic:
// written once by the terminal snapshot, so a stale replay must not erase it or
// move it backwards.
function mergeTime(current: PartTime | undefined, incoming: PartTime | undefined): PartTime | undefined {
  if (!incoming) return current ? { ...current } : undefined
  const start = current?.start ?? incoming.start
  const end =
    incoming.end === undefined ? current?.end : Math.max(incoming.end, current?.end ?? Number.NEGATIVE_INFINITY)
  return { start, ...(end === undefined ? {} : { end }) }
}

// `metadata.interrupted` is written by the abort path together with the
// terminal error state. A later (stale) replay of an earlier row must not
// clear it, or an interrupted tool renders as a plain failure.
function mergeMetadata(
  current: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (incoming === undefined && current === undefined) return undefined
  const preserved = current?.interrupted === true ? { interrupted: true } : {}
  if (incoming === undefined) return { ...current }
  return { ...incoming, ...preserved }
}

// Tool state transitions follow the processor's state machine:
// pending → running → completed|error, and `completeToolCall`/`failToolCall`
// only act when the part is `running`, so a part reaches a terminal state
// exactly once. Projecting that state machine (not comparing payload sizes):
// - a stale replay of an earlier status never rewinds the state;
// - `output` / `error` are written once, by that single terminal transition;
// - a second snapshot of the same status cannot carry newer `output`/`error`
//   (the tool already finished), so fields both snapshots define stay as the
//   current (older-to-us or equal-age) row has them — the incoming snapshot
//   may only add fields we do not have yet (schema evolution);
// - the running → running exception comes from `tool-call`, which the
//   processor re-publishes while a tool is running to update `input`;
// - `time` and `metadata` are monotonic (start immutable, end max,
//   `interrupted` never cleared).
//
// This "same-status terminal snapshots carry nothing newer" invariant comes
// from the processor contract — if it ever starts re-publishing terminal rows
// (e.g. progress updates on a completed tool), the guards below must be
// revisited together with the coupling note at the top of this file.
const TOOL_TERMINAL: ReadonlySet<ToolState["status"]> = new Set(["completed", "error"])
const TOOL_STATUS_RANK: Record<ToolState["status"], number> = {
  pending: 0,
  running: 1,
  completed: 2,
  error: 2,
}

type LooseToolState = ToolState & {
  output?: string
  error?: string
  title?: string
  metadata?: Record<string, unknown>
  time?: PartTime
  attachments?: unknown[]
}

function mergeToolState(current: ToolState, incoming: ToolState): ToolState {
  const cur = current as LooseToolState
  const inc = incoming as LooseToolState

  // A part reaches a terminal state exactly once; never accept a transition
  // out of it, a different terminal state, or an earlier status.
  if (TOOL_TERMINAL.has(cur.status) && (!TOOL_TERMINAL.has(inc.status) || inc.status !== cur.status)) {
    return current
  }
  if (TOOL_STATUS_RANK[inc.status] < TOOL_STATUS_RANK[cur.status]) return current

  const transitioning = inc.status !== cur.status
  const merged: LooseToolState = transitioning ? { ...inc } : { ...cur }

  if (!transitioning) {
    // Same status: do not overwrite fields both snapshots define; only adopt
    // what we do not have yet (an older or equal-age row cannot be more
    // complete), except `input` for running parts (see above).
    for (const key of Object.keys(inc)) {
      if ((merged as Record<string, unknown>)[key] === undefined) {
        ;(merged as Record<string, unknown>)[key] = (inc as Record<string, unknown>)[key]
      }
    }
    if (cur.status === "running") merged.input = inc.input
  }

  merged.time = mergeTime(cur.time, inc.time)
  merged.metadata = mergeMetadata(cur.metadata, inc.metadata)

  // Keep the merged state schema-shaped: no `undefined` keys.
  for (const key of Object.keys(merged)) {
    if ((merged as Record<string, unknown>)[key] === undefined) {
      delete (merged as Record<string, unknown>)[key]
    }
  }
  return merged as ToolState
}

// Replaces the content of `target` with `source` while keeping `target`'s
// identity. Only used when the part's *type* itself changes (schema evolution;
// a streaming part never changes type), where an in-place payload swap is the
// only identity-preserving option.
function replaceInPlace(target: Part, source: Part) {
  const destination = target as Record<string, unknown>
  for (const key of Object.keys(destination)) delete destination[key]
  for (const key of Object.keys(source)) destination[key] = (source as Record<string, unknown>)[key]
}

// Merges `source` into `target` in place, keeping `target`'s identity.
//
// The transcript renders parts inside a keyed `<For>` (Solid's `For` keys by
// object identity), so replacing the part object for every streamed delta
// would dispose and re-create the streaming component on each token: the
// markdown/syntax tree is rebuilt from scratch, layout re-runs, and local
// state (e.g. an expanded reasoning block) resets — the aggressive redraw and
// flicker. Mutating the existing part in place keeps the mount stable while
// the changed field's reactive node (Solid store) still fires.
//
// The merge is explicit about the fields with streaming semantics instead of
// copying the snapshot blindly:
// - text/reasoning `text`: already resolved by `mergePartText` (prefix and
//   terminal rules above, never a length comparison);
// - `time`: start immutable, end monotonic (`mergeTime`);
// - tool `state`: state machine above (status/output/error written once);
// - every other field (including fields a newer schema may add) is adopted
//   from the snapshot; fields absent from the snapshot are kept, never deleted,
//   so an older durable row cannot drop newer data.
export function mergePartInPlace(target: Part, source: Part): Part {
  if (target.type !== source.type) {
    replaceInPlace(target, source)
    return target
  }

  if (isTextLike(target) && isTextLike(source)) {
    target.text = source.text
  }
  if (target.type === "tool" && source.type === "tool") {
    target.state = mergeToolState(target.state, source.state)
  }

  const currentTime = (target as { time?: PartTime }).time
  const incomingTime = (source as { time?: PartTime }).time
  const mergedTime = mergeTime(currentTime, incomingTime)
  if (mergedTime !== undefined) (target as { time?: PartTime }).time = mergedTime

  const destination = target as Record<string, unknown>
  const incoming = source as Record<string, unknown>
  for (const key of Object.keys(incoming)) {
    if (key === "type" || key === "id" || key === "sessionID" || key === "messageID") continue
    if (key === "text" || key === "state" || key === "time") continue
    destination[key] = incoming[key]
  }
  return target
}

// Transition for the `message.part.updated` handler: merges the durable
// snapshot into the existing part in place (preserving object identity and
// streamed content; see `mergePartInPlace`), inserts missing parts in id
// order, and seeds the list when none exists yet. Operates on a Solid store
// draft (or a plain array in tests); pass it to `setStore(..., produce(...))`
// so mutations are applied and notified.
export function applyPartUpdated(parts: Part[] | undefined, incoming: Part): Part[] {
  if (!parts) return [incoming]
  const result = searchPart(parts, incoming.id)
  if (result.found) {
    const current = parts[result.index]
    mergePartInPlace(current, mergePartText(current, incoming))
    return parts
  }
  parts.splice(result.index, 0, incoming)
  return parts
}

// Transition for the `message.part.delta` handler: appends a streamed delta to
// the named field of the existing part, preserving the part's object identity
// (see `mergePartInPlace`), and returns the same list. Returns undefined when
// there is no part to append to (matching the live-only handler's early
// return). Deltas are string appends — the wire protocol only streams `text` —
// so a non-string target (e.g. `metadata`, `time`, `state`) is a protocol
// violation and is left untouched rather than corrupting the part.
export function applyPartDelta(
  parts: Part[] | undefined,
  partID: string,
  field: string,
  delta: string,
): Part[] | undefined {
  if (!parts) return undefined
  const result = searchPart(parts, partID)
  if (!result.found) return undefined
  const part = parts[result.index] as Record<string, unknown>
  const current = part[field]
  if (current !== undefined && typeof current !== "string") return parts
  part[field] = ((current as string | undefined) ?? "") + delta
  return parts
}
