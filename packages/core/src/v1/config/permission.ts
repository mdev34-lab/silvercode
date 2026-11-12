export * as ConfigPermissionV1 from "./permission"

import { Schema, SchemaGetter } from "effect"

export const Action = Schema.Literals(["ask", "allow", "deny"]).annotate({ identifier: "PermissionActionConfig" })
export type Action = Schema.Schema.Type<typeof Action>

export const Object = Schema.Record(Schema.String, Action).annotate({ identifier: "PermissionObjectConfig" })
export type Object = Schema.Schema.Type<typeof Object>

export const Rule = Schema.Union([Action, Object]).annotate({ identifier: "PermissionRuleConfig" })
export type Rule = Schema.Schema.Type<typeof Rule>

// Known permission keys get explicit types in the Effect schema for generated
// docs/types. Runtime config parsing uses Effect's `propertyOrder: "original"`
// parse option so user key order is preserved for permission precedence.
const InputObject = Schema.StructWithRest(
  Schema.Struct({
    read: Schema.optional(Rule),
    edit: Schema.optional(Rule),
    glob: Schema.optional(Rule),
    grep: Schema.optional(Rule),
    list: Schema.optional(Rule),
    shell: Schema.optional(Rule),
    // Legacy spelling of the shell tool permission from before the #780
    // rename. Kept typed so existing user config parses unchanged; matching
    // treats it as an alias of "shell".
    bash: Schema.optional(Rule),
    task: Schema.optional(Rule),
    external_directory: Schema.optional(Rule),
    todowrite: Schema.optional(Action),
    question: Schema.optional(Action),
    webfetch: Schema.optional(Action),
    websearch: Schema.optional(Action),
    lsp: Schema.optional(Rule),
    doom_loop: Schema.optional(Action),
    skill: Schema.optional(Rule),
  }),
  [Schema.Record(Schema.String, Rule)],
)

const InputSchema = Schema.Union([Action, InputObject])

const normalizeInput = (input: Schema.Schema.Type<typeof InputSchema>): Schema.Schema.Type<typeof InputObject> =>
  typeof input === "string" ? { "*": input } : input

// The two spellings of the shell tool's permission action across the #780
// rename. They are one logical permission slot written with either name.
const SHELL_RENAME_SPELLINGS: readonly string[] = ["bash", "shell"]

// An empty pattern map writes no rule. Treating it as a write can move a broad
// allow past a deny, or clear a tools-derived deny, without adding any rule.
function isShellRenameWrite(value: unknown): boolean {
  if (typeof value === "string") return true
  if (typeof value !== "object" || value === null || globalThis.Array.isArray(value)) return false
  return globalThis.Object.keys(value).length > 0
}

// Drop no-op `bash`/`shell` pattern maps from a layer before it is merged or
// assigned over another layer. Without this, remeda `mergeDeep` / Object.assign
// can replace a flat deny with `{}` even though the empty map writes no rule.
export function stripEmptyShellRules<T>(permission: T): T {
  if (typeof permission !== "object" || permission === null || globalThis.Array.isArray(permission)) return permission
  const record = permission as Record<string, unknown>
  let out = record
  for (const key of SHELL_RENAME_SPELLINGS) {
    const value = record[key]
    if (typeof value !== "object" || value === null || globalThis.Array.isArray(value)) continue
    if (globalThis.Object.keys(value).length > 0) continue
    if (out === record) out = { ...record }
    delete out[key]
  }
  return out as T
}

/**
 * Permission layers merge with the pre-existing deep-merge contract
 * (remeda `mergeDeep` / `Object.assign`): an overridden key or pattern keeps
 * its first-written position, and a flat action replaces a pattern record
 * wholesale. That contract is unchanged for every permission — with one
 * rename-scoped exception handled here.
 *
 * The rename split one logical permission across two keys (`bash`/`shell`),
 * so plain deep merge can order the spellings by first-seen position rather
 * than by last write: e.g. global `shell`, project `bash`, then local
 * `shell` would leave the local layer's `shell` entry sitting before the
 * project layer's `bash` entry, and the wrong layer would win under
 * last-match evaluation. `orderShellRename` runs after a base merge and
 * fixes ONLY the relative order of the two spellings, permuting them within
 * the key positions they already occupy: spellings the later layer
 * (`source`) wrote come after spellings it did not write, in `source`
 * order. No value changes, no other key moves — a spelling never crosses
 * `*` or any unrelated key, so single-layer written order and every other
 * permission keep exact base semantics.
 */
export function orderShellRename<T extends object>(merged: T, source: unknown): T {
  if (typeof source !== "object" || source === null || globalThis.Array.isArray(source)) return merged
  const record = merged as Record<string, unknown>
  const keys = globalThis.Object.keys(record)
  const present = keys.filter((key) => SHELL_RENAME_SPELLINGS.includes(key) && isShellRenameWrite(record[key]))
  if (present.length < 2) return merged
  const written = globalThis.Object.keys(source as Record<string, unknown>).filter(
    (key) => SHELL_RENAME_SPELLINGS.includes(key) && isShellRenameWrite((source as Record<string, unknown>)[key]),
  )
  if (written.length === 0) return merged
  const desired = [
    ...present.filter((key) => !written.includes(key)),
    ...written.filter((key) => present.includes(key)),
  ]
  if (desired.every((key, index) => key === present[index])) return merged
  const out: Record<string, unknown> = {}
  let slot = 0
  for (const key of keys) {
    if (!SHELL_RENAME_SPELLINGS.includes(key)) {
      out[key] = record[key]
      continue
    }
    const replacement = desired[slot++]
    out[replacement] = record[replacement]
  }
  return out as T
}

/**
 * Companion for tools-derived permission records: the derived `shell` entry
 * is a synthetic compat slot (folded from `tools: { bash/shell: ... }`), so
 * when an explicit permission writes a spelling, the derived entry for that
 * spelling is cleared first and the base assign/merge then appends the
 * explicit entry at its own written position instead of inheriting the
 * derived entry's position. Explicit entries for every other tool keep
 * base assign semantics.
 */
export function clearDerivedShellRename(derived: Record<string, unknown>, explicit: unknown): void {
  if (typeof explicit !== "object" || explicit === null || globalThis.Array.isArray(explicit)) return
  const record = explicit as Record<string, unknown>
  for (const key of SHELL_RENAME_SPELLINGS) {
    if (isShellRenameWrite(record[key])) delete derived[key]
  }
}

// Internal provenance for the synthetic tools-derived shell record. A legacy
// `tools: { bash: false }` is canonicalised to `shell` for users, config
// layers, and the HTTP API; this non-enumerable symbol keeps the fact that the
// surviving deny came from the legacy spelling, so the ruleset builder can
// match it against the rename clamp without changing the canonical map.
// Non-enumerable: invisible to Object.keys, spread, JSON, and schema encode.
const DERIVED_SHELL_DENY = Symbol.for("@opencode/config-permission/derived-shell-deny")

export function markDerivedShellDeny<T extends object>(permission: T): T {
  globalThis.Object.defineProperty(permission, DERIVED_SHELL_DENY, {
    value: true,
    enumerable: false,
    configurable: true,
  })
  return permission
}

export function isDerivedShellDeny(permission: unknown): boolean {
  if (typeof permission !== "object" || permission === null) return false
  return (permission as Record<PropertyKey, unknown>)[DERIVED_SHELL_DENY] === true
}

/** Does a permission layer write a real (non-empty) `bash`/`shell` slot? */
export function writesShellRename(permission: unknown): boolean {
  if (typeof permission !== "object" || permission === null || globalThis.Array.isArray(permission)) return false
  const record = permission as Record<string, unknown>
  return SHELL_RENAME_SPELLINGS.some((key) => isShellRenameWrite(record[key]))
}

/**
 * Carry the derived-deny provenance across a permission merge. The layer that
 * wrote the last real bash/shell slot owns the merged slot, so the merged map
 * inherits that layer's provenance; a layer that writes nothing leaves the
 * inherited provenance alone, and an explicit write clears it. The marker is
 * metadata only: keys, values, and order keep the canonical representation.
 */
export function carryDerivedShellDeny<T>(merged: T, target: unknown, source: unknown): T {
  if (typeof merged !== "object" || merged === null) return merged
  const owner = writesShellRename(source) ? source : target
  const inherited = isDerivedShellDeny(owner) && (merged as Record<string, unknown>).shell === "deny"
  if (inherited) return isDerivedShellDeny(merged) ? merged : markDerivedShellDeny(merged)
  // Spread copies only enumerable keys, so this drops the marker when an
  // explicit write replaced the inherited slot.
  return isDerivedShellDeny(merged) ? ({ ...(merged as Record<string, unknown>) } as T) : merged
}

export const Info = InputSchema.pipe(
  Schema.decodeTo(InputObject, {
    decode: SchemaGetter.transform(normalizeInput),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "PermissionConfig" })
type _Info = Schema.Schema.Type<typeof InputObject>
export type Info = { -readonly [K in keyof _Info]: _Info[K] }
