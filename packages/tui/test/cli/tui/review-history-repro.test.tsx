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

test("a report split across assistant messages follows the runtime newline join", async () => {
  const user = userMessage("msg_001", SESSION, { agent: "review" })
  const first = assistantMessage("msg_002", SESSION, { agent: "review", mode: "review", parentID: user.id, time: { created: 1_700_000_001_000, completed: 1_700_000_002_000 } })
  const second = assistantMessage("msg_003", SESSION, { agent: "review", mode: "review", parentID: user.id, time: { created: 1_700_000_010_000, completed: 1_700_000_011_000 } })
  const [opening, ...body] = latest.split("\n")
  const entries = [
    { info: user, parts: [textPart("request", user, "Synthetic review request")] },
    { info: first, parts: [textPart("first", first, `Earlier analysis.\n${opening}`)] },
    { info: second, parts: [textPart("second", second, body.join("\n"))] },
  ]
  const runtime = entries as unknown as SessionV1.WithParts[]
  const canonical = ReviewReport.extract(resultChunks(runtime, runtime[2]))
  expect(canonical.ok && canonical.report.assessment).toBe("needs-fixes")
  const { app } = await mountSessionRoute({ width: 120, height: 45, sessions: [sessionInfo(SESSION)], messages: { [SESSION]: entries } })
  await waitFor(app, () => app.captureCharFrame().includes("Later synthetic finding") ? true : undefined)
  const result = await spansOf(app)
  expect(result).toContain("Earlier analysis.")
  expect(result).toContain("✗ Needs fixes")
})

test("a malformed later report cannot leave an earlier approval as current", async () => {
  const user = userMessage("msg_001", SESSION, { agent: "review" })
  const first = assistantMessage("msg_002", SESSION, { agent: "review", mode: "review", parentID: user.id, time: { created: 1_700_000_001_000, completed: 1_700_000_002_000 } })
  const second = assistantMessage("msg_003", SESSION, { agent: "review", mode: "review", parentID: user.id, time: { created: 1_700_000_010_000, completed: 1_700_000_011_000 } })
  const invalid = "<silvercode-review>{invalid}</silvercode-review>"
  const entries = [
    { info: user, parts: [textPart("request", user, "Synthetic review request")] },
    { info: first, parts: [textPart("first", first, `Earlier analysis.\n${old}`)] },
    { info: second, parts: [textPart("second", second, `Malformed later report.\n${invalid}`)] },
  ]
  const runtime = entries as unknown as SessionV1.WithParts[]
  expect(ReviewReport.extract(resultChunks(runtime, runtime[2])).ok).toBe(false)
  const { app } = await mountSessionRoute({ width: 120, height: 45, sessions: [sessionInfo(SESSION)], messages: { [SESSION]: entries } })
  await waitFor(app, () => app.captureCharFrame().includes("Malformed later report.") ? true : undefined)
  const result = await spansOf(app)
  expect(result).toContain("Earlier analysis.")
  expect(result).toContain("Malformed later report.")
  expect(result).not.toContain("✓ Approved")
})

test("execution report preserves prose positions and exposes the full original text", async () => {
  const user = userMessage("msg_001", SESSION, { agent: "review" })
  const first = assistantMessage("msg_002", SESSION, { agent: "review", mode: "review", parentID: user.id, time: { created: 1_700_000_001_000, completed: 1_700_000_002_000 } })
  const second = assistantMessage("msg_003", SESSION, { agent: "review", mode: "review", parentID: user.id, time: { created: 1_700_000_010_000, completed: 1_700_000_011_000 } })
  const entries = [
    { info: user, parts: [textPart("request", user, "Synthetic review request")] },
    { info: first, parts: [textPart("first", first, `Earlier analysis.\n${old}\nEarlier follow-up.`)] },
    { info: second, parts: [textPart("second", second, `Later analysis.\n${latest}\nLater follow-up.`)] },
  ]
  const { app } = await mountSessionRoute({ width: 120, height: 70, sessions: [sessionInfo(SESSION)], messages: { [SESSION]: entries } })
  await waitFor(app, () => app.captureCharFrame().includes("Later synthetic finding") ? true : undefined)
  const before = await spansOf(app)
  expect(before.indexOf("Earlier analysis.")).toBeLessThan(before.indexOf("Earlier follow-up."))
  expect(before.indexOf("Earlier follow-up.")).toBeLessThan(before.indexOf("Later analysis."))
  expect(before.indexOf("Later analysis.")).toBeLessThan(before.indexOf("Later follow-up."))
  expect(before).not.toContain("Earlier synthetic approval")
  const row = before.split("\n").findIndex((line) => line.includes("Raw review report"))
  expect(row).toBeGreaterThanOrEqual(0)
  await app.mockMouse.click(5, row)
  await waitFor(app, () => app.captureCharFrame().includes("Earlier synthetic approval") ? true : undefined)
  const after = await spansOf(app)
  expect(after).toContain("Earlier synthetic approval")
  expect(after).toContain("Later synthetic finding")
  expect(after).toContain("Earlier follow-up.")
})

test("an incomplete later tag cannot present an earlier approval as current", async () => {
  const user = userMessage("msg_001", SESSION, { agent: "review" })
  const first = assistantMessage("msg_002", SESSION, { agent: "review", mode: "review", parentID: user.id, time: { created: 1_700_000_001_000, completed: 1_700_000_002_000 } })
  const second = assistantMessage("msg_003", SESSION, { agent: "review", mode: "review", parentID: user.id, time: { created: 1_700_000_010_000, completed: 1_700_000_011_000 } })
  const entries = [
    { info: user, parts: [textPart("request", user, "Synthetic review request")] },
    { info: first, parts: [textPart("first", first, `Earlier analysis.\n${old}`)] },
    { info: second, parts: [textPart("second", second, "Incomplete later report.\n<silvercode-review")] },
  ]
  const { app } = await mountSessionRoute({ width: 120, height: 45, sessions: [sessionInfo(SESSION)], messages: { [SESSION]: entries } })
  await waitFor(app, () => app.captureCharFrame().includes("Incomplete later report.") ? true : undefined)
  const result = await spansOf(app)
  expect(result).toContain("Earlier analysis.")
  expect(result).toContain("Incomplete later report.")
  expect(result).not.toContain("✓ Approved")
})

test("a truncated nudge chain stays on the raw path without a verdict", async () => {
  const nudge = userMessage("msg_001", SESSION, { agent: "review" })
  const first = assistantMessage("msg_002", SESSION, { agent: "review", mode: "review", parentID: nudge.id, time: { created: 1_700_000_001_000, completed: 1_700_000_002_000 } })
  const second = assistantMessage("msg_003", SESSION, { agent: "review", mode: "review", parentID: nudge.id, time: { created: 1_700_000_010_000, completed: 1_700_000_011_000 } })
  const entries = [
    { info: nudge, parts: [{ ...textPart("nudge", nudge, FINISH_NUDGE), synthetic: true }] },
    { info: first, parts: [textPart("first", first, `Earlier analysis.\n${old}`)] },
    { info: second, parts: [textPart("second", second, `Later analysis.\n${latest}`)] },
  ]
  const { app } = await mountSessionRoute({ width: 120, height: 55, sessions: [sessionInfo(SESSION)], messages: { [SESSION]: entries } })
  await waitFor(app, () => app.captureCharFrame().includes("Later synthetic finding") ? true : undefined)
  const result = await spansOf(app)
  expect(result).toContain("Earlier analysis.")
  expect(result).toContain("Later analysis.")
  expect(result).not.toContain("✓ Approved")
  expect(result).not.toContain("✗ Needs fixes")
})

test("a streaming continuation remains raw until its execution completes", async () => {
  const user = userMessage("msg_001", SESSION, { agent: "review" })
  const first = assistantMessage("msg_002", SESSION, { agent: "review", mode: "review", parentID: user.id, time: { created: 1_700_000_001_000, completed: 1_700_000_002_000 } })
  const second = assistantMessage("msg_003", SESSION, { agent: "review", mode: "review", parentID: user.id, time: { created: 1_700_000_010_000 } })
  const entries = [
    { info: user, parts: [textPart("request", user, "Synthetic review request")] },
    { info: first, parts: [textPart("first", first, `Earlier analysis.\n${old}`)] },
    { info: second, parts: [textPart("second", second, "Streaming continuation.\n<silvercode-review>{")] },
  ]
  const { app, sync } = await mountSessionRoute({ width: 120, height: 50, sessions: [sessionInfo(SESSION)], messages: { [SESSION]: entries } })
  await waitFor(app, () => app.captureCharFrame().includes("Streaming continuation.") ? true : undefined)
  expect(await spansOf(app)).not.toContain("✓ Approved")
  sync.set("part", second.id, [textPart("second", second, `Later analysis.\n${latest}`)])
  sync.set("message", SESSION, (item) => item.id === second.id, "time", { created: 1_700_000_010_000, completed: 1_700_000_011_000 })
  await waitFor(app, () => app.captureCharFrame().includes("✗ Needs fixes") ? true : undefined)
  const completed = await spansOf(app)
  expect(completed).toContain("Earlier analysis.")
  expect(completed).toContain("Later analysis.")
  expect(completed).not.toContain("✓ Approved")
})
