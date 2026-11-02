/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { ReviewReport } from "@opencode-ai/core/review-report"
import { assistantMessage, userMessage, textPart, sessionInfo, mountSessionRoute, disposeSessionRoutes } from "../../fixture/session-route"

afterEach(disposeSessionRoutes)

test("session shares history discovery across reviewer rows", async () => {
  const session = "ses_synthetic_scale"
  const count = 32
  const report = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "Synthetic scale report", findings: [] })
  const entries = Array.from({ length: count }, (_, i) => {
    const request = userMessage(`msg_${String(i * 2).padStart(3, "0")}`, session, { agent: "review", time: { created: 1700000000000 + i * 10000 } })
    const reply = assistantMessage(`msg_${String(i * 2 + 1).padStart(3, "0")}`, session, { agent: "review", mode: "review", parentID: request.id, time: { created: 1700000001000 + i * 10000, completed: 1700000002000 + i * 10000 } })
    return [{ info: request, parts: [textPart(`q_${i}`, request, "Synthetic request")] }, { info: reply, parts: [textPart(`a_${i}`, reply, report)] }]
  }).flat()
  let sorts = 0
  const original = Array.prototype.sort
  Array.prototype.sort = function (...args: Parameters<typeof original>) {
    if (this.length === count * 2 && this.every((entry: any) => entry && entry.info && Array.isArray(entry.parts))) sorts++
    return original.apply(this, args as any)
  }
  try {
    await mountSessionRoute({ width: 100, height: 35, sessions: [sessionInfo(session)], messages: { [session]: entries } })
  } finally {
    Array.prototype.sort = original
  }
  // Counts only whole-history entry sorts (not elapsed time): one shared
  // discovery should not repeat a collector search for every rendered row.
  expect(sorts).toBeGreaterThan(0)
  expect(sorts).toBeLessThanOrEqual(count * 3 + 5)
  console.info(`review scale probe: ${count} reviewer rows, ${sorts} whole-history sorts`)
})
