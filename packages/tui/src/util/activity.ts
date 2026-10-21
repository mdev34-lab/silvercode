import type { AssistantMessage, Message, Part, ReasoningPart, ToolPart } from "@opencode-ai/sdk/v2"

const ACTIVITY_ID_PREFIX = "act-"

// Orchestration/protocol tools — turn/task completion, todo-management
// bookkeeping, and subagent delegation — represent control flow rather than
// concrete user-facing work. They are not members of an activity group, so
// they are excluded from activity counting and rendering: the "Working... N
// tool calls" summary reflects meaningful work only. The transcript renders
// every excluded call as its own native top-level row instead (see
// computeActivityGroups), which keeps them available to the
// transcript/session system and makes them boundaries of the run they land in.
export const NON_WORK_TOOLS = new Set<string>(["finish", "todowrite", "todoread", "task"])

export type ActivityItem = {
  message: AssistantMessage
  part: ToolPart
}

export type ActivityGroupPart = {
  message: AssistantMessage
  part: ToolPart | ReasoningPart
}

export type ActivityGroup = {
  id: string
  items: ActivityItem[]
  parts: ActivityGroupPart[]
}

export type ActivityGroups = {
  byID: Map<string, ActivityGroup>
  groupOf: Map<string, string>
}

// Wrapper objects handed to the transcript must keep a stable identity across
// recomputes. The activity memo rebuilds the group maps on every streaming
// update, and Solid's keyed `<For>` remounts a row whenever its item object
// changes identity — which would reset local row state on every streamed
// delta: a manually expanded nested reasoning block collapses back to its
// header, and nested markdown/code bodies rebuild from scratch. Store parts
// mutate in place and keep their object identity for the lifetime of the
// transcript, so caching the wrapper on the part keeps row identity stable
// the same way the top-level part list already is.
const groupPartItems = new WeakMap<ToolPart | ReasoningPart, ActivityGroupPart>()

function groupPart<T extends ToolPart | ReasoningPart>(message: AssistantMessage, part: T) {
  const cached = groupPartItems.get(part)
  if (cached) {
    // Follow a replaced message info object without swapping the wrapper.
    if (cached.message !== message) cached.message = message
    return cached as { message: AssistantMessage; part: T }
  }
  const next = { message, part }
  groupPartItems.set(part, next)
  return next
}

export type ActivityRow = {
  message: Message
  parts: readonly Part[]
}

// A group is a maximal run of tool and reasoning parts that belong to one
// logical task in the conversation stream. The invariant is that a group only
// spans the parts it owns: user messages, visible assistant text, and
// orchestration/protocol tool calls (see NON_WORK_TOOLS) are rendered by the
// transcript as their own top-level rows, so any of them ends the run it lands
// in instead of being nested inside it. A text part ends the run only when it
// renders visible content: providers routinely persist empty text parts around
// tool-only steps (a text block opened with no deltas), and those parts render
// nothing, so treating every text part as a boundary fragments one logical
// work sequence into arbitrary blocks depending on stream batching. Grouping
// follows exactly what the transcript shows. Reasoning parts (per-turn CoT)
// belong to the run but do not start an activity until a tool is present.
// Invisible parts (step-start/step-finish, snapshots, patches, ...) neither
// render nor break a run. The group id is derived from the first tool part so
// it stays stable while the run grows at its tail during streaming.
export function computeActivityGroups(rows: readonly ActivityRow[]): ActivityGroups {
  const byID = new Map<string, ActivityGroup>()
  const groupOf = new Map<string, string>()
  const pending: ActivityGroupPart[] = []
  let current: ActivityGroup | undefined
  for (const row of rows) {
    if (row.message.role === "user") {
      current = undefined
      pending.length = 0
      continue
    }
    for (const part of row.parts) {
      // Mirror the transcript's own visibility rule: an assistant text row
      // renders only non-blank text, so a blank text part is not a semantic
      // boundary and falls through to the invisible-part skip below.
      if (part.type === "text" && part.text.trim() !== "") {
        current = undefined
        pending.length = 0
        continue
      }
      if (part.type === "reasoning") {
        const item = groupPart(row.message, part)
        if (!current) {
          pending.push(item)
          continue
        }
        current.parts.push(item)
        groupOf.set(part.id, current.id)
        continue
      }
      if (part.type !== "tool") continue
      if (NON_WORK_TOOLS.has(part.tool)) {
        // Membership is the invariant: a call the group does not own renders
        // as its own top-level row, so it ends the current run the same way
        // assistant text does. Closing `current` finalizes the group instead
        // of letting the work after the call resume it, and dropping `pending`
        // keeps reasoning that had not found a run yet out of the group that
        // opens afterwards. Adding an exception to NON_WORK_TOOLS is therefore
        // all it takes to make it a boundary — no per-tool rule here.
        current = undefined
        pending.length = 0
        continue
      }
      if (!current) {
        current = { id: ACTIVITY_ID_PREFIX + part.id, items: [], parts: [...pending] }
        byID.set(current.id, current)
        for (const item of pending) groupOf.set(item.part.id, current.id)
        pending.length = 0
      }
      const item = groupPart(row.message, part)
      current.items.push(item)
      current.parts.push(item)
      groupOf.set(part.id, current.id)
    }
  }
  return { byID, groupOf }
}

export type ToolPartOutcome = "pending" | "running" | "completed" | "denied" | "interrupted" | "error"

// Denied and interrupted outcomes are tool errors that resulted from a user
// decision rather than from the tool itself. The inline tool rows render them
// as cancelled actions instead of failures, so group summaries need to tell
// them apart too.
export function toolPartOutcome(part: ToolPart): ToolPartOutcome {
  const state = part.state
  if (state.status !== "error") return state.status
  if (
    state.error.includes("QuestionRejectedError") ||
    state.error.includes("rejected permission") ||
    state.error.includes("specified a rule") ||
    state.error.includes("user dismissed")
  )
    return "denied"
  if (state.metadata?.interrupted === true || state.error.includes("Tool execution aborted")) return "interrupted"
  return "error"
}

export type ActivitySummary = {
  count: number
  working: boolean
  failed: number
  denied: boolean
  interrupted: boolean
  durationMs: number | undefined
}

export function summarizeActivity(parts: readonly ToolPart[]): ActivitySummary {
  let working = false
  let failed = 0
  let denied = false
  let interrupted = false
  let start: number | undefined
  let end: number | undefined
  for (const part of parts) {
    const outcome = toolPartOutcome(part)
    if (outcome === "pending" || outcome === "running") working = true
    if (outcome === "error") failed++
    if (outcome === "denied") denied = true
    if (outcome === "interrupted") interrupted = true
    const state = part.state
    if (state.status !== "pending" && state.time.start !== undefined) {
      start = start === undefined ? state.time.start : Math.min(start, state.time.start)
    }
    if (state.status === "completed" || state.status === "error") {
      end = end === undefined ? state.time.end : Math.max(end, state.time.end)
    }
  }
  const durationMs = working || start === undefined || end === undefined ? undefined : Math.max(0, end - start)
  return { count: parts.length, working, failed, denied, interrupted, durationMs }
}

export type ActivityExpandedOverride = boolean | undefined

// A group's expanded state is its explicit per-group override when the user
// toggled it, otherwise it follows the global expand-all/collapse-all
// default. Resolving never writes: a newly rendered group with no override
// simply follows the default without touching any other group's toggle.
export function resolveActivityExpanded(override: ActivityExpandedOverride, allExpanded: boolean): boolean {
  return override ?? allExpanded
}

// The override to store after toggling a group. Overrides that match the
// global default are cleared so the map only holds groups that differ from
// the default and collapsed groups leave no residue behind.
export function toggleActivityOverride(
  override: ActivityExpandedOverride,
  allExpanded: boolean,
): ActivityExpandedOverride {
  const next = !resolveActivityExpanded(override, allExpanded)
  return next === allExpanded ? undefined : next
}

export type ActivityHeader = {
  marker: "▸" | "▾"
  main: string
  failed: string | undefined
  note: string | undefined
}

export function activityHeader(
  summary: ActivitySummary,
  options: { expanded: boolean; duration: string | undefined },
): ActivityHeader {
  const marker = options.expanded ? "▾" : "▸"
  const calls = `${summary.count} tool call${summary.count === 1 ? "" : "s"}`
  const failed = summary.failed > 0 ? `${summary.failed} failed` : undefined
  if (summary.working) {
    return { marker, main: `Working... ${calls}${options.duration ? ` · ${options.duration}` : ""}`, failed, note: undefined }
  }
  const main = options.duration ? `Worked for ${options.duration} · ${calls}` : calls
  const note = summary.interrupted ? "interrupted" : summary.denied ? "denied" : undefined
  return { marker, main, failed, note }
}
