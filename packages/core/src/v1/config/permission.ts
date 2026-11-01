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
  const present = keys.filter((key) => SHELL_RENAME_SPELLINGS.includes(key))
  if (present.length < 2) return merged
  const written = globalThis.Object.keys(source as Record<string, unknown>).filter(
    (key) => SHELL_RENAME_SPELLINGS.includes(key) && (source as Record<string, unknown>)[key] !== undefined,
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
    if (record[key] !== undefined) delete derived[key]
  }
}

export const Info = InputSchema.pipe(
  Schema.decodeTo(InputObject, {
    decode: SchemaGetter.transform(normalizeInput),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "PermissionConfig" })
type _Info = Schema.Schema.Type<typeof InputObject>
export type Info = { -readonly [K in keyof _Info]: _Info[K] }
