/**
 * Regression tests for what the review-loop evaluator accepts as a delivered
 * review. A review task is only a verdict when the run actually reported one:
 * a cancelled run never reached a finish call, and a run that yielded for its
 * own background subagents has not finished, so its envelope is provisional.
 *
 * They also pin the finish requirement built on that verdict: a decline is not
 * a waiver, so only an approval, the review cap, or a turn without file writes
 * ends it.
 *
 * See packages/core/src/review-loop.ts for the evaluator and
 * packages/opencode/src/tool/task.ts for the delivered task metadata.
 */

import { describe, expect, test } from "bun:test"
import { ReviewReport } from "@opencode-ai/core/review-report"
import { REVIEW_LOOP_METADATA, finishGateError, reviewLoopState } from "@opencode-ai/core/review-loop"

type Part = {
  type?: unknown
  tool?: unknown
  synthetic?: unknown
  metadata?: unknown
  state?: {
    status?: unknown
    input?: unknown
    output?: unknown
    metadata?: unknown
  }
}

const userMessage = { info: { role: "user" }, parts: [] as Part[] }

const editMessage = {
  info: { role: "assistant" },
  parts: [
    {
      type: "tool",
      tool: "edit",
      state: {
        status: "completed",
        input: {},
        output: "done",
        metadata: { [REVIEW_LOOP_METADATA]: { writesFiles: true } },
      },
    },
  ] as Part[],
}

const reviewMessage = (options?: { termination?: string; status?: string }) => ({
  info: { role: "assistant" },
  parts: [
    {
      type: "tool",
      tool: "task",
      state: {
        status: options?.status ?? "completed",
        input: { subagent_type: "review", background: false },
        output: "### Assessment\n\n**Ready to proceed?** Approved",
        ...(options?.termination ? { metadata: { termination: { reason: options.termination } } } : {}),
      },
    },
  ] as Part[],
})

const finishMessage = (termination: string) => ({
  info: { role: "assistant" },
  parts: [
    {
      type: "tool",
      tool: "finish",
      state: {
        status: "completed",
        input: { reason: "success", result: "done" },
        output: "done",
        metadata: { review: { verdict: "approved", reviews: 1, maxIterations: 5, termination } },
      },
    },
  ] as Part[],
})

describe("review loop – delivered reviews", () => {
  test("a completed synchronous review is the delivered verdict", () => {
    const state = reviewLoopState([userMessage, editMessage, reviewMessage()])

    expect(state.reviews).toBe(1)
    expect(state.verdict).toBe("approved")
    expect(finishGateError(state)).toBeUndefined()
  })

  // The parent-facing task result carries the reason its child stopped. A child
  // that yielded is still running underneath, so the envelope it delivered
  // cannot stand in for a verdict: no completion was reported, and the review
  // it describes may still change. Counting it would let a review satisfy the
  // gate while it keeps working.
  test("a review that yielded for its own subagents delivers no verdict", () => {
    const state = reviewLoopState([userMessage, editMessage, reviewMessage({ termination: "waiting_for_subagent" })])

    expect(state.reviews).toBe(0)
    expect(state.verdict).toBe("pending")
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  test("a cancelled review delivers no verdict", () => {
    const state = reviewLoopState([userMessage, editMessage, reviewMessage({ status: "cancelled" })])

    expect(state.reviews).toBe(0)
    expect(state.verdict).toBe("pending")
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  // The counter-case: a review that stopped with a real termination is the
  // delivered verdict, so the excluded reasons are exactly the undelivered ones
  // rather than every reason-carrying task.
  test("a review that stopped on a declared reason still delivers its verdict", () => {
    for (const reason of ["success", "failure", "subagent_wait"]) {
      const state = reviewLoopState([userMessage, editMessage, reviewMessage({ termination: reason })])

      expect(state.reviews).toBe(1)
      expect(state.verdict).toBe("approved")
      expect(finishGateError(state)).toBeUndefined()
    }
  })

  // Discriminating counterpart to the excluded-reason cases: the evaluator does
  // read a terminal finish metadata, so a waiting review is skipped for its own
  // reason and not because every task part is ignored.
  test("a delivered approval is disturbed by neither a yielded nor a cancelled review", () => {
    const state = reviewLoopState([
      userMessage,
      editMessage,
      reviewMessage(),
      reviewMessage({ termination: "waiting_for_subagent" }),
      reviewMessage({ termination: "cancelled", status: "cancelled" }),
    ])

    expect(state.reviews).toBe(1)
    expect(state.verdict).toBe("approved")
  })

  test("a finish that recorded a terminal review keeps the termination", () => {
    const state = reviewLoopState([userMessage, editMessage, reviewMessage(), finishMessage("approved")])

    expect(state.termination).toBe("approved")
    expect(state.nudged).toBe(false)
  })
})

// The finish gate is a requirement (#231). A decline names the Review subagent
// and the exact dispatch; it is not a waiver, so a retried finish - whatever
// its result claims about the work - is declined again until a review approves
// the current work. Only the evaluator's own outcomes end it.
describe("review loop – finish requirement", () => {
  const declinedFinish = (result: string) => ({
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "finish",
        state: {
          status: "error",
          input: { reason: "success", result },
          metadata: { review: { nudged: true, verdict: "pending", reviews: 0, maxIterations: 5 } },
        },
      },
    ] as Part[],
  })

  const needsFixesMessage = {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: { subagent_type: "review", background: false },
          output: "### Assessment\n\n**Ready to proceed?** Needs fixes",
        },
      },
    ] as Part[],
  }

  test("the decline names the Review subagent and its synchronous dispatch, and offers no skip", () => {
    const message = finishGateError(reviewLoopState([userMessage, editMessage]))?.message ?? ""

    expect(message).toContain("Review subagent")
    expect(message).toContain('`subagent_type: "review"`')
    expect(message).toContain("`background: false`")
    expect(message).toContain("no explicit Approved review")
    expect(message).not.toMatch(/skip review and deliver|call finish again to skip/i)
    expect(message).not.toContain("retrying finish does not skip review")
  })

  test("a retried finish after a decline is declined again", () => {
    const state = reviewLoopState([userMessage, editMessage, declinedFinish("done")])

    expect(state.nudged).toBe(true)
    expect(state.verdict).toBe("pending")
    const message = finishGateError(state)?.message ?? ""
    expect(message).toContain("finish declined again")
    expect(message).toContain("retrying finish does not skip review")
    expect(message).toContain('`subagent_type: "review"`')
  })

  // The evaluator never reads the finish result, so no account of the work can
  // change the outcome: the rationale from the eval-3 report is just text.
  test("a creative-asset rationale in a declined finish does not exempt the work", () => {
    const rationale =
      "Created scene.html. Review skipped: this is a creative HTML asset, not production code, so no review is needed."
    const plain = reviewLoopState([userMessage, editMessage, declinedFinish("done")])
    const creative = reviewLoopState([userMessage, editMessage, declinedFinish(rationale)])

    expect(creative).toEqual(plain)
    expect(finishGateError(creative)?.message).toBe(finishGateError(plain)?.message)
  })

  test("a retried finish after Needs fixes is declined until a new review", () => {
    const state = reviewLoopState([userMessage, editMessage, needsFixesMessage, declinedFinish("done")])

    expect(state.verdict).toBe("needs-fixes")
    expect(state.nudged).toBe(true)
    const message = finishGateError(state)?.message ?? ""
    expect(message).toContain("returned Needs fixes")
    expect(message).toContain("retrying finish does not skip review")
  })

  test("an approval after the decline ends the requirement", () => {
    const state = reviewLoopState([userMessage, editMessage, declinedFinish("done"), reviewMessage()])

    expect(state.nudged).toBe(false)
    expect(state.verdict).toBe("approved")
    expect(finishGateError(state)).toBeUndefined()
  })

  // The review cap bounds the requirement: completed reviews, not retries.
  test("the review cap ends the requirement without an approval", () => {
    const state = reviewLoopState([userMessage, editMessage, needsFixesMessage, declinedFinish("done")], 1)

    expect(state.verdict).toBe("cap")
    expect(finishGateError(state)).toBeUndefined()
  })

  test("a turn without file writes has nothing to review", () => {
    const state = reviewLoopState([userMessage, declinedFinish("done")])

    expect(state.verdict).toBe("none")
    expect(finishGateError(state)).toBeUndefined()
  })

  test("a waived completion keeps its own termination rather than reading as approved", () => {
    const state = reviewLoopState([userMessage, editMessage, finishMessage("review-unavailable")])

    expect(state.termination).toBe("review-unavailable")
    expect(state.verdict).toBe("pending")
  })
})

describe("review loop - conservative task evidence", () => {
  for (const status of ["running", "error", "completed"]) {
    test(`child write evidence survives ${status}`, () => {
      const child = {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "task",
            state: {
              status,
              input: { subagent_type: "code" },
              metadata: { reviewLoop: { writesFiles: true, handoff: "pending" } },
            },
          },
        ],
      }
      const state = reviewLoopState([userMessage, child])
      expect(state.verdict).toBe("pending")
      expect(finishGateError(state)).toBeInstanceOf(Error)
    })
  }
  // The task tool marks a review run that wrote files as an unreviewed handoff
  // on the same part that carries its report. The report association is
  // preserved there, but the marker has precedence before the report is
  // accepted: an Approved report cannot count for the child's edits.
  const handoffReviewMessage = (assessment: "approved" | "needs-fixes") => ({
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: { subagent_type: "review", background: false },
          output: `### Assessment\n\n**Ready to proceed?** ${assessment === "approved" ? "Approved" : "Needs fixes"}`,
          metadata: {
            [REVIEW_LOOP_METADATA]: { writesFiles: true, handoff: "pending", sessionId: "ses_review_child" },
            review: {
              report: { version: 1, revision: "uncommitted", assessment, summary: "done", findings: [] },
              sessionId: "ses_review_child",
              revision: "uncommitted",
              verdict: "pending",
              termination: "review-pending",
            },
          },
        },
      },
    ],
  })

  test("an Approved report cannot approve a review child's unreviewed writes", () => {
    const state = reviewLoopState([userMessage, editMessage, handoffReviewMessage("approved")])

    expect(state.reviews).toBe(1)
    expect(state.workSinceReview).toBe(true)
    expect(state.verdict).toBe("pending")
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  test("a review child's unreviewed writes need review even without parent edits", () => {
    const state = reviewLoopState([userMessage, handoffReviewMessage("approved")])

    expect(state.workSinceReview).toBe(true)
    expect(state.verdict).toBe("pending")
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  // The gate is a requirement the parent can discharge: its own later Review
  // covers the projected child writes and approves the whole current work.
  test("a clean review after the handoff covers the child's projected writes", () => {
    const state = reviewLoopState([userMessage, editMessage, handoffReviewMessage("approved"), reviewMessage()])

    expect(state.workSinceReview).toBe(false)
    expect(state.verdict).toBe("approved")
    expect(finishGateError(state)).toBeUndefined()
  })

  test("errored review counts an honest attempt and reaches cap", () => {
    const failed = reviewMessage({ status: "error" })
    const state = reviewLoopState([userMessage, editMessage, failed], 1)
    expect(state.reviews).toBe(1)
    expect(state.verdict).toBe("cap")
    expect(state.reviewInProgress).toBe(false)
  })
  // An approval covers only the tree it reviewed. Work after it, then an errored
  // attempt (which clears the work flag), must not revive the approval.
  test("an errored attempt after later work does not revive an earlier approval", () => {
    const state = reviewLoopState(
      [userMessage, editMessage, reviewMessage(), editMessage, reviewMessage({ status: "error" })],
      { effort: "medium" },
    )
    expect(state.reviews).toBe(2)
    expect(state.lastReviewVerdict).toBeUndefined()
    expect(state.verdict).not.toBe("approved")
  })

  test("errored review stays unapproved before cap", () => {
    const state = reviewLoopState([userMessage, editMessage, reviewMessage({ status: "error" })], 2)
    expect(state.reviews).toBe(1)
    expect(state.verdict).toBe("pending")
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })
})

test("rendered review tag mentions retain blocking findings in completed task accounting", () => {
  const report: ReviewReport.Info = {
    version: 1,
    revision: "uncommitted",
    assessment: "needs-fixes",
    summary: "One defect",
    findings: [{ severity: "critical", title: "Real defect" }],
  }
  const delivery = ReviewReport.extract([ReviewReport.envelope(report), "Mention <silvercode-review> in prose."])
  expect(delivery.ok).toBe(true)
  if (!delivery.ok) return
  const task = reviewMessage({ termination: "success" })
  task.parts[0].state!.output = ReviewReport.render(delivery)
  const state = reviewLoopState([userMessage, editMessage, task], { effort: "medium" })
  expect(state.verdict).toBe("needs-fixes")
  expect(state.reviews).toBe(1)
  expect(state.openFindings).toBe(1)
  expect(state.blockingFindings).toBe(1)
})
