import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { clockUsers, elapsed, useClock } from "../src/util/clock"
import { activityHeader } from "../src/util/activity"

describe("elapsed", () => {
  test("whole seconds, minutes and hours", () => {
    expect(elapsed(0)).toBe("0s")
    expect(elapsed(8400)).toBe("8s")
    expect(elapsed(502_000)).toBe("8m 22s")
    expect(elapsed(3_900_000)).toBe("1h 5m")
  })
})

describe("working header", () => {
  const working = { count: 3, working: true, failed: 0, denied: false, interrupted: false, durationMs: undefined }
  test("shows the live time while working", () => {
    expect(activityHeader(working, { expanded: false, duration: "8s" }).main).toBe("Working... 3 tool calls · 8s")
    expect(activityHeader(working, { expanded: false, duration: undefined }).main).toBe("Working... 3 tool calls")
  })
})

describe("useClock", () => {
  test("holds one timer while active and releases it on stop and dispose", () => {
    const before = clockUsers()
    let setActive!: (value: boolean) => void
    const dispose = createRoot((dispose) => {
      const [active, set] = createSignal(true)
      setActive = set
      useClock(active)
      return dispose
    })
    // Effects may be deferred under the server build; only the balance matters.
    setActive(false)
    dispose()
    expect(clockUsers()).toBe(before)
  })
})
