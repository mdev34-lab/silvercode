// Fixture-only live handle for the host-timeout probes. A test body that never settles and holds no
// live handle makes `bun test --timeout` hang on Windows instead of reporting the timeout (observed in
// the matrix in host-timeout.test.ts), so the probes hang with this interval active, the way a body
// waiting on a socket or timer would. The interval is owned by the fixture: it is cleared when the
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
