import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import { Wildcard } from "@/util/wildcard"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}

/**
 * Tool denies every spawned subagent session runs under: the default
 * todowrite/task denies plus the config's `experimental.primary_tools`
 * denies. Shared by the task tool's spawn path and prompt-time capability
 * discovery so an advertised capability can never differ from what the
 * spawned child actually receives.
 */
export function deriveSubagentToolDenies(input: {
  subagent: Agent.Info
  primaryTools?: readonly string[]
}): PermissionV1.Ruleset {
  return [
    ...(input.subagent.permission.some((rule) => rule.permission === "todowrite")
      ? []
      : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(input.subagent.permission.some((rule) => rule.permission === "task")
      ? []
      : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(input.primaryTools?.map((permission) => ({
      permission,
      pattern: "*" as const,
      action: "deny" as const,
    })) ?? []),
  ]
}

/**
 * How much of the current worktree the spawned child session can actually
 * edit, under the exact ruleset it would run with (its own rules, parent
 * denies propagated into the child, and the default + primary_tools tool
 * denies):
 *
 * - "denied": a worktree-wide deny covers everything the child could edit
 *   here and no allow reaches the worktree - the child cannot implement here
 *   at all and must not be advertised as an implementer.
 * - "partial": at least one edit deny may reach paths inside the worktree,
 *   but an allow may also reach it (or the deny covers only a subtree). The
 *   child CAN still implement in permitted paths, so it stays advertised -
 *   but the guidance must not imply unrestricted implementation.
 * - "full": no edit deny can touch the worktree.
 *
 * The classification is a conservative may-intersect scan over the merged
 * ruleset, never a probe of one synthesized path: a single sample cannot
 * prove coverage, because wildcards and later allow rules decide where the
 * sample lands - a deny scoped to the probe path alone says nothing about
 * the rest of the worktree, and a narrow allow that happens to cover the
 * probe says nothing about paths still denied. Instead:
 *
 * - any edit deny whose pattern may reach the worktree (including "*" and
 *   relative patterns, which match worktree-relative targets) makes the
 *   capability at least "partial", even when a later allow narrows it - the
 *   guidance note can over-appear, but the prompt never promises
 *   unrestricted implementation while some worktree paths may be denied;
 * - "denied" additionally requires a deny that covers the whole worktree
 *   under the matcher's semantics ("*", or an absolute pattern ending in `*`
 *   whose literal run prefixes the worktree, e.g. "<dir>/**" or "<dir>/*")
 *   with no later allow that may reach the worktree (later rules win, so an
 *   allow shadowed by a subsequent covering deny leaves nothing editable).
 *
 * Pattern syntax and normalization are the matcher's own (util/wildcard):
 * `*` matches any string, including across `/`; `?` matches exactly one
 * character, also `/`; every other character - including `[`, `]` and `{`,
 * `}` - is literal (no character classes, no brace expansion); backslashes
 * are treated as `/`, and comparisons are case-insensitive on Windows. The
 * comparisons below normalize both sides the same way before testing, so a
 * deny written with Windows separators still counts on any platform.
 */
export function subagentWorktreeEditCapability(input: {
  worktree: string
  subagent: Agent.Info
  parentSessionPermission: PermissionV1.Ruleset
  primaryTools?: readonly string[]
}): "full" | "partial" | "denied" {
  const child = [
    deriveSubagentSessionPermission({
      parentSessionPermission: input.parentSessionPermission,
      subagent: input.subagent,
    }),
    deriveSubagentToolDenies({ subagent: input.subagent, primaryTools: input.primaryTools }),
  ]
  // Later rules win (findLast evaluation), so precedence matters: an allow
  // shadowed by a later worktree-wide deny leaves nothing editable, while an
  // allow after the last covering deny can leave its own scope editable.
  const rules = Permission.merge(input.subagent.permission, ...child).filter((rule) =>
    Wildcard.match("edit", rule.permission),
  )
  const denyReaches = rules.some(
    (rule) => rule.action === "deny" && patternMayReachWorktree(rule.pattern, input.worktree),
  )
  if (!denyReaches) return "full"
  let lastCover = -1
  rules.forEach((rule, index) => {
    if (rule.action === "deny" && patternCoversWorktree(rule.pattern, input.worktree)) lastCover = index
  })
  if (lastCover === -1) return "partial"
  const allowAfterCover = rules.some(
    (rule, index) =>
      index > lastCover && rule.action === "allow" && patternMayReachWorktree(rule.pattern, input.worktree),
  )
  return allowAfterCover ? "partial" : "denied"
}

/** Mirrors Wildcard.match normalization: backslashes are separators, and matching is case-insensitive on Windows. */
const normalizePath = (value: string) => {
  const slashed = value.replaceAll("\\", "/")
  return process.platform === "win32" ? slashed.toLowerCase() : slashed
}

const isAbsolutePattern = (pattern: string) => pattern.startsWith("/") || /^[a-zA-Z]:\//.test(pattern)

/** The worktree path normalized for comparison, with any trailing slashes stripped (root stays "/"). */
const worktreeRoot = (worktree: string) => normalizePath(worktree).replace(/\/+$/, "") || "/"

/** Boundary prefix for "at or below the worktree" tests; the filesystem root is its own boundary. */
const worktreeBoundary = (root: string) => (root === "/" ? "/" : root + "/")

/**
 * Conservative test: can `pattern` match a path at or below `worktree`?
 * Relative patterns match worktree-relative targets, so they always may.
 * Absolute patterns are compared by their leading literal run (before the
 * first `*` or `?`) at a `/` boundary; a leading wildcard reaches anywhere,
 * and wildcards after a literal run that is a prefix of the worktree can
 * absorb the remainder. Over-approximates on purpose: the answer is only
 * trusted when it is "no".
 */
export function patternMayReachWorktree(pattern: string, worktree: string): boolean {
  const normalized = normalizePath(pattern)
  if (!isAbsolutePattern(normalized)) return true
  const root = worktreeRoot(worktree)
  const boundary = worktreeBoundary(root)
  const wild = normalized.search(/[*?]/)
  const literal = wild === -1 ? normalized : normalized.slice(0, wild)
  if (literal === root) return true
  if (wild === -1) return literal.startsWith(boundary)
  if (literal === "") return true
  if (root.startsWith(literal)) return true
  if (literal.startsWith(root)) return literal.startsWith(boundary)
  return false
}

/**
 * Conservative test: does `pattern` deny EVERY path at or below `worktree`?
 * Only shapes that plainly do under the matcher's real semantics, where `*`
 * crosses `/` and `?` consumes exactly one character, also crossing `/`:
 * star-only patterns match everything, and an absolute pattern ending in a
 * trailing star RUN (`*` or `**` or more - the matcher treats a run of
 * stars as one dotAll wildcard) covers the tree when its head (before the
 * run, with no other `*`) matches every possible descendant prefix. Literal
 * heads use the plain boundary-prefix test ("/repo/*" and "/repo/**" are
 * equivalent here, and "/repo*" even covers sibling roots sharing the
 * prefix - still correct, because such a pattern genuinely matches those
 * paths too). A
 * head containing `?` is aligned against the root character by character:
 * literal positions must equal the root, `?` matches any single character,
 * and the head may reach at most two characters past it - the separating
 * slash (literal or `?`) plus one `?` for the first descendant character -
 * so "/repo/?*" covers every nonempty descendant and denies the whole tree.
 * A wildcard-free pattern only ever matches its exact path, so it never
 * covers a tree.
 * Anything uncertain returns false, so the caller degrades to "partial" -
 * the cautious note - instead of suppressing a capability that may exist.
 */
export function patternCoversWorktree(pattern: string, worktree: string): boolean {
  const normalized = normalizePath(pattern)
  if (/^\*+$/.test(normalized)) return true
  if (!isAbsolutePattern(normalized)) return false
  if (!normalized.endsWith("*")) return false
  // The matcher compiles every `*` to a dotAll run crossing `/`, so a trailing
  // star RUN (`*` or `**` or more) is one wildcard: strip it whole. Leaving a
  // single star in the head would wrongly reject shapes like "/repo/**" or
  // "/**", which deny the same paths as "/repo/*" and "/*".
  const head = normalized.replace(/\*+$/, "")
  if (head.includes("*")) return false
  if (head === "") return true
  const root = worktreeRoot(worktree)
  if (!head.includes("?")) return worktreeBoundary(root).startsWith(head)
  // Heads containing `?`: align character by character against the root. `?`
  // consumes exactly one character and crosses `/`, and the shortest real
  // descendant is root + "/" + one name character, so a head longer than
  // root + 2 characters leaves it unmatched and cannot cover.
  if (root === "/") {
    if (head.length > 2) return false
    for (let i = 0; i < head.length; i++) {
      if (head[i] === "?") continue
      // Position 0 is the root slash itself; a literal anywhere past it
      // restricts descendant names, so only `?` covers.
      if (i > 0) return false
      if (head[i] !== "/") return false
    }
    return true
  }
  if (head.length > root.length + 2) return false
  for (let i = 0; i < head.length; i++) {
    const c = head[i]
    if (c === "?") continue
    if (i < root.length) {
      if (c !== root[i]) return false
    } else if (i === root.length) {
      if (c !== "/") return false
    } else {
      // First descendant-name character: a literal here restricts which
      // children match, so only `?` covers every descendant.
      return false
    }
  }
  return true
}
