/** @jsxImportSource @opentui/solid */
// Explicit, currently failing diagnostic for #793's unresolved cross-message
// presentation choice. These assertions are intentionally not skipped: the draft remains red
// until the transcript/history semantics are resolved.
import { afterEach, expect, test } from "bun:test"
import { ReviewReport } from "@opencode-ai/core/review-report"
import { resultChunks } from "../../../../opencode/src/session/subagent-result"
import FINISH_NUDGE from "../../../../opencode/src/session/prompt/finish-nudge.txt"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { assistantMessage, userMessage, sessionInfo, textPart, mountSessionRoute, disposeSessionRoutes, spansOf } from "../../fixture/session-route"
import { waitFor } from "../../fixture/frame"

afterEach(disposeSessionRoutes)
const SESSION = "ses_review_history_synthetic"
const old = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "Earlier synthetic approval", findings: [] })
const latest = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "needs-fixes", summary: "Later synthetic finding", findings: [] })

async function frame(kind: "text" | "finish", nudged = false) {
  const user = userMessage("msg_001", SESSION, { agent: "review" })
  const first = assistantMessage("msg_002", SESSION, { agent: "review", mode: "review", parentID: user.id, time: { created: 1_700_000_001_000, completed: 1_700_000_002_000 } })
  const second = assistantMessage("msg_004", SESSION, { agent: "review", mode: "review", parentID: nudged ? "msg_003" : user.id, time: { created: 1_700_000_010_000, completed: 1_700_000_011_000 } })
  const finish: ToolPart = {
    id: "finish", sessionID: SESSION, messageID: second.id, type: "tool", tool: "finish", callID: "finish_call",
    state: { status: "completed", input: { reason: "success", result: latest }, output: latest, title: "finish", metadata: {}, time: { start: 1, end: 2 } },
  }
  const nudge = userMessage("msg_003", SESSION, { agent: "review", time: { created: 1_700_000_005_000 } })
  const entries = [
    { info: user, parts: [textPart("request", user, "Synthetic review request")] },
    { info: first, parts: [textPart("first", first, `Earlier analysis.\n${old}`)] },
    ...(nudged ? [{ info: nudge, parts: [{ ...textPart("nudge", nudge, FINISH_NUDGE), synthetic: true }] }] : []),
    { info: second, parts: [kind === "text" ? textPart("second", second, `Later analysis.\n${latest}`) : finish] },
  ]
  // Prove this fixture is one execution under the same collector the finish gate
  // and task delivery use, including ID ordering and an optional real nudge.
  const runtime = entries as unknown as SessionV1.WithParts[]
  const extracted = ReviewReport.extract([...resultChunks(runtime, runtime[runtime.length - 1]), kind === "finish" ? latest : undefined])
  expect(extracted.ok && extracted.report.assessment).toBe("needs-fixes")
  expect(extracted.ok && extracted.analysis).toContain("Earlier analysis.")
  const { app } = await mountSessionRoute({
    width: 120, height: 45, sessions: [sessionInfo(SESSION)],
    messages: { [SESSION]: entries },
  })
  await waitFor(app, () => app.captureCharFrame().includes("Later synthetic finding") ? true : undefined)
  return spansOf(app)
}

for (const kind of ["text", "finish"] as const) {
  test(`later ${kind} report must not leave an unqualified earlier approval as current`, async () => {
    const result = await frame(kind)
    expect(result).toContain("Earlier analysis.")
    expect(result).toContain("Later synthetic finding")
    expect(result).not.toContain("✓ Approved")
  })
}

for (const kind of ["text", "finish"] as const) {
  test(`a runner nudge does not turn a later ${kind} report into a separate execution`, async () => {
    const result = await frame(kind, true)
    expect(result).toContain("Earlier analysis.")
    expect(result).toContain("Later synthetic finding")
    expect(result).not.toContain("✓ Approved")
  })
}

test("distinct real requests keep their own review reports", async () => {
  const firstUser = userMessage("msg_001", SESSION, { agent: "review" })
  const first = assistantMessage("msg_002", SESSION, { agent: "review", mode: "review", parentID: firstUser.id, time: { created: 1_700_000_001_000, completed: 1_700_000_002_000 } })
  const secondUser = userMessage("msg_003", SESSION, { agent: "review", time: { created: 1_700_000_005_000 } })
  const second = assistantMessage("msg_004", SESSION, { agent: "review", mode: "review", parentID: secondUser.id, time: { created: 1_700_000_010_000, completed: 1_700_000_011_000 } })
  const entries = [
    { info: firstUser, parts: [textPart("request1", firstUser, "First review request")] },
    { info: first, parts: [textPart("first", first, `Earlier analysis.\n${old}`)] },
    { info: secondUser, parts: [textPart("request2", secondUser, "Second review request")] },
    { info: second, parts: [textPart("second", second, `Later analysis.\n${latest}`)] },
  ]
  const runtime = entries as unknown as SessionV1.WithParts[]
  expect(resultChunks(runtime, runtime[3])).toEqual([`Later analysis.\n${latest}`])
  const { app } = await mountSessionRoute({ width: 120, height: 50, sessions: [sessionInfo(SESSION)], messages: { [SESSION]: entries } })
  await waitFor(app, () => app.captureCharFrame().includes("Later synthetic finding") ? true : undefined)
  const result = await spansOf(app)
  expect(result).toContain("✓ Approved")
  expect(result).toContain("✗ Needs fixes")
  expect(result).toContain("Earlier analysis.")
})

test("a completed finish is an execution boundary even with the same user parent", async () => {
  const user = userMessage("msg_001", SESSION, { agent: "review" })
  const first = assistantMessage("msg_002", SESSION, { agent: "review", mode: "review", parentID: user.id, time: { created: 1_700_000_001_000, completed: 1_700_000_002_000 } })
  const second = assistantMessage("msg_003", SESSION, { agent: "review", mode: "review", parentID: user.id, time: { created: 1_700_000_010_000, completed: 1_700_000_011_000 } })
  const finish: ToolPart = {
    id: "finish_first", sessionID: SESSION, messageID: first.id, type: "tool", tool: "finish", callID: "first_call",
    state: { status: "completed", input: { reason: "success", result: old }, output: old, title: "finish", metadata: {}, time: { start: 1, end: 2 } },
  }
  const entries = [
    { info: user, parts: [textPart("request", user, "Synthetic review request")] },
    { info: first, parts: [textPart("first", first, `Earlier analysis.\n${old}`), finish] },
    { info: second, parts: [textPart("second", second, `Later analysis.\n${latest}`)] },
  ]
  const runtime = entries as unknown as SessionV1.WithParts[]
  expect(resultChunks(runtime, runtime[2])).toEqual([`Later analysis.\n${latest}`])
  const { app } = await mountSessionRoute({ width: 120, height: 45, sessions: [sessionInfo(SESSION)], messages: { [SESSION]: entries } })
  await waitFor(app, () => app.captureCharFrame().includes("Later synthetic finding") ? true : undefined)
  const result = await spansOf(app)
  expect(result).toContain("✓ Approved")
  expect(result).toContain("✗ Needs fixes")
  expect(result).toContain("Earlier analysis.")
})
