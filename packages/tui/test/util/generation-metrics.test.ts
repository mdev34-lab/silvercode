import { describe, expect, test } from "bun:test"
import { formatGenerationMetrics } from "../../src/util/generation-metrics"

describe("formatGenerationMetrics", () => {
  test("formats both metrics compactly", () => {
    expect(formatGenerationMetrics({ tokensPerSecond: 48.7, ttft: 842.4 })).toBe("48.7 tok/s · TTFT 842ms")
  })

  test("formats tokens/sec without TTFT", () => {
    expect(formatGenerationMetrics({ tokensPerSecond: 12 })).toBe("12.0 tok/s")
  })

  test("formats TTFT without tokens/sec", () => {
    expect(formatGenerationMetrics({ ttft: 842 })).toBe("TTFT 842ms")
  })

  test("formats a long TTFT with the same duration format as the rest of the TUI", () => {
    expect(formatGenerationMetrics({ ttft: 1234 })).toBe("TTFT 1.2s")
    expect(formatGenerationMetrics({ ttft: 785768 })).toBe("TTFT 13m 5s")
  })

  test("omits missing or invalid metrics", () => {
    expect(formatGenerationMetrics({})).toBe("")
    expect(formatGenerationMetrics({ tokensPerSecond: 0, ttft: -1 })).toBe("")
    expect(formatGenerationMetrics({ tokensPerSecond: Number.POSITIVE_INFINITY, ttft: Number.NaN })).toBe("")
  })
})
