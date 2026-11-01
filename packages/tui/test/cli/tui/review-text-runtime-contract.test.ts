import { describe, expect, test } from "bun:test"
import { ReviewReport } from "@opencode-ai/core/review-report"
import type { AssistantMessage, Part, TextPart } from "@opencode-ai/sdk/v2"
import { reviewText } from "../../../src/routes/session/review-text"

const report = (summary: string, assessment: "approved" | "needs-fixes" = "needs-fixes"): ReviewReport.Info => ({
  version: 1,
  revision: "synthetic-revision",
  assessment,
  summary,
  findings: [],
})
const envelope = (summary: string, assessment?: "approved" | "needs-fixes") => ReviewReport.envelope(report(summary, assessment))
const assistant = (agent: string, sessionID = "parent"): AssistantMessage => ({
  id: "assistant", sessionID, role: "assistant", parentID: "request", agent, mode: agent,
  time: { created: 1, completed: 2 }, providerID: "test", modelID: "test",
  path: { cwd: "/synthetic", root: "/synthetic" }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
const text = (value: string, index: number, sessionID = "parent", flags: Partial<Pick<TextPart, "synthetic" | "ignored">> = {}): TextPart => ({
  type: "text", id: `text-${index}`, sessionID, messageID: "assistant", text: value, ...flags,
})

describe("review text runtime contracts", () => {
  test("multipart extraction agrees with the runtime when tags span whitespace boundaries", () => {
    const chunks = ["Analysis.", "<silvercode-review>", JSON.stringify(report("multipart")), "</silvercode-review>", "Afterward.", ""]
    const canonical = ReviewReport.extract(chunks)
    const displayed = reviewText(assistant("review"), chunks.map((chunk, i) => text(chunk, i)))
    expect(canonical.ok).toBe(true)
    if (!canonical.ok) throw new Error("fixture must be a canonical delivery")
    expect(displayed?.report).toEqual(canonical.report)
    expect(displayed?.analysis).toBe(canonical.analysis)
  })

  test("runtime does not repair a tag split inside its spelling", () => {
    const content = envelope("not a runtime delivery")
    const chunks = [content.slice(0, 8), content.slice(8)]
    // Session delivery passes separate chunks to extract(), which joins them
    // with a newline. A UI must not claim that this is a delivered verdict.
    expect(ReviewReport.extract(chunks).ok).toBe(false)
    expect(reviewText(assistant("review"), chunks.map((chunk, i) => text(chunk, i)))).toBeUndefined()
  })

  test("streaming and interrupted messages never produce a structured candidate", () => {
    const complete = assistant("review")
    const parts = [text(envelope("streamed"), 0)]
    expect(reviewText({ ...complete, time: { created: 1 } }, parts)).toBeUndefined()
    expect(reviewText(complete, parts)?.report.summary).toBe("streamed")
    expect(reviewText({ ...complete, error: { name: "MessageAbortedError", data: { message: "cancelled" } } }, parts)).toBeUndefined()
    expect(reviewText(complete, [text("<silvercode-review>{", 0)])).toBeUndefined()
  })

  test("reviewer identity comes from the assistant message, not a child-looking string", () => {
    const body = envelope("synthetic child")
    const child = assistant("review", "child")
    expect(reviewText(child, [text(body, 0, "child")])?.report.summary).toBe("synthetic child")
    expect(reviewText(assistant("work"), [text(`<task id="child" state="completed">${body}</task>`, 0)])).toBeUndefined()
    expect(reviewText(assistant("general", "child"), [text(body, 0, "child")])).toBeUndefined()
  })

  test("synthetic and ignored text parts cannot supply review identity or a verdict", () => {
    const parts: Part[] = [
      text("Visible analysis.", 0),
      text(envelope("synthetic"), 1, "parent", { synthetic: true }),
      text(envelope("ignored"), 2, "parent", { ignored: true }),
    ]
    expect(reviewText(assistant("review"), parts)).toBeUndefined()
  })

  test("ordinary messages and quoted examples do not gain a verdict", () => {
    const body = envelope("example", "approved")
    expect(reviewText(assistant("work"), [text(body, 0)])).toBeUndefined()
    expect(reviewText(assistant("review"), [text(`\`\`\`xml\n${body}\n\`\`\``, 0)])).toBeUndefined()
    expect(reviewText(assistant("review"), [text(`> ${body.replaceAll("\n", "\n> ")}`, 0)])).toBeUndefined()
  })

  test("last complete report wins but earlier raw envelopes remain in canonical analysis", () => {
    const first = envelope("earlier", "approved")
    const second = envelope("later", "needs-fixes")
    const chunks = ["Analysis.", first, "Between.", second]
    const canonical = ReviewReport.extract(chunks)
    const displayed = reviewText(assistant("review"), chunks.map((chunk, i) => text(chunk, i)))
    expect(canonical.ok).toBe(true)
    if (!canonical.ok) throw new Error("fixture must be a canonical delivery")
    expect(canonical.report.summary).toBe("later")
    expect(canonical.analysis).toContain(first)
    expect(displayed?.report).toEqual(canonical.report)
    expect(displayed?.analysis).toBe(canonical.analysis)
    // The held renderer must avoid displaying the superseded raw envelope
    // without discarding the surrounding human analysis.
  })

  test("a malformed later complete envelope supersedes an earlier approval", () => {
    const chunks = [envelope("earlier", "approved"), "<silvercode-review>{invalid}</silvercode-review>"]
    expect(ReviewReport.extract(chunks).ok).toBe(false)
    expect(reviewText(assistant("review"), chunks.map((chunk, i) => text(chunk, i)))).toBeUndefined()
  })
})
