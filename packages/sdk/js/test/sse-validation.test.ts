import { expect, test } from "bun:test"
import { createSseClient } from "../src/v2/gen/core/serverSentEvents.gen"

// #435: the SSE parser casts parsed JSON to the event type unchecked. A
// frame that is valid JSON but not a shaped event must not reach consumers.

const sse = (frames: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame))
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )

test("malformed event frames are reported and skipped, valid frames still stream", async () => {
  const errors: unknown[] = []
  const events: string[] = []
  const client = createSseClient<{ payload: { type: string } }>({
    url: "http://localhost/event",
    fetch: (async () =>
      sse([
        'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
        'data: {"type":"session.idle","properties":{}}\n\n',
        'data: {"unexpected":"shape"}\n\n',
        'data: {"payload":{"type":"server.heartbeat","properties":{}}}\n\n',
      ])) as typeof fetch,
    responseValidator: (data) => {
      if (typeof data !== "object" || data === null) throw new Error("Malformed SSE event frame")
      const envelope = data as { type?: unknown; payload?: { type?: unknown } }
      if (typeof envelope.type !== "string" && typeof envelope.payload?.type !== "string") {
        throw new Error("Malformed SSE event frame")
      }
    },
    onSseError: (error) => errors.push(error),
    onSseEvent: (event) => events.push(event.data?.payload?.type ?? ""),
  })

  const received: string[] = []
  for await (const event of client.stream) received.push(event as { payload: { type: string } })

  expect(received.map((event) => (event as Record<string, unknown>).type ?? (event as { payload: { type: string } }).payload.type)).toEqual([
    "server.connected",
    "session.idle",
    "server.heartbeat",
  ])
  expect(events).toEqual(["server.connected", "", "server.heartbeat"])
  expect(errors.length).toBe(1)
  expect(String(errors[0])).toContain("Malformed SSE event frame")
})

test("unparseable frames still surface as raw strings without invoking the validator", async () => {
  let validated = 0
  const client = createSseClient<unknown>({
    url: "http://localhost/event",
    fetch: (async () => sse(["data: not-json\n\n"])) as typeof fetch,
    responseValidator: () => {
      validated++
    },
  })

  const received: unknown[] = []
  for await (const event of client.stream) received.push(event)

  expect(received).toEqual(["not-json"])
  expect(validated).toBe(0)
})

test("aborted signal breaks immediately on connection error without sleeping or reconnecting", async () => {
  const controller = new AbortController()
  let fetchCalls = 0
  const sleeps: number[] = []
  const client = createSseClient({
    url: "http://localhost/event",
    signal: controller.signal,
    fetch: (async () => {
      fetchCalls++
      controller.abort()
      return new Response("unavailable", { status: 503, statusText: "Service Unavailable" })
    }) as typeof fetch,
    sseSleepFn: async (ms) => {
      sleeps.push(ms)
    },
  })

  const received: unknown[] = []
  for await (const event of client.stream) received.push(event)

  expect(received).toEqual([])
  expect(fetchCalls).toBe(1)
  expect(sleeps).toEqual([])
})

test("aborting during an active default retry backoff wakes immediately without 25ms tight-polling defaults", async () => {
  const controller = new AbortController()
  let fetchCalls = 0
  let abortedAt = 0
  const client = createSseClient({
    url: "http://localhost/event",
    signal: controller.signal,
    fetch: (async () => {
      fetchCalls++
      return new Response("unavailable", { status: 503, statusText: "Service Unavailable" })
    }) as typeof fetch,
    onSseError: () => {
      // Abort on the next microtask so execution is already suspended inside
      // the default 3000ms retry sleep when abort fires.
      queueMicrotask(() => {
        abortedAt = Date.now()
        controller.abort()
      })
    },
  })

  for await (const _ of client.stream) {
    // unreachable
  }

  expect(fetchCalls).toBe(1)
  expect(abortedAt).toBeGreaterThan(0)
  expect(Date.now() - abortedAt).toBeLessThan(250)
})

