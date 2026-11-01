import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import {
  APICallError,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Prompt,
  type LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { QwenWebError } from "@opencode-ai/webchat/adapters/qwen/errors"
import { QwenWebSession } from "@opencode-ai/webchat/adapters/qwen/session"
import { ThreadStore, sanitizeThread } from "@opencode-ai/webchat/store"
import { createQwenWeb, createQwenWebModel, QwenWebLanguageModel, toApiError } from "@/provider/qwen-web/sdk"
import type { QwenWebTransport } from "@opencode-ai/webchat/adapters/qwen/transport"

function byteStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
}

/** A byte stream that emits the given SSE lines, then fails the same way a stalled transport does. */
function stalledByteStream(lines: string[], error: unknown): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < lines.length) {
        controller.enqueue(encoder.encode(lines[index++]!))
        return
      }
      controller.error(error)
    },
  })
}

interface Captured {
  calls: number
  payload?: Record<string, unknown>
  stops: Array<{ chatId: string; responseId: string | undefined }>
  aborted: boolean
}

interface SessionBehavior {
  failFirstWith?: unknown
  failAllWith?: unknown
  stream?: ReadableStream<Uint8Array>
}

function fakeUpload(behavior?: {
  failWith?: unknown
  entries?: unknown[]
  onUpload?: (
    media: Array<{ source: string; mediaType?: string; filename?: string }>,
    signal?: AbortSignal,
  ) => void | Promise<void>
}) {
  return {
    uploadAll: async (
      media: Array<{ source: string; mediaType?: string; filename?: string }>,
      signal?: AbortSignal,
    ) => {
      await behavior?.onUpload?.(media, signal)
      if (behavior?.failWith) throw behavior.failWith
      return (behavior?.entries ?? []) as never
    },
  }
}

function freshStore(): ThreadStore {
  return new ThreadStore({ file: path.join(os.tmpdir(), `qwen-webchat-sdk-${Math.random().toString(36).slice(2)}.json`) })
}

function model(
  lines: string[],
  captured: Captured,
  options?: {
    sessionBehavior?: SessionBehavior
    uploadBehavior?: { failWith?: unknown; entries?: unknown[] }
    store?: ThreadStore
    modelId?: string
  },
): QwenWebLanguageModel {
  const transport: QwenWebTransport = {
    requestJson: async (_method: string, requestPath: string, requestOptions?: { body?: string }) => {
      if (requestPath.includes("/chat/completions/stop")) {
        const body = JSON.parse(requestOptions?.body ?? "{}") as { response_id?: string }
        captured.stops.push({ chatId: "chat-1", responseId: body.response_id })
      }
      return { status: 200, statusText: "OK", contentType: "application/json", body: "{}" }
    },
    requestStream: async () => {
      throw new Error("unexpected requestStream")
    },
    rawRequestJson: async () => ({
      status: 200,
      statusText: "OK",
      contentType: "application/json",
      body: '{"chat_id":"chat-1"}',
    }),
    rawRequestStream: async (_method: string, _requestPath: string, streamOptions?: { body?: string }) => {
      captured.calls++
      if (streamOptions?.body) captured.payload = JSON.parse(streamOptions.body) as Record<string, unknown>
      if (options?.sessionBehavior?.failAllWith) throw options.sessionBehavior.failAllWith
      if (options?.sessionBehavior?.failFirstWith && captured.calls === 1) throw options.sessionBehavior.failFirstWith
      return {
        status: 200,
        contentType: "text/event-stream",
        stream: options?.sessionBehavior?.stream ?? byteStream(lines),
        abort: () => {
          captured.aborted = true
        },
      }
    },
    idleBudgetMs: () => 1000,
  } as unknown as QwenWebTransport
  const session = new QwenWebSession({
    transport,
    store: options?.store ?? freshStore(),
  })
  return new QwenWebLanguageModel(options?.modelId ?? "qwen3-max", {
    session,
    upload: fakeUpload(options?.uploadBehavior) as never,
  })
}

function modelWithTransport(transport: QwenWebTransport): QwenWebLanguageModel {
  return new QwenWebLanguageModel("qwen3-max", {
    session: new QwenWebSession({ transport, store: freshStore() }),
    upload: fakeUpload() as never,
  })
}

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const reader = stream.getReader()
  const parts: LanguageModelV3StreamPart[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) parts.push(value)
  }
  return parts
}

const CREATED = 'data: {"type":"response.created","response":{"id":"r1","chat_id":"chat-1"}}\n'
const textEvent = (content: string) =>
  `data: {"response_id":"r1","choices":[{"delta":{"phase":"answer","content":${JSON.stringify(content)}}}]}\n`

function payloadPrompt(payload: Record<string, unknown> | undefined): string {
  const messages = payload?.["messages"] as Array<{ content?: string }> | undefined
  return messages?.[0]?.content ?? ""
}

function payloadModel(payload: Record<string, unknown> | undefined): string | undefined {
  return payload?.["model"] as string | undefined
}

function payloadReasoning(payload: Record<string, unknown> | undefined): string | undefined {
  const messages = payload?.["messages"] as Array<{ feature_config?: Record<string, unknown> }> | undefined
  const config = messages?.[0]?.feature_config
  if (!config) return undefined
  if (config["thinking_mode"] === "Fast") return "fast"
  if (config["thinking_mode"] === "Thinking") return "thinking"
  if (config["auto_thinking"] === true) return "auto"
  return undefined
}

describe("QwenWebLanguageModel.doStream", () => {
  test("streams ordered text blocks with linked ids", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const { stream } = await model(
      [CREATED, textEvent("Hello"), textEvent("Hello world"), "data: [DONE]\n"],
      captured,
    ).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    const parts = await collect(stream)
    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "response-metadata",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ])
    const start = parts[2] as { id: string }
    expect((parts[3] as { id: string }).id).toBe(start.id)
    expect((parts[3] as { delta: string }).delta).toBe("Hello")
    expect((parts[4] as { delta: string }).delta).toBe(" world")
    const finish = parts[6] as { finishReason: { unified: string } }
    expect(finish.finishReason.unified).toBe("stop")
    expect(payloadModel(captured.payload)).toBe("qwen3.8-max")
    expect(payloadPrompt(captured.payload)).toContain("User: hi")
    expect(payloadReasoning(captured.payload)).toBe("auto")
  })

  test("emits tool calls without leaking tags into text", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const block = '<qw_call>\n{"name": "read", "arguments": {"p": 1}}\n</qw_call>'
    const { stream } = await model(
      [CREATED, textEvent("I'll read."), textEvent(`I'll read.\n${block}`), "data: [DONE]\n"],
      captured,
    ).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "read it" }] }],
      tools: [
        { type: "function", name: "read", inputSchema: { type: "object", properties: { p: { type: "number" } } } },
      ],
    })
    const parts = await collect(stream)
    const toolCall = parts.find((part) => part.type === "tool-call") as unknown as { toolName: string; input: string }
    expect(toolCall.toolName).toBe("read")
    expect(JSON.parse(toolCall.input)).toEqual({ p: 1 })
    const finish = parts[parts.length - 1] as { finishReason: { unified: string } }
    expect(finish.finishReason.unified).toBe("tool-calls")
    const text = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("")
    expect(text).toBe("I'll read.\n")
    expect(payloadPrompt(captured.payload)).toContain("# TOOLS AVAILABLE")
  })

  test("streams reasoning before text", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const { stream } = await model(
      [
        CREATED,
        'data: {"response_id":"r1","choices":[{"delta":{"phase":"thinking_summary","extra":{"summary_title":{"content":["Plan"]},"summary_thought":{"content":["First."]}}}}]}\n',
        textEvent("answer"),
        "data: [DONE]\n",
      ],
      captured,
    ).doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
    const parts = await collect(stream)
    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "response-metadata",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ])
    expect((parts[3] as { delta: string }).delta).toBe("**Plan**\n\nFirst.")
  })

  test("maps usage and mid-stream errors", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const { stream } = await model(
      [CREATED, textEvent("partial"), 'data: {"usage":{"input_tokens":10,"output_tokens":5}}\n', "data: [DONE]\n"],
      captured,
    ).doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
    const parts = await collect(stream)
    const finish = parts[parts.length - 1] as {
      usage: { inputTokens: { total?: number }; outputTokens: { total?: number } }
    }
    expect(finish.usage.inputTokens.total).toBe(10)
    expect(finish.usage.outputTokens.total).toBe(5)

    const failing: Captured = { calls: 0, stops: [], aborted: false }
    const bad = await model([CREATED, 'data: {"error":{"code":"E","message":"kaput"}}\n'], failing).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    const error = await collect(bad.stream).catch((e) => e)
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).isRetryable).toBe(true)
  })

  test("recover a completed tool block on stall instead of erroring", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const stall = new QwenWebError({ code: "timeout", retryable: true, message: "Qwen stream stalled." })
    const block = '<qw_call>\n{"name": "read", "arguments": {"p": 1}}\n</qw_call>'
    const { stream } = await model([], captured, {
      sessionBehavior: { stream: stalledByteStream([CREATED, textEvent(`I'll read.\n${block}`)], stall) },
    }).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "read it" }] }],
      tools: [
        { type: "function", name: "read", inputSchema: { type: "object", properties: { p: { type: "number" } } } },
      ],
    })
    const parts = await collect(stream)
    const toolCall = parts.find((part) => part.type === "tool-call") as unknown as { toolName: string; input: string }
    expect(toolCall.toolName).toBe("read")
    expect(JSON.parse(toolCall.input)).toEqual({ p: 1 })
    const finish = parts[parts.length - 1] as { finishReason: { unified: string } }
    expect(finish.finishReason.unified).toBe("tool-calls")
    const text = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("")
    expect(text).toBe("I'll read.\n")
  })

  test("recover a pending tool block on stall via parser flush", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const stall = new QwenWebError({ code: "timeout", retryable: true, message: "Qwen stream stalled." })
    const { stream } = await model([], captured, {
      sessionBehavior: {
        stream: stalledByteStream([CREATED, textEvent('<qw_call>\n{"name": "read", "arguments": {"p": 2}}')], stall),
      },
    }).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "read it" }] }],
      tools: [
        { type: "function", name: "read", inputSchema: { type: "object", properties: { p: { type: "number" } } } },
      ],
    })
    const parts = await collect(stream)
    const toolCall = parts.find((part) => part.type === "tool-call") as unknown as { toolName: string; input: string }
    expect(toolCall.toolName).toBe("read")
    expect(JSON.parse(toolCall.input)).toEqual({ p: 2 })
    const finish = parts[parts.length - 1] as { finishReason: { unified: string } }
    expect(finish.finishReason.unified).toBe("tool-calls")
  })

  test("reasoning-only stall finishes gracefully as stop", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const stall = new QwenWebError({ code: "timeout", retryable: true, message: "Qwen stream stalled." })
    const { stream } = await model([], captured, {
      sessionBehavior: {
        stream: stalledByteStream(
          [CREATED, 'data: {"response_id":"r1","choices":[{"delta":{"phase":"thinking_summary","extra":{"summary_title":{"content":["Plan"]},"summary_thought":{"content":["First."]}}}}]}\n'],
          stall,
        ),
      },
    }).doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
    const parts = await collect(stream)
    const finish = parts[parts.length - 1] as { finishReason: { unified: string } }
    expect(finish.finishReason.unified).toBe("stop")
    expect(parts.some((part) => part.type === "tool-call")).toBe(false)
  })

  test("reports unsupported settings as warnings", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const { stream } = await model([CREATED, textEvent("ok"), "data: [DONE]\n"], captured).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      temperature: 0.5,
      topP: 0.9,
      tools: [{ type: "provider", name: "search", id: "qwen-web.search" as `${string}.${string}`, args: {} }],
    })
    const parts = await collect(stream)
    const start = parts[0] as { warnings: Array<{ feature?: string }> }
    const features = start.warnings.map((warning) => warning.feature)
    expect(features).toContain("temperature")
    expect(features).toContain("sampling")
    expect(features).toContain("provider tools")
  })

  test("composes prompt overrides and reasoning mode", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    await collect(
      (
        await model([CREATED, textEvent("ok"), "data: [DONE]\n"], captured).doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
          toolChoice: { type: "required" },
          responseFormat: { type: "json" },
          stopSequences: ["STOP"],
          providerOptions: { "qwen-web": { reasoningMode: "fast" } },
        })
      ).stream,
    )
    expect(payloadPrompt(captured.payload)).toContain("MUST call at least one tool")
    expect(payloadPrompt(captured.payload)).toContain("JSON")
    expect(payloadPrompt(captured.payload)).toContain("STOP")
    expect(payloadReasoning(captured.payload)).toBe("fast")
  })

  test("thinking:false selects fast mode", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    await collect(
      (
        await model([CREATED, textEvent("ok"), "data: [DONE]\n"], captured).doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          providerOptions: { "qwen-web": { thinking: false } },
        })
      ).stream,
    )
    expect(payloadReasoning(captured.payload)).toBe("fast")
  })

  test("retries setup failures once, never auth failures", async () => {
    const retryable: Captured = { calls: 0, stops: [], aborted: false }
    const retryableError = new QwenWebError({ code: "browser_error", message: "crashed", retryable: true })
    await collect(
      (
        await model([CREATED, textEvent("ok"), "data: [DONE]\n"], retryable, {
          sessionBehavior: { failFirstWith: retryableError },
        }).doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        })
      ).stream,
    )
    expect(retryable.calls).toBe(2)

    const fatal: Captured = { calls: 0, stops: [], aborted: false }
    const loginError = new QwenWebError({ code: "login_required", message: "login", retryable: false })
    const fatalModel = await model([CREATED], fatal, { sessionBehavior: { failAllWith: loginError } }).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    const error = await collect(fatalModel.stream).catch((e) => e)
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).isRetryable).toBe(false)
    expect(fatal.calls).toBe(1)
  })

  test("aborted signals reject before setup", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const controller = new AbortController()
    controller.abort()
    const error = await model([CREATED], captured)
      .doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], abortSignal: controller.signal })
      .catch((e) => e)
    expect(error).toBeInstanceOf(APICallError)
    expect(captured.calls).toBe(0)
  })

  test("cancel stops the upstream generation with the response id", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const endless = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(CREATED))
        // Never closes: the consumer cancels instead.
      },
    })
    const languageModel = model([], captured, { sessionBehavior: { stream: endless } })
    const { stream } = await languageModel.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    const reader = stream.getReader()
    expect((await reader.read()).value?.type).toBe("stream-start")
    expect((await reader.read()).value?.type).toBe("response-metadata")
    await reader.cancel()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(captured.stops).toEqual([{ chatId: "chat-1", responseId: "r1" }])
  })

  test("upload failures surface as API errors", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const failure = new QwenWebError({ code: "unsupported", message: "too big", retryable: false })
    const error = await model([CREATED], captured, { uploadBehavior: { failWith: failure } })
      .doStream({
        prompt: [{ role: "user", content: [{ type: "file", data: "aGk=", mediaType: "image/png" }] }],
      })
      .catch((e) => e)
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).message).toContain("too big")
    expect(captured.calls).toBe(0)
  })
})

describe("QwenWebLanguageModel.doGenerate", () => {
  test("collects parts into content", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const result = await model(
      [CREATED, textEvent("Hello"), textEvent("Hello world"), "data: [DONE]\n"],
      captured,
    ).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }])
    expect(result.finishReason.unified).toBe("stop")
    expect(result.warnings).toEqual([])
  })
})

describe("incremental follow-up turns", () => {
  test("an anchored thread resends only the new user content", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const modelInstance = model([CREATED, textEvent("First answer"), "data: [DONE]\n"], captured)
    await collect(
      (
        await modelInstance.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] }],
        })
      ).stream,
    )
    expect(payloadPrompt(captured.payload)).toContain("LONG ORIGINAL CONTEXT")

    await collect(
      (
        await modelInstance.doStream({
          prompt: [
            { role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] },
            { role: "assistant", content: [{ type: "text", text: "First answer" }] },
            { role: "user", content: [{ type: "text", text: "The follow-up question." }] },
          ],
        })
      ).stream,
    )
    const follow = payloadPrompt(captured.payload)
    expect(follow).toContain("The follow-up question.")
    expect(follow).not.toContain("LONG ORIGINAL CONTEXT")
  })

  test("lite streams keep the full prompt on anchored threads", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const modelInstance = model([CREATED, textEvent("First answer"), "data: [DONE]\n"], captured)
    await collect(
      (
        await modelInstance.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] }],
        })
      ).stream,
    )
    await collect(
      (
        await modelInstance.doStream({
          prompt: [
            { role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] },
            { role: "assistant", content: [{ type: "text", text: "First answer" }] },
            { role: "user", content: [{ type: "text", text: "The follow-up question." }] },
          ],
          providerOptions: { "qwen-web": { small: true } },
        })
      ).stream,
    )
    const follow = payloadPrompt(captured.payload)
    expect(follow).toContain("LONG ORIGINAL CONTEXT")
    expect(follow).toContain("The follow-up question.")
  })

  test("the first turn on a fresh thread sends the full prompt", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const modelInstance = model([CREATED, textEvent("Answer"), "data: [DONE]\n"], captured)
    await collect(
      (
        await modelInstance.doStream({
          prompt: [
            { role: "user", content: [{ type: "text", text: "Context" }] },
            { role: "assistant", content: [{ type: "text", text: "Previous" }] },
            { role: "user", content: [{ type: "text", text: "Now" }] },
          ],
        })
      ).stream,
    )
    expect(payloadPrompt(captured.payload)).toContain("Context")
  })

  test("follow-ups with tools resend a short reminder, not the full manifest", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const modelInstance = model([CREATED, textEvent("First answer"), "data: [DONE]\n"], captured)
    await collect(
      (
        await modelInstance.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] }],
          tools: [
            {
              type: "function",
              name: "read",
              inputSchema: { type: "object", properties: { p: { type: "number" } } },
            },
          ],
        })
      ).stream,
    )
    expect(payloadPrompt(captured.payload)).toContain("# TOOLS AVAILABLE")

    await collect(
      (
        await modelInstance.doStream({
          prompt: [
            { role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] },
            { role: "assistant", content: [{ type: "text", text: "First answer" }] },
            { role: "user", content: [{ type: "text", text: "The follow-up question." }] },
          ],
          tools: [
            {
              type: "function",
              name: "read",
              inputSchema: { type: "object", properties: { p: { type: "number" } } },
            },
          ],
        })
      ).stream,
    )
    const follow = payloadPrompt(captured.payload)
    expect(follow).toContain("The follow-up question.")
    expect(follow).toContain("Tools still available")
    expect(follow).not.toContain("# TOOLS AVAILABLE")
    expect(follow).not.toContain("LONG ORIGINAL CONTEXT")
  })

  test("forced tool choices keep full instructions on follow-ups", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const modelInstance = model([CREATED, textEvent("First answer"), "data: [DONE]\n"], captured)
    await collect(
      (
        await modelInstance.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] }],
          tools: [
            {
              type: "function",
              name: "read",
              inputSchema: { type: "object", properties: { p: { type: "number" } } },
            },
          ],
        })
      ).stream,
    )
    await collect(
      (
        await modelInstance.doStream({
          prompt: [
            { role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] },
            { role: "assistant", content: [{ type: "text", text: "First answer" }] },
            { role: "user", content: [{ type: "text", text: "The follow-up question." }] },
          ],
          tools: [
            {
              type: "function",
              name: "read",
              inputSchema: { type: "object", properties: { p: { type: "number" } } },
            },
          ],
          toolChoice: { type: "tool", toolName: "read" },
        })
      ).stream,
    )
    const follow = payloadPrompt(captured.payload)
    expect(follow).toContain("# TOOLS AVAILABLE")
    expect(follow).toContain('MUST call the tool "read"')
  })

  test("tool-loop continuations send only the tool result tail", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const modelInstance = model([CREATED, textEvent("Answer"), "data: [DONE]\n"], captured)
    await collect(
      (
        await modelInstance.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "ORIGINAL CONTEXT" }] }],
        })
      ).stream,
    )
    await collect(
      (
        await modelInstance.doStream({
          prompt: [
            { role: "user", content: [{ type: "text", text: "ORIGINAL CONTEXT" }] },
            { role: "assistant", content: [{ type: "text", text: "I'll call a tool." }] },
            {
              role: "user",
              content: [{ type: "text", text: "Tool Response (read): file contents here" }],
            },
          ],
        })
      ).stream,
    )
    const follow = payloadPrompt(captured.payload)
    expect(follow).toContain("Tool Response (read): file contents here")
    expect(follow).not.toContain("ORIGINAL CONTEXT")
  })
})

describe("factories and error mapping", () => {
  test("factories build spec-compliant models", () => {
    const languageModel = createQwenWebModel("qwen3-max", { reasoningMode: "thinking" })
    expect(languageModel).toBeInstanceOf(QwenWebLanguageModel)
    expect(languageModel.modelId).toBe("qwen3-max")
    expect(languageModel.provider).toBe("qwen-web")
    expect(languageModel.specificationVersion).toBe("v3")
    expect(createQwenWeb().languageModel("x").modelId).toBe("x")
    expect(languageModel.supportedUrls).toEqual({})
  })

  test("toApiError preserves retryability and status", () => {
    const options: LanguageModelV3CallOptions = { prompt: [] }
    expect(options).toBeDefined()
    const rateLimited = toApiError(
      new QwenWebError({ code: "rate_limited", message: "slow", retryable: true, status: 429 }),
      "m",
    )
    expect(rateLimited).toBeInstanceOf(APICallError)
    expect(rateLimited.isRetryable).toBe(true)
    expect(rateLimited.statusCode).toBe(429)
    const aborted = toApiError(Object.assign(new Error("x"), { name: "AbortError" }), "m")
    expect(aborted.statusCode).toBe(499)
    expect(aborted.isRetryable).toBe(false)
    const unknown = toApiError(new Error("weird"), "m")
    expect(unknown.isRetryable).toBe(true)
    const passthrough = new APICallError({ message: "x", url: "u", requestBodyValues: {}, isRetryable: false })
    expect(toApiError(passthrough, "m")).toBe(passthrough)
  })
})
describe("issue 232: dead-chat recovery and honest errors at the SDK boundary", () => {
  const DELETED_JSON = JSON.stringify({
    success: false,
    code: "CHAT_NOT_FOUND",
    message: "This chat has been deleted. Please start a new chat to continue.",
  })
  const STALE_EVENT = 'data: {"error":{"code":"CHAT_NOT_FOUND","message":"This chat has been deleted."}}\n'
  const MODEL_NOT_FOUND_EVENT = 'data: {"error":{"code":"Not_Found","message":"Model does not exist"}}\n'
  const created = (id: string, chatId: string) =>
    `data: {"type":"response.created","response":{"id":"${id}","chat_id":"${chatId}"}}\n`
  const textFor = (responseId: string, content: string) =>
    `data: {"response_id":"${responseId}","choices":[{"delta":{"phase":"answer","content":"${content}"}}]}\n`

  type Scripted = { kind: "sse"; lines: string[] } | { kind: "json"; status: number; body: string }

  function recoveryHarness(
    completionScript: Scripted[],
    uploadEntries: unknown[] = [],
    uploadBehavior?: {
      failWith?: unknown
      onUpload?: (
        media: Array<{ source: string; mediaType?: string; filename?: string }>,
        signal?: AbortSignal,
      ) => void | Promise<void>
    },
  ) {
    const payloads: Array<{ path: string; prompt: string; files: unknown[] }> = []
    const uploadedMedia: Array<Array<{ source: string; mediaType?: string; filename?: string }>> = []
    const createdChats: string[] = []
    let completions = 0
    const transport = {
      requestJson: async () => ({ status: 200, statusText: "OK", contentType: "application/json", body: "{}" }),
      requestStream: async () => {
        throw new Error("unexpected requestStream")
      },
      rawRequestJson: async () => {
        const id = `chat-${createdChats.length + 1}`
        createdChats.push(id)
        return { status: 200, statusText: "OK", contentType: "application/json", body: JSON.stringify({ chat_id: id }) }
      },
      rawRequestStream: async (_method: string, requestPath: string, options?: { body?: string }) => {
        const body = JSON.parse(options?.body ?? "{}") as { messages?: Array<{ content?: string; files?: unknown[] }> }
        payloads.push({
          path: requestPath,
          prompt: body.messages?.[0]?.content ?? "",
          files: body.messages?.[0]?.files ?? [],
        })
        const result = completionScript[Math.min(completions, completionScript.length - 1)]!
        completions++
        if (result.kind === "json") {
          return { status: result.status, contentType: "application/json", stream: byteStream([result.body]), abort: () => {} }
        }
        return { status: 200, contentType: "text/event-stream", stream: byteStream(result.lines), abort: () => {} }
      },
      idleBudgetMs: () => 1000,
    } as unknown as QwenWebTransport
    const store = freshStore()
    const session = new QwenWebSession({ transport, store })
    const languageModel = new QwenWebLanguageModel("qwen3-max", {
      session,
      upload: fakeUpload({
        entries: uploadEntries,
        failWith: uploadBehavior?.failWith,
        onUpload: async (media, signal) => {
          uploadedMedia.push(media.map((item) => ({ ...item })))
          await uploadBehavior?.onUpload?.(media, signal)
        },
      }) as never,
    })
    return { languageModel, session, store, payloads, uploadedMedia, createdChats }
  }

  const followUpPrompt: LanguageModelV3Prompt = [
    { role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] },
    { role: "assistant", content: [{ type: "text", text: "First answer" }] },
    { role: "user", content: [{ type: "text", text: "The follow-up question." }] },
  ]

  test("a deleted chat recovers once and re-sends the FULL prompt, not the trimmed tail", async () => {
    const harness = recoveryHarness([
      { kind: "sse", lines: [CREATED, textEvent("First answer"), "data: [DONE]\n"] },
      { kind: "json", status: 200, body: DELETED_JSON },
      { kind: "sse", lines: [created("r2", "chat-2"), textFor("r2", "Second answer"), "data: [DONE]\n"] },
    ])

    // Turn 1 anchors the thread on chat-1.
    await collect(
      (
        await harness.languageModel.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] }],
        })
      ).stream,
    )
    expect(harness.payloads[0]!.prompt).toContain("LONG ORIGINAL CONTEXT")

    // Turn 2's trimmed tail hits CHAT_NOT_FOUND; the caller sees one clean stream.
    const parts = await collect((await harness.languageModel.doStream({ prompt: [...followUpPrompt] })).stream)

    expect(harness.createdChats).toEqual(["chat-1", "chat-2"])
    expect(harness.payloads).toHaveLength(3)
    // Attempt 1: the incremental tail against the dead chat.
    expect(harness.payloads[1]!.path).toContain("chat_id=chat-1")
    expect(harness.payloads[1]!.prompt).not.toContain("LONG ORIGINAL CONTEXT")
    // Attempt 2: fresh chat, FULL prompt (the fresh chat has no transcript).
    expect(harness.payloads[2]!.path).toContain("chat_id=chat-2")
    expect(harness.payloads[2]!.prompt).toContain("LONG ORIGINAL CONTEXT")
    expect(harness.payloads[2]!.prompt).toContain("The follow-up question.")
    expect(parts.some((part) => part.type === "text-delta")).toBe(true)
    expect((parts.at(-1) as { finishReason?: { unified?: string } }).finishReason?.unified).toBe("stop")
  })

  test("a non-chat Not_Found stream error preserves the live binding and incremental follow-ups", async () => {
    const harness = recoveryHarness([
      { kind: "sse", lines: [CREATED, textEvent("First answer"), "data: [DONE]\n"] },
      { kind: "sse", lines: [MODEL_NOT_FOUND_EVENT] },
      { kind: "sse", lines: [created("r3", "chat-1"), textFor("r3", "Retried"), "data: [DONE]\n"] },
    ])

    await collect(
      (
        await harness.languageModel.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] }],
        })
      ).stream,
    )
    const error = await collect((await harness.languageModel.doStream({ prompt: [...followUpPrompt] })).stream).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).message).toContain("Model does not exist")
    expect(harness.payloads).toHaveLength(2)
    expect(harness.createdChats).toEqual(["chat-1"])
    expect(harness.store.all()[0]!.providerId).toBe("chat-1")
    expect(harness.store.all()[0]!.messages.some((message) => message.providerState?.["responseId"] === "r1")).toBe(true)

    await collect((await harness.languageModel.doStream({ prompt: [...followUpPrompt] })).stream)
    expect(harness.payloads).toHaveLength(3)
    expect(harness.payloads[2]!.path).toContain("chat_id=chat-1")
    expect(harness.payloads[2]!.prompt).toContain("The follow-up question.")
    expect(harness.payloads[2]!.prompt).not.toContain("LONG ORIGINAL CONTEXT")
    expect(harness.createdChats).toEqual(["chat-1"])
  })

  test("a text-only follow-up preserves prior image attachments during fresh-chat recovery", async () => {
    const priorImage = { type: "image", id: "prior-image", url: "https://files.test/prior.png", name: "prior.png" }
    const harness = recoveryHarness(
      [
        { kind: "sse", lines: [CREATED, textEvent("First answer"), "data: [DONE]\n"] },
        { kind: "json", status: 200, body: DELETED_JSON },
        { kind: "sse", lines: [created("r3", "chat-2"), textFor("r3", "Recovered"), "data: [DONE]\n"] },
      ],
      [priorImage],
    )
    const originalPrompt: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this picture." },
          { type: "file", data: "aW1hZ2U=", mediaType: "image/png", filename: "prior.png" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "It shows a landscape." }] },
    ]
    const followUpPrompt: LanguageModelV3Prompt = [
      ...originalPrompt,
      { role: "user", content: [{ type: "text", text: "What color is the sky?" }] },
    ]

    await collect((await harness.languageModel.doStream({ prompt: [originalPrompt[0]!] })).stream)
    await collect((await harness.languageModel.doStream({ prompt: followUpPrompt })).stream)

    expect(harness.payloads[0]!.files).toEqual([priorImage])
    expect(harness.payloads[1]!.prompt).toContain("What color is the sky?")
    expect(harness.payloads[1]!.prompt).not.toContain("Describe this picture.")
    expect(harness.payloads[1]!.files).toEqual([])
    expect(harness.payloads[2]!.prompt).toContain("Describe this picture.")
    expect(harness.payloads[2]!.files).toEqual([priorImage])
    expect(harness.uploadedMedia).toHaveLength(2)
    expect(harness.uploadedMedia[1]![0]!.filename).toBe("prior.png")
  })

  test("full-prompt media upload is lazy and a recovery upload failure stops before fresh completion", async () => {
    const priorImage = { type: "image", id: "prior-image", url: "https://files.test/prior.png", name: "prior.png" }
    let uploadCount = 0
    const harness = recoveryHarness(
      [
        { kind: "sse", lines: [CREATED, textEvent("First answer"), "data: [DONE]\n"] },
        { kind: "json", status: 200, body: DELETED_JSON },
        { kind: "sse", lines: [created("r3", "chat-2"), textFor("r3", "Recovered"), "data: [DONE]\n"] },
      ],
      [priorImage],
      {
        onUpload: () => {
          uploadCount++
          if (uploadCount === 2) {
            throw new QwenWebError({ code: "network_error", retryable: true, message: "recovery upload failed" })
          }
        },
      },
    )
    const imageMessage = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Describe this picture." },
        { type: "file" as const, data: "aW1hZ2U=", mediaType: "image/png", filename: "prior.png" },
      ],
    }
    const followUp: LanguageModelV3Prompt = [
      imageMessage,
      { role: "assistant", content: [{ type: "text", text: "It shows a landscape." }] },
      { role: "user", content: [{ type: "text", text: "What color is the sky?" }] },
    ]

    await collect((await harness.languageModel.doStream({ prompt: [imageMessage] })).stream)
    expect(uploadCount).toBe(1)
    const error = await collect((await harness.languageModel.doStream({ prompt: followUp })).stream).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).message).toContain("recovery upload failed")
    expect(uploadCount).toBe(2)
    expect(harness.payloads).toHaveLength(2)
    expect(harness.payloads[1]!.files).toEqual([])
    expect(harness.createdChats).toEqual(["chat-1"])
    expect(harness.store.all()[0]!.providerId).toBeUndefined()
    expect(harness.store.all()[0]!.messages.some((message) => message.content === "What color is the sky?")).toBe(false)
  })

  test("aborting a lazy recovery upload prevents the fresh-chat completion", async () => {
    const priorImage = { type: "image", id: "prior-image", url: "https://files.test/prior.png", name: "prior.png" }
    let uploadCount = 0
    let resolveUploadStarted: (() => void) | undefined
    const uploadStarted = new Promise<void>((resolve) => {
      resolveUploadStarted = resolve
    })
    let recoverySignal: AbortSignal | undefined
    const harness = recoveryHarness(
      [
        { kind: "sse", lines: [CREATED, textEvent("First answer"), "data: [DONE]\n"] },
        { kind: "json", status: 200, body: DELETED_JSON },
        { kind: "sse", lines: [created("r3", "chat-2"), textFor("r3", "Recovered"), "data: [DONE]\n"] },
      ],
      [priorImage],
      {
        onUpload: (_media, signal) => {
          uploadCount++
          if (uploadCount === 1) return
          recoverySignal = signal
          resolveUploadStarted?.()
          return new Promise<void>((_resolve, reject) => {
            const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"))
            if (signal?.aborted) onAbort()
            else signal?.addEventListener("abort", onAbort, { once: true })
          })
        },
      },
    )
    const imageMessage = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Describe this picture." },
        { type: "file" as const, data: "aW1hZ2U=", mediaType: "image/png", filename: "prior.png" },
      ],
    }
    const followUp: LanguageModelV3Prompt = [
      imageMessage,
      { role: "assistant", content: [{ type: "text", text: "It shows a landscape." }] },
      { role: "user", content: [{ type: "text", text: "What color is the sky?" }] },
    ]

    await collect((await harness.languageModel.doStream({ prompt: [imageMessage] })).stream)
    const abort = new AbortController()
    const { stream } = await harness.languageModel.doStream({ prompt: followUp, abortSignal: abort.signal })
    const reading = collect(stream).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    await uploadStarted
    expect(recoverySignal).toBeDefined()
    expect(recoverySignal?.aborted).toBe(false)

    abort.abort()
    const error = await reading

    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).isRetryable).toBe(false)
    expect(recoverySignal?.aborted).toBe(true)
    expect(harness.payloads).toHaveLength(2)
    expect(harness.createdChats).toEqual(["chat-1"])
    expect(harness.store.all()[0]!.providerId).toBeUndefined()
    expect(harness.store.all()[0]!.messages.some((message) => message.content === "What color is the sky?")).toBe(false)
  })

  test("an anchored thread without a live chat binding keeps the full prompt", async () => {
    const harness = recoveryHarness([{ kind: "sse", lines: [CREATED, textEvent("First answer"), "data: [DONE]\n"] }])
    await collect(
      (
        await harness.languageModel.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] }],
        })
      ).stream,
    )
    // Simulate a poisoned legacy threads.json: anchors survived, binding gone.
    const thread = (harness.session as unknown as { store: ThreadStore }).store.all()[0]!
    expect(thread.messages.at(-1)?.providerState).toEqual({ responseId: "r1" })
    thread.providerId = undefined

    await collect((await harness.languageModel.doStream({ prompt: [...followUpPrompt] })).stream)
    expect(harness.payloads[1]!.prompt).toContain("LONG ORIGINAL CONTEXT")
    expect(harness.payloads[1]!.prompt).toContain("The follow-up question.")
  })

  test("a mid-stream dead chat after output fails the stream and unbinds the thread", async () => {
    const harness = recoveryHarness([
      { kind: "sse", lines: [CREATED, textEvent("First answer"), "data: [DONE]\n"] },
      { kind: "sse", lines: [created("r2", "chat-1"), textFor("r2", "partial"), STALE_EVENT] },
      { kind: "sse", lines: [created("r3", "chat-2"), textFor("r3", "Recovered"), "data: [DONE]\n"] },
    ])
    await collect(
      (
        await harness.languageModel.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] }],
        })
      ).stream,
    )

    // Output already reached the caller, so the turn fails honestly instead of re-running.
    const error = await collect((await harness.languageModel.doStream({ prompt: [...followUpPrompt] })).stream).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).message).toContain("no longer valid")
    expect((error as APICallError).isRetryable).toBe(true)

    // The dead binding was dropped: the next turn starts fresh with the FULL prompt.
    await collect((await harness.languageModel.doStream({ prompt: [...followUpPrompt] })).stream)
    expect(harness.createdChats).toEqual(["chat-1", "chat-2"])
    const last = harness.payloads.at(-1)!
    expect(last.path).toContain("chat_id=chat-2")
    expect(last.prompt).toContain("LONG ORIGINAL CONTEXT")
  })

  test("a mid-stream dead chat after response-metadata alone fails the stream honestly and unbinds the thread (issue 238)", async () => {
    const harness = recoveryHarness([
      { kind: "sse", lines: [CREATED, textEvent("First answer"), "data: [DONE]\n"] },
      { kind: "sse", lines: [created("r2", "chat-1"), STALE_EVENT] },
      { kind: "sse", lines: [created("r3", "chat-2"), textFor("r3", "Recovered"), "data: [DONE]\n"] },
    ])
    await collect(
      (
        await harness.languageModel.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] }],
        })
      ).stream,
    )

    // response-metadata was emitted before CHAT_NOT_FOUND; the turn surfaces the error honestly
    // rather than retrying on a fresh chat and emitting duplicate/conflicting response metadata.
    const error = await collect((await harness.languageModel.doStream({ prompt: [...followUpPrompt] })).stream).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).message).toContain("no longer valid")
    expect((error as APICallError).isRetryable).toBe(true)
    expect(harness.createdChats).toEqual(["chat-1"]) // No second chat created during the failed turn
    expect(harness.payloads).toHaveLength(2)

    // The dead binding was dropped: the next turn starts fresh with the FULL prompt on a new chat.
    await collect((await harness.languageModel.doStream({ prompt: [...followUpPrompt] })).stream)
    expect(harness.createdChats).toEqual(["chat-1", "chat-2"])
    const last = harness.payloads.at(-1)!
    expect(last.path).toContain("chat_id=chat-2")
    expect(last.prompt).toContain("LONG ORIGINAL CONTEXT")
  })

  test("a mapped stale-after-text error persists the unbinding before generator.return", async () => {
    const file = path.join(os.tmpdir(), `qwen-webchat-sdk-reload-${Math.random().toString(36).slice(2)}.json`)
    const store = new ThreadStore({ file })
    const scope = "issue232-stale-persist"
    const threadId = `qwen-web:qwen3.8-max:${scope}`
    const now = Date.now()
    store.put({
      id: threadId,
      model: "qwen3.8-max",
      providerId: "dead-chat",
      messages: [
        { id: "u0", role: "user", content: "Earlier", parts: [{ type: "text", text: "Earlier" }] },
        {
          id: "a0",
          role: "assistant",
          content: "Earlier answer",
          parts: [{ type: "text", text: "Earlier answer" }],
          providerState: { responseId: "r-old" },
        },
      ],
      createdAt: now,
      updatedAt: now,
    })
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const languageModel = model([], captured, {
      store,
      modelId: "qwen3.8-max",
      sessionBehavior: { stream: byteStream([CREATED, textEvent("partial text"), STALE_EVENT]) },
    })
    const { stream } = await languageModel.doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "Earlier" }] },
        { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] },
        { role: "user", content: [{ type: "text", text: "Continue" }] },
      ],
      providerOptions: { "qwen-web": { threadId: scope } },
    })
    const reader = stream.getReader()
    const parts: LanguageModelV3StreamPart[] = []
    let streamError: unknown
    for (;;) {
      try {
        const next = await reader.read()
        if (next.done) break
        if (next.value) parts.push(next.value)
      } catch (error) {
        streamError = error
        break
      }
    }
    expect(streamError).toBeInstanceOf(APICallError)
    expect(parts.some((part) => part.type === "response-metadata")).toBe(true)
    expect(parts.some((part) => part.type === "text-delta" && part.delta === "partial text")).toBe(true)
    expect(captured.calls).toBe(1)
    const reloaded = new ThreadStore({ file }).get(threadId)
    expect(reloaded?.providerId).toBeUndefined()
    expect(reloaded?.messages.some((message) => message.providerState?.["responseId"] === "r-old")).toBe(false)
  })

  test("an empty upstream turn surfaces a non-retryable API error, not a silent stop", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const { stream } = await model([CREATED, "data: [DONE]\n"], captured).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    const error = await collect(stream).catch((e) => e)
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).isRetryable).toBe(false)
    expect((error as APICallError).message).toContain("empty response")
  })
})

describe("workstream 232 cancellation cleanup (sdk)", () => {
  test("abort before setup throws abort identity; no upstream request", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const ac = new AbortController()
    ac.abort()
    const modelInst = model([CREATED], captured)
    const err = await modelInst.doStream({ prompt: "test" as never, abortSignal: ac.signal }).catch((e) => e)
    // Must be the abort path, not a generic TypeError from a regression
    const isAbort = (err instanceof APICallError && err.statusCode === 499) || (err instanceof Error && /aborted/i.test(err.message))
    expect(isAbort).toBe(true)
    // A retryable abort error is worse than the old behavior: pin it at the SDK boundary.
    expect(err).toBeInstanceOf(APICallError)
    expect((err as APICallError).isRetryable).toBe(false)
    expect(captured.calls).toBe(0)
    expect(captured.stops.length).toBe(0)
  })

  test("stalled stream + abort cleans up promptly; no extra finish/text after abort", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const ac = new AbortController()
    const stall = new Error("stalled")
    const modelInst = model([CREATED, textEvent("hello")], captured, {
      sessionBehavior: { stream: stalledByteStream([CREATED, textEvent("hello")], stall) },
    })
    const { stream } = await modelInst.doStream({ prompt: "test" as never, abortSignal: ac.signal })
    const reader = stream.getReader()
    // Consume first chunk, then abort
    const first = await reader.read()
    expect(first.done).toBe(false)
    ac.abort()
    // After abort the stream must settle (error or close) quickly: a hang fails.
    let timedOut = false
    const outcome = await Promise.race([
      (async () => {
        try {
          const chunks: unknown[] = []
          for (;;) {
            const r = await reader.read()
            if (r.done) break
            chunks.push(r.value)
          }
          return { chunks }
        } catch (error) {
          return { error }
        }
      })(),
      new Promise<{ timedout: true }>((resolve) =>
        setTimeout(() => {
          timedOut = true
          resolve({ timedout: true })
        }, 500),
      ),
    ])
    expect(timedOut).toBe(false)
    if ("chunks" in outcome) {
      // Closed cleanly: no further output after the abort.
      const types = (outcome.chunks as unknown[]).map((v: any) => v?.type)
      expect(types).not.toContain("text-delta")
      expect(types.filter((t) => t === "finish")).toHaveLength(0)
    } else if ("error" in outcome) {
      // Errored: it must be the abort, not the upstream "stalled" error.
      expect(String((outcome.error as any)?.message ?? outcome.error)).toMatch(/abort/i)
    }
    await reader.cancel().catch(() => {})
  })
})

describe("issue 232 workstream 3: transcript divergence detection before trimming", () => {
  const createdEvent = (id: string, chatId: string) =>
    `data: {"type":"response.created","response":{"id":"${id}","chat_id":"${chatId}"}}\n`
  const textFor = (responseId: string, content: string) =>
    `data: {"response_id":"${responseId}","choices":[{"delta":{"phase":"answer","content":${JSON.stringify(content)}}}]}\n`
  const DONE = "data: [DONE]\n"

  interface DivergencePayload {
    path: string
    prompt: string
    parentId: unknown
    files: unknown[]
  }

  /**
   * Scripted all-success harness: every chat creation yields `chat-N`, every
   * completion yields response `rN` ("Answer N") on the chat its path names.
   * `uploads.entries` is mutable so a test can swap what the fake uploader
   * returns between turns; every upload call is recorded in `uploadedMedia`.
   */
  function divergenceHarness(options?: { store?: ThreadStore }) {
    const payloads: DivergencePayload[] = []
    const uploadedMedia: Array<Array<{ source: string; mediaType?: string; filename?: string }>> = []
    const createdChats: string[] = []
    // fakeUpload reads `entries` off this exact object per call, so tests can
    // swap what the uploader returns between turns via `harness.uploads`.
    const uploads = {
      entries: [] as unknown[],
      onUpload: async (media: Array<{ source: string; mediaType?: string; filename?: string }>) => {
        uploadedMedia.push(media.map((item) => ({ ...item })))
      },
    }
    let completions = 0
    const transport = {
      requestJson: async () => ({ status: 200, statusText: "OK", contentType: "application/json", body: "{}" }),
      requestStream: async () => {
        throw new Error("unexpected requestStream")
      },
      rawRequestJson: async () => {
        const id = `chat-${createdChats.length + 1}`
        createdChats.push(id)
        return { status: 200, statusText: "OK", contentType: "application/json", body: JSON.stringify({ chat_id: id }) }
      },
      rawRequestStream: async (_method: string, requestPath: string, requestOptions?: { body?: string }) => {
        const body = JSON.parse(requestOptions?.body ?? "{}") as {
          parent_id?: unknown
          messages?: Array<{ content?: string; files?: unknown[] }>
        }
        payloads.push({
          path: requestPath,
          prompt: body.messages?.[0]?.content ?? "",
          parentId: body.parent_id,
          files: body.messages?.[0]?.files ?? [],
        })
        completions++
        const chatId = /chat_id=([^&]+)/.exec(requestPath)?.[1] ?? "chat-?"
        const responseId = `r${completions}`
        return {
          status: 200,
          contentType: "text/event-stream",
          stream: byteStream([createdEvent(responseId, chatId), textFor(responseId, `Answer ${completions}`), DONE]),
          abort: () => {},
        }
      },
      idleBudgetMs: () => 1000,
    } as unknown as QwenWebTransport
    const store = options?.store ?? freshStore()
    const session = new QwenWebSession({ transport, store })
    const languageModel = new QwenWebLanguageModel("qwen3-max", {
      session,
      upload: fakeUpload(uploads) as never,
    })
    return {
      languageModel,
      store,
      payloads,
      uploadedMedia,
      createdChats,
      uploads,
      thread(scope?: string) {
        const threads = store.all()
        return scope ? threads.find((thread) => thread.id.endsWith(`:${scope}`)) : threads[0]
      },
    }
  }

  const user = (text: string): LanguageModelV3Prompt[number] => ({
    role: "user",
    content: [{ type: "text", text }],
  })
  const assistant = (text: string): LanguageModelV3Prompt[number] => ({
    role: "assistant",
    content: [{ type: "text", text }],
  })

  test("same-provider follow-ups keep trimming and the cursor survives a restart", async () => {
    const file = path.join(os.tmpdir(), `qwen-webchat-sdk-cursor-${Math.random().toString(36).slice(2)}.json`)
    const harness = divergenceHarness({ store: new ThreadStore({ file }) })
    // Production callers scope threads by agent+session (withQwenWebThreadScope),
    // which is stable across restarts; without it each model instance falls
    // back to its own random instance scope. Pin the scope to model a restart.
    const scope = { "qwen-web": { threadId: "ws3-restart" } }

    await collect(
      (await harness.languageModel.doStream({ prompt: [user("LONG ORIGINAL CONTEXT")], providerOptions: scope }))
        .stream,
    )
    expect(harness.createdChats).toEqual(["chat-1"])
    expect(harness.payloads[0]!.prompt).toContain("LONG ORIGINAL CONTEXT")

    // The commit persisted a provenance cursor alongside the anchor.
    const persisted = new ThreadStore({ file }).all()[0]!
    expect(persisted.providerId).toBe("chat-1")
    expect(persisted.contextCursor?.messages).toBe(1)
    expect(persisted.contextCursor?.fingerprint).toMatch(/^[0-9a-f]{64}$/)

    // Simulated restart: a fresh session/model over the same threads file.
    const restarted = divergenceHarness({ store: new ThreadStore({ file }) })
    const followUp: LanguageModelV3Prompt = [
      user("LONG ORIGINAL CONTEXT"),
      assistant("Answer 1"),
      user("The follow-up question."),
    ]
    await collect((await restarted.languageModel.doStream({ prompt: followUp, providerOptions: scope })).stream)

    expect(restarted.createdChats).toEqual([]) // no rebind: the cursor verified
    expect(restarted.payloads[0]!.path).toContain("chat_id=chat-1")
    expect(restarted.payloads[0]!.parentId).toBe("r1")
    expect(restarted.payloads[0]!.prompt).toContain("The follow-up question.")
    expect(restarted.payloads[0]!.prompt).not.toContain("LONG ORIGINAL CONTEXT")
    // The follow-up's own commit refreshed the persisted cursor.
    const after = new ThreadStore({ file }).all()[0]!
    expect(after.contextCursor?.messages).toBe(3)
    expect(after.contextCursor?.fingerprint).not.toBe(persisted.contextCursor?.fingerprint)
  })

  test("a Qwen -> other provider -> Qwen sequence rebinds on a fresh chat with the FULL transcript", async () => {
    const harness = divergenceHarness()
    const u1 = user("LONG ORIGINAL CONTEXT")
    await collect((await harness.languageModel.doStream({ prompt: [u1] })).stream)
    expect(harness.createdChats).toEqual(["chat-1"])

    // Intervening turns ran on ANOTHER provider: the Qwen thread never saw
    // them, but the session history now carries them.
    const backToQwen: LanguageModelV3Prompt = [
      u1,
      assistant("Answer 1"),
      user("Question routed elsewhere."),
      assistant("OTHER PROVIDER REPLY"),
      user("Back to Qwen."),
    ]
    await collect((await harness.languageModel.doStream({ prompt: backToQwen })).stream)

    // Divergence detected: fresh chat, full prompt, no chaining onto the old
    // chat's anchor — the context Qwen never saw is included, not dropped.
    expect(harness.createdChats).toEqual(["chat-1", "chat-2"])
    const rebind = harness.payloads[1]!
    expect(rebind.path).toContain("chat_id=chat-2")
    expect(rebind.parentId).toBeNull()
    expect(rebind.prompt).toContain("LONG ORIGINAL CONTEXT")
    expect(rebind.prompt).toContain("OTHER PROVIDER REPLY")
    expect(rebind.prompt).toContain("Back to Qwen.")

    // The stale binding/anchors were replaced, not merely bypassed.
    const thread = harness.thread()!
    expect(thread.providerId).toBe("chat-2")
    expect(thread.messages.some((message) => message.providerState?.["responseId"] === "r1")).toBe(false)
    expect(thread.messages.some((message) => message.providerState?.["responseId"] === "r2")).toBe(true)

    // The rebound chat is a verified mirror again: the next follow-up trims.
    const next: LanguageModelV3Prompt = [...backToQwen, assistant("Answer 2"), user("Follow-up after rebind.")]
    await collect((await harness.languageModel.doStream({ prompt: next })).stream)
    expect(harness.createdChats).toEqual(["chat-1", "chat-2"])
    const follow = harness.payloads[2]!
    expect(follow.path).toContain("chat_id=chat-2")
    expect(follow.parentId).toBe("r2")
    expect(follow.prompt).toContain("Follow-up after rebind.")
    expect(follow.prompt).not.toContain("LONG ORIGINAL CONTEXT")
    expect(follow.prompt).not.toContain("OTHER PROVIDER REPLY")
  })

  test("an edited earlier message rebinds on a fresh chat instead of trimming", async () => {
    const harness = divergenceHarness()
    await collect((await harness.languageModel.doStream({ prompt: [user("LONG ORIGINAL CONTEXT")] })).stream)

    const edited: LanguageModelV3Prompt = [
      user("CORRECTED CONTEXT"),
      assistant("Answer 1"),
      user("The follow-up question."),
    ]
    await collect((await harness.languageModel.doStream({ prompt: edited })).stream)

    expect(harness.createdChats).toEqual(["chat-1", "chat-2"])
    const rebind = harness.payloads[1]!
    expect(rebind.path).toContain("chat_id=chat-2")
    expect(rebind.parentId).toBeNull()
    expect(rebind.prompt).toContain("CORRECTED CONTEXT")
    expect(rebind.prompt).toContain("The follow-up question.")
    expect(harness.thread()!.messages.some((message) => message.providerState?.["responseId"] === "r1")).toBe(false)
  })

  test("an edit that drops the committed response rebinds instead of chaining the stale anchor", async () => {
    const harness = divergenceHarness()
    await collect((await harness.languageModel.doStream({ prompt: [user("LONG ORIGINAL CONTEXT")] })).stream)
    expect(harness.thread()!.providerId).toBe("chat-1")

    // The caller removed the assistant reply: the prompt has no assistant
    // message at all, but the thread still holds a live binding + anchor
    // from the committed turn. Chaining the stale anchor would replay the
    // full prompt under a response the caller discarded.
    const noAssistant: LanguageModelV3Prompt = [user("LONG ORIGINAL CONTEXT"), user("Actually, answer this instead.")]
    await collect((await harness.languageModel.doStream({ prompt: noAssistant })).stream)

    expect(harness.createdChats).toEqual(["chat-1", "chat-2"])
    const rebind = harness.payloads[1]!
    expect(rebind.path).toContain("chat_id=chat-2")
    expect(rebind.parentId).toBeNull()
    expect(rebind.prompt).toContain("Actually, answer this instead.")
    expect(harness.thread()!.messages.some((message) => message.providerState?.["responseId"] === "r1")).toBe(false)
  })

  test("a compacted history rebinds on a fresh chat with the full rendered prompt", async () => {
    const harness = divergenceHarness()
    await collect((await harness.languageModel.doStream({ prompt: [user("LONG ORIGINAL CONTEXT")] })).stream)
    // A normal trimmed follow-up first, so the cursor describes [u1, a1, u2].
    await collect(
      (
        await harness.languageModel.doStream({
          prompt: [user("LONG ORIGINAL CONTEXT"), assistant("Answer 1"), user("More work.")],
        })
      ).stream,
    )
    expect(harness.payloads[1]!.prompt).not.toContain("LONG ORIGINAL CONTEXT")
    expect(harness.createdChats).toEqual(["chat-1"])

    // Compaction replaces the older turns with a summary: the prefix no
    // longer matches what chat-1 mirrors.
    const compacted: LanguageModelV3Prompt = [
      user("COMPACTED SUMMARY of earlier turns."),
      assistant("Understood."),
      user("Continue from the summary."),
    ]
    await collect((await harness.languageModel.doStream({ prompt: compacted })).stream)

    expect(harness.createdChats).toEqual(["chat-1", "chat-2"])
    const rebind = harness.payloads[2]!
    expect(rebind.path).toContain("chat_id=chat-2")
    expect(rebind.parentId).toBeNull()
    expect(rebind.prompt).toContain("COMPACTED SUMMARY of earlier turns.")
    expect(rebind.prompt).toContain("Continue from the summary.")
    expect(rebind.prompt).not.toContain("LONG ORIGINAL CONTEXT")
  })

  test("a legacy thread without a cursor rebinds once, then trims again", async () => {
    const store = freshStore()
    const scope = "ws3-legacy"
    // NB: the harness model "qwen3-max" maps to the upstream id "qwen3.8-max"
    // (toUpstreamModelId), and the thread key embeds the UPSTREAM id - so the
    // seed must use qwen3.8-max here or the session never finds this thread.
    const threadId = `qwen-web:qwen3.8-max:${scope}`
    const now = Date.now()
    store.put({
      id: threadId,
      model: "qwen3.8-max",
      providerId: "legacy-chat",
      messages: [
        { id: "u0", role: "user", content: "Earlier", parts: [{ type: "text", text: "Earlier" }] },
        {
          id: "a0",
          role: "assistant",
          content: "Earlier answer",
          parts: [{ type: "text", text: "Earlier answer" }],
          providerState: { responseId: "r-old" },
        },
      ],
      createdAt: now,
      updatedAt: now,
    })
    const harness = divergenceHarness({ store })
    const prompt: LanguageModelV3Prompt = [user("Earlier"), assistant("Earlier answer"), user("Continue")]
    await collect(
      (await harness.languageModel.doStream({ prompt, providerOptions: { "qwen-web": { threadId: scope } } })).stream,
    )

    // The unverifiable binding was not trusted: the legacy chat was never
    // addressed, a fresh one was created, and the FULL prompt was sent.
    expect(harness.createdChats).toEqual(["chat-1"])
    expect(harness.payloads[0]!.path).toContain("chat_id=chat-1")
    expect(harness.payloads[0]!.path).not.toContain("legacy-chat")
    expect(harness.payloads[0]!.parentId).toBeNull()
    expect(harness.payloads[0]!.prompt).toContain("Earlier")
    expect(harness.payloads[0]!.prompt).toContain("Continue")

    // Self-healed: a cursor now exists and the next follow-up trims again.
    const thread = harness.thread(scope)!
    // Pin the premise: the thread that got rebound must be the SEEDED legacy
    // one. Without this the whole test passes vacuously if the seed id/model
    // drifts from what the session derives (a fresh thread satisfies every
    // assertion below while testing nothing about legacy rebinding).
    expect(thread.id).toBe(threadId)
    expect(thread.messages.map((message) => message.id)).toContain("u0")
    expect(thread.providerId).toBe("chat-1")
    expect(thread.contextCursor?.messages).toBe(3)
    expect(thread.messages.some((message) => message.providerState?.["responseId"] === "r-old")).toBe(false)

    const followUp: LanguageModelV3Prompt = [...prompt, assistant("Answer 1"), user("And next?")]
    await collect(
      (
        await harness.languageModel.doStream({ prompt: followUp, providerOptions: { "qwen-web": { threadId: scope } } })
      ).stream,
    )
    expect(harness.createdChats).toEqual(["chat-1"])
    expect(harness.payloads[1]!.path).toContain("chat_id=chat-1")
    expect(harness.payloads[1]!.prompt).toContain("And next?")
    expect(harness.payloads[1]!.prompt).not.toContain("Earlier")
  })

  test("per-agent/session scopes keep their bindings and cursors isolated", async () => {
    const harness = divergenceHarness()
    const scopeA = { "qwen-web": { threadId: "scope-a" } }
    const scopeB = { "qwen-web": { threadId: "scope-b" } }

    await collect(
      (await harness.languageModel.doStream({ prompt: [user("Session A context")], providerOptions: scopeA })).stream,
    )
    await collect(
      (await harness.languageModel.doStream({ prompt: [user("Session B context")], providerOptions: scopeB })).stream,
    )
    expect(harness.createdChats).toEqual(["chat-1", "chat-2"])

    // Each scope trims on ITS OWN chat: scope B's activity never invalidated
    // scope A's cursor (and vice versa).
    await collect(
      (
        await harness.languageModel.doStream({
          prompt: [user("Session A context"), assistant("Answer 1"), user("A follow-up")],
          providerOptions: scopeA,
        })
      ).stream,
    )
    await collect(
      (
        await harness.languageModel.doStream({
          prompt: [user("Session B context"), assistant("Answer 2"), user("B follow-up")],
          providerOptions: scopeB,
        })
      ).stream,
    )
    expect(harness.createdChats).toEqual(["chat-1", "chat-2"])

    const followA = harness.payloads[2]!
    const followB = harness.payloads[3]!
    expect(followA.path).toContain("chat_id=chat-1")
    expect(followA.parentId).toBe("r1")
    expect(followA.prompt).toContain("A follow-up")
    expect(followA.prompt).not.toContain("Session A context")
    expect(followA.prompt).not.toContain("Session B context")
    expect(followB.path).toContain("chat_id=chat-2")
    expect(followB.parentId).toBe("r2")
    expect(followB.prompt).toContain("B follow-up")
    expect(followB.prompt).not.toContain("Session B context")

    const threadA = harness.thread("scope-a")!
    const threadB = harness.thread("scope-b")!
    expect(threadA.providerId).toBe("chat-1")
    expect(threadB.providerId).toBe("chat-2")
    expect(threadA.contextCursor?.fingerprint).not.toBe(threadB.contextCursor?.fingerprint)
    expect(threadA.contextCursor?.messages).toBe(3)
    expect(threadB.contextCursor?.messages).toBe(3)
  })

  test("an attachment swapped in the committed prefix rebinds and re-uploads the new media", async () => {
    const harness = divergenceHarness()
    const imageA = { type: "image", id: "img-a", url: "https://files.test/a.png", name: "a.png" }
    const imageB = { type: "image", id: "img-b", url: "https://files.test/b.png", name: "b.png" }

    const withImage = (data: string, filename: string): LanguageModelV3Prompt[number] => ({
      role: "user",
      content: [
        { type: "text", text: "Describe this picture." },
        { type: "file", data, mediaType: "image/png", filename },
      ],
    })

    harness.uploads.entries = [imageA]
    await collect((await harness.languageModel.doStream({ prompt: [withImage("QUFB", "a.png")] })).stream)
    expect(harness.payloads[0]!.files).toEqual([imageA])

    // An edit swapped the attachment: same message count, different media —
    // only the fingerprint catches this.
    harness.uploads.entries = [imageB]
    const swapped: LanguageModelV3Prompt = [
      withImage("QkJC", "b.png"),
      assistant("Answer 1"),
      user("And what about now?"),
    ]
    await collect((await harness.languageModel.doStream({ prompt: swapped })).stream)

    expect(harness.createdChats).toEqual(["chat-1", "chat-2"])
    const rebind = harness.payloads[1]!
    expect(rebind.path).toContain("chat_id=chat-2")
    expect(rebind.parentId).toBeNull()
    expect(rebind.files).toEqual([imageB])
    expect(rebind.prompt).toContain("Describe this picture.")
    expect(rebind.prompt).toContain("And what about now?")
    // The full prompt's media (the NEW attachment) was re-uploaded for the
    // fresh chat — the rebind never strands the swapped-in attachment.
    expect(harness.uploadedMedia).toHaveLength(2)
    expect(harness.uploadedMedia[1]![0]!.filename).toBe("b.png")
  })

  test("a new attachment in the tail keeps trimming and uploads only the tail media", async () => {
    const harness = divergenceHarness()
    const imageC = { type: "image", id: "img-c", url: "https://files.test/c.png", name: "c.png" }

    await collect((await harness.languageModel.doStream({ prompt: [user("LONG ORIGINAL CONTEXT")] })).stream)
    expect(harness.uploadedMedia).toHaveLength(0) // text-only turn uploaded nothing

    harness.uploads.entries = [imageC]
    const tailImage: LanguageModelV3Prompt = [
      user("LONG ORIGINAL CONTEXT"),
      assistant("Answer 1"),
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this one?" },
          { type: "file", data: "Q0ND", mediaType: "image/png", filename: "c.png" },
        ],
      },
    ]
    await collect((await harness.languageModel.doStream({ prompt: tailImage })).stream)

    // Prefix verified (unchanged text-only transcript): still trimmed, on the
    // same chat, chained to the committed anchor, with the new media uploaded.
    expect(harness.createdChats).toEqual(["chat-1"])
    const follow = harness.payloads[1]!
    expect(follow.path).toContain("chat_id=chat-1")
    expect(follow.parentId).toBe("r1")
    expect(follow.files).toEqual([imageC])
    expect(follow.prompt).toContain("What is in this one?")
    expect(follow.prompt).not.toContain("LONG ORIGINAL CONTEXT")
    expect(harness.uploadedMedia).toHaveLength(1)
    expect(harness.uploadedMedia[0]![0]!.filename).toBe("c.png")
  })

  test("a failed turn never vouches for the upstream mirror: no cursor written, committed cursor untouched", async () => {
    // finish-on-commit ordering is the load-bearing precondition for the
    // cursor design: a turn that errors mid-stream produced no upstream
    // mirror, so it must neither write a cursor nor disturb a committed one.
    const createdChats: string[] = []
    let completions = 0
    let failNext = false
    const transport = {
      requestJson: async () => ({ status: 200, statusText: "OK", contentType: "application/json", body: "{}" }),
      requestStream: async () => {
        throw new Error("unexpected requestStream")
      },
      rawRequestJson: async () => {
        const id = `chat-${createdChats.length + 1}`
        createdChats.push(id)
        return { status: 200, statusText: "OK", contentType: "application/json", body: JSON.stringify({ chat_id: id }) }
      },
      rawRequestStream: async (_method: string, requestPath: string) => {
        completions++
        const chatId = /chat_id=([^&]+)/.exec(requestPath)?.[1] ?? "chat-?"
        const responseId = `r${completions}`
        const lines = failNext
          ? [createdEvent(responseId, chatId), 'data: {"error":{"code":"Not_Found","message":"Model does not exist"}}\n']
          : [createdEvent(responseId, chatId), textFor(responseId, `Answer ${completions}`), DONE]
        return { status: 200, contentType: "text/event-stream", stream: byteStream(lines), abort: () => {} }
      },
      idleBudgetMs: () => 1000,
    } as unknown as QwenWebTransport
    const store = freshStore()
    const session = new QwenWebSession({ transport, store })
    const languageModel = new QwenWebLanguageModel("qwen3-max", { session, upload: fakeUpload({ entries: [] }) as never })
    const scope = { "qwen-web": { threadId: "ws3-failed-turn" } }
    const run = async (prompt: LanguageModelV3Prompt) =>
      collect((await languageModel.doStream({ prompt, providerOptions: scope })).stream).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )

    // Turn 1 fails mid-stream: the thread exists (the chat was created) but
    // no cursor may be written for an uncommitted mirror.
    failNext = true
    const firstError = await run([user("Context that never commits")])
    expect(firstError).toBeInstanceOf(APICallError)
    expect(store.all()[0]?.contextCursor).toBeUndefined()

    // Turn 2 commits: the cursor is written.
    failNext = false
    expect(await run([user("Context that never commits")])).toBeUndefined()
    const committed = store.all()[0]!.contextCursor
    expect(committed).toBeDefined()

    // Turn 3 trims onto the committed binding, then fails mid-stream: the
    // committed cursor and binding survive byte-for-byte.
    failNext = true
    const thirdError = await run([user("Context that never commits"), assistant("Answer 2"), user("Follow-up")])
    expect(thirdError).toBeInstanceOf(APICallError)
    expect(store.all()[0]!.contextCursor).toEqual(committed)
    expect(store.all()[0]!.providerId).toBe("chat-1")
  })

  test("the provenance cursor round-trips through sanitizeThread, and a malformed one is dropped", () => {
    // sanitizeThread is the store load path: the whitelist must pass the
    // cursor through (validated), or every restart silently unbinds.
    const now = Date.now()
    const valid = sanitizeThread({
      id: "qwen-web:qwen3-max:rt",
      model: "qwen3-max",
      providerId: "chat-1",
      messages: [{ id: "u0", role: "user", content: "Hi", parts: [{ type: "text", text: "Hi" }] }],
      createdAt: now,
      updatedAt: now,
      contextCursor: { fingerprint: "abc123", messages: 1, recordedAt: now },
    })
    expect(valid?.contextCursor).toEqual({ fingerprint: "abc123", messages: 1, recordedAt: now })

    // A malformed cursor is dropped, which fails safe into a rebind.
    const malformed = sanitizeThread({
      id: "qwen-web:qwen3-max:rt",
      model: "qwen3-max",
      messages: [],
      createdAt: now,
      updatedAt: now,
      contextCursor: { fingerprint: "", messages: "1" },
    })
    expect(malformed?.contextCursor).toBeUndefined()
  })
})

describe("issue 232 workstream 5: API error boundary", () => {
  const DIAGNOSTIC =
    "upstream rejected request; cookie=COOKIE_FIXTURE; bx-ua=WAF_HEADER_FIXTURE; authorization=Bearer AUTH_FIXTURE; access_token=ACCESS_FIXTURE; echoed text=PRIVATE_PROMPT_INPUT"
  const SECRETS = ["COOKIE_FIXTURE", "WAF_HEADER_FIXTURE", "AUTH_FIXTURE", "ACCESS_FIXTURE", "PRIVATE_PROMPT_INPUT"]
  const prompt: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "PRIVATE_PROMPT_INPUT" }] }]
  const CREATED_OK = { status: 200, statusText: "OK", contentType: "application/json", body: '{"chat_id":"chat-1"}' }

  test("toApiError emits stable JSON fields and redacts prompt echo", () => {
    const error = toApiError(
      new QwenWebError({ code: "rate_limited", message: "slow PRIVATE_PROMPT_INPUT", retryable: true, status: 429, phase: "setup", upstreamCode: "RateLimited", detail: "slow" }),
      "m",
      undefined,
      ["PRIVATE_PROMPT_INPUT"],
    )
    expect(error).toBeInstanceOf(APICallError)
    expect(error.statusCode).toBe(429)
    expect(error.isRetryable).toBe(true)
    expect(JSON.parse(error.responseBody ?? "{}")).toEqual({
      provider: "qwen-web", phase: "setup", code: "rate_limited", status: 429, upstreamCode: "RateLimited", retryable: true, detail: "slow",
    })
    expect(error.message).not.toContain("PRIVATE_PROMPT_INPUT")
    const aborted = toApiError(Object.assign(new Error("x"), { name: "AbortError" }), "m")
    expect(JSON.parse(aborted.responseBody ?? "{}")).toMatchObject({ phase: "stop", code: "aborted", status: 499, retryable: false })
    const unknown = toApiError(new Error("weird"), "m")
    expect(unknown.isRetryable).toBe(true)
    expect(JSON.parse(unknown.responseBody ?? "{}").phase).toBe("setup")
  })

  test("table: fake create/setup/stream responses retain safe APICallError fields", async () => {
    const scenarios = [
      { name: "chat-create", create: { status: 503, statusText: "Service Unavailable", contentType: "application/json", body: JSON.stringify({ success: false, code: "E_CREATE", message: DIAGNOSTIC }) }, completion: undefined, phase: "chat-create", status: 503, upstream: "E_CREATE" },
      { name: "setup", create: CREATED_OK, completion: () => ({ status: 503, contentType: "application/json", stream: byteStream([JSON.stringify({ success: false, code: "E_SETUP", message: DIAGNOSTIC })]), abort: () => {} }), phase: "setup", status: 503, upstream: "E_SETUP" },
      { name: "stream", create: CREATED_OK, completion: () => ({ status: 200, contentType: "text/event-stream", stream: byteStream([CREATED, `data: ${JSON.stringify({ error: { code: "E_STREAM", message: DIAGNOSTIC } })}\n`]), abort: () => {} }), phase: "stream", status: 200, upstream: "E_STREAM" },
    ] as const
    for (const scenario of scenarios) {
      const transport = {
        requestJson: async () => ({ status: 200, statusText: "OK", contentType: "application/json", body: "{}" }),
        requestStream: async () => { throw new Error("unexpected requestStream") },
        rawRequestJson: async () => scenario.create,
        rawRequestStream: async () => scenario.completion?.(),
        idleBudgetMs: () => 1000,
        revealChallengeWindow: async () => false,
      } as unknown as QwenWebTransport
      const languageModel = modelWithTransport(transport)
      const error = await languageModel.doStream({ prompt }).then(
        async ({ stream }) => collect(stream).then(() => undefined, (failure: unknown) => failure),
        (failure: unknown) => failure,
      )
      expect(error, scenario.name).toBeInstanceOf(APICallError)
      const apiError = error as APICallError
      expect(apiError.statusCode, scenario.name).toBe(scenario.status)
      expect(apiError.isRetryable, scenario.name).toBe(true)
      const body = JSON.parse(apiError.responseBody ?? "{}")
      expect(body, scenario.name).toMatchObject({ provider: "qwen-web", phase: scenario.phase, code: "upstream_error", status: scenario.status, upstreamCode: scenario.upstream, retryable: true })
      expect(body.detail, scenario.name).toContain("upstream rejected request")
      expect((body.detail as string).length, scenario.name).toBeLessThanOrEqual(240)
      for (const secret of SECRETS) {
        expect(apiError.message, scenario.name).not.toContain(secret)
        expect(apiError.responseBody ?? "", scenario.name).not.toContain(secret)
      }
    }
  })

  test("caller abort maps to a non-retryable stop-phase API error and still stops upstream", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const endless = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(CREATED)) },
    })
    const controller = new AbortController()
    const { stream } = await model([], captured, { sessionBehavior: { stream: endless } }).doStream({ prompt, abortSignal: controller.signal })
    const reader = stream.getReader()
    expect((await reader.read()).value?.type).toBe("stream-start")
    expect((await reader.read()).value?.type).toBe("response-metadata")
    const pending = reader.read().then(() => undefined, (failure: unknown) => failure)
    controller.abort()
    const error = await pending
    expect(error).toBeInstanceOf(APICallError)
    const apiError = error as APICallError
    expect(apiError.statusCode).toBe(499)
    expect(apiError.isRetryable).toBe(false)
    expect(JSON.parse(apiError.responseBody ?? "{}")).toMatchObject({ phase: "stop", code: "aborted", status: 499, retryable: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(captured.stops).toEqual([{ chatId: "chat-1", responseId: "r1" }])
    for (const secret of SECRETS) expect(apiError.responseBody ?? "").not.toContain(secret)
  })
})
