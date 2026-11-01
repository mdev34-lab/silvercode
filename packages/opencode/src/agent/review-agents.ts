import { Agent as AgentSchema } from "@opencode-ai/schema/agent"

/**
 * The agent that reviews completed work and therefore must deliver its result
 * through a `<silvercode-review>` report envelope.
 *
 * The set is the single source of truth for the report gate, which is applied in
 * three places: the finish tool (refuses to complete a run without a parseable
 * envelope), the task tool (extracts the envelope and attaches it to the parent
 * envelope), and the session nudge (applies review stagnation to a reviewer's
 * turns). A review agent missing from this set still completes without a verdict
 * rather than failing loudly, so centralising the list here buys a single edit
 * site and a guard test - it does not remove the failure mode. A new reviewer
 * must be added here rather than compared inline at each gate.
 *
 * `ReviewAgent` is the element type, not `string`, so the compiler can enforce
 * that every name this module calls a reviewer is one the registry defines; the
 * set stays a runtime value because the gate is applied to an agent name read
 * from a session row, which the type system never sees. The pair is pinned
 * together by the guard test rather than by inference from the `Set`.
 */
export const REVIEW_AGENTS: ReadonlySet<ReviewAgent> = new Set<ReviewAgent>(["review"])

export type ReviewAgent = "review"

/**
 * Reviewer names retired by the single-reviewer consolidation, derived from the
 * schema's legacy-id table so this gate and `Agent.get` can never disagree
 * about them. They stay resolvable so stored sessions that recorded a
 * specialist reviewer still pass the report gate, and so delegations and config
 * written against them keep working: `Agent.get` answers them through the
 * legacy-id table, and `resolveReviewer` rewrites them to the single reviewer.
 */
export const LEGACY_REVIEW_AGENTS: ReadonlySet<string> = new Set(
  Object.entries(AgentSchema.LEGACY_IDS)
    .filter((entry): entry is [string, string] => entry[1] === "review")
    .map(([id]) => id),
)

/**
 * Answers "is this dispatched or recorded name a reviewer", for the report
 * gate. Legacy specialist names count: a session row written before the
 * consolidation still names them, and the gate must not silently drop its
 * verdict requirement for it.
 */
export function isReviewAgent(name: string | undefined) {
  return (
    name !== undefined &&
    (REVIEW_AGENTS.has(name as ReviewAgent) || LEGACY_REVIEW_AGENTS.has(name))
  )
}

/**
 * Resolves the agent actually dispatched. A legacy specialist name is rewritten
 * to the single reviewer; every other requested name passes through untouched,
 * so resolution can never turn an explicit delegation into a different one.
 */
export function resolveReviewer(requested: string) {
  return LEGACY_REVIEW_AGENTS.has(requested) ? "review" : requested
}
