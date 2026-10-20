import { afterEach, describe, expect, test } from "bun:test"
import {
  buildChatNewBody,
  buildCompletionPayload,
  buildStopBody,
  buildStsBody,
  formatThinkingSummary,
  incrementalDelta,
  normalizeModelRecord,
  parseChatNewOutcome,
  parseChatNewResponse,
  parseModelsResponse,
  parseQwenEvent,
  qwenWebBaseUrl,
  qwenWebUrl,
  QwenWebSSEParser,
  toUpstreamModelId,
} from "@opencode-ai/webchat/adapters/qwen/protocol"

afterEach(() => {
  delete process.env["QWEN_WEB_BASE_URL"]
})

describe("urls and model ids", () => {
  test("base url override and normalization", () => {
    expect(qwenWebBaseUrl()).toBe("https://chat.qwen.ai")
    process.env["QWEN_WEB_BASE_URL"] = "https://proxy.local/qwen///"
    expect(qwenWebBaseUrl()).toBe("https://proxy.local/qwen")
    expect(qwenWebUrl("/api/models")).toBe("https://proxy.local/qwen/api/models")
    expect(qwenWebUrl("api/models")).toBe("https://proxy.local/qwen/api/models")
  })

  test("variant suffixes are stripped", () => {
    expect(toUpstreamModelId("qwen3-max")).toBe("qwen3-max")
    expect(toUpstreamModelId("qwen3-max-fast")).toBe("qwen3-max")
    expect(toUpstreamModelId("qwen3-max-thinking")).toBe("qwen3-max")
    expect(toUpstreamModelId("qwen3-max-no-thinking")).toBe("qwen3-max")
    expect(toUpstreamModelId("qwen3-maximum")).toBe("qwen3-maximum")
  })
})

describe("payload builders", () => {
  test("chat creation always uses the persisted normal mode", () => {
    const temp = buildChatNewBody("qwen3-max", "temp")
    expect(temp["chat_mode"]).toBe("normal")
    expect(temp["models"]).toEqual(["qwen3-max"])
    expect(temp["chat_type"]).toBe("t2t")
    expect(buildChatNewBody("qwen3-max", "thread")["chat_mode"]).toBe("normal")
  })

  test("chat id parsing accepts nested shapes", () => {
    expect(parseChatNewResponse({ chat_id: "c1" })).toBe("c1")
    expect(parseChatNewResponse({ id: "c2" })).toBe("c2")
    expect(parseChatNewResponse({ data: { chat_id: "c3" } })).toBe("c3")
    expect(parseChatNewResponse({ data: { chat: { id: "c4" } } })).toBe("c4")
    expect(parseChatNewResponse({})).toBeUndefined()
    expect(parseChatNewResponse(null)).toBeUndefined()
    expect(parseChatNewResponse("c5")).toBeUndefined()
  })

  test("completion payload carries prompt, model and reasoning mode", () => {
    const payload = buildCompletionPayload({
      prompt: "Hello",
      model: "qwen3-max",
      chatId: "chat-1",
      parentId: null,
      reasoningMode: "thinking",
      files: [{ type: "image", id: "f1", url: "https://x/y.png", name: "y.png" }],
      ids: { fid: "fid-1", childId: "child-1", timestamp: 1000 },
    })
    expect(payload["stream"]).toBe(true)
    expect(payload["incremental_output"]).toBe(true)
    expect(payload["chat_id"]).toBe("chat-1")
    expect(payload["chat_mode"]).toBe("normal")
    const message = (payload["messages"] as Record<string, unknown>[])[0]!
    expect(message["content"]).toBe("Hello")
    expect(message["role"]).toBe("user")
    expect(message["files"]).toHaveLength(1)
    const feature = message["feature_config"] as Record<string, unknown>
    expect(feature["thinking_enabled"]).toBe(true)
    expect(feature["thinking_mode"]).toBe("Thinking")
    expect(payload["timestamp"]).toBe(1001)
  })

  test("fast mode disables thinking", () => {
    const payload = buildCompletionPayload({
      prompt: "hi",
      model: "m",
      chatId: "c",
      parentId: null,
      reasoningMode: "fast",
    })
    const message = (payload["messages"] as Record<string, unknown>[])[0]!
    const feature = message["feature_config"] as Record<string, unknown>
    expect(feature["thinking_enabled"]).toBe(false)
    expect(feature["thinking_mode"]).toBe("Fast")
    expect(feature["auto_thinking"]).toBe(false)
  })

  test("chat-create outcomes separate an ok id from a missing one", () => {
    expect(parseChatNewOutcome({ chat_id: "c1" })).toEqual({ kind: "ok", chatId: "c1" })
    expect(parseChatNewOutcome({ data: { chat: { id: "c4" } } })).toEqual({ kind: "ok", chatId: "c4" })
    // Whitespace-only ids are not ids, and the body did arrive.
    expect(parseChatNewOutcome({ chat_id: "   " })).toEqual({ kind: "missing-id", reason: "blank" })
    expect(parseChatNewOutcome({ data: { chat_id: "" } })).toEqual({ kind: "missing-id", reason: "blank" })
    expect(parseChatNewResponse({ chat_id: " c1 " })).toBe("c1")
    // Nothing came back at all.
    expect(parseChatNewOutcome(undefined)).toEqual({ kind: "missing-id", reason: "empty" })
    expect(parseChatNewOutcome(null)).toEqual({ kind: "missing-id", reason: "empty" })
    expect(parseChatNewOutcome({})).toEqual({ kind: "missing-id", reason: "empty" })
    expect(parseChatNewOutcome([])).toEqual({ kind: "missing-id", reason: "empty" })
    // A body arrived, but no id lives anywhere known. Never stale-chat
    // evidence: a create call proves nothing about an existing binding.
    expect(parseChatNewOutcome({ data: {} })).toEqual({ kind: "missing-id", reason: "unrecognized" })
    expect(parseChatNewOutcome({ ok: true, data: { chat: {} } })).toEqual({
      kind: "missing-id",
      reason: "unrecognized",
    })
    expect(parseChatNewResponse({ data: {} })).toBeUndefined()
  })

  test("stop and sts bodies", () => {
    expect(buildStopBody("c", "r")).toEqual({ chat_id: "c", response_id: "r" })
    expect(buildStsBody("a.png", 12, "image")).toEqual({ filename: "a.png", filesize: "12", filetype: "image" })
  })
})

describe("incrementalDelta", () => {
  test("pure appends diff in O(1)", () => {
    expect(incrementalDelta("", "Hello")).toEqual({ delta: "Hello", matched: "Hello" })
    expect(incrementalDelta("Hello", "Hello")).toEqual({ delta: "", matched: "Hello" })
    expect(incrementalDelta("Hello", "Hello world")).toEqual({ delta: " world", matched: "Hello world" })
  })

  test("rewrites fall back to common-prefix scan", () => {
    expect(incrementalDelta("Hello world", "Hello there")).toEqual({ delta: "there", matched: "Hello there" })
  })

  test("unrelated updates are appended, never dropped", () => {
    const result = incrementalDelta("aaa", "zzz")
    expect(result.delta).toBe("zzz")
    expect(result.matched).toBe("aaazzz")
  })
})

describe("QwenWebSSEParser", () => {
  test("splits chunks on newlines and skips comments", () => {
    const parser = new QwenWebSSEParser()
    const events = parser.feed(": comment\n\ndata: [DONE]\n")
    expect(events).toEqual([{ kind: "done" }])
  })

  test("handles events split across transport chunks", () => {
    const parser = new QwenWebSSEParser()
    expect(parser.feed('data: {"respo')).toEqual([])
    const events = parser.feed('nse_id":"r1","choices":[{"delta":{"phase":"answer","content":"Hi"}}]}\n')
    expect(events).toEqual([{ kind: "text", content: "Hi", responseId: "r1" }])
  })

  test("flush emits a trailing unterminated line", () => {
    const parser = new QwenWebSSEParser()
    expect(parser.feed("data: [DONE]")).toEqual([])
    expect(parser.flush()).toEqual([{ kind: "done" }])
    expect(parser.flush()).toEqual([])
  })
})

describe("parseQwenEvent", () => {
  test("[DONE] and blanks", () => {
    expect(parseQwenEvent("[DONE]")).toEqual({ kind: "done" })
    expect(parseQwenEvent("")).toEqual({ kind: "unknown" })
    expect(parseQwenEvent("definitely not json")).toEqual({ kind: "unknown" })
    expect(parseQwenEvent("[]")).toEqual({ kind: "unknown" })
  })

  test("error shapes", () => {
    expect(parseQwenEvent('{"error":"kaput"}')).toEqual({ kind: "error", code: "upstream_error", message: "kaput" })
    expect(parseQwenEvent('{"error":{"code":"E1","message":"m"}}')).toEqual({ kind: "error", code: "E1", message: "m" })
  })

  test("response.created carries chat id", () => {
    expect(parseQwenEvent('{"type":"response.created","response":{"id":"r1","chat_id":"c1"}}')).toEqual({
      kind: "response-created",
      responseId: "r1",
      chatId: "c1",
    })
  })

  test("a chunk-level chat_id is surfaced so a rotated chat can be adopted", () => {
    // `response.created` is not the only place the authoritative chat id can
    // appear; a rotation reported only at the chunk root must still arrive.
    expect(
      parseQwenEvent(
        '{"response_id":"r1","chat_id":"c-rotated","choices":[{"delta":{"phase":"answer","content":"Hi"}}]}',
      ),
    ).toEqual({ kind: "text", content: "Hi", responseId: "r1", chatId: "c-rotated" })
    expect(parseQwenEvent('{"chat_id":"c-rotated","usage":{"output_tokens":2}}')).toEqual({
      kind: "usage",
      chatId: "c-rotated",
      outputTokens: 2,
      inputTokens: undefined,
      totalTokens: undefined,
      cachedTokens: undefined,
      reasoningTokens: undefined,
      textTokens: undefined,
    })
    // `response.created` keeps its own id when it has one; otherwise the
    // chunk-level id is used instead of leaving the session on a stale binding.
    expect(parseQwenEvent('{"type":"response.created","response":{"id":"r1"},"chat_id":"c-rotated"}')).toEqual({
      kind: "response-created",
      responseId: "r1",
      chatId: "c-rotated",
    })
    expect(
      parseQwenEvent('{"type":"response.created","response":{"id":"r1","chat_id":"c1"},"chat_id":"c-rotated"}'),
    ).toEqual({
      kind: "response-created",
      responseId: "r1",
      chatId: "c1",
    })
    // No chat id anywhere: nothing to adopt.
    expect(parseQwenEvent('{"type":"response.created","response":{"id":"r1"}}')).toEqual({
      kind: "response-created",
      responseId: "r1",
    })
    expect(parseQwenEvent('{"response_id":"r1","choices":[{"delta":{"phase":"answer","content":"Hi"}}]}')).toEqual({
      kind: "text",
      content: "Hi",
      responseId: "r1",
    })
  })

  test("usage aliases", () => {
    expect(
      parseQwenEvent(
        '{"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":3},"output_tokens_details":{"reasoning_tokens":2,"text_tokens":3}}}',
      ),
    ).toEqual({
      kind: "usage",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedTokens: 3,
      reasoningTokens: 2,
      textTokens: 3,
    })
  })

  test("answer / thinking / finished phases", () => {
    expect(parseQwenEvent('{"response_id":"r","choices":[{"delta":{"phase":"answer","content":"Hi"}}]}')).toEqual({
      kind: "text",
      content: "Hi",
      responseId: "r",
    })
    expect(parseQwenEvent('{"choices":[{"delta":{"phase":"answer","status":"finished"}}]}')).toEqual({
      kind: "answer-finished",
      responseId: undefined,
    })
    const thinking = parseQwenEvent('{"choices":[{"delta":{"phase":"thinking_summary","extra":{}}}]}')
    expect(thinking.kind).toBe("thinking")
    expect(parseQwenEvent('{"choices":[{"delta":{"phase":"other"}}]}')).toEqual({ kind: "unknown" })
    expect(parseQwenEvent('{"choices":[]}')).toEqual({ kind: "unknown" })
  })

  test("text wins over a sidecar usage object", () => {
    // The upstream sends a cumulative `usage` object on every delta chunk as a
    // sidecar; choices must be checked first or every text chunk is dropped.
    const event = parseQwenEvent(
      '{"response_id":"r","choices":[{"delta":{"phase":"answer","content":"Hi"}}],"usage":{"output_tokens":1,"total_tokens":2}}',
    )
    expect(event).toEqual({ kind: "text", content: "Hi", responseId: "r" })
  })

  test("a WAF challenge served as SSE is classified as an error", () => {
    // The upstream sometimes serves a human-verification challenge as
    // `text/event-stream` instead of a normal JSON event; without this the
    // stream would look like an endless run of `unknown` events and hang.
    const challenge = parseQwenEvent(
      '{"ret":["FAIL_SYS_USER_VALIDATE"],"x5step":2,"action":"captcha","pureCaptcha":"abc"}',
    )
    expect(challenge).toEqual({
      kind: "error",
      code: "waf_challenge",
      message: expect.stringContaining("FAIL_SYS_USER_VALIDATE"),
    })
    const html = parseQwenEvent("<html><body>security verification</body></html>")
    expect(html).toEqual({ kind: "error", code: "waf_challenge", message: expect.any(String) })
  })
})

describe("formatThinkingSummary", () => {
  test("pairs titles with thoughts as markdown", () => {
    const formatted = formatThinkingSummary({
      extra: { summary_title: { content: ["Plan", "Verify"] }, summary_thought: { content: ["First.", "Then."] } },
    })
    expect(formatted).toBe("**Plan**\n\nFirst.\n\n**Verify**\n\nThen.")
    expect(formatThinkingSummary({})).toBe("")
    expect(formatThinkingSummary({ extra: { summary_title: { content: ["Only"] } } })).toBe("**Only**")
  })
})

describe("model catalog parsing", () => {
  test("records normalize id, name, activity and context", () => {
    const records = parseModelsResponse({
      data: [
        { id: "qwen3-max", name: "Qwen3 Max", is_active: true, metadata: { max_context_length: 262144 } },
        { id: "", name: "nameless" },
        { info: { name: "Qwen Plus" }, metadata: {} },
      ],
    })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ id: "qwen3-max", name: "Qwen3 Max", isActive: true, contextWindow: 262144 })
  })

  test("non-array data yields no records", () => {
    expect(parseModelsResponse({})).toEqual([])
    expect(parseModelsResponse(null)).toEqual([])
  })

  test("name falls back to info name, then id", () => {
    expect(normalizeModelRecord({ id: "a", info: { name: "Info Name" } })?.name).toBe("Info Name")
    expect(normalizeModelRecord({ id: "b" })?.name).toBe("b")
  })
})
