// Fixture-only live handle for the host-timeout probes. On Windows (Bun 1.3.14) child runs whose body
// never settled and registered no timer reported no timeout and did not finish within an 8s guard,
// while bodies with 100ms/1200ms timers did report it (#609 records the runs). The probes therefore
// hang with this interval active. That case is untested for other Bun versions and says nothing about
// handle-less hangs, which stay unresolved. The interval is owned by the fixture: it is cleared when the
// hung run is interrupted, and afterAll clears it if an interruption never arrives. It writes nothing,
// so it can neither restore the environment value nor replace the host timeout.
import { afterAll } from "bun:test"
import { Effect } from "effect"

let interval: ReturnType<typeof setInterval> | undefined

const stop = () => {
  if (interval === undefined) return
  clearInterval(interval)
  interval = undefined
}

afterAll(stop)

export const hangWithLiveHandle = Effect.acquireUseRelease(
  Effect.sync(() => {
    interval = setInterval(() => {}, 100)
  }),
  () => Effect.never,
  () => Effect.sync(stop),
)
