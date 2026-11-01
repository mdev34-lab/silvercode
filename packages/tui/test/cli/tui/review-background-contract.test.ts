import { expect, test } from "bun:test"
import { ReviewReport } from "@opencode-ai/core/review-report"
import type { Part, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { backgroundReview } from "../../../src/routes/session/review-text"
import { userMessage, assistantMessage, sessionInfo } from "../../fixture/session-route"

const parent = "ses_parent"
const child = "ses_child"
const run = `${child}@1234`
const request = userMessage("msg_001", parent)
const assistant = assistantMessage("msg_002", parent, { parentID: request.id })
const notification = userMessage("msg_003", parent)
const report = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "Synthetic approval", findings: [] })
const output = (id = child, runID = run, body = report, end = '<termination reason="success"></termination>\n</task>') =>
  `<task id="${id}" run="${runID}" state="completed">\n<summary>Background task completed: Review</summary>\n<task_result>\n${body}\n</task_result>\n${end}`
const launch: ToolPart = { id: "launch", sessionID: parent, messageID: assistant.id, type: "tool", tool: "task", callID: "call", state: {
  status: "completed", title: "Review", input: { subagent_type: "review" }, output: "started", time: { start: 1, end: 2 },
  metadata: { parentSessionId: parent, sessionId: child, background: true, runId: run },
} }
const receipt: TextPart = { id: "receipt", sessionID: parent, messageID: notification.id, type: "text", synthetic: true, text: output() }
const fixture = () => ({ receipt, messages: [request, assistant, notification], parts: { [request.id]: [], [assistant.id]: [launch], [notification.id]: [receipt] } as Record<string, Part[]>, sessions: [sessionInfo(child, { parentID: parent, agent: "review" })], complete: true })

test("background report requires a complete, uniquely correlated review launch and successful receipt", () => {
  const data = fixture()
  expect(backgroundReview(data)?.report.summary).toBe("Synthetic approval")
  expect(backgroundReview(data)?.raw).toBe(receipt.text)
  const longReceipt = { ...receipt, text: output(child, run, `Long analysis ${"x".repeat(3000)}\n${report}`) }
  expect(backgroundReview({ ...data, receipt: longReceipt, parts: { ...data.parts, [notification.id]: [longReceipt] } })?.raw).toBe(longReceipt.text)
  expect(backgroundReview({ ...data, complete: false })).toBeUndefined()
  expect(backgroundReview({ ...data, sessions: [] })).toBeUndefined()
  expect(backgroundReview({ ...data, sessions: [sessionInfo(child, { parentID: parent, agent: "work" })] })).toBeUndefined()
  expect(backgroundReview({ ...data, sessions: [sessionInfo(child, { parentID: "other", agent: "review" })] })).toBeUndefined()
  expect(backgroundReview({ ...data, parts: { [assistant.id]: [launch], [notification.id]: [receipt] } })).toBeUndefined()
  expect(backgroundReview({ ...data, parts: { ...data.parts, [assistant.id]: [] } })).toBeUndefined()
  expect(backgroundReview({ ...data, parts: { ...data.parts, [assistant.id]: [launch, { ...launch, id: "duplicate" }] } })).toBeUndefined()
  expect(backgroundReview({ ...data, parts: { ...data.parts, [notification.id]: [receipt, { ...receipt, id: "duplicate" }] } })).toBeUndefined()
})

test("background report never trusts a mismatched run, failed or ambiguous wrapper, or incomplete report", () => {
  const data = fixture()
  for (const text of [
    output(child, `${child}@1235`),
    output(child, run, report, '<termination reason="failure">failure</termination>\n</task>'),
    output(child, run, report, '<termination reason="success"></termination>'),
    output(child, run, report) + "\ntrailing",
    output(child, run, `${report}\n<task_result>other</task_result>`),
    output(child, run, "<silvercode-review>{"),
  ]) {
    const candidate = { ...receipt, text }
    expect(backgroundReview({ ...data, receipt: candidate, parts: { ...data.parts, [notification.id]: [candidate] } })).toBeUndefined()
  }
  expect(backgroundReview({ ...data, receipt: { ...receipt, synthetic: false } })).toBeUndefined()
  const nonReview = { ...launch, state: { ...launch.state, input: { subagent_type: "work" } } } as ToolPart
  expect(backgroundReview({ ...data, parts: { ...data.parts, [assistant.id]: [nonReview] } })).toBeUndefined()
})
