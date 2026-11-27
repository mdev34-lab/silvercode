/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- middleware callbacks require unused model operations */
import { describe, expect, test } from "bun:test"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { parsePollinationsProtocol, pollinationsProtocolMiddleware } from "../../src/provider/pollinations-protocol"

const options: LanguageModelV3CallOptions = {
  prompt: [],
  tools: [{ type: "function", name: "finish", inputSchema: { type: "object" } }],
}
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

describe("Pollinations text protocol", () => {
  test("maps the observed GLM assistant, reasoning, and finish envelopes", async () => {
    const fixture = await Bun.file("test/fixtures/pollinations/glm-5.3-flash-observed.json").json()
    expect(parsePollinationsProtocol(fixture.content, options)).toEqual([
      { type: "reasoning", text: "The user only said hello." },
      { type: "text", text: "Hello! How can I help you today?" },
      { type: "reasoning", text: "I should finish after answering." },
      {
        type: "tool-call",
        toolCallId: "pollinations-call-0",
        toolName: "finish",
        input: '{"message":"Greeted the user."}',
      },
    ])
  })

  test("preserves normal text and ordinary JSON", () => {
    expect(parsePollinationsProtocol("Hello.", options)).toEqual([{ type: "text", text: "Hello." }])
    const json = '{"name":"Ada","arguments":{"example":true},"note":"user-facing"}'
    expect(parsePollinationsProtocol(json, options)).toEqual([{ type: "text", text: json }])
    const quoted = "A model may literally write <think>example</think> in documentation."
    expect(parsePollinationsProtocol(quoted, options)).toEqual([{ type: "text", text: quoted }])
  })

  test("rejects malformed reasoning and unavailable protocol tools", () => {
    expect(() => parsePollinationsProtocol("<think>unfinished", options)).toThrow("unterminated reasoning")
    expect(() => parsePollinationsProtocol('{"name":"shell","arguments":{"command":"pwd"}}', options)).toThrow(
      "unavailable tool",
    )
  })

  test("keeps malformed and ambiguous JSON visible", () => {
    const malformed = '{"name":null,"message":'
    expect(parsePollinationsProtocol(malformed, options)).toEqual([{ type: "text", text: malformed }])
    const extra = '{"name":null,"message":"hello","extra":true}'
    expect(parsePollinationsProtocol(extra, options)).toEqual([{ type: "text", text: extra }])
  })

  test("maps non-streaming output to native AI SDK content", async () => {
    const result = await pollinationsProtocolMiddleware.wrapGenerate!({
      params: options,
      model: undefined as never,
      doStream: undefined as never,
      doGenerate: async () => ({
        content: [{ type: "text", text: '<think>private</think>{"name":"finish","arguments":{"ok":true}}' }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      }),
    })
    expect(result.content).toEqual([
      { type: "reasoning", text: "private" },
      {
        type: "tool-call",
        toolCallId: "pollinations-call-0",
        toolName: "finish",
        input: '{"ok":true}',
      },
    ])
    expect(result.finishReason.unified).toBe("tool-calls")
  })

  test("assembles fragmented streaming delimiters and arguments", async () => {
    const chunks = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "upstream" },
      { type: "text-delta", id: "upstream", delta: "<thi" },
      { type: "text-delta", id: "upstream", delta: "nk>private</th" },
      { type: "text-delta", id: "upstream", delta: 'ink>{"name":"finish","arg' },
      { type: "text-delta", id: "upstream", delta: 'uments":{"ok":true}}' },
      { type: "text-end", id: "upstream" },
      {
        type: "finish",
        usage,
        finishReason: { unified: "stop", raw: "stop" },
      },
    ] satisfies LanguageModelV3StreamPart[]
    const wrapped = await pollinationsProtocolMiddleware.wrapStream!({
      params: options,
      model: undefined as never,
      doGenerate: undefined as never,
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            chunks.forEach((chunk) => controller.enqueue(chunk))
            controller.close()
          },
        }),
      }),
    })
    const events: LanguageModelV3StreamPart[] = []
    const reader = wrapped.stream.getReader()
    while (true) {
      const item = await reader.read()
      if (item.done) break
      events.push(item.value)
    }
    expect(events.map((event) => event.type)).toEqual([
      "stream-start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "tool-call",
      "finish",
    ])
    expect(events.at(-1)).toMatchObject({ finishReason: { unified: "tool-calls" } })
  })
})
