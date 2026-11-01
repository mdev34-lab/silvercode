import { describe, expect, test } from "bun:test"
import { abandonedCleanups, boundedCleanup, CLEANUP_BOUND_MS, type CleanupTimer } from "./cleanup"

// Deterministic timer: the test decides when the bound fires and records cancel() calls.
const fakeTimer = () => {
  const timers: { ms: number; cancelled: number; fire: () => void }[] = []
  const start = (ms: number): CleanupTimer => {
    const entry = { ms, cancelled: 0, fire: () => {} }
    const promise = new Promise<void>((resolve) => {
      entry.fire = () => resolve()
    })
    timers.push(entry)
    return {
      promise,
      cancel: () => {
        entry.cancelled += 1
      },
    }
  }
  return { timers, start }
}

const captured = () => {
  const logs: unknown[][] = []
  return { logs, log: (...args: unknown[]) => void logs.push(args) }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("boundedCleanup", () => {
  test("pins the production bound at 60 seconds", () => {
    expect(CLEANUP_BOUND_MS).toBe(60_000)
  })

  test("fast success resolves done, cancels the timer, and logs nothing", async () => {
    const timer = fakeTimer()
    const out = captured()
    const before = abandonedCleanups()

    const outcome = await boundedCleanup("fast", Promise.resolve("ok"), { timer: timer.start, log: out.log })

    expect(outcome).toBe("done")
    expect(timer.timers.length).toBe(1)
    expect(timer.timers[0].cancelled).toBe(1)
    expect(out.logs).toEqual([])
    expect(abandonedCleanups()).toBe(before)
  })

  test("uses the configured bound when starting the timer", async () => {
    const timer = fakeTimer()
    await boundedCleanup("bound", Promise.resolve(), { boundMs: 1234, timer: timer.start, log: () => {} })
    expect(timer.timers[0].ms).toBe(1234)
  })

  test("a rejected cleanup resolves failed, logs the error, and cancels the timer", async () => {
    const timer = fakeTimer()
    const out = captured()
    const error = new Error("disposal broke")

    const outcome = await boundedCleanup("broken", Promise.reject(error), { timer: timer.start, log: out.log })

    expect(outcome).toBe("failed")
    expect(timer.timers[0].cancelled).toBe(1)
    expect(out.logs).toEqual([["[reset] broken failed; continuing", error]])
  })

  test("a wedged cleanup times out, logs it, and tracks it as abandoned until it settles", async () => {
    const timer = fakeTimer()
    const out = captured()
    const before = abandonedCleanups()
    const wedged = new Promise<void>(() => {})

    const pending = boundedCleanup("wedged", wedged, { timer: timer.start, log: out.log })
    timer.timers[0].fire()
    const outcome = await pending

    expect(outcome).toBe("timed-out")
    expect(timer.timers[0].cancelled).toBe(1)
    expect(abandonedCleanups()).toBe(before + 1)
    expect(out.logs.length).toBe(1)
    expect(String(out.logs[0][0])).toContain("wedged did not finish within 60s; continuing")
  })

  test("a timed-out cleanup that later settles logs the late completion and decrements abandoned", async () => {
    const timer = fakeTimer()
    const out = captured()
    const before = abandonedCleanups()
    const late = Promise.withResolvers<void>()

    const pending = boundedCleanup("late", late.promise, { timer: timer.start, log: out.log })
    timer.timers[0].fire()
    expect(await pending).toBe("timed-out")
    expect(abandonedCleanups()).toBe(before + 1)

    late.resolve()
    await flush()

    expect(abandonedCleanups()).toBe(before)
    expect(out.logs.at(-1)).toEqual(["[reset] late settled after timeout (done)"])
  })

  test("a late rejection after timeout is reported as failed, not as a second timeout", async () => {
    const timer = fakeTimer()
    const out = captured()
    const before = abandonedCleanups()
    const late = Promise.withResolvers<void>()

    const pending = boundedCleanup("late-fail", late.promise, { timer: timer.start, log: out.log })
    timer.timers[0].fire()
    await pending
    late.reject(new Error("late"))
    await flush()

    expect(abandonedCleanups()).toBe(before)
    expect(out.logs.at(-1)).toEqual(["[reset] late-fail settled after timeout (failed)"])
  })

  test("a real timer really bounds a wedged cleanup", async () => {
    const out = captured()
    const before = abandonedCleanups()
    const started = Date.now()

    const outcome = await boundedCleanup("real", new Promise<void>(() => {}), { boundMs: 20, log: out.log })

    // Generous ceiling to avoid flakiness on slow CI. The point is that the wait is bounded.
    expect(outcome).toBe("timed-out")
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(abandonedCleanups()).toBe(before + 1)
  })
})
