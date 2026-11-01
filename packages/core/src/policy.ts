export * as Policy from "./policy"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect as EffectRuntime, Layer, Schema } from "effect"
import { Wildcard } from "./util/wildcard"
import { Location } from "./location"

export const Effect = Schema.Literals(["allow", "deny"]).annotate({ identifier: "Policy.Effect" })
export type Effect = typeof Effect.Type

export class Info extends Schema.Class<Info>("Policy.Info")({
  action: Schema.String,
  effect: Effect,
  resource: Schema.String,
}) {}

export interface Interface {
  readonly load: (statements: Info[]) => EffectRuntime.Effect<void>
  readonly evaluate: (action: string, resource: string, fallback: Effect) => EffectRuntime.Effect<Effect>
  readonly hasStatements: () => boolean
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Policy") {}

const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    let statements: Info[] = []
    yield* Location.Service

    return Service.of({
      load: EffectRuntime.fn("Policy.load")(function* (input) {
        statements = input
      }),
      hasStatements: () => statements.length > 0,
      evaluate: EffectRuntime.fn("Policy.evaluate")(function* (action, resource, fallback) {
        // doom_loop resources are tool ids (action names), so legacy `bash` patterns
        // must still gate the tool now published as `shell` (#780).
        const matchResource = action === "doom_loop" ? Wildcard.matchAction : Wildcard.match
        return (
          statements.findLast(
            (statement) => Wildcard.matchAction(action, statement.action) && matchResource(resource, statement.resource),
          )?.effect ?? fallback
        )
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [Location.node] })
