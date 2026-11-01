import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import FINISH_NUDGE from "../../src/session/prompt/finish-nudge.txt"
import {
  continuesPrompt,
  REPETITION_RECOVERY,
  repetitionRecoveryPromptID,
  resultChunks,
  textResult,
  renderTextResult,
} from "../../src/session/subagent-result"

// Only the fields consumed by the collector are relevant to this pure boundary test.
const user = (id: string) => ({ info: { id, role: "user" }, parts: [] }) as unknown as SessionV1.WithParts
const synthetic = (id: string, text: string) =>
  ({ info: { id, role: "user" }, parts: [{ type: "text", text, synthetic: true }] }) as unknown as SessionV1.WithParts
const nudge = (id: string) => synthetic(id, FINISH_NUDGE)
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
  test("a finish nudge keeps the envelope written before it", () => {
    const first = assistant("02", "01", [text(envelope)])
    const last = assistant("04", "03", [text("")])
    expect(textResult(resultChunks([user("01"), first, nudge("03"), last], last))).toEqual({ ok: true, text: plan })
  })
  test("a nudge chain stops at the original prompt, never an earlier one", () => {
    const old = assistant("02", "01", [text(envelope)])
    const last = assistant("06", "05", [text("")])
    expect(textResult(resultChunks([user("01"), old, user("03"), nudge("05"), last], last))).toEqual({ ok: false })
  })
  test("a nudge after a completed finish does not resurrect the earlier result", () => {
    const old = assistant("02", "01", [text(envelope), { type: "tool", tool: "finish", state: { status: "completed" } }])
    const last = assistant("04", "03", [text("")])
    expect(textResult(resultChunks([user("01"), old, nudge("03"), last], last))).toEqual({ ok: false })
  })
  test("never promotes reasoning or tool output to a result", () => {
    const last = assistant("02", "01", [
      { type: "reasoning", text: envelope },
      { type: "tool", tool: "read", state: { status: "completed", output: envelope } },
      text("Progress only"),
      { type: "text", text: envelope, synthetic: true },
      { type: "text", text: envelope, ignored: true },
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

describe("prompt continuation through finish nudges", () => {
  test("a direct answer and a nudged answer both continue the prompt", () => {
    const direct = assistant("02", "01", [text("a")])
    expect(continuesPrompt([user("01"), direct], direct, "01")).toBe(true)
    const nudged = assistant("04", "03", [text("b")])
    expect(continuesPrompt([user("01"), assistant("02", "01", []), nudge("03"), nudged], nudged, "01")).toBe(true)
  })
  test("a real later prompt or an unrelated id is not a continuation", () => {
    const last = assistant("04", "03", [text("b")])
    expect(continuesPrompt([user("01"), user("03"), last], last, "01")).toBe(false)
    expect(continuesPrompt([user("01"), nudge("03"), last], last, "99")).toBe(false)
    expect(continuesPrompt([nudge("03"), last], last, "01")).toBe(false)
  })
})

describe("prompt continuation boundaries", () => {
  const done = { type: "tool", tool: "finish", state: { status: "completed" } }
  test("a later real user message makes an older parent stale", () => {
    const stale = assistant("05", "01", [text("b")])
    expect(continuesPrompt([user("01"), user("03"), stale], stale, "01")).toBe(false)
    expect(resultChunks([user("01"), assistant("02", "01", [text(envelope)]), user("03"), stale], stale)).toEqual(["b"])
  })
  test("a synthetic user message that is not the runner nudge is a boundary", () => {
    const last = assistant("04", "03", [text("b")])
    const old = assistant("02", "01", [text(envelope)])
    expect(continuesPrompt([user("01"), old, synthetic("03", "Background task finished"), last], last, "01")).toBe(false)
    expect(resultChunks([user("01"), old, synthetic("03", "Background task finished"), last], last)).toEqual(["b"])
  })
  test("a nudge after a completed finish does not continue the earlier prompt", () => {
    const old = assistant("02", "01", [text(envelope), done])
    const last = assistant("04", "03", [text("b")])
    expect(continuesPrompt([user("01"), old, nudge("03"), last], last, "01")).toBe(false)
  })
  test("an absent prompt is a direct match only while no later real user message is present", () => {
    const last = assistant("04", "01", [text("b")])
    expect(continuesPrompt([], last, "01")).toBe(true)
    expect(continuesPrompt([last], last, "01")).toBe(true)
    expect(continuesPrompt([user("03"), last], last, "01")).toBe(false)
    const early = assistant("02", "03", [text("b")])
    expect(continuesPrompt([early], early, "03")).toBe(false)
  })
  test("an assistant after a completed finish does not continue the prompt", () => {
    const old = assistant("02", "01", [text(envelope), done])
    const later = assistant("03", "01", [text("b")])
    expect(continuesPrompt([user("01"), old, later], later, "01")).toBe(false)
    const fresh = assistant("02", "01", [text("a")])
    expect(continuesPrompt([user("01"), fresh], fresh, "01")).toBe(true)
  })
  test("a missing prompt with a known completed finish after it is not a continuation", () => {
    const old = assistant("02", "01", [text(envelope), done])
    const last = assistant("03", "01", [text("b"), done])
    expect(continuesPrompt([old, last], last, "01")).toBe(false)
    expect(continuesPrompt([last], last, "01")).toBe(true)
    // a finish before the (absent) prompt's id is not after it
    expect(continuesPrompt([assistant("00", "x", [done]), last], last, "01")).toBe(true)
  })
  test("a parent that sorts after the assistant is not a continuation", () => {
    const last = assistant("02", "03", [text("b")])
    expect(continuesPrompt([user("01"), last, nudge("03")], last, "01")).toBe(false)
    expect(continuesPrompt([last, user("03")], last, "03")).toBe(false)
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


test("rejects nested tags and an unfinished newer result instead of using stale text", () => {
  expect(textResult(["<silvercode-result>outer<silvercode-result>inner</silvercode-result></silvercode-result>"])).toEqual({ ok: false })
  expect(textResult([renderTextResult("earlier"), "<silvercode-result>unfinished"])).toEqual({ ok: false })
})

test("a corrected later envelope recovers after an unfinished earlier assistant result", () => {
  expect(textResult(["<silvercode-result>unfinished", renderTextResult("corrected")])).toEqual({ ok: true, text: "corrected" })
})

test("a corrected later envelope recovers after a stray closing tag", () => {
  expect(textResult(["</silvercode-result>", renderTextResult("corrected")])).toEqual({ ok: true, text: "corrected" })
})

describe("repetition recovery continuation", () => {
  const recovery = (id: string, promptID: string, text = "The previous response was cut off by the repetition guard") =>
    ({
      info: { id, role: "user" },
      parts: [{ type: "text", text, synthetic: true, metadata: { [REPETITION_RECOVERY]: { promptID, attempt: 1 } } }],
    }) as unknown as SessionV1.WithParts

  test("a recovery message continues the prompt it resumes", () => {
    const aborted = assistant("02", "01", [text("partial output")])
    const resumed = assistant("04", "03", [text(envelope)])
    expect(continuesPrompt([user("01"), aborted, recovery("03", "01"), resumed], resumed, "01")).toBe(true)
    expect(textResult(resultChunks([user("01"), aborted, recovery("03", "01"), resumed], resumed))).toEqual({
      ok: true,
      text: plan,
    })
  })
  test("a recovery only continues its own prompt lineage", () => {
    const resumed = assistant("04", "03", [text(envelope)])
    expect(continuesPrompt([user("01"), user("02"), recovery("03", "01"), resumed], resumed, "02")).toBe(false)
  })
  test("another synthetic message is still a boundary", () => {
    const resumed = assistant("03", "02", [text(envelope)])
    expect(continuesPrompt([user("01"), synthetic("02", "shell marker"), resumed], resumed, "01")).toBe(false)
  })
  test("the lineage marker is readable only from a synthetic text part", () => {
    expect(repetitionRecoveryPromptID(recovery("03", "01"))).toBe("01")
    expect(repetitionRecoveryPromptID(synthetic("04", "opaque"))).toBeUndefined()
    expect(repetitionRecoveryPromptID(user("05"))).toBeUndefined()
    expect(
      repetitionRecoveryPromptID({
        info: { id: "06", role: "user" },
        parts: [{ type: "text", text: "not synthetic", metadata: { [REPETITION_RECOVERY]: { promptID: "01" } } }],
      } as unknown as SessionV1.WithParts),
    ).toBeUndefined()
  })
})

