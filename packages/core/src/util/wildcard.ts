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
 * Matching preserves what every pattern meant when it was written:
 * - A literal pattern names the tool under either exact spelling, so legacy
 *   `bash` rules and new `shell` rules both apply, in written order.
 * - A wildcard pattern keeps its pre-rename extension: it is matched against
 *   the legacy spelling(s) only. `ba*` therefore still gates the renamed
 *   tool, while `s*` — which covered `skill` when the tool was called
 *   `bash` — does not silently recruit `shell` and cannot bypass an explicit
 *   legacy deny ordered before it. (New config should name the tool exactly:
 *   `shell`.)
 */
const LEGACY_ACTION_ALIASES: Readonly<Record<string, readonly string[]>> = { shell: ["bash"] }

export function matchAction(action: string, pattern: string) {
  const canonicalName = canonical(action)
  const legacy = LEGACY_ACTION_ALIASES[canonicalName] ?? []
  if (legacy.length === 0) return match(action, pattern)
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return match(canonicalName, pattern) || legacy.some((name) => match(name, pattern))
  }
  return legacy.some((name) => match(name, pattern))
}

/** Canonical spelling of a tool/permission name: legacy `bash` folds to `shell` (#780). */
export function canonical(name: string) {
  return name === "bash" ? "shell" : name
}
