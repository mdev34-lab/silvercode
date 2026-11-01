import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
import { reviewText } from "../../../src/routes/session/review-text"

const report = { version: 1 as const, revision: "uncommitted", assessment: "needs-fixes" as const, summary: "Synthetic finding", findings: [] }
const envelope = `<silvercode-review>${JSON.stringify(report)}</silvercode-review>`
const message = { agent: "review", time: { created: 1, completed: 2 } } as AssistantMessage
function parts(...chunks: string[]): Part[] {
  return chunks.map((text, index) => ({ type: "text", id: `p${index}`, messageID: "m", sessionID: "s", text }))
}

describe("review text presentation boundary", () => {
  test("extracts a complete reviewer message across parts and split tags", () => {
    const result = reviewText(message, parts("Synthetic analysis.", envelope.slice(0, 8), envelope.slice(8), "Afterward."))
    expect(result?.report).toEqual(report)
    expect(result?.analysis).toBe("Synthetic analysis.\n\nAfterward.")
    expect(result?.textPartIDs).toEqual(["p0", "p1", "p2", "p3"])
  })
  test("reassembles tags split across multiple boundaries", () => {
    const result = reviewText(message, parts("Analysis", ...envelope.slice(0, 19).split(""), envelope.slice(19)))
    expect(result?.report).toEqual(report)
    expect(result?.analysis).toBe("Analysis")
  })
  test("keeps streaming, failed, malformed and incomplete output as ordinary text", () => {
    expect(reviewText({ ...message, time: { created: 1 } }, parts(envelope))).toBeUndefined()
    expect(reviewText({ ...message, error: { name: "MessageAbortedError", data: { message: "aborted" } } }, parts(envelope))).toBeUndefined()
    expect(reviewText(message, parts(envelope.slice(0, -10)))).toBeUndefined()
    expect(reviewText(message, parts(envelope.replace('"version":1', '"version":2')))).toBeUndefined()
    expect(reviewText(message, parts("<silvercode-review>{invalid}</silvercode-review>"))).toBeUndefined()
  })
  test("does not use content as identity or treat quoted examples as deliveries", () => {
    expect(reviewText({ ...message, agent: "work" }, parts(envelope))).toBeUndefined()
    expect(reviewText(message, parts(`Example:\n\`\`\`xml\n${envelope}\n\`\`\``))).toBeUndefined()
    expect(reviewText(message, parts(`> ${envelope}`))).toBeUndefined()
    expect(reviewText(message, parts(`An example: \`${envelope}\``))).toBeUndefined()
  })
  test("recognizes persisted reviewer aliases and legacy envelopes", () => {
    expect(reviewText({ ...message, agent: "code-review" }, parts(envelope.replaceAll("silvercode-review", "alphacode-review")))?.report).toEqual(report)
  })
})
