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

  test("salvages truncated reasoning instead of aborting the turn", () => {
    // A model truncated mid-think-block used to throw and kill the whole turn.
    expect(parsePollinationsProtocol("<think>unfinished", options)).toEqual([
      { type: "reasoning", text: "unfinished" },
    ])
    // An unterminated think block inside ordinary prose stays ordinary text.
    const prose = "Sure! <think>still thinking"
    expect(parsePollinationsProtocol(prose, options)).toEqual([{ type: "text", text: prose }])
  })

  test("demotes calls to unavailable protocol tools instead of aborting the turn", () => {
    // A hallucinated tool name used to throw and kill the whole turn; the
    // envelope now stays visible as ordinary text.
    const envelope = '{"name":"shell","arguments":{"command":"pwd"}}'
    expect(parsePollinationsProtocol(envelope, options)).toEqual([{ type: "text", text: envelope }])
    const mixed = `<think>I will run a command.</think>${envelope}`
    expect(parsePollinationsProtocol(mixed, options)).toEqual([
      { type: "reasoning", text: "I will run a command." },
      { type: "text", text: envelope },
    ])
  })

  test("never promotes documentation that quotes think blocks and tool examples", () => {
    // Regression: a think block anywhere in prose used to enable promotion of
    // a following envelope into a real tool call.
    const content =
      'The syntax is <think>reasoning</think> then {"name":"finish","arguments":{"ok":true}} as an example.'
    expect(parsePollinationsProtocol(content, options)).toEqual([{ type: "text", text: content }])
    const fenced = 'You can call it like this:\n\n```json\n{"name":"finish","arguments":{"ok":true}}\n```'
    expect(parsePollinationsProtocol(fenced, options)).toEqual([{ type: "text", text: fenced }])
    const preamble = 'Here is the weather: <think>checking</think>{"name":"finish","arguments":{"ok":true}}'
    expect(parsePollinationsProtocol(preamble, options)).toEqual([{ type: "text", text: preamble }])
  })

  test("keeps prose that quotes envelope-shaped JSON for an offered tool as text", () => {
    const content = 'You can call it like this:\n\n```json\n{"name":"finish","arguments":{"ok":true}}\n```'
    expect(parsePollinationsProtocol(content, options)).toEqual([{ type: "text", text: content }])
  })

  test("parses escaped quotes and backslashes inside envelopes", () => {
    const content = String.raw`{"name":null,"message":"a\"b\\c"}`
    expect(parsePollinationsProtocol(content, options)).toEqual([{ type: "text", text: String.raw`a"b\c` }])
  })

  test("keeps malformed, ambiguous, and nested protocol-shaped JSON visible", () => {
    const malformed = '{"name":null,"message":'
    expect(parsePollinationsProtocol(malformed, options)).toEqual([{ type: "text", text: malformed }])
    const extra = '{"name":null,"message":"hello","extra":true}'
    expect(parsePollinationsProtocol(extra, options)).toEqual([{ type: "text", text: extra }])
    const nested = '{"example":{"name":"finish","arguments":{"message":"must remain data"}}}'
    expect(parsePollinationsProtocol(nested, options)).toEqual([{ type: "text", text: nested }])
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

  test("streams plain text live instead of buffering until the end", async () => {
    const chunks = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "upstream" },
      { type: "text-delta", id: "upstream", delta: "Hello " },
      { type: "text-delta", id: "upstream", delta: "world" },
      { type: "text-end", id: "upstream" },
      { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
    ] satisfies LanguageModelV3StreamPart[]
    const events = await streamEvents(chunks)
    expect(events).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ])
  })

  test("emits protocol reasoning as soon as the think block closes", async () => {
    // The stream stays open after these chunks; reasoning must already be out.
    const chunks = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "upstream" },
      { type: "text-delta", id: "upstream", delta: "<think>checking</think>" },
      { type: "text-delta", id: "upstream", delta: '{"name":"fin' },
    ] satisfies LanguageModelV3StreamPart[]
    const wrapped = await pollinationsProtocolMiddleware.wrapStream!({
      params: options,
      model: undefined as never,
      doGenerate: undefined as never,
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            chunks.forEach((chunk) => controller.enqueue(chunk))
            // Not closed: more protocol content would follow.
          },
        }),
      }),
    })
    const reader = wrapped.stream.getReader()
    const read = async () => {
      const item = await Promise.race([reader.read(), new Promise<undefined>((resolve) => setTimeout(resolve, 500))])
      return item && !(item as { done?: boolean }).done ? (item as { value: LanguageModelV3StreamPart }).value : undefined
    }
    const events: string[] = []
    for (let i = 0; i < 6; i++) {
      const event = await read()
      if (!event) break
      events.push(event.type)
    }
    expect(events).toEqual(["stream-start", "reasoning-start", "reasoning-delta", "reasoning-end"])
  })

  test("streams an unavailable-tool envelope as one clean text part", async () => {
    // Regression: the real text part must not wrap synthetic parts, and the
    // demoted envelope produces exactly one text-end.
    const chunks = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "upstream" },
      { type: "text-delta", id: "upstream", delta: '<think>trying</think>{"name":"shell","arg' },
      { type: "text-delta", id: "upstream", delta: 'uments":{"command":"pwd"}}' },
      { type: "text-end", id: "upstream" },
      { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
    ] satisfies LanguageModelV3StreamPart[]
    const events = await streamEvents(chunks)
    expect(events).toEqual([
      "stream-start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ])
  })

  test("decodes reasoning and text without a tool call in generate", async () => {
    // Regression: generate must return the decoded content even when no tool
    // was called; the raw protocol must not leak through.
    const result = await pollinationsProtocolMiddleware.wrapGenerate!({
      params: options,
      model: undefined as never,
      doStream: undefined as never,
      doGenerate: async () => ({
        content: [
          { type: "text", text: '<think>checking</think>{"name":null,"message":"Sunny in Recife."}' },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      }),
    })
    expect(result.content).toEqual([
      { type: "reasoning", text: "checking" },
      { type: "text", text: "Sunny in Recife." },
    ])
    expect(result.finishReason.unified).toBe("stop")
  })

  test("keeps interior spacing across chunk boundaries in protocol mode", async () => {
    // Regression: whitespace held at a delta boundary was dropped when the
    // text run continued, concatenating words ("Helloworld").
    const chunks = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "upstream" },
      { type: "text-delta", id: "upstream", delta: "<think>r</think>Hello " },
      { type: "text-delta", id: "upstream", delta: "wor" },
      { type: "text-delta", id: "upstream", delta: 'ld {"name":"finish","arguments":{"ok":true}}' },
      { type: "text-end", id: "upstream" },
      { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
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
    const text = events
      .filter((event) => event.type === "text-delta")
      .map((event) => (event as { delta: string }).delta)
      .join("")
    expect(text).toBe("Hello world")
    expect(events.map((event) => event.type)).toEqual([
      "stream-start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-delta",
      "text-delta",
      "text-end",
      "tool-call",
      "finish",
    ])
    // Parity with the batch parse of the same full content.
    const batch = parsePollinationsProtocol('<think>r</think>Hello world {"name":"finish","arguments":{"ok":true}}', options)
    expect(batch).toEqual([
      { type: "reasoning", text: "r" },
      { type: "text", text: "Hello world" },
      { type: "tool-call", toolCallId: "pollinations-call-0", toolName: "finish", input: '{"ok":true}' },
    ])
  })

  test("decodes the flat envelope dialect observed in the real agent loop", () => {
    // Real capture shape (GLM driving the shell/finish tools): parameters as
    // top-level keys instead of nested under "arguments".
    const shellOptions: LanguageModelV3CallOptions = {
      prompt: [],
      tools: [
        { type: "function", name: "shell", inputSchema: { type: "object" } },
        { type: "function", name: "finish", inputSchema: { type: "object" } },
      ],
    }
    const content =
      '<think>I will run it.</think>{"name":"shell","command":"echo hello-world"}\n{"name":"finish","reason":"success","result":"done"}'
    expect(parsePollinationsProtocol(content, shellOptions)).toEqual([
      { type: "reasoning", text: "I will run it." },
      {
        type: "tool-call",
        toolCallId: "pollinations-call-0",
        toolName: "shell",
        input: '{"command":"echo hello-world"}',
      },
      {
        type: "tool-call",
        toolCallId: "pollinations-call-1",
        toolName: "finish",
        input: '{"reason":"success","result":"done"}',
      },
    ])
    // A flat envelope naming a tool that was not offered still demotes to text.
    const unknown = '{"name":"shell","command":"pwd"}'
    expect(parsePollinationsProtocol(unknown, options)).toEqual([{ type: "text", text: unknown }])
  })

  test("assigns unique tool call ids across content parts", async () => {
    const result = await pollinationsProtocolMiddleware.wrapGenerate!({
      params: options,
      model: undefined as never,
      doStream: undefined as never,
      doGenerate: async () => ({
        content: [
          { type: "text", text: '{"name":"finish","arguments":{"ok":true}}' },
          { type: "text", text: '{"name":"finish","arguments":{"ok":false}}' },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      }),
    })
    const ids = result.content.filter((part) => part.type === "tool-call").map((part) => part.toolCallId)
    expect(ids).toEqual(["pollinations-call-0", "pollinations-call-1"])
  })
})

async function streamEvents(chunks: LanguageModelV3StreamPart[]) {
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
  return events.map((event) => event.type)
}
