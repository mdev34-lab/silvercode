import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { REVIEW_LOOP_METADATA } from "@opencode-ai/core/review-loop"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { finishGateError, parseReviewVerdict, reviewLoopState } from "../../src/session/review-loop"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EditTool } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"

const promptDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/session/prompt")
const toolDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/tool")
const agentPromptDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/agent/prompt")

const readPrompt = (name: string) => readFile(path.join(promptDirectory, name), "utf8")
const readTool = (name: string) => readFile(path.join(toolDirectory, name), "utf8")
const readAgentPrompt = (name: string) => readFile(path.join(agentPromptDirectory, name), "utf8")

function userMessage() {
  return { info: { role: "user" }, parts: [] } as unknown as SessionV1.WithParts
}

function syntheticNudge() {
  return {
    info: { role: "user" },
    parts: [{ type: "text", synthetic: true, text: "Continue." }],
  } as unknown as SessionV1.WithParts
}

/**
 * A persisted `task(review)` part.
 *
 * The two axes have to be settable separately, because since synchronous
 * execution became a per-agent opt-in they can disagree: `background` is what the
 * caller asked for, and `delivery` is what the tool recorded as the mode it ran in
 * (`false` foreground, `true` background). Leaving `delivery` out builds the older
 * transcript shape, which carries no recorded mode and is judged on the request
 * alone - so a fixture that only ever sets `background` cannot express a request
 * that was overridden, nor a foreground review nobody asked to wait for.
 */
function reviewMessage(
  output: string,
  options?: {
    status?: "completed" | "running"
    background?: boolean | "omitted"
    delivery?: boolean
    metadata?: Record<string, unknown>
  },
) {
  const input =
    options?.background === "omitted"
      ? { subagent_type: "review" }
      : { subagent_type: "review", background: options?.background ?? false }
  return {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "task",
        state: {
          status: options?.status ?? "completed",
          input,
          output,
          metadata: {
            ...(options?.delivery === undefined ? {} : { background: options.delivery }),
            ...options?.metadata,
          },
        },
      },
    ],
  } as unknown as SessionV1.WithParts
}

function finishNudgeMessage() {
  return {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "finish",
        state: {
          status: "error",
          input: { result: "done" },
          error: "Review required",
          metadata: { review: { nudged: true, verdict: "pending", reviews: 0, maxIterations: 5 } },
        },
      },
    ],
  } as unknown as SessionV1.WithParts
}

function waitingFinishMessage() {
  return finishPart({ reason: "waiting_for_subagent", result: "Waiting on the children." }, { waiting: true })
}

function finishPart(input: Record<string, unknown>, metadata: Record<string, unknown>) {
  return {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "finish",
        state: {
          status: "completed",
          input,
          output: "done",
          metadata,
        },
      },
    ],
  } as unknown as SessionV1.WithParts
}

function toolMessage(tool: string, options?: { writesFiles?: boolean }) {
  return {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool,
        state: {
          status: "completed",
          input: {},
          output: "done",
          ...(options?.writesFiles ? { metadata: { [REVIEW_LOOP_METADATA]: { writesFiles: true } } } : {}),
        },
      },
    ],
  } as unknown as SessionV1.WithParts
}

describe("review loop prompt contract", () => {
  test("uses todo as the scope contract for every task", async () => {
    const prompt = (await readPrompt("review-loop.txt")).replace(/\s+/g, " ")

    expect(prompt).toContain("## Todo as scope contract")
    expect(prompt).toContain(
      "At the start of any task, write its scope as todo items before your first tool call.",
    )
    expect(prompt).toContain("The todo list IS the task's scope.")
    expect(prompt).toContain("Doing out-of-scope work silently and then reverting it is forbidden.")
    expect(prompt).toContain("When scope changes, update the todo list to reflect the new scope before continuing.")
    expect(prompt).toContain("Do not create backup files (`.bak`) — git already tracks your changes.")
  })

  test("todo tool guidance defers optional skips to the scope contract", async () => {
    const description = (await readTool("todowrite.txt")).replace(/\s+/g, " ")

    expect(description).toContain(
      "The system-prompt todo scope contract overrides these skips: when present, write its scope items before your first tool call, even for the cases above.",
    )
  })

  test("requires a review after work that follows review findings", async () => {
    const prompt = await readPrompt("review-loop.txt")

    expect(prompt).toContain("After every Work pass made in response to findings, return to Review")
    expect(prompt).toContain("Prefer not to call `finish` until a later review explicitly approves")
    // The pass budget belongs to the effort policy; the old fixed `review-cap`
    // termination is gone from the prompt contract.
    expect(prompt).toContain("The effort policy owns the pass budget")
    expect(prompt).toContain("`budget-exhausted` or `findings-open` status — never as approved")
    expect(prompt).not.toContain("review-cap")
  })

  test("makes finish the only enforcement checkpoint for the review requirement", async () => {
    const prompt = await readPrompt("review-loop.txt")

    expect(prompt).toContain("`finish` is the only enforcement checkpoint")
    expect(prompt).toContain("A missing or stale review is never reported as approved")
    expect(prompt).not.toContain("Review is guidance, not an enforcement gate")
    expect(prompt).not.toContain("explicitly skip review")
    expect(prompt).not.toContain("Mandatory Review Loop")
  })

  test("finish nudge preserves the review recommendation and forbids a skip path", async () => {
    const nudge = await readPrompt("finish-nudge.txt")

    expect(nudge).toContain("explicit Approved review from the Review subagent")
    expect(nudge).toContain('`subagent_type: "review"` and `background: false`')
    expect(nudge).toContain("latest review returned `Needs fixes`")
    expect(nudge).toContain("labelled UNREVIEWED and is never approval")
    expect(nudge).not.toContain("review-cap")
  })

  test("presents review as a requirement with no skip path", async () => {
    const prompt = (await readPrompt("review-loop.txt")).replace(/\s+/g, " ")

    expect(prompt).toContain("Review is required before finishing file-writing work.")
    expect(prompt).toContain("`finish` delivers it labelled UNREVIEWED")
    // #233 replaced the runtime waiver with three outcomes, none of which is a
    // skip: the attempt cap, a child's unreviewed handoff, and a blocked
    // dispatch that only an honest failure may report.
    expect(prompt).toContain("`budget-exhausted`")
    expect(prompt).toContain("`review-pending`")
    expect(prompt).toContain("`review-blocked`")
    expect(prompt).toContain("None of these outcomes means the work was approved")
    expect(prompt).not.toContain("`review-unavailable`")
    expect(prompt).not.toContain("Review is guidance, not an enforcement gate")
    expect(prompt).not.toMatch(/explicitly skip review|Skip review only/)
  })

  test("finish nudge names the Review subagent and offers no skip path", async () => {
    const nudge = (await readPrompt("finish-nudge.txt")).replace(/\s+/g, " ")

    expect(nudge).toContain("explicit Approved review from the Review subagent")
    expect(nudge).toContain('`subagent_type: "review"` and `background: false`')
    expect(nudge).toContain("latest review returned `Needs fixes`")
    expect(nudge).toContain("a Review that returned blocking findings holds `finish` back")
    expect(nudge).toContain("budget-exhausted")
    expect(nudge).not.toMatch(/explicitly skip review|strongly recommended/)
  })

  test("the finish tool description states the requirement and offers no skip path", async () => {
    const description = (await readTool("finish.txt")).replace(/\s+/g, " ")

    expect(description).toContain("an explicit Approved review of that work from the Review subagent is expected before finish")
    expect(description).toContain('`subagent_type: "review"` and `background: false`')
    expect(description).toContain("labelled UNREVIEWED and never approved")
    expect(description).toContain("`budget-exhausted`")
    // #233: the waiver is gone from the tool description too. A dispatch that
    // cannot run blocks success and only an honest failure may report it.
    expect(description).toContain("`review-blocked`")
    expect(description).toContain("`review-pending`")
    expect(description).not.toContain("`review-unavailable`")
    expect(description).not.toMatch(/explicitly skip review|strongly recommended/)
  })

  test("the reviewer must end with one machine-readable report envelope", async () => {
    const prompt = await readAgentPrompt("review.txt")

    expect(prompt).toContain("<silvercode-review>")
    expect(prompt).toContain('"version": 1')
    expect(prompt).toContain('"assessment"')
    expect(prompt).toContain('"findings"')
    expect(prompt).toContain("zero findings is a valid report")
    // Multiple envelopes are tolerated by protocol: the last complete one is
    // canonical. The prompt keeps "exactly one" as the instruction while
    // documenting the runtime's last-wins behavior.
    expect(prompt).toContain("last complete envelope")
    // The envelope must not be demonstrated inside a fence, or the model may
    // emit an unparseable fenced copy.
    expect(prompt).not.toMatch(/```[\s\S]*<silvercode-review>/)
  })

  test("the review loop documents envelope delivery and the re-dispatch path", async () => {
    const prompt = await readPrompt("review-loop.txt")

    expect(prompt).toContain("<silvercode-review>")
    expect(prompt).toContain("review-delivery failure")
    expect(prompt).toContain("re-dispatch the review")
  })

  test("the task tool extracts the report from the complete child output", async () => {
    const task = await readTool("task.ts")

    // The review branch must extract the envelope from the whole response and
    // fail delivery explicitly, instead of returning the last text part. Which
    // dispatched names take that branch is not asserted here: it is the shared
    // reviewer set's job, covered behaviourally by
    // review-specialization.test.ts for every name in that set.
    expect(task).toContain("ReviewReport.extract")
    expect(task).toContain("ReviewReport.failureMessage")
  })

  test("finish evaluates persisted history and fails the tool call when the gate blocks", async () => {
    const finish = await readTool("finish.ts")

    expect(finish).toContain("ctx.waitForOtherTools ?? Effect.void")
    expect(finish).toContain(".messages({ sessionID: ctx.sessionID })")
    expect(finish).toContain(
      'return yield* Effect.fail(new ToolFailure({ message: outcome.feedback ?? "Review required." }))',
    )
    expect(finish).not.toContain("Effect.orDie")
    expect(finish).not.toContain('termination: "blocked"')
  })

  test("file-writing tools advertise writes-files metadata", () => {
    expect(EditTool.metadata).toEqual({ writesFiles: true })
    expect(WriteTool.metadata).toEqual({ writesFiles: true })
    expect(ApplyPatchTool.metadata).toEqual({ writesFiles: true })
  })
})

describe("runtime review gate", () => {
  test("parses the last explicit review verdict without depending on one markdown shape", () => {
    expect(parseReviewVerdict("### Assessment\n\n**Ready to proceed?** Approved")).toBe("approved")
    expect(parseReviewVerdict("Assessment: Approved")).toBe("approved")
    expect(parseReviewVerdict("- Verdict — Needs fixes")).toBe("needs-fixes")
    expect(
      parseReviewVerdict("### Prior assessment\n\nAssessment: Approved\n\n### Assessment\n\nAssessment: Needs fixes"),
    ).toBe("needs-fixes")
    expect(parseReviewVerdict("Assessment: [Approved | Needs fixes]")).toBeUndefined()
    expect(parseReviewVerdict("Assessment: Approved (no Needs fixes remain)")).toBe("approved")
    expect(parseReviewVerdict("The implementation looks good, but no final assessment was emitted.")).toBeUndefined()
  })

  test("the report envelope in the task output is the canonical verdict", () => {
    const envelope = [
      "<silvercode-review>",
      JSON.stringify({ version: 1, revision: "uncommitted", assessment: "approved", summary: "clean", findings: [] }),
      "</silvercode-review>",
    ].join("\n")
    expect(parseReviewVerdict(`Assessment: Needs fixes\n\n${envelope}`)).toBe("approved")
  })

  test("the metadata report survives output truncation", () => {
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      reviewMessage("### Assessment\n\n**Ready to pro", {
        metadata: {
          review: {
            report: { version: 1, revision: "uncommitted", assessment: "approved", summary: "clean", findings: [] },
          },
        },
      }),
    ])

    expect(state.verdict).toBe("approved")
    expect(finishGateError(state)).toBeUndefined()
  })

  test("a detected-but-invalid envelope is not rescued as a prose verdict", () => {
    // The output carries a broken envelope plus a contradicting prose
    // assessment: the delivery failed, so no verdict may be minted from the
    // surrounding prose and the finish gate must ask for a fresh review.
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      reviewMessage(`Assessment: Approved\n\n<silvercode-review>{ not json </silvercode-review>`),
    ])

    expect(state.verdict).toBe("pending")
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  test("allows no-tool turns to finish without review", () => {
    const state = reviewLoopState([userMessage()])

    expect(state.verdict).toBe("none")
    expect(finishGateError(state)).toBeUndefined()
  })

  test("allows read-only tool turns to finish without review", () => {
    expect(reviewLoopState([userMessage(), toolMessage("read")]).verdict).toBe("none")
    expect(reviewLoopState([userMessage(), toolMessage("bash")]).verdict).toBe("none")
    expect(reviewLoopState([userMessage(), toolMessage("grep")]).verdict).toBe("none")
    expect(reviewLoopState([userMessage(), toolMessage("future_writer")]).verdict).toBe("none")
    expect(finishGateError(reviewLoopState([userMessage(), toolMessage("bash")]))).toBeUndefined()
  })

  test("nudges review for tools that declare file writes even when no review exists yet", () => {
    for (const tool of ["edit", "write", "apply_patch", "future_writer"]) {
      const state = reviewLoopState([userMessage(), toolMessage(tool, { writesFiles: true })])
      expect(state.verdict).toBe("pending")
      expect(state.nudged).toBe(false)
      expect(finishGateError(state)).toBeInstanceOf(Error)
      expect(finishGateError(state)?.message).toContain('`subagent_type: "review"`')
    }
  })

  // Yielding for a background subagent is not a terminal result: the run is
  // still in flight through its children, so the transcript must not record a
  // termination and the nudge stays armed for the finish that really ends it.
  //
  // These are evaluator fixtures, not a live wait: they pin what the loop reads
  // out of a transcript that contains a waiting finish part. That such a part
  // can exist at all, and what the tool returns for it, is guaranteed by
  // `test/tool/finish.test.ts`; here the counter-case keeps the fixture honest
  // by showing the evaluator does read a terminal finish's metadata.
  test("a waiting finish leaves no termination and keeps the review gate armed", () => {
    const state = reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), waitingFinishMessage()])

    expect(state.termination).toBeUndefined()
    expect(state.nudged).toBe(false)
    expect(state.verdict).toBe("pending")
    expect(finishGateError(state)).toBeInstanceOf(Error)

    const terminal = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      finishPart({ reason: "success", result: "done" }, { review: { termination: "approved" } }),
    ])
    expect(terminal.termination).toBe("approved")
    expect(terminal.nudged).toBe(false)
  })

  test("declines a second finish call after a decline instead of skipping review", () => {
    const state = reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), finishNudgeMessage()])

    expect(state.verdict).toBe("pending")
    expect(state.nudged).toBe(true)
    expect(finishGateError(state)?.message).toContain("retrying finish does not skip review")
  })

  test("declines a second finish call after needs-fixes findings instead of skipping review", () => {
    const findings = reviewMessage("### Assessment\n\n**Ready to proceed?** Needs fixes")
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      findings,
      finishNudgeMessage(),
    ])

    expect(state.verdict).toBe("needs-fixes")
    expect(state.nudged).toBe(true)
    expect(finishGateError(state)?.message).toContain("returned Needs fixes")
    expect(finishGateError(state)?.message).toContain("retrying finish does not skip review")
  })

  test("new file writes after a decline start a fresh decline", () => {
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      finishNudgeMessage(),
      toolMessage("edit", { writesFiles: true }),
    ])

    expect(state.nudged).toBe(false)
    expect(finishGateError(state)).toBeInstanceOf(Error)
    expect(finishGateError(state)?.message).not.toContain("retrying finish does not skip review")
  })

  test("a review after a decline resets it and is honoured", () => {
    const findings = reviewMessage("### Assessment\n\n**Ready to proceed?** Needs fixes")
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      finishNudgeMessage(),
      findings,
    ])

    expect(state.nudged).toBe(false)
    expect(state.verdict).toBe("needs-fixes")
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  test("does not carry a decline across user turns", () => {
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      finishNudgeMessage(),
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
    ])

    expect(state.nudged).toBe(false)
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  // Finish no longer records `skipped`, but a transcript persisted before #231
  // keeps the outcome it recorded.
  test("still surfaces a legacy skipped termination from a completed finish", () => {
    const skipped = {
      info: { role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "finish",
          state: { status: "completed", input: {}, output: "done", metadata: { review: { termination: "skipped" } } },
        },
      ],
    } as unknown as SessionV1.WithParts

    expect(
      reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), finishNudgeMessage(), skipped])
        .termination,
    ).toBe("skipped")
  })

  test("requires an explicit synchronous review", () => {
    const background = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved", { background: true })
    const synchronous = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")
    // The third arm is the one the first two cannot express: the input still says
    // "wait", and the outcome says otherwise. Synchronous execution is a per-agent
    // opt-in, so a `background: false` request that the agent did not opt into
    // comes back as a launch, and the gate has to judge the effective mode.
    const launched = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved", { delivery: true })

    expect(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), background]).verdict).toBe(
      "pending",
    )
    expect(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), synchronous]).verdict).toBe(
      "approved",
    )
    expect(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), launched]).verdict).toBe(
      "pending",
    )
  })

  // A review that ran detached from the parent - launched in the background by the
  // agent's configuration, or promoted out of a wait that started in the foreground
  // - persists as a *completed* tool part carrying a running envelope. Nothing was
  // delivered, so it must neither count toward the review cap nor clear the
  // unreviewed-work gate, and it must not mint a verdict.
  const LAUNCH_ENVELOPE = [
    '<task id="ses_review" state="running">',
    "<summary>Background task started: review cache fix</summary>",
    "</task>",
  ].join("\n")

  const launch = (output = LAUNCH_ENVELOPE, metadata: Record<string, unknown> = {}) =>
    reviewMessage(output, { delivery: true, metadata: { jobId: "ses_review", ...metadata } })

  test("a review launched instead of awaited is not a delivered review", () => {
    const state = reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), launch()])

    expect(state.reviews).toBe(0)
    expect(state.workSinceReview).toBe(true)
    expect(state.phase).toBe("work")
    expect(state.verdict).toBe("pending")
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  test("launches do not walk the turn to the review cap", () => {
    // The cap disarms the gate, so counting launches would let a model finish
    // unreviewed work by asking for a verdict three times and never waiting for
    // one - the failure the cancelled-review rule already refuses.
    const state = reviewLoopState(
      [userMessage(), toolMessage("edit", { writesFiles: true }), launch(), launch(), launch()],
      2,
    )

    expect(state.reviews).toBe(0)
    expect(state.verdict).toBe("pending")
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  test("a launch mints no verdict from its own envelope text", () => {
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      launch(`${LAUNCH_ENVELOPE}\n\n### Assessment\n\n**Ready to proceed?** Approved`),
    ])

    expect(state.reviews).toBe(0)
    expect(state.verdict).toBe("pending")
    expect(state.workSinceReview).toBe(true)
  })

  test("a report on a detached part does not satisfy the gate without a foreground delivery", () => {
    // The verdict of a launched review reaches the parent as a later notification,
    // not as this part's result; the gate stays a foreground contract.
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      launch(LAUNCH_ENVELOPE, {
        review: { report: { version: 1, assessment: "approved", summary: "Clean.", findings: [] } },
      }),
    ])

    expect(state.reviews).toBe(0)
    expect(state.verdict).toBe("pending")
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  // A completed part carrying a real report, i.e. the delivery a foreground review
  // produces; only the two mode axes vary between the arms below.
  const WITH_REPORT = {
    metadata: {
      sessionId: "ses_review",
      review: { report: { version: 1, assessment: "approved", summary: "Clean.", findings: [] } },
    },
  }

  // The recorded mode is the authority, which has to hold in both directions. An
  // omitted argument on an opted-in agent is the shape the opt-in exists to
  // produce: the model dispatches `review`, says nothing about waiting, and the
  // configured reviewer hands the verdict back in this turn. Losing that would
  // leave a real, configured, foreground review uncounted - an armed gate over
  // work that was in fact reviewed.
  test("counts a configured foreground review whose caller omitted the argument", () => {
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      reviewMessage("### Assessment\n\n**Ready to proceed?** Approved", {
        background: "omitted",
        delivery: false,
        ...WITH_REPORT,
      }),
    ])

    expect(state.reviews).toBe(1)
    expect(state.verdict).toBe("approved")
    expect(state.workSinceReview).toBe(false)
    expect(finishGateError(state)).toBeUndefined()
  })

  test("an omitted request that ran in the background is not a delivered review", () => {
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      reviewMessage(LAUNCH_ENVELOPE, { background: "omitted", delivery: true }),
    ])

    expect(state.reviews).toBe(0)
    expect(state.workSinceReview).toBe(true)
    expect(state.verdict).toBe("pending")
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  test("the same report delivered in the foreground still counts", () => {
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      reviewMessage(LAUNCH_ENVELOPE.replace('state="running"', 'state="completed"'), {
        delivery: false,
        ...WITH_REPORT,
      }),
    ])

    expect(state.reviews).toBe(1)
    expect(state.verdict).toBe("approved")
    expect(state.workSinceReview).toBe(false)
    expect(finishGateError(state)).toBeUndefined()
  })

  // A transcript from before the mode was recorded carries only the request, and
  // back then the request was the outcome: this is why the fallback is safe
  // rather than merely tolerant.
  test("a transcript with no recorded mode is judged on its request", () => {
    const asked = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved", WITH_REPORT)
    const silent = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved", {
      background: "omitted",
      ...WITH_REPORT,
    })

    expect(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), asked]).reviews).toBe(1)
    expect(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), asked]).verdict).toBe("approved")
    expect(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), silent]).reviews).toBe(0)
    expect(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), silent]).verdict).toBe("pending")
  })

  test("does not treat a synthetic continuation nudge as a new turn", () => {
    const approved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      approved,
      syntheticNudge(),
    ])

    expect(state.verdict).toBe("approved")
  })

  test("forces two work/review cycles when the first review finds fixes", () => {
    const findings = reviewMessage("### Assessment\n\n**Ready to proceed?** Needs fixes")
    const fixed = toolMessage("edit", { writesFiles: true })
    const approved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")

    const firstCycle = reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), findings])
    const secondCycle = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      findings,
      fixed,
      approved,
    ])

    expect(firstCycle.reviews).toBe(1)
    expect(firstCycle.verdict).toBe("needs-fixes")
    expect(finishGateError(firstCycle)).toBeInstanceOf(Error)
    expect(secondCycle.reviews).toBe(2)
    expect(secondCycle.verdict).toBe("approved")
    expect(finishGateError(secondCycle)).toBeUndefined()
  })

  test("ignores earlier user turns when deriving the current review gate", () => {
    const earlierApproved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")
    const earlierTurn = [userMessage(), toolMessage("edit", { writesFiles: true }), earlierApproved]
    const currentTurn = [userMessage(), toolMessage("edit", { writesFiles: true })]
    const state = reviewLoopState([...earlierTurn, ...currentTurn])

    expect(state.reviews).toBe(0)
    expect(state.verdict).toBe("pending")
  })

  test("requires review only for declared file-writing tools", () => {
    const approved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")

    expect(
      reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), approved, toolMessage("read")])
        .verdict,
    ).toBe("approved")
    expect(
      reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), approved, toolMessage("read")])
        .verdict,
    ).toBe("approved")
    expect(
      reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), approved, toolMessage("bash")])
        .verdict,
    ).toBe("approved")
    expect(
      reviewLoopState([
        userMessage(),
        toolMessage("edit", { writesFiles: true }),
        approved,
        toolMessage("edit", { writesFiles: true }),
      ]).verdict,
    ).toBe("pending")
    expect(
      finishGateError(
        reviewLoopState([
          userMessage(),
          toolMessage("edit", { writesFiles: true }),
          approved,
          toolMessage("edit", { writesFiles: true }),
        ]),
      ),
    ).toBeInstanceOf(Error)
  })

  test("stops at the configured cap after completed non-approval reviews", () => {
    const findings = reviewMessage("### Assessment\n\n**Ready to proceed?** Needs fixes")
    const secondFindings = reviewMessage("### Assessment\n\n**Ready to proceed?** Needs fixes")

    const state = reviewLoopState(
      [
        userMessage(),
        toolMessage("edit", { writesFiles: true }),
        findings,
        toolMessage("edit", { writesFiles: true }),
        secondFindings,
      ],
      2,
    )

    expect(state.verdict).toBe("cap")
    expect(state.reviews).toBe(2)
    expect(state.maxIterations).toBe(2)
    expect(finishGateError(state)).toBeUndefined()
  })

  test("ignores a cancelled review instead of counting it as a delivered one", () => {
    const approved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")
    const cancelled = reviewMessage("", { metadata: { termination: { reason: "cancelled" } } })

    // A cancelled review that follows an approval leaves that approval intact.
    const stillApproved = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      approved,
      cancelled,
    ])
    expect(stillApproved.verdict).toBe("approved")
    expect(stillApproved.reviews).toBe(1)
    expect(finishGateError(stillApproved)).toBeUndefined()

    // Cancellations must not pile up into the iteration cap and silently
    // disable the gate: each one is a non-event.
    const cancelledTwice = reviewLoopState(
      [
        userMessage(),
        toolMessage("edit", { writesFiles: true }),
        cancelled,
        toolMessage("edit", { writesFiles: true }),
        cancelled,
      ],
      2,
    )
    expect(cancelledTwice.reviews).toBe(0)
    expect(cancelledTwice.verdict).toBe("pending")
    expect(finishGateError(cancelledTwice)).toBeInstanceOf(Error)
  })

  test("does not treat an incomplete or malformed review as approval", () => {
    const running = reviewMessage("", { status: "running" })
    const malformed = reviewMessage("review failed before producing an assessment")

    expect(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), running]).verdict).toBe(
      "pending",
    )
    expect(
      finishGateError(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), running])),
    ).toBeInstanceOf(Error)
    expect(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), malformed]).verdict).toBe(
      "pending",
    )
    expect(
      finishGateError(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), malformed])),
    ).toBeInstanceOf(Error)
  })
})
