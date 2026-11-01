import { RGBA } from "@opentui/core"
import { AgentEffort } from "@opencode-ai/schema/agent-effort"
import { describe, expect, test } from "bun:test"
import {
  configLevel,
  defaultLevel,
  effortRecord,
  effortColor,
  effortBadge,
  coupledThinking,
  finishStatus,
  finishStatusLines,
  mergeEffortMetadata,
  metadataLevel,
  nextLevel,
  resolveEffort,
} from "../../src/util/agent-effort"

describe("agent effort resolution", () => {
  test("reads only a closed literal from session metadata", () => {
    expect(metadataLevel({ agentEffort: "fast" })).toBe("fast")
    expect(metadataLevel({ agentEffort: "medium" })).toBe("medium")
    expect(metadataLevel({ agentEffort: "thorough" })).toBe("thorough")
    expect(metadataLevel({ agentEffort: "turbo" })).toBeUndefined()
    expect(metadataLevel({ agentEffort: 5 })).toBeUndefined()
    expect(metadataLevel({})).toBeUndefined()
    expect(metadataLevel(undefined)).toBeUndefined()
    expect(metadataLevel("fast")).toBeUndefined()
    expect(metadataLevel(["fast"])).toBeUndefined()
    // A legacy named agent whose `effort` entry is an object never parses
    // as the scalar policy setting.
    expect(metadataLevel({ agentEffort: { model: "provider/model" } })).toBeUndefined()
  })

  test("reads the reserved scalar config setting without trusting named agents", () => {
    expect(configLevel({ agent: { effort: "thorough" } })).toBe("thorough")
    expect(configLevel({ agent: { effort: "fast", work: { model: "a/b" } } })).toBe("fast")
    expect(configLevel({ agent: { effort: "medium" } })).toBe("medium")
    expect(configLevel({ agent: { effort: "turbo" } })).toBeUndefined()
    expect(configLevel({ agent: { effort: { model: "a/b" } } })).toBeUndefined()
    expect(configLevel({ agent: { work: { model: "a/b" } } })).toBeUndefined()
    expect(configLevel({ model: "a/b" })).toBeUndefined()
    expect(configLevel(undefined)).toBeUndefined()
  })

  test("applies session, config, then medium precedence for untrusted input", () => {
    const config = { agent: { effort: "thorough" } }
    expect(resolveEffort({ metadata: { agentEffort: "fast" }, config })).toBe("fast")
    expect(resolveEffort({ metadata: { agentEffort: "bogus" }, config })).toBe("thorough")
    expect(resolveEffort({ metadata: { agentEffort: "bogus" }, config: { agent: { effort: "nope" } } })).toBe("medium")
    expect(resolveEffort({ config })).toBe("thorough")
    expect(resolveEffort({})).toBe("medium")
    expect(resolveEffort({ fallback: "fast" })).toBe("fast")
    expect(resolveEffort({ metadata: { agentEffort: "thorough" }, fallback: "fast" })).toBe("thorough")
  })

  test("merges metadata so unrelated keys survive every effort write", () => {
    expect(mergeEffortMetadata({ agentEffort: "medium", task: "abc", nested: { a: 1 } }, "fast")).toEqual({
      agentEffort: "fast",
      task: "abc",
      nested: { a: 1 },
    })
    expect(mergeEffortMetadata({ other: true }, "thorough")).toEqual({ agentEffort: "thorough", other: true })
    expect(mergeEffortMetadata(undefined, "fast")).toEqual({ agentEffort: "fast" })
    expect(mergeEffortMetadata(["not", "a", "record"], "fast")).toEqual({ agentEffort: "fast" })
  })

  test("cycles the dial fast → medium → thorough → ultra → fast", () => {
    expect(nextLevel("fast")).toBe("medium")
    expect(nextLevel("medium")).toBe("thorough")
    expect(nextLevel("thorough")).toBe("ultra")
    expect(nextLevel("ultra")).toBe("fast")
  })
})

describe("coupled thinking defaults", () => {
  test("prefers low/medium/high only when the model offers the variant", () => {
    expect(coupledThinking({ effort: "fast", variants: ["low", "medium", "high"] })).toBe("low")
    expect(coupledThinking({ effort: "medium", variants: ["low", "medium", "high"] })).toBe("medium")
    expect(coupledThinking({ effort: "thorough", variants: ["low", "medium", "high"] })).toBe("high")
    expect(coupledThinking({ effort: "fast", variants: ["high"] })).toBeUndefined()
    expect(coupledThinking({ effort: "fast" })).toBeUndefined()
    expect(coupledThinking({ effort: "fast", variants: [] })).toBeUndefined()
  })

  test("never applies over an explicit choice, including explicit default/off", () => {
    expect(coupledThinking({ effort: "fast", variants: ["low"], chosen: "default" })).toBeUndefined()
    expect(coupledThinking({ effort: "thorough", variants: ["high"], chosen: "high" })).toBeUndefined()
    expect(coupledThinking({ effort: "fast", variants: ["low"], chosen: "medium" })).toBeUndefined()
  })

  test("never applies over a configured agent or model variant", () => {
    expect(coupledThinking({ effort: "fast", variants: ["low"], configured: "high" })).toBeUndefined()
    expect(coupledThinking({ effort: "fast", variants: ["low"], configured: "" })).toBe("low")
    expect(coupledThinking({ effort: "fast", variants: ["low"], chosen: undefined })).toBe("low")
  })
})

describe("honest finish status", () => {
  test("keeps legacy transcript labels readable", () => {
    const approved = finishStatus({
      review: { verdict: "approved", reviews: 1, maxIterations: 5, termination: "approved" },
    })
    expect(approved?.review).toEqual({ label: "approved", detail: "1/5 passes", tone: "success" })

    expect(finishStatus({ review: { termination: "skipped", reviews: 0, maxIterations: 5 } })?.review?.label).toBe(
      "skipped",
    )
    expect(finishStatus({ review: { termination: "review-cap", reviews: 5, maxIterations: 5 } })?.review?.label).toBe(
      "cap",
    )
    expect(finishStatus({ verdict: "approved" })).toBeUndefined()
    expect(finishStatus(undefined)).toBeUndefined()
    expect(finishStatus({})).toBeUndefined()
    expect(finishStatus("review")).toBeUndefined()
  })

  test("shows fast delivery as unreviewed, never approved", () => {
    const status = finishStatus({
      review: {
        effort: "fast",
        disposition: "unreviewed",
        reviews: 0,
        termination: "unreviewed",
        openFindings: 0,
        blockingFindings: 0,
        workSinceReview: false,
      },
    })
    expect(status?.review?.label).toBe("unreviewed")
    expect(status?.review?.tone).toBe("warning")
    expect(status?.review?.detail).toBe("fast · 0 passes")
    expect(JSON.stringify(status)).not.toContain("approved")
  })

  test("reports exhausted budgets with open and stale findings intact", () => {
    const status = finishStatus({
      review: {
        effort: "medium",
        disposition: "reviewed",
        reviews: 2,
        maxIterations: 2,
        termination: "budget-exhausted",
        openFindings: 3,
        blockingFindings: 1,
        workSinceReview: true,
      },
    })
    expect(status?.review?.label).toBe("budget exhausted")
    expect(status?.review?.detail).toBe("medium · 2/2 passes · 3 open, 1 blocking · stale")
    expect(status?.review?.tone).toBe("warning")
  })

  test("shows findings-open and stale-after-review without upgrading to approved", () => {
    const status = finishStatus({
      review: {
        disposition: "reviewed",
        termination: "findings-open",
        reviews: 1,
        openFindings: 2,
        workSinceReview: 1,
      },
    })
    expect(status?.review?.label).toBe("findings open")
    expect(status?.review?.detail).toContain("2 open")
    expect(status?.review?.detail).toContain("stale")

    const staleOnly = finishStatus({
      review: { disposition: "reviewed", termination: "approved", workSinceReview: true },
    })
    expect(staleOnly?.review?.detail).toContain("stale")
  })

  test("keeps the legacy reviewer-unavailable label readable with its visible reason", () => {
    const status = finishStatus({
      review: {
        effort: "thorough",
        disposition: "unreviewed",
        termination: "review-unavailable",
        unavailableReason: "no reviewer agent permitted at depth 3",
      },
    })
    expect(status?.review?.label).toBe("review unavailable")
    expect(status?.review?.detail).toContain("no reviewer agent permitted at depth 3")
    expect(status?.review?.tone).toBe("warning")
  })

  test("distinguishes blocked review failures from pending child handoffs", () => {
    const blocked = finishStatus({
      review: {
        effort: "thorough",
        disposition: "unreviewed",
        termination: "review-blocked",
        unavailableReason: "permission config denies the reviewer",
      },
    })
    expect(blocked?.review).toEqual({
      label: "review blocked",
      detail: "thorough · permission config denies the reviewer",
      tone: "warning",
    })

    const pending = finishStatus({
      review: {
        effort: "medium",
        disposition: "unreviewed",
        reviews: 0,
        maxIterations: 2,
        termination: "review-pending",
        unavailableReason: "subagent depth limit reached",
      },
    })
    expect(pending?.review).toEqual({
      label: "review pending",
      detail: "medium · 0/2 passes · subagent depth limit reached",
      tone: "warning",
    })
  })

  test("distinguishes exemption from approval for read-only work", () => {
    const status = finishStatus({ review: { disposition: "unreviewed", termination: "not-required", reviews: 0 } })
    expect(status?.review?.label).toBe("not required")
    expect(status?.review?.tone).toBe("text")

    expect(finishStatus({ review: { termination: "waiting" } })?.review?.label).toBe("waiting")
    expect(finishStatus({ review: { disposition: "reviewed", reviews: 1 } })?.review?.label).toBe("reviewed")
  })

  test("never serializes an infinite thorough budget", () => {
    const status = finishStatus({
      review: { effort: "thorough", disposition: "reviewed", reviews: 4, maxIterations: Infinity },
    })
    expect(status?.review?.detail).toBe("thorough · 4 passes")
    expect(JSON.stringify(status)).not.toContain("Infinity")
  })

  test("surfaces failed, missing, and not-run validation evidence", () => {
    const passed = finishStatus({
      validation: {
        gate: "standard",
        status: "passed",
        checks: [{ category: "tests", status: "passed" }],
        source: "agent-reported",
      },
    })
    expect(passed?.validation?.label).toBe("validation passed")
    expect(passed?.validation?.tone).toBe("success")
    expect(passed?.validation?.detail).toBe("standard")

    const failed = finishStatus({
      validation: {
        gate: "full",
        status: "failed",
        checks: [
          { category: "tests", status: "failed" },
          { category: "typecheck", status: "not-run" },
          { category: "parity", status: "not-applicable" },
        ],
      },
    })
    expect(failed?.validation?.label).toBe("validation failed")
    expect(failed?.validation?.tone).toBe("warning")
    expect(failed?.validation?.detail).toBe("full · tests: failed · typecheck: not-run · parity: not-applicable")

    const incomplete = finishStatus({ validation: { gate: "minimal", status: "incomplete", checks: [] } })
    expect(incomplete?.validation?.label).toBe("validation incomplete")
    expect(incomplete?.validation?.tone).toBe("text")
    expect(JSON.stringify(incomplete)).not.toContain("passed")

    const unknown = finishStatus({ validation: { checks: [{ category: "smoke", status: "not-run" }] } })
    expect(unknown?.validation?.label).toBe("validation")
    expect(unknown?.validation?.detail).toContain("smoke: not-run")
  })

  test("renders review and validation lines together for the transcript", () => {
    const lines = finishStatusLines({
      review: { label: "budget exhausted", detail: "medium · 2/2 passes", tone: "warning" },
      validation: { label: "validation incomplete", detail: "standard · tests: not-run", tone: "text" },
    })
    expect(lines).toEqual([
      "review: budget exhausted · medium · 2/2 passes",
      "validation incomplete · standard · tests: not-run",
    ])
    expect(
      finishStatusLines({
        review: { label: "unreviewed", tone: "warning" },
      }),
    ).toEqual(["review: unreviewed"])
  })
})


test("every schema level is safe across utility consumers, including ultra", () => {
  for (const level of AgentEffort.levels) {
    expect(metadataLevel(effortRecord(level))).toBe(level)
    expect(configLevel({ agent: { effort: level } })).toBe(level)
    expect(resolveEffort({ metadata: effortRecord(level) })).toBe(level)
    expect(resolveEffort({ config: { agent: { effort: level } } })).toBe(level)
    expect(defaultLevel({ selected: level })).toBe(level)
    expect(defaultLevel({ config: { agent: { effort: level } } })).toBe(level)
    expect(mergeEffortMetadata({ other: true }, level)).toEqual({ other: true, agentEffort: level })
    expect(AgentEffort.levels).toContain(nextLevel(level))
    expect(finishStatusLines(finishStatus({ review: { effort: level, reviews: 3, termination: "approved" } })!)[0]).toContain(`${level} · 3 passes`)
    for (const background of ["#000000", "#ffffff"]) {
      const theme = { background: RGBA.fromHex(background), text: RGBA.fromHex("#ffffff") }
      expect(effortBadge(level, theme).bg).toEqual(effortColor(level, theme))
    }
  }
  expect(coupledThinking({ effort: "ultra", variants: ["low", "medium", "high"] })).toBe("high")
  expect(coupledThinking({ effort: "ultra", variants: ["low"] })).toBeUndefined()
  expect(coupledThinking({ effort: "ultra", variants: ["high"], chosen: "default" })).toBeUndefined()
  expect(coupledThinking({ effort: "ultra", variants: ["high"], configured: "low" })).toBeUndefined()
})

test("ultra matches the approved purple palette on opaque and transparent surfaces", () => {
  for (const [background, text, expected] of [
    ["#000000", "#ffffff", "#bc8cff"], ["#ffffff", "#000000", "#8250df"],
    ["#00000000", "#ffffff", "#bc8cff"], ["#00000000", "#000000", "#8250df"],
  ]) {
    const theme = { background: RGBA.fromHex(background), text: RGBA.fromHex(text) }
    expect(effortColor("ultra", theme)).toEqual(RGBA.fromHex(expected))
    expect(effortBadge("ultra", theme).fg).toEqual(RGBA.fromHex(expected === "#bc8cff" ? "#000000" : "#ffffff"))
  }
})
