export * as Wildcard from "./wildcard"

export function match(input: string, pattern: string) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}

/**
 * Legacy permission-action aliases. The shell tool was published as "bash"
 * before the rename to "shell" (#780); persisted rules, saved grants, and user
 * config may still spell the action "bash".
 *
 * `matchAction` is plain union matching resolved by the caller's `findLast`
 * (the contract the rename must preserve): a pattern matches the action if
 * it matches any spelling of the tool's name, current or legacy. Canonical
 * wildcards therefore keep working (`s*` names `shell` today, `ba*` still
 * names it via the legacy spelling), and a legacy `bash` rule can never
 * silently stop matching.
 *
 * The one compatibility hazard union matching creates is *recruitment*: a
 * wildcard like `s*` — written when it covered `skill` — now also covers
 * `shell`, and ordered after an explicit `bash: deny` it would bypass that
 * deny. `recruitedByRename` identifies exactly those matches (a wildcard
 * matching the canonical name but no legacy spelling; exact spellings of
 * either name are never recruited), and `winningRule` applies the narrow
 * clamp the issue's no-broadening contract requires: a rename-recruited
 * winner cannot lift a deny that already applied under the legacy name.
 * Everything else — canonical carve-outs, narrowing, explicit re-permits by
 * exact name — keeps plain written-order semantics.
 */
const LEGACY_ACTION_ALIASES: Readonly<Record<string, readonly string[]>> = { shell: ["bash"] }

export function matchAction(action: string, pattern: string) {
  const canonicalName = canonical(action)
  const subjects = new Set([action, canonicalName, ...(LEGACY_ACTION_ALIASES[canonicalName] ?? [])])
  return [...subjects].some((subject) => match(subject, pattern))
}

/** Plain pre-rename matching: does `pattern` match the action's legacy spelling(s)? */
export function matchesLegacyName(action: string, pattern: string) {
  return (LEGACY_ACTION_ALIASES[canonical(action)] ?? []).some((name) => match(name, pattern))
}

/**
 * Does `pattern` match the action only because of the rename — a wildcard
 * matching the canonical name but no legacy spelling? Exact spellings of
 * either name name the tool in whichever era they were written and are
 * never recruited.
 */
export function recruitedByRename(action: string, pattern: string) {
  const canonicalName = canonical(action)
  if ((LEGACY_ACTION_ALIASES[canonicalName] ?? []).length === 0) return false
  if (!pattern.includes("*") && !pattern.includes("?")) return false
  return match(canonicalName, pattern) && !matchesLegacyName(action, pattern)
}

/**
 * The winning rule for an action: plain union matching with `findLast`
 * order, plus the rename clamp above. `actionPattern` extracts the pattern
 * matched against the (possibly renamed) action/tool name; `restMatches`
 * covers the remaining dimensions of the rule (e.g. the resource pattern);
 * `isDeny` identifies deny rules. Only deny is clamped, and only when the
 * union winner matched the action solely via rename recruitment.
 */
export function winningRule<T>(
  rules: readonly T[],
  action: string,
  actionPattern: (rule: T) => string,
  restMatches: (rule: T) => boolean,
  isDeny: (rule: T) => boolean,
): T | undefined {
  const winner = rules.findLast((rule) => matchAction(action, actionPattern(rule)) && restMatches(rule))
  if (!winner || isDeny(winner)) return winner
  if (!recruitedByRename(action, actionPattern(winner))) return winner
  const legacyWinner = rules.findLast((rule) => matchesLegacyName(action, actionPattern(rule)) && restMatches(rule))
  return legacyWinner && isDeny(legacyWinner) ? legacyWinner : winner
}

/** Canonical spelling of a tool/permission name: legacy `bash` folds to `shell` (#780). */
export function canonical(name: string) {
  return name === "bash" ? "shell" : name
}
