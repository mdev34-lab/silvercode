/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- middleware callbacks require unused model operations */
import { describe, expect, test } from "bun:test"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { parsePollinationsProtocol, pollinationsProtocolMiddleware } from "../../src/provider/pollinations-protocol"

const options: LanguageModelV3CallOptions = {
  prompt: [],
  tools: [{ type: "function", name: "finish", inputSchema: { type: "object" } }],
}
const readToolOptions: LanguageModelV3CallOptions = {
  prompt: [],
  tools: [
    {
      type: "function",
      name: "read",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
      },
    },
  ],
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
    expect(parsePollinationsProtocol("<think>unfinished", options)).toEqual([{ type: "reasoning", text: "unfinished" }])
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
    expect(events.map((event) => event.type)).toEqual([
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
      return item && !(item as { done?: boolean }).done
        ? (item as { value: LanguageModelV3StreamPart }).value
        : undefined
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
    expect(events.map((event) => event.type)).toEqual([
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
        content: [{ type: "text", text: '<think>checking</think>{"name":null,"message":"Sunny in Recife."}' }],
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
    const batch = parsePollinationsProtocol(
      '<think>r</think>Hello world {"name":"finish","arguments":{"ok":true}}',
      options,
    )
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

  test("qualifies flat envelopes against the offered tool's input schema", () => {
    // Real converted tool shapes (effect Struct semantics: closed to extra
    // keys unless additionalProperties/patternProperties opt out).
    const shell = {
      type: "object",
      properties: { command: { type: "string" }, timeout: { type: "number" }, workdir: { type: "string" } },
      required: ["command"],
    }
    const read = {
      type: "object",
      properties: { filePath: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
      required: ["filePath"],
    }
    const finish = {
      type: "object",
      properties: { reason: { type: "string" }, result: { type: "string" } },
      required: ["reason", "result"],
    }
    const list = { type: "object", properties: {}, required: [] }
    const freeform = { type: "object" }
    const opts = (tools: unknown[]): LanguageModelV3CallOptions => ({
      prompt: [],
      tools: tools as LanguageModelV3CallOptions["tools"],
    })
    const types = (doc: string, tools: unknown[]) =>
      parsePollinationsProtocol(doc, opts(tools)).map((part) =>
        part.type === "tool-call" ? `call:${part.toolName}` : part.type,
      )

    const shellTool = { type: "function", name: "shell", inputSchema: shell }
    const readTool = { type: "function", name: "read", inputSchema: read }
    const finishTool = { type: "function", name: "finish", inputSchema: finish }

    // Ordinary leading JSON that names an offered tool but does not match its
    // parameters stays text (Kilo review case): wrong key for read, and
    // package.json-like / config-like data.
    expect(types('{"name":"read","path":"./env"}', [readTool])).toEqual(["text"])
    expect(types('{"name":"read","version":"1.0.0","description":"x"}', [readTool])).toEqual(["text"])
    expect(types('{"name":"shell","enabled":true,"timeout":30}', [shellTool])).toEqual(["text"])
    // Required key missing, and metadata keys mixed into a real-looking call.
    expect(types('{"name":"shell","timeout":30}', [shellTool])).toEqual(["text"])
    expect(types('{"name":"shell","id":"x","command":"pwd"}', [shellTool])).toEqual(["text"])
    expect(types('{"name":"read"}', [readTool])).toEqual(["text"])
    // Legitimate calls with the real shapes still promote.
    expect(types('{"name":"shell","command":"pwd"}', [shellTool])).toEqual(["call:shell"])
    expect(types('{"name":"shell","command":"pwd","workdir":"/tmp"}', [shellTool])).toEqual(["call:shell"])
    expect(types('{"name":"read","filePath":"/tmp/a.txt"}', [readTool])).toEqual(["call:read"])
    expect(types('{"name":"finish","reason":"success","result":"done"}', [finishTool])).toEqual(["call:finish"])
    // Zero-argument tools: a bare name promotes against a closed empty
    // schema, but an unexpected key demotes.
    expect(types('{"name":"list"}', [{ type: "function", name: "list", inputSchema: list }])).toEqual(["call:list"])
    expect(types('{"name":"list","verbose":true}', [{ type: "function", name: "list", inputSchema: list }])).toEqual([
      "text",
    ])
    // Schemas that cannot discriminate (no properties object) accept.
    expect(
      types('{"name":"freeform","anything":"goes"}', [{ type: "function", name: "freeform", inputSchema: freeform }]),
    ).toEqual(["call:freeform"])
    // The nested dialect is not gated by this rule (pre-existing behavior).
    expect(types('{"name":"read","arguments":{"path":"./env"}}', [readTool])).toEqual(["call:read"])
    // A demoted flat envelope keeps its raw text visible.
    const raw = '{"name":"read","path":"./env"}'
    expect(parsePollinationsProtocol(raw, opts([readTool]))).toEqual([{ type: "text", text: raw }])
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

  test("decodes the serialized assistant-message dialect observed from GPT-6-Luna", () => {
    // Observed 2026-11-27 in the real TUI: Luna imitates the backend's raw
    // JSON serialization of an assistant message, including the ids this
    // middleware assigned to earlier promoted calls (path anonymized).
    const envelope =
      '{"tool_calls":[{"id":"pollinations-call-1","type":"function","function":{"name":"read","arguments":"{\\"filePath\\":\\"/tmp/example\\"}"}}],"role":"assistant","content":"No matches for that pattern."}'
    expect(parsePollinationsProtocol(envelope, readToolOptions)).toEqual([
      { type: "text", text: "No matches for that pattern." },
      {
        type: "tool-call",
        toolCallId: "pollinations-call-0",
        toolName: "read",
        input: '{"filePath":"/tmp/example"}',
      },
    ])
  })

  test("decodes the reasoning_content sibling of the assistant-message dialect", () => {
    const envelope =
      '{"tool_calls":[{"id":"pollinations-call-2","type":"function","function":{"name":"read","arguments":"{\\"filePath\\":\\"/tmp/example\\"}"}}],"reasoning_content":"The previous read call ended the turn without a result, so I will retry."}'
    expect(parsePollinationsProtocol(envelope, readToolOptions)).toEqual([
      { type: "reasoning", text: "The previous read call ended the turn without a result, so I will retry." },
      {
        type: "tool-call",
        toolCallId: "pollinations-call-0",
        toolName: "read",
        input: '{"filePath":"/tmp/example"}',
      },
    ])
  })

  test("assigns fresh ids to every call in an assistant-message envelope", () => {
    // Echoed ids collide with calls already in history; they are discarded.
    const envelope =
      '{"tool_calls":[{"id":"pollinations-call-1","type":"function","function":{"name":"read","arguments":"{\\"filePath\\":\\"/tmp/a\\"}"}},{"id":"pollinations-call-1","type":"function","function":{"name":"read","arguments":"{\\"filePath\\":\\"/tmp/b\\"}"}}],"role":"assistant"}'
    expect(parsePollinationsProtocol(envelope, readToolOptions)).toEqual([
      { type: "tool-call", toolCallId: "pollinations-call-0", toolName: "read", input: '{"filePath":"/tmp/a"}' },
      { type: "tool-call", toolCallId: "pollinations-call-1", toolName: "read", input: '{"filePath":"/tmp/b"}' },
    ])
  })

  test("accepts assistant-message arguments already decoded as an object", () => {
    const envelope = '{"tool_calls":[{"type":"function","function":{"name":"read","arguments":{"filePath":"/tmp/a"}}}]}'
    expect(parsePollinationsProtocol(envelope, readToolOptions)).toEqual([
      { type: "tool-call", toolCallId: "pollinations-call-0", toolName: "read", input: '{"filePath":"/tmp/a"}' },
    ])
  })

  test("demotes assistant-message envelopes that fail strict qualification", () => {
    // A call naming a tool that was not offered never executes.
    const unknownTool =
      '{"tool_calls":[{"type":"function","function":{"name":"shell","arguments":"{\\"command\\":\\"pwd\\"}"}}],"role":"assistant"}'
    expect(parsePollinationsProtocol(unknownTool, readToolOptions)).toEqual([{ type: "text", text: unknownTool }])
    // An arguments string that is not decodable JSON stays visible text.
    const badArguments =
      '{"tool_calls":[{"type":"function","function":{"name":"read","arguments":"{not json"}}],"role":"assistant"}'
    expect(parsePollinationsProtocol(badArguments, readToolOptions)).toEqual([{ type: "text", text: badArguments }])
    // Sibling keys beyond the observed assistant-message shape stay text.
    const extraKey =
      '{"tool_calls":[{"type":"function","function":{"name":"read","arguments":"{\\"filePath\\":\\"/tmp/a\\"}"}}],"role":"assistant","finish_reason":"tool_calls"}'
    expect(parsePollinationsProtocol(extraKey, readToolOptions)).toEqual([{ type: "text", text: extraKey }])
    // A non-assistant role is not the observed dialect.
    const toolRole =
      '{"tool_calls":[{"type":"function","function":{"name":"read","arguments":"{\\"filePath\\":\\"/tmp/a\\"}"}}],"role":"tool"}'
    expect(parsePollinationsProtocol(toolRole, readToolOptions)).toEqual([{ type: "text", text: toolRole }])
    // Ordinary prose quoting the dialect is never promoted (anchored rule).
    const quoted = `Documentation may show ${extraKey} without calling anything.`
    expect(parsePollinationsProtocol(quoted, readToolOptions)).toEqual([{ type: "text", text: quoted }])
  })

  test("maps the assistant-message dialect to native content in generate", async () => {
    const result = await pollinationsProtocolMiddleware.wrapGenerate!({
      params: readToolOptions,
      model: undefined as never,
      doStream: undefined as never,
      doGenerate: async () => ({
        content: [
          {
            type: "text",
            text: '{"tool_calls":[{"id":"pollinations-call-1","type":"function","function":{"name":"read","arguments":"{\\"filePath\\":\\"/tmp/example\\"}"}}],"role":"assistant","content":"No matches for that pattern."}',
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      }),
    })
    expect(result.content).toEqual([
      { type: "text", text: "No matches for that pattern." },
      {
        type: "tool-call",
        toolCallId: "pollinations-call-0",
        toolName: "read",
        input: '{"filePath":"/tmp/example"}',
      },
    ])
    expect(result.finishReason.unified).toBe("tool-calls")
  })

  test("streams the fragmented assistant-message dialect as reasoning and a tool call", async () => {
    const events = await streamEvents(
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "upstream" },
        { type: "text-delta", id: "upstream", delta: '{"tool_calls":[{"id":"pollinations-call-2","type":"func' },
        {
          type: "text-delta",
          id: "upstream",
          delta: 'tion","function":{"name":"read","arguments":"{\\"filePath\\":\\"/tmp/example\\"}"}}],',
        },
        { type: "text-delta", id: "upstream", delta: '"reasoning_content":"Retrying the listing."}' },
        { type: "text-end", id: "upstream" },
        { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
      ],
      readToolOptions,
    )
    expect(events.map((event) => event.type)).toEqual([
      "stream-start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "tool-call",
      "finish",
    ])
    const call = events.find((event) => event.type === "tool-call")
    expect(call).toMatchObject({
      toolCallId: "pollinations-call-0",
      toolName: "read",
      input: '{"filePath":"/tmp/example"}',
    })
    expect(events.at(-1)).toMatchObject({ finishReason: { unified: "tool-calls" } })
  })

  test("promotes the dialect through wrapLanguageModel, the composition provider.ts uses", async () => {
    const { MockLanguageModelV3 } = await import("ai/test")
    const { wrapLanguageModel } = await import("ai")
    const mock = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "upstream" })
            controller.enqueue({
              type: "text-delta",
              id: "upstream",
              delta:
                '{"tool_calls":[{"id":"pollinations-call-1","type":"function","function":{"name":"read","arguments":"{\\"filePath\\":\\"/tmp/example\\"}"}}],"role":"assistant","content":"No matches for that pattern."}',
            })
            controller.enqueue({ type: "text-end", id: "upstream" })
            controller.enqueue({
              type: "finish",
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
              finishReason: { unified: "stop", raw: "stop" },
            })
            controller.close()
          },
        }),
      }),
    })
    const model = wrapLanguageModel({ model: mock, middleware: pollinationsProtocolMiddleware })
    const result = await model.doStream(readToolOptions)
    const events: LanguageModelV3StreamPart[] = []
    const reader = result.stream.getReader()
    while (true) {
      const item = await reader.read()
      if (item.done) break
      events.push(item.value)
    }
    expect(events.map((event) => event.type)).toEqual(["text-start", "text-delta", "text-end", "tool-call", "finish"])
    expect(events[3]).toMatchObject({
      toolCallId: "pollinations-call-0",
      toolName: "read",
      input: '{"filePath":"/tmp/example"}',
    })
    expect(events.at(-1)).toMatchObject({ finishReason: { unified: "tool-calls" } })
  })
})

async function streamEvents(chunks: LanguageModelV3StreamPart[], params: LanguageModelV3CallOptions = options) {
  const wrapped = await pollinationsProtocolMiddleware.wrapStream!({
    params,
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
  return events
}
