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
 * config may still spell the action "bash". Matching a canonical action also
 * tries each legacy spelling as the subject, so wildcard patterns keep their
 * exact semantics under both spellings and a legacy "deny" can never silently
 * degrade to the default "ask".
 */
const LEGACY_ACTION_ALIASES: Readonly<Record<string, readonly string[]>> = { shell: ["bash"] }

export function matchAction(action: string, pattern: string) {
  if (match(action, pattern)) return true
  return (LEGACY_ACTION_ALIASES[action] ?? []).some((legacy) => match(legacy, pattern))
}

/** Canonical spelling of a tool/permission name: legacy `bash` folds to `shell` (#780). */
export function canonical(name: string) {
  return name === "bash" ? "shell" : name
}
