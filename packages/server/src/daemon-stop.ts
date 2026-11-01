export * as DaemonStop from "./daemon-stop"

import { Context, Effect, Layer } from "effect"

export interface Interface {
  /** Terminates the server process after an idle stop has been granted. */
  readonly terminate: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/server/DaemonStop") {}

/**
 * Real teardown. The delay lets the granted response reach the client before
 * the signal lands; the run gate is already closed by then, so nothing can
 * start behind the response. SIGTERM matches how `service stop` ends the
 * process, so registration cleanup behaves the same either way.
 */
export const layer = Layer.succeed(
  Service,
  Service.of({
    terminate: Effect.sleep("250 millis").pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.kill(process.pid, "SIGTERM")
        }),
      ),
    ),
  }),
)
