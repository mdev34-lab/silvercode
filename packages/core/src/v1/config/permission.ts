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

type MergeInput = Action | Record<string, Rule | undefined> | undefined

const toRecord = (input: MergeInput): Record<string, Rule | undefined> => {
  if (typeof input === "string") return { "*": input }
  if (typeof input !== "object" || input === null || globalThis.Array.isArray(input)) return {}
  return input
}

const mergeRule = (target: Rule, source: Rule): Rule => {
  if (typeof target === "string" && typeof source === "string") return source
  // A flat action is the "*" pattern written first; promote it so inner
  // patterns keep their written sequence instead of being replaced wholesale.
  const out: Record<string, Action> = { ...(typeof target === "string" ? { "*": target } : target) }
  for (const [pattern, action] of globalThis.Object.entries(
    typeof source === "string" ? { "*": source } : source,
  )) {
    if (action === undefined) continue
    delete out[pattern]
    out[pattern] = action
  }
  return out
}

/**
 * Merge two permission layers with rule-sequence semantics: the result
 * evaluates exactly as if the target's rules were followed by the source's
 * rules and the last matching rule won. A key the source writes moves to the
 * source's position (delete + reinsert) instead of keeping its first-seen
 * position the way a plain deep merge would — key position is precedence for
 * permission objects, across both spellings of a renamed action (#780) and
 * across config layers (global/project/local/managed/env/agent).
 */
export function merge(target: MergeInput, source: MergeInput): Record<string, Rule> {
  const out: Record<string, Rule> = {}
  for (const [key, value] of globalThis.Object.entries(toRecord(target))) {
    if (value !== undefined) out[key] = value
  }
  for (const [key, value] of globalThis.Object.entries(toRecord(source))) {
    if (value === undefined) continue
    const existing = out[key]
    delete out[key]
    out[key] = existing === undefined ? value : mergeRule(existing, value)
  }
  return out
}

export const Info = InputSchema.pipe(
  Schema.decodeTo(InputObject, {
    decode: SchemaGetter.transform(normalizeInput),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "PermissionConfig" })
type _Info = Schema.Schema.Type<typeof InputObject>
export type Info = { -readonly [K in keyof _Info]: _Info[K] }
