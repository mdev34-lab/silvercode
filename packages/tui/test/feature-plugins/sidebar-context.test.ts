import { describe, expect, test } from "bun:test"
import type { AssistantMessage, SessionNextContextPrepared } from "@opencode-ai/sdk/v2"
import { CONTEXT_BAR_WIDTH, contextBarGlyphs, type ContextUsage } from "../../src/feature-plugins/sidebar/context"
import { contextUsage } from "../../src/util/context-usage"

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "m1",
    sessionID: "s1",
    role: "assistant",
    time: { created: 0, completed: 1 },
    parentID: "u1",
    modelID: "model",
    providerID: "test",
    mode: "work",
    agent: "work",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  }
}

function report(overrides: Partial<SessionNextContextPrepared["data"]> = {}): SessionNextContextPrepared["data"] {
  return {
    timestamp: 0,
    sessionID: "s1",
    tokens: 30_000,
    overheadTokens: 4_000,
    reclaimedTokens: 0,
    limit: 200_000,
    utilization: 0.15,
    outcome: "untouched",
    ...overrides,
  }
}

const noModel = () => undefined
const model = () => 200_000

/** What the sidebar renders for a derivation, so the bar can be asserted. */
const barState = (measured: ReturnType<typeof contextUsage>): ContextUsage =>
  measured === undefined || measured.percent === undefined
    ? { status: "unknown", tokens: measured?.tokens ?? 0 }
    : { status: "known", tokens: measured.tokens, percent: measured.percent }

describe("sidebar context report (#139)", () => {
  test("the runtime report is authoritative and carries its own measurements", () => {
    const measured = contextUsage({ report: report(), messages: [], contextLimit: noModel })!
    expect(measured).toEqual({
      tokens: 30_000,
      percent: 15,
      reclaimed: 0,
      overhead: 4_000,
      urgent: false,
      exhausted: false,
    })
  })

  test("the report, not the provider accounting, decides the readout", () => {
    // A reduced request is far smaller than the assistant turn that produced it; rendering the
    // assistant's tokens here would describe a request that was never sent.
    const measured = contextUsage({
      report: report({ tokens: 5_000, reclaimedTokens: 25_000, outcome: "reduced" }),
      messages: [assistant({ tokens: { input: 29_523, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } })],
      contextLimit: model,
    })!
    expect(measured.tokens).toBe(5_000)
    expect(measured.reclaimed).toBe(25_000)
    expect(measured.urgent).toBe(true)
    expect(measured.exhausted).toBe(false)
  })

  test("an exhausted request is flagged so the surface can say so", () => {
    const measured = contextUsage({
      report: report({ tokens: 190_000, reclaimedTokens: 10_000, utilization: 0.95, outcome: "exhausted" }),
      messages: [],
      contextLimit: model,
    })!
    expect(measured.exhausted).toBe(true)
    expect(measured.urgent).toBe(true)
    expect(measured.percent).toBe(95)
  })

  test("a model without a declared window reports no percentage instead of pretending one", () => {
    const measured = contextUsage({
      report: report({ limit: undefined, utilization: 0 }),
      messages: [],
      contextLimit: noModel,
    })!
    expect(measured.percent).toBeUndefined()
    expect(measured.tokens).toBe(30_000)
    expect(barState(measured)).toEqual({ status: "unknown", tokens: 30_000 })
  })
})

describe("sidebar context before the first report", () => {
  test("no assistant output yet is UNKNOWN, not 0 tokens/0% used", () => {
    const measured = contextUsage({ report: undefined, messages: [], contextLimit: noModel })
    expect(measured).toBeUndefined()
    const glyphs = contextBarGlyphs(barState(measured))
    expect(glyphs).toBe("░".repeat(CONTEXT_BAR_WIDTH))
    expect(glyphs).not.toContain("█")
    expect(glyphs).not.toContain("▨")
  })

  test("usage exists but no model context limit resolves to unknown, rendered as a plain empty bar", () => {
    const measured = contextUsage({
      report: undefined,
      messages: [assistant({ tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } })],
      contextLimit: noModel,
    })!
    expect(measured.percent).toBeUndefined()
    expect(measured.tokens).toBe(1200)
    const glyphs = contextBarGlyphs(barState(measured))
    // Unknown must render identically to the "no usage yet" unknown case: a
    // plain empty bar, never a hatch glyph (hatch glyphs render at a
    // different cell height than fill/empty glyphs in terminal fonts).
    expect(glyphs).toBe("░".repeat(CONTEXT_BAR_WIDTH))
    expect(glyphs).not.toContain("█")
    expect(glyphs).not.toContain("▨")
  })

  test("partial usage fills a proportional number of cells", () => {
    const measured = contextUsage({
      report: undefined,
      messages: [assistant({ tokens: { input: 29_523, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } })],
      contextLimit: model,
    })!
    expect(measured.tokens).toBe(29_723)
    expect(measured.percent).toBe(15)
    const glyphs = contextBarGlyphs(barState(measured))
    expect(glyphs.length).toBe(CONTEXT_BAR_WIDTH)
    // 15% of 20 cells rounds to 3 filled cells.
    expect(glyphs).toBe("█".repeat(3) + "░".repeat(CONTEXT_BAR_WIDTH - 3))
  })

  test("near-limit usage fills almost the whole bar without overflowing it", () => {
    const measured = contextUsage({
      report: undefined,
      messages: [assistant({ tokens: { input: 183_800, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } })],
      contextLimit: model,
    })!
    expect(measured.tokens).toBe(184_000)
    expect(measured.percent).toBe(92)
    const glyphs = contextBarGlyphs(barState(measured))
    expect(glyphs.length).toBe(CONTEXT_BAR_WIDTH)
    expect(glyphs).toBe("█".repeat(18) + "░".repeat(CONTEXT_BAR_WIDTH - 18))
  })

  test("percent above 100 (e.g. a stale/overshot limit) still clamps to a full bar", () => {
    const measured = contextUsage({
      report: undefined,
      messages: [assistant({ tokens: { input: 500_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } })],
      contextLimit: model,
    })!
    expect(measured.percent).toBe(250)
    const glyphs = contextBarGlyphs(barState(measured))
    expect(glyphs).toBe("█".repeat(CONTEXT_BAR_WIDTH))
  })
})

describe("sidebar context zero-output usage", () => {
  test("completed input-only turn is measured instead of unknown", () => {
    expect(
      contextUsage({
        report: undefined,
        messages: [assistant({ tokens: { input: 30000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })],
        contextLimit: model,
      }),
    ).toEqual({ tokens: 30000, percent: 15, reclaimed: 0, overhead: 0, urgent: false, exhausted: false })
  })

  test("latest input-only turn replaces older output-bearing usage", () => {
    expect(
      contextUsage({
        report: undefined,
        messages: [
          assistant(),
          assistant({ id: "latest", tokens: { input: 184000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
        ],
        contextLimit: model,
      }),
    ).toEqual({ tokens: 184000, percent: 92, reclaimed: 0, overhead: 0, urgent: false, exhausted: false })
  })

  test("cache/reasoning-only usage counts, all-zero placeholder stays unknown", () => {
    expect(
      contextUsage({
        report: undefined,
        messages: [assistant({ tokens: { input: 0, output: 0, reasoning: 5, cache: { read: 10, write: 5 } } })],
        contextLimit: () => 100,
      }),
    ).toEqual({ tokens: 20, percent: 20, reclaimed: 0, overhead: 0, urgent: false, exhausted: false })
    expect(
      contextUsage({
        report: undefined,
        messages: [
          assistant({
            id: "placeholder",
            time: { created: 0 },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }),
        ],
        contextLimit: () => 100,
      }),
    ).toBeUndefined()
  })
})
