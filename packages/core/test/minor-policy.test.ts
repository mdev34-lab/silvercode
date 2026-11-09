import { describe, expect, test } from "bun:test"
import { EffortPolicy } from "@opencode-ai/core/effort-policy"
import { REVIEW_LOOP_METADATA, reviewLoopState, type ReviewHistoryMessage } from "@opencode-ai/core/review-loop"
import { AgentEffort } from "@opencode-ai/schema/agent-effort"

const user = { info: { role: "user" }, parts: [] }
const minor = { severity: "minor", title: "Correct the documented name" }

function history(assessment: "approved" | "needs-fixes", findings: readonly Record<string, unknown>[]) {
  return {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: { subagent_type: "review", background: false },
          output: `<silvercode-review>${JSON.stringify({
            version: 1,
            revision: "uncommitted",
            assessment,
            summary: "Reviewed the current work",
            findings,
          })}</silvercode-review>`,
          metadata: { background: false },
        },
      },
    ],
  }
}

function write() {
  return {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "edit",
        state: {
          status: "completed",
          input: {},
          output: "corrected",
          metadata: { [REVIEW_LOOP_METADATA]: { writesFiles: true } },
        },
      },
    ],
  }
}

function state(messages: ReviewHistoryMessage[], effort: AgentEffort.Level = "thorough") {
  return reviewLoopState([user, write(), ...messages], { effort })
}

function finish(effort: AgentEffort.Level, messages: ReviewHistoryMessage[], reviewerAvailable = true) {
  return EffortPolicy.evaluateFinish({
    effort,
    reason: "success",
    state: state(messages, effort),
    reviewerAvailable,
    ...(reviewerAvailable
      ? {}
      : { unavailableReason: "no reviewer is dispatchable", unavailableCode: "permission-denied" }),
  })
}

describe("known minor findings: persisted evidence and current effort", () => {
  test("an Approved envelope retains minor findings separately from blocking findings", () => {
    const result = state([history("approved", [minor])])
    expect(result).toMatchObject({
      verdict: "approved",
      lastReviewVerdict: "approved",
      openFindings: 1,
      blockingFindings: 0,
      workSinceReview: false,
      stale: false,
    })
  })

  test("thorough requires correction and a fresh clean review, not just another finish", () => {
    const outstanding = [history("approved", [minor])]
    const before = finish("thorough", outstanding)
    expect(before.deliver).toBe(false)
    expect(before.termination).not.toBe("approved")
    expect(before.feedback).toContain("minor")
    expect(before.feedback).toContain("fresh")
    expect(finish("thorough", outstanding)).toEqual(before)

    const corrected = [...outstanding, write()]
    expect(state(corrected)).toMatchObject({ openFindings: 1, blockingFindings: 0, workSinceReview: true, stale: true })
    expect(finish("thorough", corrected).deliver).toBe(false)
    expect(finish("thorough", [...corrected, history("approved", [minor])]).deliver).toBe(false)

    const clean = finish("thorough", [...corrected, history("approved", [])])
    expect(clean).toMatchObject({ deliver: true, termination: "approved", disposition: "reviewed" })
  })

  test("the current effort controls an unchanged persisted report in both switch directions", () => {
    const report = [history("approved", [minor])]
    expect(finish("thorough", report).deliver).toBe(false)
    expect(finish("medium", report)).toMatchObject({ deliver: true, termination: "approved" })
    expect(finish("fast", report)).toMatchObject({ deliver: true, termination: "approved" })
    expect(finish("thorough", report).deliver).toBe(false)

    const capped = [history("needs-fixes", [minor]), history("approved", [minor])]
    expect(finish("medium", capped)).toMatchObject({ deliver: true, termination: "approved" })
    expect(finish("thorough", capped).deliver).toBe(false)
  })

  test("fast and medium still warn on minor findings, including after later work", () => {
    for (const effort of ["fast", "medium"] as const) {
      const report = [history("approved", [minor])]
      expect(finish(effort, report)).toMatchObject({ deliver: true, termination: "approved" })
      const stale = [...report, write()]
      // Minor findings do not add a new Medium blocker: its existing stale-work rule still applies.
      expect(finish(effort, stale).deliver).toBe(effort === "fast")
      if (effort === "fast") expect(finish(effort, stale).termination).toBe("findings-open")
      if (effort === "medium")
        expect(finish(effort, [...stale, history("approved", [minor])])).toMatchObject({
          deliver: true,
          termination: "approved",
        })
      expect(state(stale, effort)).toMatchObject({ openFindings: 1, blockingFindings: 0, stale: true })
    }
  })

  test("blocking findings and a Needs-fixes report with no findings keep their existing meaning", () => {
    for (const effort of AgentEffort.levels) {
      const blocking = state([history("approved", [{ severity: "important", title: "Broken behavior" }])], effort)
      expect(blocking).toMatchObject({ openFindings: 1, blockingFindings: 1 })
      expect(
        finish(effort, [history("approved", [{ severity: "important", title: "Broken behavior" }])]).termination,
      ).not.toBe("approved")
    }
    const empty = state([history("needs-fixes", [])])
    expect(empty).toMatchObject({ openFindings: 0, blockingFindings: 1 })
    expect(finish("thorough", [history("needs-fixes", [])]).deliver).toBe(false)
  })

  test("known minor findings with no dispatchable reviewer decline rather than deliver", () => {
    // Coverage guard, not a deadlock: Thorough keeps declining while the reviewer
    // cannot run, exactly as it already does for an unavailable reviewer with no
    // findings. Restoring dispatch is what lets the correction-and-review cycle finish.
    const outstanding = [history("approved", [minor])]
    const thorough = finish("thorough", outstanding, false)
    expect(thorough.deliver).toBe(false)
    expect(thorough.feedback).toContain("blocked")
    expect(thorough.unavailableReason).toBe("no reviewer is dispatchable")

    // A clean Approved report already on record still delivers: the review happened,
    // so later dispatch capability cannot un-approve it. The unavailable gate is the
    // missing-review path, which keeps declining rather than fabricating a pass.
    expect(finish("thorough", [history("approved", [])], false)).toMatchObject({
      deliver: true,
      termination: "approved",
    })
    const missing = finish("thorough", [], false)
    expect(missing.deliver).toBe(false)
    expect(missing.feedback).toContain("blocked")

    // A declared failure still delivers honestly as review-blocked; minor findings
    // are the persisted evidence, so this is not reported as approval.
    const failed = EffortPolicy.evaluateFinish({
      effort: "thorough",
      reason: "failure",
      state: state(outstanding),
      reviewerAvailable: false,
      unavailableReason: "no reviewer is dispatchable",
    })
    expect(failed).toMatchObject({ deliver: true, termination: "review-blocked" })

    // Fast and medium are unchanged: severity-only, so a Minor does not gate them.
    expect(finish("fast", outstanding, false).deliver).toBe(true)
    expect(finish("medium", outstanding, false).deliver).toBe(true)
  })

  test("missing review remains the existing policy, not a fabricated finding", () => {
    const missing = state([])
    expect(missing).toMatchObject({ openFindings: 0, blockingFindings: 0, workSeen: true })
    expect(finish("thorough", []).deliver).toBe(false)
    expect(finish("medium", []).deliver).toBe(false)
    expect(finish("fast", [])).toMatchObject({ deliver: true, termination: "unreviewed" })
  })
})
