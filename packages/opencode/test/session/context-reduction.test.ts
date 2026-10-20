import { describe, expect, test } from "bun:test"
import { ContextReduction } from "../../src/session/context-reduction"

const user = (id: string, text: string) =>
  ({
    info: { id, role: "user", sessionID: "s", time: { created: 1 } },
    parts: [{ id: id + "p", type: "text", text }],
  }) as never

const tool = (id: string, callID: string, output: string) =>
  ({
    info: { id, role: "assistant", sessionID: "s", time: { created: 1 } },
    parts: [
      {
        id: id + "p",
        type: "tool",
        callID,
        tool: "bash",
        state: { status: "completed", input: { cmd: "x" }, output, title: "t", metadata: {}, time: { start: 1, end: 2 } },
      },
    ],
  }) as never

const model = { limit: { context: 2000, output: 200 } }

describe("session context reduction adapter", () => {
  test("returns the input untouched when the request fits", () => {
    const messages = [user("m1", "hi"), tool("m2", "c1", "ok")]
    const result = ContextReduction.reduce({ messages, envelope: {}, model, config: undefined })
    expect(result.messages).toBe(messages)
  })

  test("projects an oversized history without mutating the canonical messages", () => {
    const big = "x".repeat(20000)
    const messages = [
      user("m1", "start"),
      ...Array.from({ length: 12 }, (_, i) => [tool(`a${i}`, `c${i}`, big), user(`u${i}`, "next")]).flat(),
    ]
    const snapshot = JSON.stringify(messages)
    const result = ContextReduction.reduce({ messages, envelope: {}, model, config: undefined })
    expect(JSON.stringify(messages)).toBe(snapshot)
    expect(JSON.stringify(result.messages).length).toBeLessThan(snapshot.length)
  })

  test("config can disable reduction", () => {
    const big = "x".repeat(20000)
    const messages = Array.from({ length: 12 }, (_, i) => tool(`a${i}`, `c${i}`, big))
    const result = ContextReduction.reduce({ messages, envelope: {}, model, config: { reduction: { enabled: false } } as never })
    expect(result.messages).toBe(messages)
  })
})

describe("multi-turn behavior", () => {
  test("is deterministic and re-derives from canonical history every turn", () => {
    const big = "x".repeat(20000)
    const history: never[] = [user("m0", "start")]
    const sizes: number[] = []
    for (let turn = 0; turn < 8; turn++) {
      history.push(tool(`a${turn}`, `c${turn}`, big + turn), user(`u${turn}`, "next"))
      const snapshot = JSON.stringify(history)
      const first = ContextReduction.reduce({ messages: history, envelope: {}, model, config: undefined })
      const second = ContextReduction.reduce({ messages: history, envelope: {}, model, config: undefined })
      expect(JSON.stringify(first.messages)).toBe(JSON.stringify(second.messages))
      expect(JSON.stringify(history)).toBe(snapshot)
      sizes.push(JSON.stringify(first.messages).length)
    }
    // pressure is bounded: the projection does not grow with every turn
    expect(sizes[7]).toBeLessThan(JSON.stringify(history).length)
  })
})
