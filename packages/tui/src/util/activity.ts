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


export type ActivityKind = "explore" | "bash" | "edit" | "misc"

// Working-block kinds, keyed by tool id. Everything not listed here (web
// tools, LSP, skills, MCP, invalid, ...) stays in the unchanged "Working..."
// misc block. Membership here is presentation only: it never changes whether
// a call belongs to the activity run (that is NON_WORK_TOOLS above).
const TOOL_KIND: Record<string, ActivityKind> = {
  read: "explore",
  glob: "explore",
  grep: "explore",
  list: "explore",
  bash: "bash",
  write: "edit",
  edit: "edit",
  apply_patch: "edit",
}

export function activityKindOf(tool: string): ActivityKind {
  // Own-property lookup: indexing a plain object would resolve inherited
  // names ("constructor", "toString") to a bogus kind for unknown tools.
  return Object.prototype.hasOwnProperty.call(TOOL_KIND, tool) ? TOOL_KIND[tool]! : "misc"
}

export type ActivitySubGroup = {
  id: string
  kind: ActivityKind
  items: ActivityItem[]
  parts: ActivityGroupPart[]
}

// Splits one activity group into per-kind blocks in chronological order: a
// change of activity kind closes the current block, and same-kind work after
// an interleaving kind opens a NEW block (read, bash, read -> Explored, Ran,
// Explored). Reasoning attaches to the block of the tool call that follows it,
// since that is the action it plans; trailing reasoning lands in the last
// block. Block ids are occurrence-indexed (act-<firstToolId>:<kind>:<n>), so
// growing a run during streaming either grows the tail block or appends a new
// one without changing earlier blocks' ids. The ActivityGroup <For> keys rows
// by id (see the comment by subIDs in src/routes/session/index.tsx), so
// streamed updates never remount earlier sub-blocks or reset their collapse
// state (which is keyed on the same id).
export function computeActivitySubGroups(group: ActivityGroup): ActivitySubGroup[] {
  const toolKinds = group.parts.map((item) =>
    item.part.type === "tool" ? activityKindOf(item.part.tool) : undefined,
  )
  // Resolve reasoning to the kind of the tool call that follows it (that is
  // the action it plans); trailing reasoning joins the previous tool's block.
  const nextTool: (ActivityKind | undefined)[] = new Array(group.parts.length)
  let next: ActivityKind | undefined
  for (let i = group.parts.length - 1; i >= 0; i--) {
    if (toolKinds[i] !== undefined) next = toolKinds[i]
    nextTool[i] = next
  }
  const kinds: ActivityKind[] = new Array(group.parts.length)
  let prev: ActivityKind | undefined
  for (let i = 0; i < group.parts.length; i++) {
    if (toolKinds[i] !== undefined) {
      kinds[i] = toolKinds[i]!
      prev = toolKinds[i]
      continue
    }
    kinds[i] = nextTool[i] ?? prev ?? "misc"
  }
  const subs: ActivitySubGroup[] = []
  const occurrence = new Map<ActivityKind, number>()
  let current: ActivitySubGroup | undefined
  for (let i = 0; i < group.parts.length; i++) {
    const kind = kinds[i]!
    if (!current || current.kind !== kind) {
      const n = (occurrence.get(kind) ?? 0) + 1
      occurrence.set(kind, n)
      current = { id: `${group.id}:${kind}:${n}`, kind, items: [], parts: [] }
      subs.push(current)
    }
    current.parts.push(group.parts[i]!)
    if (group.parts[i]!.part.type === "tool") current.items.push(group.parts[i] as ActivityItem)
  }
  return subs
}

// The target a call counts towards in an Explored/Edited header. Distinct
// targets keep repeated reads of one file from inflating the count. Calls
// without a recognizable target still count once (fallback key per call).
// Path spellings differ per call ("src/a.ts" vs "./src/a.ts"); normalize
// before counting so one file is one target. The policy follows the
// platform's own naming rules: on Windows a backslash is a path separator
// and names are case-insensitive, so both are folded; on POSIX a backslash
// is a legal literal filename character and names are case-sensitive, so
// both are preserved. This key is only ever counted, never rendered, so
// display text is unaffected either way.
function normalizeTargetPath(value: string, platform: NodeJS.Platform = process.platform): string {
  let out = value.trim()
  if (platform === "win32") out = out.replaceAll("\\", "/").toLowerCase()
  while (out.startsWith("./")) out = out.slice(2)
  return out.replace(/\/+/g, "/")
}

// apply_patch inputs carry the whole patch text, not a filePath. Parse the
// affected files out of the patch headers so repeated patches to the same
// file count once and one multi-file patch counts each file.
const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm

function activityTarget(part: ToolPart, platform: NodeJS.Platform): string {
  const input = "input" in part.state && part.state.input ? (part.state.input as Record<string, unknown>) : {}
  const filePath = typeof input.filePath === "string" ? normalizeTargetPath(input.filePath, platform) : undefined
  switch (part.tool) {
    case "read":
    case "write":
    case "edit":
      return filePath ?? part.id
    case "apply_patch": {
      if (typeof input.patchText === "string") {
        const files = [...input.patchText.matchAll(PATCH_FILE_RE)]
          .map((match) => normalizeTargetPath(match[1] ?? "", platform))
          .filter((file) => file.length > 0)
        if (files.length > 0) return [...new Set(files)].sort().join("\n")
      }
      return filePath ?? part.id
    }
    case "glob":
    case "grep":
      return `${typeof input.pattern === "string" ? input.pattern : part.id} in ${typeof input.path === "string" ? normalizeTargetPath(input.path, platform) : ""}`
    case "list":
      return typeof input.path === "string" ? normalizeTargetPath(input.path, platform) : part.id
    default:
      return part.id
  }
}

// Distinct-target count for file-oriented blocks (Explored/Edited). Bash and
// misc blocks count calls instead, so they pass targetCount = summary.count.
export function countActivityTargets(
  items: readonly ActivityItem[],
  platform: NodeJS.Platform = process.platform,
): number {
  const seen = new Set<string>()
  for (const item of items) {
    // A multi-file apply_patch yields one composite key (newline-joined, and
    // real paths never contain newlines); count each affected file.
    for (const target of activityTarget(item.part, platform).split("\n")) seen.add(target)
  }
  return seen.size
}

// Per-kind header text. The misc block keeps the original "Working... N tool
// calls" / "Worked for X · N calls" wording; the typed blocks name the work.
// Duration renders as "· X" for typed blocks (mockup format) and stays
// "Worked for X · N calls" for misc.
export function typedActivityHeader(
  kind: ActivityKind,
  summary: ActivitySummary,
  targetCount: number,
  options: { expanded: boolean; duration: string | undefined },
): ActivityHeader {
  const marker = options.expanded ? "−" : "+"
  const failed = summary.failed > 0 ? `${summary.failed} failed` : undefined
  const suffix = options.duration ? ` · ${options.duration}` : ""
  if (kind === "misc") return activityHeader(summary, options)
  if (kind === "explore") {
    const main = summary.working
      ? `Exploring files...${suffix}`
      : `Explored ${targetCount} file${targetCount === 1 ? "" : "s"}${suffix}`
    const note = summary.working ? undefined : summary.interrupted ? "interrupted" : summary.denied ? "denied" : undefined
    return { marker, main, failed, note }
  }
  if (kind === "bash") {
    const main = summary.working
      ? `Running command...${suffix}`
      : `Ran ${summary.count} command${summary.count === 1 ? "" : "s"}${suffix}`
    const note = summary.working ? undefined : summary.interrupted ? "interrupted" : summary.denied ? "denied" : undefined
    return { marker, main, failed, note }
  }
  const main = summary.working
    ? `Editing files...${suffix}`
    : `Edited ${targetCount} file${targetCount === 1 ? "" : "s"}${suffix}`
  const note = summary.working ? undefined : summary.interrupted ? "interrupted" : summary.denied ? "denied" : undefined
  return { marker, main, failed, note }
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
  marker: "+" | "−"
  main: string
  failed: string | undefined
  note: string | undefined
}

export function activityHeader(
  summary: ActivitySummary,
  options: { expanded: boolean; duration: string | undefined },
): ActivityHeader {
  const marker = options.expanded ? "−" : "+"
  const calls = `${summary.count} tool call${summary.count === 1 ? "" : "s"}`
  const failed = summary.failed > 0 ? `${summary.failed} failed` : undefined
  if (summary.working) {
    return { marker, main: `Working... ${calls}${options.duration ? ` · ${options.duration}` : ""}`, failed, note: undefined }
  }
  const main = options.duration ? `Worked for ${options.duration} · ${calls}` : calls
  const note = summary.interrupted ? "interrupted" : summary.denied ? "denied" : undefined
  return { marker, main, failed, note }
}
