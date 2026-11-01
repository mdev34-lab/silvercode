import { describe, expect, test } from "bun:test"
import { age, due, next, PROBE_TTL_MS, STALE_MS, status } from "../src/util/model-health"

describe("model health", () => {
  test("missing or stale evidence is unknown, never working", () => {
    expect(status(undefined, 1000)).toBe("unknown")
    const ok = next(undefined, "ok", 0)
    expect(status(ok, 1000)).toBe("working")
    expect(status(ok, STALE_MS + 1)).toBe("unknown")
  })

  test("one rate limit or network error is not a permanent failure", () => {
    const once = next(undefined, "transient", 0)
    expect(status(once, 1)).toBe("degraded")
    expect(status(next(once, "transient", 1), 2)).toBe("degraded")
  })

  test("a real error fails, and a success recovers", () => {
    const failing = next(undefined, "error", 1)
    expect(status(failing, 2)).toBe("failing")
    const recovered = next(failing, "ok", 3)
    expect(recovered.failures).toBe(0)
    expect(status(recovered, 4)).toBe("working")
  })

  test("probes back off after failures", () => {
    const ok = next(undefined, "ok", 0)
    expect(due(undefined)).toBe(0)
    expect(due(ok)).toBe(PROBE_TTL_MS)
    const failed = next(ok, "error", 0)
    expect(due(failed)).toBe(PROBE_TTL_MS * 2)
    let entry = failed
    for (let i = 0; i < 10; i++) entry = next(entry, "error", 0)
    expect(due(entry)).toBe(PROBE_TTL_MS * 8)
  })

  test("age reads naturally", () => {
    const entry = next(undefined, "ok", 0)
    expect(age(entry, 10_000)).toBe("now")
    expect(age(entry, 9 * 60_000)).toBe("9m ago")
    expect(age(entry, 2 * 3600_000)).toBe("2h ago")
  })
})
