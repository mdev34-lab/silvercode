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

// #780: `bash` is the pre-rename spelling of the `shell` permission. Config layers merge
// by object key, so letting both spellings survive would let an older layer's `bash`
// outrank a newer layer's `shell` (or the reverse) purely by key position once merged.
// Fold the legacy key into `shell` as each layer is decoded, preserving entry order:
// two rule objects deep-merge per pattern and otherwise the later entry wins — exactly
// how an already-canonical config behaves across layers.
export function canonicalize<T extends Record<string, Rule | undefined>>(permission: T): T {
  if (!("bash" in permission)) return permission
  const out: Record<string, Rule> = {}
  for (const [key, value] of globalThis.Object.entries(permission)) {
    if (value === undefined) continue
    const canonical = key === "bash" ? "shell" : key
    const existing = out[canonical]
    out[canonical] =
      existing !== undefined && typeof existing === "object" && typeof value === "object"
        ? { ...existing, ...value }
        : value
  }
  return out as T
}

const normalizeInput = (input: Schema.Schema.Type<typeof InputSchema>): Schema.Schema.Type<typeof InputObject> =>
  typeof input === "string" ? { "*": input } : canonicalize(input)

export const Info = InputSchema.pipe(
  Schema.decodeTo(InputObject, {
    decode: SchemaGetter.transform(normalizeInput),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "PermissionConfig" })
type _Info = Schema.Schema.Type<typeof InputObject>
export type Info = { -readonly [K in keyof _Info]: _Info[K] }
