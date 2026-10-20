export * as ConfigContext from "./context"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

/** How a provider request is brought back under the model's usable window. */
export class Reduction extends Schema.Class<Reduction>("ConfigV2.Context.Reduction")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  /** Fraction of the usable window reduction starts at and reduces back to. */
  threshold: Schema.Number.pipe(Schema.optional),
  /** Assistant turns a failed call keeps its original input for. */
  error_turns: NonNegativeInt.pipe(Schema.optional),
}) {}

/** Content reduction may never touch, whatever the pressure. */
export class Protection extends Schema.Class<Protection>("ConfigV2.Context.Protection")({
  /** Assistant turns kept verbatim, counted back from the end of history. */
  recent_turns: NonNegativeInt.pipe(Schema.optional),
  /** Tool names whose recorded calls are never reduced. */
  tools: Schema.String.pipe(Schema.Array, Schema.optional),
  /** Glob patterns of file paths whose recorded calls are never reduced. */
  files: Schema.String.pipe(Schema.Array, Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Context")({
  reduction: Reduction.pipe(Schema.optional),
  protection: Protection.pipe(Schema.optional),
}) {}
