import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { QwenWebError } from "@opencode-ai/webchat/adapters/qwen/errors"
import { consumeQwenStream, QwenWebSession } from "@opencode-ai/webchat/adapters/qwen/session"
import { ThreadStore } from "@opencode-ai/webchat/store"
import type { QwenWebTransport } from "@opencode-ai/webchat/adapters/qwen/transport"
import type { WebChatEvent } from "@opencode-ai/webchat/types"

function byteStream(lines: string[], chunkBytes = 7): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(lines.join(""))
  const chunks: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += chunkBytes) chunks.push(bytes.slice(i, i + chunkBytes))
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

function fakeTransport(overrides: Partial<QwenWebTransport> = {}): QwenWebTransport {
  return {
    requestJson: async () => {
      throw new Error("unexpected requestJson")
    },
    requestStream: async () => {
      throw new Error("unexpected requestStream")
    },
    rawRequestJson: async () => {
      throw new Error("unexpected rawRequestJson")
    },
    rawRequestStream: async () => {
      throw new Error("unexpected rawRequestStream")
    },
    idleBudgetMs: () => 1000,
    revealChallengeWindow: async () => false,
    ...overrides,
  } as unknown as QwenWebTransport
}

async function captureRejection(promise: Promise<unknown>): Promise<QwenWebError> {
  try {
    await promise
  } catch (error) {
    return error as QwenWebError
  }
  throw new Error("expected promise to reject")
}

describe("QwenWebSession.createChat", () => {
  test("returns the chat id", async () => {
    const calls: string[] = []
    const transport = fakeTransport({
      rawRequestJson: (async (method: string, path: string, options?: { body?: string }) => {
        calls.push(`${method} ${path}`)
        const body = JSON.parse(options?.body ?? "{}")
        expect(body.models).toEqual(["qwen3-max"])
        expect(body.chat_mode).toBe("normal")
        return { status: 200, statusText: "OK", contentType: "application/json", body: '{"data":{"chat_id":"c1"}}' }
      }) as QwenWebTransport["rawRequestJson"],
    })
    const session = new QwenWebSession({ transport })
    expect(await session.createChat("qwen3-max")).toBe("c1")
    expect(calls).toEqual(["POST /api/v2/chats/new"])
  })

  test("login (401/403) is distinct from a challenge body, even a success-shaped one", async () => {
    let reveals = 0
    const transport = fakeTransport({
      revealChallengeWindow: async () => {
        reveals++
        return false
      },
      rawRequestJson: (async (_method: string, _path: string, options?: { body?: string }) => ({
        status: 403,
        statusText: "Forbidden",
        contentType: "application/json",
        body: '{"message":"CAPTCHA verification required"}',
      })) as QwenWebTransport["rawRequestJson"],
    })
    const session = new QwenWebSession({ transport })
    const challenge = await captureRejection(session.createChat("m"))
    expect(challenge.code).toBe("challenge")
    expect(challenge.retryable).toBe(false)
    expect(reveals).toBe(1)

    const loginTransport = fakeTransport({
      rawRequestJson: (async () => ({
        status: 403,
        statusText: "Forbidden",
        contentType: "application/json",
        body: '{"success":false,"message":"login required"}',
      })) as QwenWebTransport["rawRequestJson"],
    })
    const login = await captureRejection(new QwenWebSession({ transport: loginTransport }).createChat("m"))
    expect(login.code).toBe("session_expired")
    expect(login.status).toBe(403)

    // Same distinction on 401: a plain auth failure stays session_expired,
    // and the status is preserved (the deleted 401/403 shortcut contract).
    const login401Transport = fakeTransport({
      rawRequestJson: (async () => ({
        status: 401,
        statusText: "Unauthorized",
        contentType: "application/json",
        body: '{"success":false,"message":"login required"}',
      })) as QwenWebTransport["rawRequestJson"],
    })
    const login401 = await captureRejection(new QwenWebSession({ transport: login401Transport }).createChat("m"))
    expect(login401.code).toBe("session_expired")
    expect(login401.status).toBe(401)

    const successShapedWaf = fakeTransport({
      rawRequestJson: (async () => ({
        status: 200,
        statusText: "OK",
        contentType: "application/json",
        body: '{"success":true,"message":"security verification required"}',
      })) as QwenWebTransport["rawRequestJson"],
    })
    const waf = await captureRejection(new QwenWebSession({ transport: successShapedWaf }).createChat("m"))
    expect(waf.code).toBe("challenge")
    // The motivating case: a challenge can arrive with HTTP 200, and the
    // status parameter must survive to the error instead of defaulting.
    expect(waf.status).toBe(200)
  })

  test("unexpected payloads become invalid_response", async () => {
    const transport = fakeTransport({
      rawRequestJson: (async () => ({
        status: 200,
        statusText: "OK",
        contentType: "application/json",
        body: '{"data":{}}',
      })) as QwenWebTransport["rawRequestJson"],
    })
    const session = new QwenWebSession({ transport })
    const error = await captureRejection(session.createChat("m"))
    expect(error.code).toBe("invalid_response")
  })

  test("a create response without a usable chat id says what is missing", async () => {
    // A create call proves nothing about an *existing* binding, so this is
    // never stale-chat evidence: report it and leave the thread unbound.
    const bodies = ["", "{}", '{"data":{}}', '{"chat_id":"   "}']
    const messages: string[] = []
    for (const body of bodies) {
      const transport = fakeTransport({
        rawRequestJson: (async () => ({
          status: 200,
          statusText: "OK",
          contentType: "application/json",
          body,
        })) as QwenWebTransport["rawRequestJson"],
      })
      const session = new QwenWebSession({ transport })
      const error = await captureRejection(session.createChat("m"))
      expect(error.code).toBe("invalid_response")
      expect(error.retryable).toBe(false)
      messages.push(error.message)
    }
    expect(messages[0]).toContain("empty body")
    expect(messages[1]).toContain("empty body")
    expect(messages[2]!).toContain("no chat id")
    expect(messages[3]!).toContain("blank chat id")
    for (const message of messages) expect(message).toContain("nothing to bind to")
  })
})

describe("persisted binding validation (issue 232)", () => {
  function storeWith(threads: unknown[]): ThreadStore {
    const file = path.join(os.tmpdir(), `qwen-webchat-store-${Math.random().toString(36).slice(2)}.json`)
    fs.writeFileSync(file, JSON.stringify({ threads }))
    return new ThreadStore({ file })
  }

  test("blank chat ids and blank anchors are dropped when a thread file is loaded", () => {
    const store = storeWith([
      {
        id: "t1",
        model: "qwen3-max",
        providerId: "   ",
        messages: [
          { id: "u1", role: "user", content: "hi", parts: [{ type: "text", text: "hi" }] },
          { id: "a1", role: "assistant", content: "yo", parts: [], providerState: { responseId: "  " } },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
      // Unusable entries are dropped rather than loaded half-broken.
      { id: "t2", messages: [], createdAt: 1, updatedAt: 1 },
      { id: "t3", model: "qwen3-max", createdAt: 1, updatedAt: 1 },
      "not a thread",
    ])

    const thread = store.get("t1")
    expect(thread).toBeDefined()
    // A blank id is not a binding: it would have been sent upstream as one.
    expect(thread?.providerId).toBeUndefined()
    expect(thread?.messages.map((message) => message.providerState?.["responseId"])).toEqual([undefined, undefined])
    expect(store.get("t2")).toBeUndefined()
    expect(store.get("t3")).toBeUndefined()
    expect(store.all()).toHaveLength(1)
  })

  test("a usable binding survives validation untouched", () => {
    const store = storeWith([
      {
        id: "t1",
        model: "qwen3-max",
        providerId: "chat-1",
        messages: [
          { id: "u1", role: "user", content: "hi", parts: [{ type: "text", text: "hi" }] },
          {
            id: "a1",
            role: "assistant",
            content: "yo",
            parts: [{ type: "text", text: "yo" }],
            providerState: { responseId: "r1", editedLocally: true },
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    const thread = store.get("t1")
    expect(thread?.providerId).toBe("chat-1")
    expect(thread?.messages[1]?.providerState).toEqual({ responseId: "r1", editedLocally: true })
  })

  test("a thread held in memory with a blank binding is repaired before the turn", async () => {
    const store = new ThreadStore({
      file: path.join(os.tmpdir(), `qwen-webchat-memory-${Math.random().toString(36).slice(2)}.json`),
    })
    const paths: string[] = []
    const bodies: string[] = []
    const transport = fakeTransport({
      rawRequestJson: (async () => ({
        status: 200,
        statusText: "OK",
        contentType: "application/json",
        body: '{"chat_id":"c-new"}',
      })) as QwenWebTransport["rawRequestJson"],
      rawRequestStream: (async (_method: string, requestPath: string, options?: { body?: string }) => {
        paths.push(requestPath)
        bodies.push(options?.body ?? "")
        return {
          status: 200,
          contentType: "text/event-stream",
          stream: byteStream([
            'data: {"type":"response.created","response":{"id":"r1","chat_id":"c-new"}}\n',
            'data: {"response_id":"r1","choices":[{"delta":{"phase":"answer","content":"hi"}}]}\n',
            "data: [DONE]\n",
          ]),
          abort: () => {},
        }
      }) as QwenWebTransport["rawRequestStream"],
    })
    const session = new QwenWebSession({ transport, store })
    const thread = await session.ensureThread({ model: "qwen3-max" })
    // Half-written binding: a blank chat id plus a blank continuation anchor,
    // neither of which may be sent upstream as if it were live.
    thread.providerId = "  "
    thread.messages.push({
      id: "a1",
      role: "assistant",
      content: "yo",
      parts: [{ type: "text", text: "yo" }],
      providerState: { responseId: "" },
    })

    const events: WebChatEvent[] = []
    for await (const event of session.runTurn({ thread, content: "hello" })) events.push(event)

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(paths[0]).toContain("chat_id=c-new")
    // The blank anchor was dropped rather than sent as a parent id.
    expect(JSON.parse(bodies[0]!)["parent_id"]).toBeNull()
    expect(thread.providerId).toBe("c-new")
    expect(thread.messages.find((message) => message.id === "a1")?.providerState).toBeUndefined()
  })

  test("a thread loaded with a blank binding creates a chat instead of addressing it", async () => {
    const store = storeWith([
      {
        id: "t1",
        model: "qwen3-max",
        providerId: "",
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    const paths: string[] = []
    const transport = fakeTransport({
      rawRequestJson: (async () => ({
        status: 200,
        statusText: "OK",
        contentType: "application/json",
        body: '{"chat_id":"c-new"}',
      })) as QwenWebTransport["rawRequestJson"],
      rawRequestStream: (async (_method: string, requestPath: string) => {
        paths.push(requestPath)
        return {
          status: 200,
          contentType: "text/event-stream",
          stream: byteStream([
            'data: {"type":"response.created","response":{"id":"r1","chat_id":"c-new"}}\n',
            'data: {"response_id":"r1","choices":[{"delta":{"phase":"answer","content":"hi"}}]}\n',
            "data: [DONE]\n",
          ]),
          abort: () => {},
        }
      }) as QwenWebTransport["rawRequestStream"],
    })
    const session = new QwenWebSession({ transport, store })
    const thread = store.get("t1")!
    const events: WebChatEvent[] = []
    for await (const event of session.runTurn({ thread, content: "hello" })) events.push(event)

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(paths[0]).toContain("chat_id=c-new")
    expect(thread.providerId).toBe("c-new")
  })
})

describe("QwenWebSession.startGeneration", () => {
  test("creates a chat then opens a stream on it", async () => {
    const seen: Array<{ method: string; path: string; body?: string }> = []
    const transport = fakeTransport({
      rawRequestJson: (async (method: string, path: string, options?: { body?: string }) => {
        seen.push({ method, path, body: options?.body })
        return { status: 200, statusText: "OK", contentType: "application/json", body: '{"chat_id":"chat-9"}' }
      }) as QwenWebTransport["rawRequestJson"],
      rawRequestStream: (async (method: string, path: string, options?: { body?: string }) => {
        seen.push({ method, path, body: options?.body })
        return {
          status: 200,
          contentType: "text/event-stream",
          stream: byteStream(["data: [DONE]\n"]),
          abort: () => {},
        }
      }) as QwenWebTransport["rawRequestStream"],
    })
    const session = new QwenWebSession({ transport })
    const generation = await session.startGeneration({ prompt: "Hi", model: "qwen3-max", reasoningMode: "fast" })
    expect(generation.chatId).toBe("chat-9")
    expect(seen[1]?.path).toBe("/api/v2/chat/completions?chat_id=chat-9")
    const payload = JSON.parse(seen[1]?.body ?? "{}")
    expect(payload.model).toBe("qwen3-max")
    expect(payload.messages[0].content).toBe("Hi")
  })

  test("non-SSE JSON errors are classified", async () => {
    let aborted = false
    const transport = fakeTransport({
      rawRequestJson: (async () => ({
        status: 200,
        statusText: "OK",
        contentType: "application/json",
        body: '{"chat_id":"c"}',
      })) as QwenWebTransport["rawRequestJson"],
      rawRequestStream: (async () => ({
        status: 429,
        contentType: "application/json",
        stream: byteStream(['{"success":false,"code":"RateLimited","message":"slow"}']),
        abort: () => {
          aborted = true
        },
      })) as QwenWebTransport["rawRequestStream"],
    })
    const session = new QwenWebSession({ transport })
    const error = await captureRejection(session.startGeneration({ prompt: "Hi", model: "m" }))
    expect(error.code).toBe("rate_limited")
    expect(aborted).toBe(true)
  })

  test("HTML responses mean the session is gone", async () => {
    const transport = fakeTransport({
      rawRequestJson: (async () => ({
        status: 200,
        statusText: "OK",
        contentType: "application/json",
        body: '{"chat_id":"c"}',
      })) as QwenWebTransport["rawRequestJson"],
      rawRequestStream: (async () => ({
        status: 200,
        contentType: "text/html",
        stream: byteStream(["<html>login</html>"]),
        abort: () => {},
      })) as QwenWebTransport["rawRequestStream"],
    })
    const session = new QwenWebSession({ transport })
    const error = await captureRejection(session.startGeneration({ prompt: "Hi", model: "m" }))
    expect(error.code).toBe("session_expired")
  })
})

describe("QwenWebSession.stopGeneration", () => {
  test("notifies upstream, then always aborts locally", async () => {
    const calls: string[] = []
    let aborted = false
    const transport = fakeTransport({
      requestJson: (async (method: string, path: string, options?: { body?: string }) => {
        calls.push(`${method} ${path} ${options?.body}`)
        return { status: 200, statusText: "OK", contentType: "application/json", body: "{}" }
      }) as QwenWebTransport["requestJson"],
    })
    const session = new QwenWebSession({ transport })
    await session.stopGeneration("c1", "r1", () => {
      aborted = true
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("/api/v2/chat/completions/stop?chat_id=c1")
    expect(calls[0]).toContain('"response_id":"r1"')
    expect(aborted).toBe(true)

    await session.stopGeneration("c1", undefined, () => {})
    expect(calls).toHaveLength(1)
  })
})

describe("consumeQwenStream", () => {
  const created = 'data: {"type":"response.created","response":{"id":"r1","chat_id":"c1"}}\n'

  test("diffs cumulative content into ordered deltas", async () => {
    const seen: string[] = []
    const result = await consumeQwenStream(
      byteStream([
        created,
        'data: {"response_id":"r1","choices":[{"delta":{"phase":"answer","content":"Hello"}}]}\n',
        'data: {"response_id":"r1","choices":[{"delta":{"phase":"answer","content":"Hello world"}}]}\n',
        "data: [DONE]\n",
      ]),
      { onText: (delta) => seen.push(delta) },
    )
    expect(seen).toEqual(["Hello", " world"])
    expect(result.text).toBe("Hello world")
    expect(result.responseId).toBe("r1")
    expect(result.chatId).toBe("c1")
    expect(result.finishReason).toBe("stop")
  })

  test("swallows FINISHED and empty deltas", async () => {
    const seen: string[] = []
    const result = await consumeQwenStream(
      byteStream([
        'data: {"response_id":"r1","choices":[{"delta":{"phase":"answer","content":"FINISHED"}}]}\n',
        'data: {"choices":[{"delta":{"phase":"answer","status":"finished"}}]}\n',
      ]),
      { onText: (delta) => seen.push(delta) },
    )
    expect(seen).toEqual([])
    expect(result.text).toBe("")
    expect(result.finishReason).toBe("stop")
  })

  test("ignores interleaved foreign response ids", async () => {
    const seen: string[] = []
    await consumeQwenStream(
      byteStream([
        'data: {"type":"response.created","response":{"id":"r1"}}\n',
        'data: {"response_id":"r1","choices":[{"delta":{"phase":"answer","content":"mine"}}]}\n',
        'data: {"response_id":"r2","choices":[{"delta":{"phase":"answer","content":"mine + theirs"}}]}\n',
        "data: [DONE]\n",
      ]),
      { onText: (delta) => seen.push(delta) },
    )
    expect(seen).toEqual(["mine"])
  })

  test("captures thinking summaries and usage", async () => {
    const reasoning: string[] = []
    const result = await consumeQwenStream(
      byteStream([
        'data: {"response_id":"r1","choices":[{"delta":{"phase":"thinking_summary","extra":{"summary_title":{"content":["Plan"]},"summary_thought":{"content":["First."]}}}}]}\n',
        'data: {"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}\n',
        "data: [DONE]\n",
      ]),
      { onReasoning: (delta) => reasoning.push(delta) },
    )
    expect(reasoning).toEqual(["**Plan**\n\nFirst."])
    expect(result.reasoning).toBe("**Plan**\n\nFirst.")
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  })

  test("stream errors end the consumption with a typed error", async () => {
    const result = await consumeQwenStream(
      byteStream([
        'data: {"response_id":"r1","choices":[{"delta":{"phase":"answer","content":"partial"}}]}\n',
        'data: {"error":{"code":"E1","message":"kaput"}}\n',
      ]),
    )
    expect(result.text).toBe("partial")
    expect(result.finishReason).toBe("error")
    expect(result.error?.code).toBe("upstream_error")
  })

  test("deleted-chat stream errors carry the stale-chat recovery marker", async () => {
    const result = await consumeQwenStream(
      byteStream(['data: {"error":{"code":"CHAT_NOT_FOUND","message":"This chat has been deleted."}}\n']),
    )
    expect(result.finishReason).toBe("error")
    expect(result.error?.upstreamCode).toBe("chat_not_exist")
    expect(result.error?.retryable).toBe(true)
  })

  test("aborted signals stop consumption", async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await consumeQwenStream(byteStream(["data: [DONE]\n"]), undefined, controller.signal).catch((e) => e)
    expect(error).toBeInstanceOf(QwenWebError)
    expect((error as QwenWebError).code).toBe("aborted")
  })
})

describe("workstream 232 cancellation cleanup (session)", () => {
  test("stopGeneration calls abortLocal first, only once with known pair, and skips when pair unknown", async () => {
    const stops: Array<{ chatId: string; responseId: string | undefined }> = []
    let abortLocalCalled = false
    const transport = fakeTransport({
      requestJson: async (_method: string, path: string, opts?: { body?: string }) => {
        if (path.includes("/chat/completions/stop")) {
          stops.push({ chatId: "c1", responseId: JSON.parse(opts?.body ?? "{}").response_id })
        }
        // Resolve quickly; local abort already executed synchronously.
        await new Promise((r) => setTimeout(r, 20))
        return { status: 200, statusText: "OK", contentType: "application/json", body: "{}" }
      },
      rawRequestStream: async () => ({
        status: 200, contentType: "text/event-stream",
        stream: byteStream(['data: {"type":"response.created","response":{"id":"r1","chat_id":"c1"}}\n\n']),
        abort: () => {},
      }),
      idleBudgetMs: () => 100,
    })
    const storePath = `/tmp/session-test-232-${Math.random().toString(36).slice(2)}.json`
    const session = new QwenWebSession({ transport, store: new (await import("@opencode-ai/webchat/store")).ThreadStore({ file: storePath }) })

    // With known pair: local abort must happen before remote wait; only one stop attempt
    const p = session.stopGeneration("c1", "r1", () => { abortLocalCalled = true })
    // Give micro-task time; abortLocal is synchronous
    await new Promise((r) => setTimeout(r, 5))
    expect(abortLocalCalled).toBe(true)
    // Remote completes quickly; exactly one stop POST recorded
    await p
    expect(stops.length).toBe(1)
    expect(stops[0]!.responseId).toBe("r1")

    // Unknown pair: must return immediately without touching remote
    abortLocalCalled = false
    const quick = await session.stopGeneration("c1", undefined, () => { abortLocalCalled = true })
    expect(abortLocalCalled).toBe(true)
    // No additional stop POST beyond the one from the known-pair case above.
    expect(stops.length).toBe(1)
  })

  test("abort landing during response setup tears down the upstream stream", async () => {
    let upstreamAborted = false
    const ac = new AbortController()
    const transport = fakeTransport({
      rawRequestStream: async () => {
        // The abort lands after runTurn's entry check but before the abort
        // listener is installed: a {once:true} listener attached to an
        // already-aborted signal never fires, so without the explicit
        // signal.aborted pre-check the upstream stream would leak.
        ac.abort()
        return {
          status: 200,
          contentType: "text/event-stream",
          stream: byteStream([
            'data: {"type":"response.created","response":{"id":"r1","chat_id":"c1"}}\n',
          ]),
          abort: () => {
            upstreamAborted = true
          },
        }
      },
      idleBudgetMs: () => 100,
    })
    const storePath = `/tmp/session-test-232-2-${Math.random().toString(36).slice(2)}.json`
    const session = new QwenWebSession({ transport, store: new (await import("@opencode-ai/webchat/store")).ThreadStore({ file: storePath }) })
    const thread = await session.createThread({ model: "m" })
    // Existing binding: skip chat creation so the turn reaches the stream setup.
    thread.providerId = "c1"
    // The turn surfaces the abort as an error event (it does not reject).
    const events: Array<{ type: string; error?: unknown }> = []
    for await (const ev of session.runTurn({ thread, content: "test", signal: ac.signal })) {
      events.push(ev as { type: string; error?: unknown })
    }
    const errorEvent = events.find((e) => e.type === "error")
    expect(errorEvent).toBeDefined()
    expect(String((errorEvent!.error as { code?: string; message?: string })?.code ?? (errorEvent!.error as Error)?.message)).toMatch(/abort/i)
    expect(upstreamAborted).toBe(true)
  })
})

describe("issue 232 workstream 5: session phase and sanitized diagnostics", () => {
  const SECRETS = ["COOKIE_FIXTURE", "WAF_FIXTURE", "AUTH_FIXTURE", "PROMPT_FIXTURE"]
  const DIAGNOSTIC =
    "broker rejected request; cookie=COOKIE_FIXTURE; bx-ua=WAF_FIXTURE; authorization=Bearer AUTH_FIXTURE; full prompt: PROMPT_FIXTURE"

  test("createChat failure is chat-create phase with safe detail", async () => {
    const transport = fakeTransport({
      rawRequestJson: (async () => ({
        status: 503,
        statusText: "Service Unavailable",
        contentType: "application/json",
        body: JSON.stringify({ success: false, code: "E_CREATE", message: DIAGNOSTIC }),
      })) as QwenWebTransport["rawRequestJson"],
    })
    const error = await captureRejection(new QwenWebSession({ transport }).createChat("m"))
    expect(error.phase).toBe("chat-create")
    expect(error.code).toBe("upstream_error")
    expect(error.status).toBe(503)
    expect(error.upstreamCode).toBe("E_CREATE")
    expect(error.retryable).toBe(true)
    expect(error.detail).toContain("broker rejected request")
    for (const secret of SECRETS) {
      expect(error.message).not.toContain(secret)
      expect(error.detail ?? "").not.toContain(secret)
    }
  })

  test("startGeneration non-SSE failure is setup phase; auth failure stays auth", async () => {
    const setupTransport = fakeTransport({
      rawRequestJson: (async () => ({ status: 200, statusText: "OK", contentType: "application/json", body: '{"chat_id":"c1"}' })) as QwenWebTransport["rawRequestJson"],
      rawRequestStream: (async () => ({
        status: 503,
        contentType: "application/json",
        stream: byteStream([JSON.stringify({ success: false, code: "E_SETUP", message: DIAGNOSTIC })]),
        abort: () => {},
      })) as QwenWebTransport["rawRequestStream"],
    })
    const setupError = await captureRejection(new QwenWebSession({ transport: setupTransport }).startGeneration({ prompt: "hi", model: "m" }))
    expect(setupError.phase).toBe("setup")
    expect(setupError.status).toBe(503)
    expect(setupError.upstreamCode).toBe("E_SETUP")
    for (const secret of SECRETS) expect(setupError.message).not.toContain(secret)

    const authTransport = fakeTransport({
      rawRequestJson: (async () => ({ status: 401, statusText: "Unauthorized", contentType: "application/json", body: '{"success":false,"message":"login required"}' })) as QwenWebTransport["rawRequestJson"],
    })
    const authError = await captureRejection(new QwenWebSession({ transport: authTransport }).createChat("m"))
    expect(authError.phase).toBe("auth")
    expect(authError.code).toBe("session_expired")
    expect(authError.status).toBe(401)
  })

  test("stopGeneration debug output carries only safe fields", async () => {
    const previous = process.env.QWEN_WEB_DEBUG
    process.env.QWEN_WEB_DEBUG = "1"
    const debugSpy = spyOn(console, "debug").mockImplementation(() => {})
    try {
      let aborted = false
      const transport = fakeTransport({
        requestJson: (async () => ({
          status: 403,
          statusText: "Forbidden",
          contentType: "application/json",
          body: JSON.stringify({ ret: ["FAIL_SYS_USER_VALIDATE"], cookie: "COOKIE_FIXTURE", "bx-umidtoken": "WAF_FIXTURE", message: "full prompt: PROMPT_FIXTURE" }),
        })) as QwenWebTransport["requestJson"],
      })
      await new QwenWebSession({ transport }).stopGeneration("c1", "r1", () => { aborted = true })
      const output = debugSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n")
      expect(aborted).toBe(true)
      expect(output).toContain("auth")
      expect(output).toContain("challenge")
      expect(output).toContain("403")
      for (const secret of SECRETS) expect(output).not.toContain(secret)
    } finally {
      debugSpy.mockRestore()
      if (previous === undefined) delete process.env.QWEN_WEB_DEBUG
      else process.env.QWEN_WEB_DEBUG = previous
    }
  })

  test("consumeQwenStream error is stream phase with status 200 and safe detail", async () => {
    const result = await consumeQwenStream(byteStream([`data: ${JSON.stringify({ error: { code: "E_STREAM", message: DIAGNOSTIC } })}\n`]))
    expect(result.error?.phase).toBe("stream")
    expect(result.error?.status).toBe(200)
    expect(result.error?.upstreamCode).toBe("E_STREAM")
    for (const secret of SECRETS) {
      expect(result.error?.message ?? "").not.toContain(secret)
      expect(result.error?.detail ?? "").not.toContain(secret)
    }
  })
})
