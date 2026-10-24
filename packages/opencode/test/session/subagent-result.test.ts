import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { resultChunks, textResult, renderTextResult } from "../../src/session/subagent-result"

// Only the fields consumed by the collector are relevant to this pure boundary test.
const user = (id: string) => ({ info: { id, role: "user" }, parts: [] }) as unknown as SessionV1.WithParts
const assistant = (id: string, parentID: string, parts: unknown[]) =>
  ({ info: { id, role: "assistant", parentID }, parts }) as unknown as SessionV1.WithParts
const text = (text: string) => ({ type: "text", text })
const plan = "Use an orthographic camera, build the garden, then validate the HTML."
const envelope = renderTextResult(plan)

describe("subagent result execution boundary", () => {
  test("delivers a prior assistant turn when finish has no text", () => {
    const first = assistant("02", "01", [text(envelope)])
    const last = assistant("03", "01", [text("")])
    expect(textResult(resultChunks([user("01"), first, last], last))).toEqual({ ok: true, text: plan })
  })
  test("delivers same-turn result despite trailing empty text", () => {
    const last = assistant("02", "01", [text(envelope), text("")])
    expect(textResult(resultChunks([user("01"), last], last))).toEqual({ ok: true, text: plan })
  })
  test("never borrows an earlier prompt or different assistant parent", () => {
    const old = assistant("02", "01", [text(envelope)])
    const wrongParent = assistant("04", "01", [text(envelope)])
    const last = assistant("05", "03", [text("Finished")])
    expect(textResult(resultChunks([user("01"), old, user("03"), wrongParent, last], last))).toEqual({ ok: false })
  })
  test("a completed finish is an execution boundary even with the same user parent", () => {
    const old = assistant("02", "01", [
      text(envelope),
      { type: "tool", tool: "finish", state: { status: "completed" } },
    ])
    const last = assistant("03", "01", [text("Finished")])
    expect(textResult(resultChunks([user("01"), old, last], last))).toEqual({ ok: false })
  })
  test("never promotes reasoning or tool output to a result", () => {
    const last = assistant("02", "01", [
      { type: "reasoning", text: envelope },
      { type: "tool", tool: "read", state: { status: "completed", output: envelope } },
      text("Progress only"),
    ])
    expect(textResult(resultChunks([user("01"), last], last))).toEqual({ ok: false })
  })
  test("missing prompt history may use only the current assistant", () => {
    const old = assistant("02", "01", [text(envelope)])
    const last = assistant("03", "01", [text("done")])
    expect(textResult(resultChunks([old, last], last))).toEqual({ ok: false })
  })
  test("out-of-order history is normalized and current message is not duplicated", () => {
    const first = assistant("02", "01", [text(envelope)])
    const last = assistant("03", "01", [text("")])
    expect(resultChunks([last, first, user("01")], last)).toEqual([envelope, ""])
  })
})

describe("text result envelope", () => {
  test("keeps plain text and code without JSON escaping", () => {
    const content = 'Use <canvas> and `const x = "hello"`\nwith a second line.'
    expect(textResult([renderTextResult(content)])).toEqual({ ok: true, text: content })
  })
  test("rejects missing, empty and incomplete envelopes", () => {
    for (const source of ["Done", "<silvercode-result> </silvercode-result>", "<silvercode-result>unfinished"])
      expect(textResult([source])).toEqual({ ok: false })
  })
  test("uses the latest complete envelope instead of old progress", () => {
    expect(textResult([renderTextResult("old"), envelope])).toEqual({ ok: true, text: plan })
  })
})
