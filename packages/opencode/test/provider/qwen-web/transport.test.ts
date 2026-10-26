import { describe, expect, test } from "bun:test"
import type { QwenWebBrowser, QwenWebPage } from "@opencode-ai/webchat/adapters/qwen/browser"
import { QwenWebError } from "@opencode-ai/webchat/adapters/qwen/errors"
import { QWEN_WEB_CLIENT_CONTEXT_ARG } from "@opencode-ai/webchat/adapters/qwen/constants"
import { qwenWebOrigin } from "@opencode-ai/webchat/adapters/qwen/protocol"
import { QwenWebTransport, type JsonResponse } from "@opencode-ai/webchat/adapters/qwen/transport"

interface BridgeCall {
  requestId: string
  bindingName: string
}

interface Fake {
  page: QwenWebPage
  bindings: Map<string, (...args: any[]) => unknown>
  evaluates: Array<{ kind: "json" | "bridge" | "abort" | "signal" | "context"; arg: Record<string, any> | string }>
  jsonHandler: (arg: Record<string, any>) => JsonResponse
  onBridge: (call: BridgeCall) => void
  ensureOnOrigin: () => Promise<QwenWebPage>
  restoreChecks: Array<boolean | undefined>
  invalidated: () => boolean
  browser: QwenWebBrowser
  wafSignals: Record<string, string>
  cookies: Array<{ name: string; value: string }>
}

function makeFake(): Fake {
  const fake = {} as Fake
  fake.bindings = new Map()
  fake.evaluates = []
  fake.restoreChecks = []
  fake.jsonHandler = () => ({ status: 200, statusText: "OK", contentType: "application/json", body: "{}" })
  fake.onBridge = () => {}
  fake.wafSignals = { "bx-v": "2.5.37", version: "0.2.91", "bx-ua": "bxua-fake", "bx-umidtoken": "tok-fake" }
  fake.cookies = [{ name: "token", value: "abc" }, { name: "isg", value: "123" }]
  fake.page = {
    url: () => "https://chat.qwen.ai/",
    isClosed: () => false,
    goto: async () => {},
    evaluate: (async (_fn: unknown, arg: Record<string, any> | string) => {
      if (arg === QWEN_WEB_CLIENT_CONTEXT_ARG) {
        fake.evaluates.push({ kind: "context", arg })
        return {
          "user-agent": "Chrome/151",
          "accept-language": "en-US,en;q=0.9",
          "sec-ch-ua": "\"Not=A?Brand\";v=\"99\", \"Chromium\";v=\"151\"",
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": "\"Windows\"",
        }
      }
      if (typeof arg === "string") {
        fake.evaluates.push({ kind: "signal", arg })
        return { ...fake.wafSignals }
      }
      if (arg && Array.isArray((arg as { keys?: unknown }).keys)) {
        fake.evaluates.push({ kind: "signal", arg })
        return { ...fake.wafSignals }
      }
      if (arg?.bindingName) {
        fake.evaluates.push({ kind: "bridge", arg })
        const call = { requestId: arg.requestId as string, bindingName: arg.bindingName as string }
        setTimeout(() => fake.onBridge(call), 0)
        return true
      }
      if (arg?.abortersKey) {
        fake.evaluates.push({ kind: "abort", arg })
        return true
      }
      fake.evaluates.push({ kind: "json", arg })
      return fake.jsonHandler(arg)
    }) as QwenWebPage["evaluate"],
    exposeBinding: (async (name: string, callback: (...args: any[]) => unknown) => {
      fake.bindings.set(name, callback)
    }) as QwenWebPage["exposeBinding"],
    title: async () => "",
    context: () =>
      ({
        pages: () => [fake.page],
        newPage: async () => fake.page,
        cookies: async () => fake.cookies,
        close: async () => {},
        on: () => {},
      }) as unknown as ReturnType<QwenWebPage["context"]>,
    on: () => {},
    close: async () => {},
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
  } as unknown as QwenWebPage
  let invalidated = false
  fake.invalidated = () => invalidated
  let pageOpen: ((page: QwenWebPage) => void) | undefined
  fake.ensureOnOrigin = async () => {
    pageOpen?.(fake.page)
    return fake.page
  }
  fake.browser = {
    ensureOnOrigin: (...args: unknown[]) => (fake.ensureOnOrigin as (...a: unknown[]) => Promise<QwenWebPage>)(...args),
    ensureForRequest: (...args: unknown[]) => {
      fake.restoreChecks.push((args[1] as { canRestore?: () => boolean } | undefined)?.canRestore?.())
      return (fake.ensureOnOrigin as (...a: unknown[]) => Promise<QwenWebPage>)(...args)
    },
    invalidatePage: () => {
      invalidated = true
    },
    onPageOpen: (handler: (page: QwenWebPage) => void) => {
      pageOpen = handler
    },
  } as unknown as QwenWebBrowser
  return fake
}

function emit(fake: Fake, call: BridgeCall, event: Record<string, unknown>): void {
  const binding = fake.bindings.get(call.bindingName)
  if (!binding) throw new Error(`binding ${call.bindingName} not installed`)
  binding({} as unknown, call.requestId, event)
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

async function captureRejection(promise: Promise<unknown>): Promise<QwenWebError> {
  try {
    await promise
  } catch (error) {
    return error as QwenWebError
  }
  throw new Error("expected promise to reject")
}

function mockFetch(handler: (input: RequestInfo | URL, init: RequestInit | undefined) => Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(input, init)) as unknown as typeof fetch
}

function pending(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"))
      return
    }
    signal?.addEventListener(
      "abort",
      () => reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError")),
      { once: true },
    )
  })
}

function signalTiedStream(init: RequestInit | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(inner) {
      const signal = init?.signal
      if (!signal || signal.aborted) {
        if (signal?.aborted) {
          inner.error(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"))
        }
        return
      }
      signal.addEventListener(
        "abort",
        () =>
          inner.error(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      )
    },
  })
}

async function withFetch(mock: typeof fetch, run: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch
  globalThis.fetch = mock
  try {
    await run()
  } finally {
    globalThis.fetch = realFetch
  }
}

describe("QwenWebTransport.requestJson", () => {
  test("runs in-page fetch with merged headers", async () => {
    const fake = makeFake()
    fake.jsonHandler = (arg) => {
      expect(arg["url"]).toBe("https://chat.qwen.ai/api/models")
      expect(arg["method"]).toBe("GET")
      expect(arg["headers"]["source"]).toBe("web")
      expect(arg["headers"]["x-extra"]).toBe("yes")
      return { status: 200, statusText: "OK", contentType: "application/json", body: '{"data":[]}' }
    }
    const transport = new QwenWebTransport({ browser: fake.browser })
    const response = await transport.requestJson("GET", "/api/models", { headers: { "x-extra": "yes" } })
    expect(response.status).toBe(200)
    expect(response.body).toBe('{"data":[]}')
    expect(fake.evaluates.filter((item) => item.kind === "json")).toHaveLength(1)
  })

  test("aborted signals never reach the page", async () => {
    const fake = makeFake()
    const transport = new QwenWebTransport({ browser: fake.browser })
    const controller = new AbortController()
    controller.abort()
    const error = await transport.requestJson("GET", "/x", { signal: controller.signal }).catch((e) => e)
    expect((error as QwenWebError).code).toBe("aborted")
    expect(fake.evaluates).toHaveLength(0)
  })

  test("dead contexts invalidate the page and report retryable errors", async () => {
    const fake = makeFake()
    fake.ensureOnOrigin = async () => {
      throw new Error("Target closed")
    }
    const transport = new QwenWebTransport({ browser: fake.browser })
    const error = await captureRejection(transport.requestJson("GET", "/x"))
    expect(error.code).toBe("browser_error")
    expect(error.retryable).toBe(true)
    expect(fake.invalidated()).toBe(true)
  })
})

describe("QwenWebTransport.requestStream", () => {
  test("assembles bridged chunks incrementally", async () => {
    const fake = makeFake()
    fake.onBridge = (call) => {
      emit(fake, call, { type: "headers", status: 200, contentType: "text/event-stream" })
      emit(fake, call, { type: "chunk", data: "Hello " })
      emit(fake, call, { type: "chunk", data: "world" })
      emit(fake, call, { type: "done" })
    }
    const transport = new QwenWebTransport({ browser: fake.browser })
    const response = await transport.requestStream("POST", "/api/v2/chat/completions", { body: "{}" })
    expect(response.status).toBe(200)
    // The binding is installed once per page, even across streams.
    expect(fake.bindings.size).toBe(1)
    expect(await readAll(response.stream)).toBe("Hello world")
    // Events for unknown request ids are ignored.
    fake.bindings.get("__silvercodeQwenStream")?.({}, "nope", { type: "chunk", data: "x" })
  })

  test("passes non-200 statuses through to the caller", async () => {
    const fake = makeFake()
    fake.onBridge = (call) => {
      emit(fake, call, { type: "headers", status: 429, contentType: "application/json" })
      emit(fake, call, { type: "chunk", data: '{"success":false}' })
      emit(fake, call, { type: "done" })
    }
    const transport = new QwenWebTransport({ browser: fake.browser })
    const response = await transport.requestStream("POST", "/x")
    expect(response.status).toBe(429)
    expect(await readAll(response.stream)).toBe('{"success":false}')
  })

  test("bridge errors fail the stream", async () => {
    const fake = makeFake()
    fake.onBridge = (call) => {
      emit(fake, call, { type: "headers", status: 200, contentType: "text/event-stream" })
      emit(fake, call, { type: "error", message: "socket hang up" })
    }
    const transport = new QwenWebTransport({ browser: fake.browser })
    const response = await transport.requestStream("POST", "/x")
    const error = await captureRejection(readAll(response.stream))
    expect(error.code).toBe("network_error")
    expect(error.retryable).toBe(true)
  })

  test("missing headers time out", async () => {
    const fake = makeFake()
    fake.onBridge = () => {}
    const transport = new QwenWebTransport({ browser: fake.browser, metadataTimeoutMs: 30 })
    const error = await captureRejection(transport.requestStream("POST", "/x"))
    expect(error.code).toBe("timeout")
    expect(error.retryable).toBe(true)
  })

  test("stalled streams time out on idle", async () => {
    const fake = makeFake()
    fake.onBridge = (call) => {
      emit(fake, call, { type: "headers", status: 200, contentType: "text/event-stream" })
    }
    const transport = new QwenWebTransport({ browser: fake.browser, idleTimeoutMs: 30, metadataTimeoutMs: 1000 })
    const response = await transport.requestStream("POST", "/x")
    const error = await captureRejection(readAll(response.stream))
    expect(error.code).toBe("timeout")
  })

  test("abort() stops the upstream fetch and releases the slot", async () => {
    const fake = makeFake()
    fake.onBridge = (call) => {
      emit(fake, call, { type: "headers", status: 200, contentType: "text/event-stream" })
    }
    const transport = new QwenWebTransport({ browser: fake.browser, idleTimeoutMs: 5000, metadataTimeoutMs: 1000 })
    const response = await transport.requestStream("POST", "/x")
    response.abort()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fake.evaluates.some((item) => item.kind === "abort")).toBe(true)
    const error = await captureRejection(readAll(response.stream))
    expect(error.code).toBe("aborted")
  })

  test("external abort signals propagate", async () => {
    const fake = makeFake()
    fake.onBridge = () => {}
    const transport = new QwenWebTransport({ browser: fake.browser, metadataTimeoutMs: 5000 })
    const controller = new AbortController()
    const pending = transport.requestStream("POST", "/x", { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    const error = await captureRejection(pending)
    expect(error.code).toBe("aborted")
  })

  test("stream slots serialize beyond capacity", async () => {
    const fake = makeFake()
    const calls: BridgeCall[] = []
    fake.onBridge = (call) => {
      calls.push(call)
      emit(fake, call, { type: "headers", status: 200, contentType: "text/event-stream" })
    }
    const transport = new QwenWebTransport({
      browser: fake.browser,
      maxStreams: 1,
      idleTimeoutMs: 5000,
      metadataTimeoutMs: 1000,
    })
    const first = await transport.requestStream("POST", "/a")
    let second: Awaited<ReturnType<QwenWebTransport["requestStream"]>> | undefined
    const pending = transport.requestStream("POST", "/b").then((response) => {
      second = response
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toHaveLength(1)
    expect(second).toBeUndefined()
    first.abort()
    await pending
    expect(calls).toHaveLength(2)
    second?.abort()
  })
})

describe("QwenWebTransport headless restore gate", () => {
  const stream = (fake: Fake) => {
    fake.onBridge = (call) => emit(fake, call, { type: "headers", status: 200, contentType: "text/event-stream" })
  }

  test("a running stream blocks the restore for other requests and releases it when it ends", async () => {
    const fake = makeFake()
    stream(fake)
    const transport = new QwenWebTransport({ browser: fake.browser, maxStreams: 2, idleTimeoutMs: 5000, metadataTimeoutMs: 1000 })
    const running = await transport.requestStream("POST", "/a")
    await transport.requestJson("GET", "/meta")
    const second = await transport.requestStream("POST", "/b")
    // stream a: alone; json meta: a stream is running; stream b: another stream is running
    expect(fake.restoreChecks).toEqual([true, false, false])
    running.abort()
    second.abort()
    await transport.requestJson("GET", "/meta")
    expect(fake.restoreChecks.at(-1)).toBe(true)
  })

  test("an in-flight one-shot request blocks the restore and the counter is cleaned up after success and failure", async () => {
    const fake = makeFake()
    const transport = new QwenWebTransport({ browser: fake.browser, metadataTimeoutMs: 1000 })
    const original = fake.page.evaluate.bind(fake.page)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    fake.page.evaluate = (async (fn: unknown, arg: unknown) => {
      await gate
      return (original as (f: unknown, a: unknown) => unknown)(fn, arg)
    }) as QwenWebPage["evaluate"]
    const first = transport.requestJson("GET", "/one")
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = transport.requestJson("GET", "/two")
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    await Promise.all([first, second])
    expect(fake.restoreChecks).toEqual([true, false])
    fake.page.evaluate = (async () => {
      throw new Error("page is closed")
    }) as QwenWebPage["evaluate"]
    await captureRejection(transport.requestJson("GET", "/three"))
    fake.page.evaluate = original as QwenWebPage["evaluate"]
    await transport.requestJson("GET", "/four")
    expect(fake.restoreChecks.slice(-2)).toEqual([true, true])
  })
})

describe("QwenWebTransport.rawRequest", () => {

  test("rawRequestJson sends cookies + WAF signals and returns the body", async () => {
    const fake = makeFake()
    const transport = new QwenWebTransport({ browser: fake.browser })
    await withFetch(
      mockFetch(async (input, init) => {
        const url = typeof input === "string" ? input : (input as URL).href
        expect(url).toBe("https://chat.qwen.ai/api/v2/chats/new")
        const headers = (init?.headers ?? {}) as Record<string, string>
        expect(headers["cookie"]).toBe("token=abc; isg=123")
        expect(headers["bx-v"]).toBe("2.5.37")
        expect(headers["bx-ua"]).toBe("bxua-fake")
        expect(headers["bx-umidtoken"]).toBe("tok-fake")
        expect(headers["version"]).toBe("0.2.91")
        expect(headers["accept"]).toBe("application/json")
        expect(headers["x-accel-buffering"]).toBe("no")
        expect(headers["origin"]).toBe(qwenWebOrigin())
        expect(headers["referer"]).toBe("https://chat.qwen.ai/c/c1")
        expect(headers["source"]).toBe("web")
        expect(headers["user-agent"]).toBe("Chrome/151")
        expect(headers["accept-language"]).toBe("en-US,en;q=0.9")
        expect(headers["sec-ch-ua"]).toBe("\"Not=A?Brand\";v=\"99\", \"Chromium\";v=\"151\"")
        expect(headers["sec-ch-ua-mobile"]).toBe("?0")
        expect(headers["sec-ch-ua-platform"]).toBe("\"Windows\"")
        expect(init?.body).toBe('{"x":1}')
        return new Response('{"chat_id":"c1"}', { status: 200, headers: { "content-type": "application/json" } })
      }),
      async () => {
        const response = await transport.rawRequestJson("POST", "/api/v2/chats/new", {
          body: '{"x":1}',
          referrer: "/c/c1",
        })
        expect(response.status).toBe(200)
        expect(response.contentType).toBe("application/json")
        expect(response.body).toBe('{"chat_id":"c1"}')
      },
    )
    expect(fake.evaluates.some((item) => item.kind === "signal")).toBe(true)
    expect(fake.evaluates.some((item) => item.kind === "context")).toBe(true)
  })

  test("rawRequestStream relays the SSE bytes", async () => {
    const fake = makeFake()
    const transport = new QwenWebTransport({ browser: fake.browser, idleTimeoutMs: 5000 })
    await withFetch(
      mockFetch(async () => {
        return new Response("data: A\n\ndata: B\n", { status: 200, headers: { "content-type": "text/event-stream" } })
      }),
      async () => {
        const response = await transport.rawRequestStream("POST", "/api/v2/chat/completions?chat_id=c", { body: "{}" })
        expect(response.status).toBe(200)
        expect(response.contentType).toBe("text/event-stream")
        expect(await readAll(response.stream)).toBe("data: A\n\ndata: B\n")
      },
    )
  })

  test("missing response headers time out", async () => {
    const fake = makeFake()
    const transport = new QwenWebTransport({ browser: fake.browser, metadataTimeoutMs: 30 })
    await withFetch(mockFetch(async (_input, init) => pending(init)), async () => {
      const error = await captureRejection(transport.rawRequestStream("POST", "/x"))
      expect(error.code).toBe("timeout")
      expect(error.retryable).toBe(true)
    })
  })

  test("external abort signals surface as aborted", async () => {
    const fake = makeFake()
    const transport = new QwenWebTransport({ browser: fake.browser, metadataTimeoutMs: 5000 })
    const controller = new AbortController()
    await withFetch(
      mockFetch(async (_input, init) => pending(init)),
      async () => {
        const pendingCall = transport.rawRequestStream("POST", "/x", { signal: controller.signal })
        setTimeout(() => controller.abort(), 10)
        const error = await captureRejection(pendingCall)
        expect(error.code).toBe("aborted")
      },
    )
  })

  test("stalled streams time out on idle", async () => {
    const fake = makeFake()
    const transport = new QwenWebTransport({ browser: fake.browser, idleTimeoutMs: 30, metadataTimeoutMs: 1000 })
    await withFetch(
      mockFetch(async (_input, init) => new Response(signalTiedStream(init), { status: 200, headers: { "content-type": "text/event-stream" } })),
      async () => {
        const response = await transport.rawRequestStream("POST", "/x", { body: "{}" })
        const error = await captureRejection(readAll(response.stream))
        expect(error.code).toBe("timeout")
      },
    )
  })

  test("abort() ends a running raw stream cleanly", async () => {
    const fake = makeFake()
    const transport = new QwenWebTransport({ browser: fake.browser, idleTimeoutMs: 5000, metadataTimeoutMs: 1000 })
    await withFetch(
      mockFetch(async (_input, init) => new Response(signalTiedStream(init), { status: 200, headers: { "content-type": "text/event-stream" } })),
      async () => {
        const response = await transport.rawRequestStream("POST", "/x")
        response.abort()
        expect(await readAll(response.stream)).toBe("")
      },
    )
  })

  test("static client-version headers apply when WAF signals are not captured", async () => {
    const fake = makeFake()
    fake.wafSignals = {}
    const transport = new QwenWebTransport({ browser: fake.browser, metadataTimeoutMs: 30 })
    await withFetch(
      mockFetch(async (_input, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>
        expect(headers["bx-v"]).toBe("2.5.37")
        expect(headers["version"]).toBe("0.2.91")
        expect(headers["bx-ua"]).toBeUndefined()
        expect(headers["bx-umidtoken"]).toBeUndefined()
        expect(headers["user-agent"]).toBe("Chrome/151")
        expect(headers["accept-language"]).toBe("en-US,en;q=0.9")
        expect(headers["cookie"]).toBe("token=abc; isg=123")
        return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } })
      }),
      async () => {
        const response = await transport.rawRequestJson("GET", "/ping")
        expect(response.body).toBe('{"ok":true}')
      },
    )
  })

  test("streaming requests reuse the real WAF token pair captured from page traffic", async () => {
    const fake = makeFake()
    fake.wafSignals = {}
    let onRequest: ((request: { url(): string; method(): string; headers(): Record<string, string> }) => void) | undefined
    fake.page.on = ((event: string, handler: unknown) => {
      if (event === "request") onRequest = handler as typeof onRequest
    }) as QwenWebPage["on"]
    const transport = new QwenWebTransport({ browser: fake.browser, metadataTimeoutMs: 30 })
    await withFetch(
      mockFetch(async (_input, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>
        expect(headers["bx-ua"]).toBe("bxua-fake")
        expect(headers["bx-umidtoken"]).toBe("tok-fake")
        return new Response("data: A\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
      }),
      async () => {
        setTimeout(() => {
          onRequest?.({
            url: () => "https://chat.qwen.ai/api/v1/auths/",
            method: () => "GET",
            headers: () => ({ "bx-ua": "bxua-fake", "bx-umidtoken": "tok-fake" }),
          })
        }, 10)
        const response = await transport.rawRequestStream("POST", "/api/v2/chat/completions?chat_id=c", { body: "{}" })
        expect(await readAll(response.stream)).toBe("data: A\n\n")
      },
    )
  })

  test("subsequent streaming requests skip the harvest and reuse the captured pair", async () => {
    const fake = makeFake()
    fake.wafSignals = {}
    let onRequest: ((request: { url(): string; method(): string; headers(): Record<string, string> }) => void) | undefined
    fake.page.on = ((event: string, handler: unknown) => {
      if (event === "request") onRequest = handler as typeof onRequest
    }) as QwenWebPage["on"]
    const transport = new QwenWebTransport({ browser: fake.browser, metadataTimeoutMs: 30, idleTimeoutMs: 5000 })
    let fetches = 0
    await withFetch(
      mockFetch(async (_input, init) => {
        fetches++
        const headers = (init?.headers ?? {}) as Record<string, string>
        expect(headers["bx-ua"]).toBe("bxua-fake")
        expect(headers["bx-umidtoken"]).toBe("tok-fake")
        return new Response("data: A\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
      }),
      async () => {
        setTimeout(() => {
          onRequest?.({
            url: () => "https://chat.qwen.ai/api/v1/auths/",
            method: () => "GET",
            headers: () => ({ "bx-ua": "bxua-fake", "bx-umidtoken": "tok-fake" }),
          })
        }, 10)
        const first = await transport.rawRequestStream("POST", "/api/v2/chat/completions?chat_id=c", { body: "{}" })
        expect(await readAll(first.stream)).toBe("data: A\n\n")
        const before = fake.evaluates.length
        const second = await transport.rawRequestStream("POST", "/api/v2/chat/completions?chat_id=c", { body: "{}" })
        expect(await readAll(second.stream)).toBe("data: A\n\n")
        expect(fetches).toBe(2)
        const newSignalReads = fake.evaluates
          .slice(before)
          .filter((item) => item.kind === "signal").length
        expect(newSignalReads).toBe(1)
      },
    )
  })

  test("streaming requests skip the harvest poll during the post-miss cooldown", async () => {
    const fake = makeFake()
    fake.wafSignals = {}
    const transport = new QwenWebTransport({
      browser: fake.browser,
      metadataTimeoutMs: 30,
      idleTimeoutMs: 5000,
      wafHardWaitMs: 20,
      wafHarvestCooldownMs: 60_000,
    })
    await withFetch(
      mockFetch(async () => new Response("data: A\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })),
      async () => {
        const first = await transport.rawRequestStream("POST", "/api/v2/chat/completions?chat_id=c", { body: "{}" })
        expect(await readAll(first.stream)).toBe("data: A\n\n")
        const firstSignalReads = fake.evaluates.filter((item) => item.kind === "signal").length
        expect(firstSignalReads).toBeGreaterThan(1)
        const before = fake.evaluates.length
        const second = await transport.rawRequestStream("POST", "/api/v2/chat/completions?chat_id=c", { body: "{}" })
        expect(await readAll(second.stream)).toBe("data: A\n\n")
        const newSignalReads = fake.evaluates
          .slice(before)
          .filter((item) => item.kind === "signal").length
        expect(newSignalReads).toBe(1)
      },
    )
  })
})


describe("workstream 232 cancellation cleanup (transport) — listener ownership", () => {
  test("single ownership: listener set empty after finish, abort, and cancel", async () => {
    // Track listener identities (not just event names) so a leaked listener
    // left installed after any terminal path is detected exactly.
    const scenarios = ["finish", "abort", "cancel"] as const
    for (const scenario of scenarios) {
      const fake = makeFake()
      fake.onBridge = (call) => {
        emit(fake, call, { type: "headers", status: 200, contentType: "text/event-stream" })
      }
      const transport = new QwenWebTransport({ browser: fake.browser, idleTimeoutMs: 5000, metadataTimeoutMs: 1000 })
      await withFetch(
        mockFetch(async (_input, init) => {
          if (scenario === "finish") {
            return new Response("data: A\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
          }
          // Stay pending until the fetch is torn down by the controller.
          return new Response(signalTiedStream(init), { status: 200, headers: { "content-type": "text/event-stream" } })
        }),
        async () => {
          const signal = new AbortController()
          const installed = new Set<unknown>()
          const origAdd = signal.signal.addEventListener.bind(signal.signal)
          const origRemove = signal.signal.removeEventListener.bind(signal.signal)
          signal.signal.addEventListener = ((...args: any[]) => {
            if (args[0] === "abort") installed.add(args[1])
            return (origAdd as any)(...args)
          }) as typeof signal.signal.addEventListener
          signal.signal.removeEventListener = ((...args: any[]) => {
            if (args[0] === "abort") installed.delete(args[1])
            return (origRemove as any)(...args)
          }) as typeof signal.signal.removeEventListener

          const response = await transport.rawRequestStream("POST", "/x", { signal: signal.signal })
          if (scenario === "finish") {
            await readAll(response.stream)
          } else if (scenario === "abort") {
            signal.abort()
            await readAll(response.stream).catch(() => {})
          } else {
            await response.stream.cancel().catch(() => {})
          }
          // Let the pump's stop/finalize run.
          await new Promise((resolve) => setTimeout(resolve, 20))
          expect(installed.size).toBe(0)
        },
      )
    }
  })

  test("already-aborted signal aborts controller immediately; no hang", async () => {
    const fake = makeFake()
    fake.onBridge = (call) => {
      emit(fake, call, { type: "headers", status: 200, contentType: "text/event-stream" })
    }
    const transport = new QwenWebTransport({ browser: fake.browser, metadataTimeoutMs: 1000 })
    await withFetch(
      mockFetch(async () => new Response("data: A\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })),
      async () => {
        const signal = new AbortController()
        signal.abort()
        // Pre-aborted signals reject before any upstream work (no fetch, no hang).
        const error = await transport.rawRequestStream("POST", "/x", { signal: signal.signal }).then(
          () => undefined,
          (e: unknown) => e,
        )
        expect(error).toBeInstanceOf(QwenWebError)
        expect((error as QwenWebError).code).toBe("aborted")
        expect((error as QwenWebError).retryable).toBe(false)
      },
    )
  })
})
