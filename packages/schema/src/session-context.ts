export * as SessionContext from "./session-context"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema"

/**
 * What dynamic context reduction did to one provider request.
 *
 * - `untouched`: the request fits the usable window, so canonical history was sent as it is.
 * - `reduced`: the request was over the reduction threshold and the deterministic rungs brought it
 *   back under.
 * - `exhausted`: every rung ran and the request is still over, because only protected content is
 *   left to send. Reduction stops; compaction is a separate step: threshold compaction follows `compaction.auto`, overflow compaction after a provider error does not.
 */
export const Outcome = Schema.Literals(["untouched", "reduced", "exhausted"])
export type Outcome = typeof Outcome.Type

/**
 * The authoritative measurement of the context one provider request carries.
 *
 * Published by the session runner once per request, for the messages that request actually sends.
 * Every consumer — TUI indicator, prompt footer, plugins — renders this report; none of them
 * derives its own utilization, budget band or reclamation figure, so a client cannot disagree with
 * the runtime about what was sent.
 */
export const Report = Schema.Struct({
  /** Tokens the request carries: the sent history plus the prompt envelope. */
  tokens: NonNegativeInt,
  /** The envelope share of `tokens`: system prompt, tool definitions and request extras. */
  overheadTokens: NonNegativeInt,
  /** Tokens reduction removed from canonical history; zero unless the outcome is `reduced`. */
  reclaimedTokens: NonNegativeInt,
  /** Usable context window `utilization` is measured against, when the model declares one. */
  limit: NonNegativeInt.pipe(optional),
  /** Fraction of the usable window the request occupies. */
  utilization: Schema.Finite,
  outcome: Outcome,
}).annotate({ identifier: "SessionContext.Report" })
export interface Report extends Schema.Schema.Type<typeof Report> {}
