export * as DaemonRuns from "./daemon-runs"

import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Context, Effect, Layer } from "effect"

export interface Interface {
  /** Atomically stops accepting new runs when nothing is active. */
  readonly stopIfIdle: Effect.Effect<SessionExecution.IdleStop>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/server/DaemonRuns") {}

// Reads the run state through the Session service that owns execution, so a
// claim is decided by the same coordinator that starts runs.
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    return Service.of({ stopIfIdle: session.stopIfIdle })
  }),
)
