/** @jsxImportSource @opentui/solid */
// Explicit, currently failing diagnostic for #793's unresolved cross-message
// presentation choice. These assertions are intentionally not skipped: the draft remains red
// until the transcript/history semantics are resolved.
import { afterEach, expect, test } from "bun:test"
import { ReviewReport } from "@opencode-ai/core/review-report"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { assistantMessage, userMessage, sessionInfo, textPart, mountSessionRoute, disposeSessionRoutes, spansOf } from "../../fixture/session-route"
import { waitFor } from "../../fixture/frame"

afterEach(disposeSessionRoutes)
const SESSION = "ses_review_history_synthetic"
const old = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "Earlier synthetic approval", findings: [] })
const latest = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "needs-fixes", summary: "Later synthetic finding", findings: [] })

async function frame(kind: "text" | "finish") {
  const user = userMessage("msg_user", SESSION, { agent: "review" })
  const first = assistantMessage("msg_first", SESSION, { agent: "review", mode: "review", parentID: user.id, time: { created: 1_700_000_001_000, completed: 1_700_000_002_000 } })
  const second = assistantMessage("msg_second", SESSION, { agent: "review", mode: "review", parentID: user.id, time: { created: 1_700_000_010_000, completed: 1_700_000_011_000 } })
  const finish: ToolPart = {
    id: "finish", sessionID: SESSION, messageID: second.id, type: "tool", tool: "finish", callID: "finish_call",
    state: { status: "completed", input: { reason: "success", result: latest }, output: latest, title: "finish", metadata: {}, time: { start: 1, end: 2 } },
  }
  const { app } = await mountSessionRoute({
    width: 120, height: 45, sessions: [sessionInfo(SESSION)],
    messages: { [SESSION]: [
      { info: user, parts: [textPart("request", user, "Synthetic review request")] },
      { info: first, parts: [textPart("first", first, `Earlier analysis.\n${old}`)] },
      { info: second, parts: [kind === "text" ? textPart("second", second, `Later analysis.\n${latest}`) : finish] },
    ] },
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
