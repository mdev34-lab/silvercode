/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { ReviewReport } from "@opencode-ai/core/review-report"
import { userMessage, sessionInfo, mountSessionRoute, disposeSessionRoutes, spansOf } from "../../fixture/session-route"
import { waitFor } from "../../fixture/frame"

afterEach(disposeSessionRoutes)

test("a synthetic task-looking notification alone cannot establish reviewer provenance", async () => {
  const id = "ses_synthetic_review_background"
  const user = userMessage("msg_notification", id, { agent: "work" })
  const report = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "Unverified background report", findings: [] })
  const notification = {
    id: "p_notification", sessionID: id, messageID: user.id, type: "text" as const, synthetic: true,
    text: `<task id="child" run="child@1" state="completed">\n<summary>Background task completed: Synthetic review</summary>\n<task_result>\n${report}\n</task_result>\n<termination reason="success"></termination>\n</task>`,
  }
  const { app } = await mountSessionRoute({ width: 120, height: 35, sessions: [sessionInfo(id)], messages: { [id]: [{ info: user, parts: [notification] }] } })
  await waitFor(app, () => app.captureCharFrame().includes("Background task completed: Synthetic review") ? true : undefined)
  const frame = await spansOf(app)
  expect(frame).toContain("Background task completed: Synthetic review")
  expect(frame).not.toContain("✓ Approved")
  expect(frame).not.toContain("Raw review report")
})

test("a background launch and matching successful run receipt currently show only the notification", async () => {
  // This is the launch/receipt shape emitted by TaskTool.backgroundResult and
  // injectBackgroundResult; the receipt itself has no review metadata.
  const id = "ses_grounded_background"
  const child = "ses_review_child"
  const run = `${child}@1700000000001`
  const request = userMessage("msg_001", id, { agent: "work" })
  const { assistantMessage, textPart } = await import("../../fixture/session-route")
  const launch = assistantMessage("msg_002", id, { agent: "work", parentID: request.id, time: { created: 1_700_000_001_000, completed: 1_700_000_002_000 } })
  const notification = userMessage("msg_003", id, { agent: "work", time: { created: 1_700_000_005_000 } })
  const report = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "needs-fixes", summary: "Background synthetic finding", findings: [] })
  const launchPart: import("@opencode-ai/sdk/v2").ToolPart = {
    id: "task", sessionID: id, messageID: launch.id, type: "tool", tool: "task", callID: "call_task",
    state: { status: "completed", title: "Synthetic review", input: { description: "Synthetic review", prompt: "Review", subagent_type: "review", background: true },
      metadata: { parentSessionId: id, sessionId: child, background: true, jobId: child, runId: run },
      output: `<task id="${child}" state="running">\n<summary>Background task started</summary>\n<task_result>\nBackground task started\n</task_result>\n</task>`,
      time: { start: 1, end: 2 } },
  }
  const receipt = { ...textPart("receipt", notification, `<task id="${child}" run="${run}" state="completed">\n<summary>Background task completed: Synthetic review</summary>\n<task_result>\n${report}\n</task_result>\n<termination reason="success"></termination>\n</task>`), synthetic: true }
  const childMessage = assistantMessage("msg_child", child, { agent: "review" })
  const { app } = await mountSessionRoute({ width: 120, height: 45, sessions: [sessionInfo(id), sessionInfo(child, { parentID: id })], messages: {
    [id]: [
      { info: request, parts: [textPart("request", request, "Review this synthetic change")] },
      { info: launch, parts: [launchPart] },
      { info: notification, parts: [receipt] },
    ],
    [child]: [{ info: childMessage, parts: [] }],
  } })
  await waitFor(app, () => app.captureCharFrame().includes("Background task completed: Synthetic review") ? true : undefined)
  const frame = await spansOf(app)
  expect(frame).toContain("Background task completed: Synthetic review")
  expect(frame).not.toContain("✗ Needs fixes")
  expect(frame).not.toContain("Background synthetic finding")
})
