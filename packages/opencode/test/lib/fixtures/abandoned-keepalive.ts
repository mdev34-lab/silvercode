// Fixture-only live handle for Bun host/per-test timeout probes that carry no `OwnedDeadline`
// timer. On Windows (Bun 1.3.14), child runs whose body never settled and kept no active timer
// handle did not deliver Bun's test timeout within the guard, while bodies keeping an active
// timer did (#609). Tracks per-acquisition intervals so overlapping fibers each clear their own
// handle on interruption, with `afterAll` as a backstop if interruption never arrives.
import { afterAll } from "bun:test"
import { Effect } from "effect"

const intervals = new Set<ReturnType<typeof setInterval>>()

const stopOne = (handle: ReturnType<typeof setInterval>) => {
  clearInterval(handle)
  intervals.delete(handle)
}

const stopAll = () => {
  for (const handle of intervals) {
    clearInterval(handle)
  }
  intervals.clear()
}

afterAll(stopAll)

export const hangWithLiveHandle = Effect.acquireUseRelease(
  Effect.sync(() => {
    const handle = setInterval(() => {}, 100)
    intervals.add(handle)
    return handle
  }),
  () => Effect.never,
  (handle) => Effect.sync(() => stopOne(handle)),
)
