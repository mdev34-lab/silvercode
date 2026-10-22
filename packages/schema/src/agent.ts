export * as Agent from "./agent"

import { Schema } from "effect"
import { optional } from "./schema"
import { Model } from "./model"
import { Permission } from "./permission"
import { Provider } from "./provider"
import { PositiveInt, statics } from "./schema"

export const ID = Schema.String.pipe(Schema.brand("AgentV2.ID"))
export type ID = typeof ID.Type

/**
 * Canonical id of the builtin default agent.
 *
 * The agent is displayed as "Work"; the id below is the stable internal
 * identifier used by config, the API and persisted sessions.
 */
export const DEFAULT_ID = ID.make("work")

/**
 * Identity color of the builtin default agent.
 *
 * Surfaces that have design tokens (web/app) should use
 * `--icon-agent-work-base` / `--v2-agent-work-solid` instead; this constant
 * exists because the TUI renders agent colors from the API payload and has no
 * CSS variables to resolve. Keep the CSS tokens in sync with it.
 */
export const DEFAULT_COLOR = "#FFFFFF"

/**
 * Legacy agent ids that must keep working: they appear in user config
 * (`default_agent`, `agent: { ... }`, `mode: { ... }`), in persisted sessions
 * and in API payloads written by older clients.
 *
 * A legacy id is only rewritten when nothing actually answers to it, so a user
 * who defines a real agent named `build` keeps their own agent.
 */
export const LEGACY_IDS: Readonly<Record<string, string | undefined>> = Object.freeze({
  build: "work",
  // The planning specialist was renamed: plan -> think.
  plan: "think",
  // Retired specialist reviewers, consolidated into the single `review` agent.
  "work-review": "review",
  "code-review": "review",
})

/** Maps a legacy agent id onto its canonical id. Unknown ids pass through. */
export function canonicalID(id: string): string {
  return LEGACY_IDS[id] ?? id
}

/**
 * Looks an agent up by id, falling back to the canonical id when the requested
 * one is a legacy alias that nothing defines.
 */
export function withLegacyID<T>(id: string, lookup: (id: string) => T | undefined): T | undefined {
  const direct = lookup(id)
  if (direct !== undefined) return direct
  const canonical = LEGACY_IDS[id]
  if (canonical === undefined || canonical === id) return undefined
  return lookup(canonical)
}

export const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
]).annotate({ identifier: "Agent.Color" })
export type Color = typeof Color.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  model: Model.Ref.pipe(optional),
  request: Provider.Request,
  system: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  hidden: Schema.Boolean,
  color: Color.pipe(optional),
  steps: PositiveInt.pipe(optional),
  permissions: Permission.Ruleset,
})
  .annotate({ identifier: "AgentV2.Info" })
  .pipe(
    statics((schema) => ({
      empty: (id: ID) =>
        schema.make({ id, request: { headers: {}, body: {} }, mode: "all", hidden: false, permissions: [] }),
    })),
  )
