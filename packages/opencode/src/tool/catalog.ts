import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Context, Data, Effect, Layer } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { isRecord } from "@/util/record"
import { InstanceState } from "@/effect/instance-state"
import { BM25 } from "@/search/bm25"
import { Wildcard } from "@/util/wildcard"
import { Wildcard as CoreWildcard } from "@opencode-ai/core/util/wildcard"

/**
 * Catalog of every tool the current agent could use, including the ones that are
 * withheld from the model until it discovers them with `tool_search`.
 *
 * The catalog is intentionally passive: `SessionTools.resolve` pushes the current
 * entries in on every step. Keeping the dependency arrow pointing that way avoids a
 * layer cycle (registry -> tool_search -> catalog -> registry) and makes the catalog
 * trivially testable.
 */

export type Source = "builtin" | "mcp"

export interface Entry {
  id: string
  description: string
  parameters: string[]
  source: Source
  /** MCP server name, when the tool comes from an MCP server */
  server?: string
  /** Withheld from the model until discovered through a tool search */
  deferred: boolean
}

export interface Options {
  enabled: boolean
  alwaysLoad: string[]
  defer: string[]
  limit: number
}

export interface SearchOptions {
  limit?: number
  source?: Source
  /**
   * The session doing the search. Tools it already discovered are in its next request, so
   * they are filtered out for the same reason loaded tools are — they would burn a result
   * slot on something the model already has.
   */
  session?: string
  /**
   * Include tools that are already loaded into the request. Off by default: the point of a
   * tool search is to surface what the model cannot see, and a loaded tool would just burn
   * a result slot.
   */
  includeLoaded?: boolean
}

/**
 * Collapse tool ids into the lines of the `<available_tools>` overview block.
 *
 * Tools are grouped by their first underscore-separated segment. A family of three or more
 * collapses to its longest common segment prefix plus a wildcard and a member count
 * (`playwright_* (12)`); smaller groups are listed by name on a single line, sorted
 * alphabetically. Collapsed families come first, ordered by count descending (label
 * ascending for ties). Names only — descriptions stay the job of tool_search.
 */
export function collapseToolNames(ids: string[]): string[] {
  if (ids.length === 0) return []
  const families = new Map<string, string[]>()
  for (const id of ids) {
    const key = id.split("_")[0] ?? id
    const members = families.get(key) ?? []
    members.push(id)
    families.set(key, members)
  }

  const collapsed: { label: string; count: number }[] = []
  const nominal: string[] = []
  for (const members of families.values()) {
    members.sort()
    if (members.length >= 3) collapsed.push({ label: `${commonSegmentPrefix(members)}_*`, count: members.length })
    else nominal.push(...members)
  }

  collapsed.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  const lines = collapsed.map(({ label, count }) => `${label} (${count})`)
  if (nominal.length > 0) lines.push(nominal.sort().join(", "))
  return lines
}

/** Longest prefix of `ids` at underscore-segment granularity, joined back with `_`. */
function commonSegmentPrefix(ids: string[]): string {
  const segments = ids.map((id) => id.split("_"))
  const first = segments[0]
  let shared = 0
  outer: for (let i = 0; i < first.length; i++) {
    for (const parts of segments) {
      if (parts[i] !== first[i]) break outer
    }
    shared = i + 1
  }
  return first.slice(0, shared).join("_")
}

/** Longest regex we are willing to compile from model input */
export const MAX_PATTERN_LENGTH = 200

/**
 * Longest slice of a description that is searchable. Both searches use it, so a term past
 * the cut is invisible to both: `tool_search` and `tool_search_regex` must never disagree
 * about whether a tool matches.
 */
export const MAX_DESCRIPTION_LENGTH = 2000

/** Largest repetition count accepted in a bounded quantifier */
const MAX_REPETITION = 1000

export class InvalidPatternError extends Data.TaggedError("ToolCatalog.InvalidPatternError")<{
  pattern: string
  detail: string
}> {
  override get message() {
    return `Invalid regex pattern "${this.pattern}": ${this.detail}`
  }
}

/** Maximum number of results a single search returns unless configured otherwise */
export const DEFAULT_LIMIT = 5

/**
 * Tools that stay in every request. These are the ones an agent needs to do basic work
 * (and to search for everything else) — deferring them would just cost an extra round trip.
 */
export const CORE_TOOLS = [
  "invalid",
  "tool_search",
  "tool_search_regex",
  "shell",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "apply_patch",
  "todowrite",
  "todoread",
  "task",
  "skill",
  "question",
  "plan_exit",
  "finish",
  "execute",
] as const

const CORE = new Set<string>(CORE_TOOLS)

export function options(config: ConfigV1.Info["tool_search"]): Options {
  return {
    enabled: config?.enabled ?? true,
    alwaysLoad: config?.always_load ?? [],
    defer: config?.defer ?? [],
    limit: config?.limit ?? DEFAULT_LIMIT,
  }
}

function matches(id: string, patterns: string[]) {
  // Tool-name patterns are action names: legacy `bash` entries must match the tool
  // now published as `shell` (#780).
  return patterns.some((pattern) => CoreWildcard.matchAction(id, pattern))
}

/** Should this tool be withheld from the model until it is discovered? */
export function deferred(input: { id: string; source: Source; options: Options }): boolean {
  if (!input.options.enabled) return false
  if (matches(input.id, input.options.alwaysLoad)) return false
  if (matches(input.id, input.options.defer)) return true
  if (input.source === "mcp") return true
  return !CORE.has(input.id)
}

/**
 * Regexes come straight from the model, so a valid-but-pathological pattern (nested or
 * alternating quantifiers, backreferences, huge repetition counts) could pin the event loop
 * with catastrophic backtracking. JavaScript cannot interrupt a running regex, so the only
 * defence is to refuse the shapes that cause it before compiling.
 *
 * This is a mitigation, not a sandbox: it rejects the known-explosive shapes and bounds the
 * input, it does not prove that what is left runs in polynomial time.
 *
 * Returns the reason a pattern is rejected, or undefined when it is safe to compile.
 */
export function unsafePattern(pattern: string): string | undefined {
  if (pattern.length > MAX_PATTERN_LENGTH) return `pattern is longer than ${MAX_PATTERN_LENGTH} characters`
  if (/\\[1-9]/.test(pattern)) return "backreferences are not supported"
  for (const repetition of pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
    const bounds = [repetition[1], repetition[2]].filter(Boolean).map(Number)
    if (bounds.some((bound) => bound > MAX_REPETITION))
      return `repetition counts above ${MAX_REPETITION} are not supported`
  }

  // A group followed by a quantifier, where the group itself contains a quantifier or an
  // alternation, is the classic exponential-backtracking shape: (a+)+ , (a|a)* , (x*)*
  const open: number[] = []
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === "\\") {
      i++
      continue
    }
    if (char === "(") {
      open.push(i)
      continue
    }
    if (char !== ")") continue
    const start = open.pop()
    if (start === undefined) continue
    const rest = pattern.slice(i + 1)
    if (!/^(?:[*+?]|\{\d+(?:,\d*)?\})/.test(rest)) continue
    const body = pattern.slice(start + 1, i).replace(/\\./g, "")
    if (/[*+?]|\{\d+(?:,\d*)?\}/.test(body)) return "nested quantifiers are not supported"
    if (body.includes("|")) return "a quantified group with alternation is not supported"
  }

  return undefined
}

type State = {
  entries: Entry[]
  index: BM25.Index<Entry> | undefined
  limit: number
  discovered: Map<string, Set<string>>
}

export interface Interface {
  /** Replace the catalog contents. Called once per agent step. */
  readonly sync: (entries: Entry[], options?: Options) => Effect.Effect<void>
  readonly list: () => Effect.Effect<Entry[]>
  readonly get: (id: string) => Effect.Effect<Entry | undefined>
  readonly search: (query: string, options?: SearchOptions) => Effect.Effect<Entry[]>
  readonly searchRegex: (pattern: string, options?: SearchOptions) => Effect.Effect<Entry[], InvalidPatternError>
  readonly discover: (sessionID: string, ids: string[]) => Effect.Effect<void>
  readonly discovered: (sessionID: string) => Effect.Effect<ReadonlySet<string>>
  readonly forget: (sessionID: string) => Effect.Effect<void>
  /**
   * Names of the tools hidden from a session right now (deferred and not yet discovered),
   * rendered as a `<available_tools>` block with families collapsed by prefix. The block
   * tells the model what exists so it can decide to look one up with tool_search; it is
   * `undefined` when nothing is hidden.
   */
  readonly overview: (sessionID: string) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolCatalog") {}

export const use = serviceUse(Service)

const EMPTY: ReadonlySet<string> = new Set<string>()

function session(state: State, options?: SearchOptions): ReadonlySet<string> {
  if (!options?.session) return EMPTY
  return state.discovered.get(options.session) ?? EMPTY
}

/**
 * The searchable text of an entry, as a list of fields. Both searches read exactly this:
 * the keyword index is built from it and the regex is tested against each field, so
 * `tool_search` and `tool_search_regex` can never disagree about whether a tool matches.
 * Fields stay separate so an anchored pattern like `^github_` still means "the id starts
 * with", not "somewhere in a concatenation".
 */
export function corpus(entry: Entry): string[] {
  return [entry.id, entry.description.slice(0, MAX_DESCRIPTION_LENGTH), ...entry.parameters]
}

function discoverable(entry: Entry, options: SearchOptions | undefined, discovered: ReadonlySet<string>) {
  if (options?.source && entry.source !== options.source) return false
  if (options?.includeLoaded === true) return true
  // Deferred but already discovered means the session has it: hidden to the catalog,
  // visible to the model.
  return entry.deferred && !discovered.has(entry.id)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolCatalog.state")(() =>
        Effect.succeed<State>({ entries: [], index: undefined, limit: DEFAULT_LIMIT, discovered: new Map() }),
      ),
    )

    const sync: Interface["sync"] = Effect.fn("ToolCatalog.sync")(function* (entries, options) {
      const s = yield* InstanceState.get(state)
      s.entries = entries
      s.limit = options?.limit ?? DEFAULT_LIMIT
      // Parameter names carry real signal ("owner", "repo", "sql"), and measurably improve
      // recall@1 on the retrieval battery without hurting recall@3. Rebuilding beats trying
      // to detect what changed: the catalog is small and the index is only read per search.
      s.index = BM25.createIndex(entries, corpus)
    })

    const list: Interface["list"] = Effect.fn("ToolCatalog.list")(function* () {
      return (yield* InstanceState.get(state)).entries
    })

    const get: Interface["get"] = Effect.fn("ToolCatalog.get")(function* (id) {
      return (yield* InstanceState.get(state)).entries.find((entry) => entry.id === id)
    })

    const search: Interface["search"] = Effect.fn("ToolCatalog.search")(function* (query, options) {
      const s = yield* InstanceState.get(state)
      if (!s.index) return []
      const held = session(s, options)
      return BM25.search(s.index, query, s.entries.length)
        .map((result) => result.item)
        .filter((entry) => discoverable(entry, options, held))
        .slice(0, options?.limit ?? s.limit)
    })

    const searchRegex: Interface["searchRegex"] = Effect.fn("ToolCatalog.searchRegex")(function* (pattern, options) {
      const s = yield* InstanceState.get(state)
      const unsafe = unsafePattern(pattern)
      if (unsafe) return yield* Effect.fail(new InvalidPatternError({ pattern, detail: unsafe }))
      const regex = yield* Effect.try({
        try: () => new RegExp(pattern, "i"),
        catch: (error) =>
          new InvalidPatternError({ pattern, detail: error instanceof Error ? error.message : String(error) }),
      })
      const held = session(s, options)
      return s.entries
        .filter((entry) => discoverable(entry, options, held))
        .filter((entry) => corpus(entry).some((field) => regex.test(field)))
        .slice(0, options?.limit ?? s.limit)
    })

    const discover: Interface["discover"] = Effect.fn("ToolCatalog.discover")(function* (sessionID, ids) {
      const s = yield* InstanceState.get(state)
      const existing = s.discovered.get(sessionID) ?? new Set<string>()
      for (const id of ids) {
        // Discovery only ever unlocks a deferred tool. Anything else — a loaded tool, or an
        // id that is not in the catalog at all — is not something a search may grant.
        if (!s.entries.some((entry) => entry.id === id && entry.deferred)) continue
        existing.add(id)
      }
      s.discovered.set(sessionID, existing)
    })

    const discovered: Interface["discovered"] = Effect.fn("ToolCatalog.discovered")(function* (sessionID) {
      const s = yield* InstanceState.get(state)
      return s.discovered.get(sessionID) ?? EMPTY
    })

    const forget: Interface["forget"] = Effect.fn("ToolCatalog.forget")(function* (sessionID) {
      const s = yield* InstanceState.get(state)
      s.discovered.delete(sessionID)
    })

    const overview: Interface["overview"] = Effect.fn("ToolCatalog.overview")(function* (sessionID) {
      const s = yield* InstanceState.get(state)
      const held = s.discovered.get(sessionID) ?? EMPTY
      const hidden = s.entries.filter((entry) => entry.deferred && !held.has(entry.id))
      if (hidden.length === 0) return undefined
      return ["<available_tools>", ...collapseToolNames(hidden.map((entry) => entry.id)), "</available_tools>"].join(
        "\n",
      )
    })

    // Discovery is per session, so it has to die with the session: otherwise a long-running
    // server accumulates one Set per session that ever ran a search.
    const events = yield* EventV2Bridge.Service
    yield* events.listen((event) => {
      if (event.type !== SessionV1.Event.Deleted.type) return Effect.void
      const data = event.data
      if (!isRecord(data) || typeof data.sessionID !== "string") return Effect.void
      return forget(data.sessionID).pipe(
        Effect.catchCause((cause) => Effect.logError("tool catalog cleanup failed", { cause })),
      )
    })

    return Service.of({ sync, list, get, search, searchRegex, discover, discovered, forget, overview })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [EventV2Bridge.node] })

export * as ToolCatalog from "./catalog"
