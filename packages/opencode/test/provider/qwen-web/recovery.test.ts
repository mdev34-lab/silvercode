/**
 * Issue 232 regression suite: dead upstream chats must recover instead of
 * poisoning the thread, and empty/truncated upstream answers must report
 * honestly. All tests run against scripted fake transports — no browser, no
 * network, no live Qwen traffic.
 */
import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { QwenWebError, isStaleAnchorError, isStaleChatError } from "@opencode-ai/webchat/adapters/qwen/errors"
import { QwenWebSession } from "@opencode-ai/webchat/adapters/qwen/session"
import { ThreadStore } from "@opencode-ai/webchat/store"
import type { QwenWebTransport } from "@opencode-ai/webchat/adapters/qwen/transport"
import type { WebChatEvent, WebChatThread } from "@opencode-ai/webchat/types"

const DELETED_JSON = JSON.stringify({
  success: false,
  code: "CHAT_NOT_FOUND",
  message: "This chat has been deleted. Please start a new chat to continue.",
})

const CREATED = (id: string, chatId: string) =>
  `data: {"type":"response.created","response":{"id":"${id}","chat_id":"${chatId}"}}\n`
const text = (content: string, responseId = "r1") =>
  `data: {"response_id":"${responseId}","choices":[{"delta":{"phase":"answer","content":"${content}"}}]}\n`
const DONE = "data: [DONE]\n"
const STALE_EVENT = `data: {"error":{"code":"CHAT_NOT_FOUND","message":"This chat has been deleted. Please start a new chat to continue."}}\n`
const STALE_ANCHOR_EVENT = `data: {"error":{"code":"PARENT_NOT_FOUND","message":"parent id not found"}}\n`
const STALE_ANCHOR_JSON = JSON.stringify({ success: false, code: "PARENT_NOT_FOUND", message: "parent id not found" })
const AMBIGUOUS_NOT_FOUND_JSON = JSON.stringify({ error: { code: "Not_Found", message: "resource not found" } })
const MODEL_NOT_FOUND_EVENT = `data: {"error":{"code":"Not_Found","message":"Model does not exist"}}\n`
const USAGE_EVENT = `data: {"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}\n`

function byteStream(lines: string[], chunkBytes = 64): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(lines.join(""))
  const chunks: Uint8Array[] = []
  for (let index = 0; index < bytes.length; index += chunkBytes) chunks.push(bytes.slice(index, index + chunkBytes))
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

type CompletionResult =
  | { kind: "sse"; lines: string[] }
  | { kind: "json"; status: number; body: string; contentType?: string }
  | { kind: "throw"; error: unknown }

interface State {
  payloads: Array<{ path: string; body: Record<string, unknown> }>
  chatsCreated: number
  completionsCalled: number
  stops: string[]
  stopBodies: Array<Record<string, unknown>>
  stopGate?: Promise<unknown>
  aborts: number
  challengeReveals: number
  newChatIds: string[]
}

function newState(): State {
  return {
    payloads: [],
    chatsCreated: 0,
    completionsCalled: 0,
    stops: [],
    stopBodies: [],
    aborts: 0,
    challengeReveals: 0,
    newChatIds: ["fresh-1", "fresh-2", "fresh-3"],
  }
}

function scriptedTransport(results: CompletionResult[], state: State): QwenWebTransport {
  return {
    requestJson: async (_method: string, requestPath: string, options?: { body?: string }) => {
      state.stops.push(requestPath)
      if (options?.body) state.stopBodies.push(JSON.parse(options.body) as Record<string, unknown>)
      await state.stopGate
      return { status: 200, statusText: "OK", contentType: "application/json", body: "{}" }
    },
    requestStream: async () => {
      throw new Error("unexpected requestStream")
    },
    rawRequestJson: async () => {
      state.chatsCreated++
      const id = state.newChatIds[state.chatsCreated - 1] ?? `fresh-${state.chatsCreated}`
      return { status: 200, statusText: "OK", contentType: "application/json", body: JSON.stringify({ chat_id: id }) }
    },
    rawRequestStream: async (_method: string, requestPath: string, options?: { body?: string }) => {
      state.completionsCalled++
      state.payloads.push({ path: requestPath, body: JSON.parse(options?.body ?? "{}") as Record<string, unknown> })
      const result = results[Math.min(state.completionsCalled - 1, results.length - 1)]!
      if (result.kind === "throw") throw result.error
      if (result.kind === "json") {
        return {
          status: result.status,
          contentType: result.contentType ?? "application/json",
          stream: byteStream([result.body]),
          abort: () => {
            state.aborts++
          },
        }
      }
      return {
        status: 200,
        contentType: "text/event-stream",
        stream: byteStream(result.lines),
        abort: () => {
          state.aborts++
        },
      }
    },
    revealChallengeWindow: async () => {
      state.challengeReveals++
      return true
    },
    idleBudgetMs: () => 1000,
  } as unknown as QwenWebTransport
}

function sessionFor(results: CompletionResult[], state: State): QwenWebSession {
  const store = new ThreadStore({
    file: path.join(os.tmpdir(), `qwen-webchat-recovery-${Math.random().toString(36).slice(2)}.json`),
  })
  return new QwenWebSession({ transport: scriptedTransport(results, state), store })
}

/** A session whose store records every `put` with the chat id persisted then. */
function sessionWithStore(
  results: CompletionResult[],
  state: State,
): { session: QwenWebSession; store: ThreadStore; puts: Array<string | undefined> } {
  const store = new ThreadStore({
    file: path.join(os.tmpdir(), `qwen-webchat-adopt-${Math.random().toString(36).slice(2)}.json`),
  })
  const puts: Array<string | undefined> = []
  const original = store.put.bind(store)
  store.put = (thread: WebChatThread) => {
    puts.push(thread.providerId)
    original(thread)
  }
  return { session: new QwenWebSession({ transport: scriptedTransport(results, state), store }), store, puts }
}

/** A thread that already looks like an in-progress conversation. */
async function seededThread(
  session: QwenWebSession,
  options?: { providerId?: string; responseId?: string; seed?: string },
): Promise<WebChatThread> {
  const thread = await session.ensureThread({ model: "qwen3-max" })
  if (options?.providerId) thread.providerId = options.providerId
  if (options?.responseId) {
    thread.messages.push({ id: "u0", role: "user", content: "old", parts: [{ type: "text", text: "old" }] })
    thread.messages.push({
      id: "a0",
      role: "assistant",
      content: "old answer",
      parts: [{ type: "text", text: "old answer" }],
      providerState: { responseId: options.responseId },
    })
  }
  if (options?.seed) thread.seedText = options.seed
  return thread
}

async function drain(gen: AsyncGenerator<WebChatEvent>): Promise<WebChatEvent[]> {
  const events: WebChatEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

function promptOf(payload: { body: Record<string, unknown> } | undefined): string {
  const messages = payload?.body["messages"] as Array<{ content?: string }> | undefined
  return messages?.[0]?.content ?? ""
}

describe("fresh-chat recovery from a dead upstream chat (issue 232)", () => {
  test("challenge pauses without replay, reveals once, and preserves the chat anchor", async () => {
    const state = newState()
    const session = sessionFor(
      [{ kind: "json", status: 403, body: '{"message":"CAPTCHA verification required"}' }],
      state,
    )
    const thread = await seededThread(session, { providerId: "chat-kept", responseId: "r-kept" })

    const failure = await drain(session.runTurn({ thread, content: "possibly accepted prompt" })).then(
      () => undefined,
      (error: unknown) => error as QwenWebError,
    )

    expect(failure?.code).toBe("challenge")
    expect(failure?.retryable).toBe(false)
    expect(state.completionsCalled).toBe(1)
    expect(state.chatsCreated).toBe(0)
    expect(state.challengeReveals).toBe(1)
    // The challenge does not prove the chat or response anchor is dead. Keep
    // both for a user-directed retry, but never replay the possibly accepted turn.
    expect(thread.providerId).toBe("chat-kept")
    expect(thread.messages.at(-1)?.providerState).toEqual({ responseId: "r-kept" })
    expect(thread.messages.some((message) => message.content.includes("possibly accepted prompt"))).toBe(false)
  })

  test("pre-stream CHAT_NOT_FOUND recovers once, on a fresh chat, with the FULL prompt", async () => {
    const state = newState()
    const session = sessionFor(
      [
        { kind: "json", status: 200, body: DELETED_JSON },
        { kind: "sse", lines: [CREATED("r9", "fresh-1"), text("Recovered", "r9"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "dead-chat", responseId: "r-old" })

    const events = await drain(
      session.runTurn({ thread, content: "trimmed tail", recoveryContent: "FULL PROMPT WITH CONTEXT" }),
    )

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.some((event) => event.type === "finish")).toBe(true)
    expect(events.at(-1)?.type).toBe("done")

    // Delivery 1 addressed the dead chat with the trimmed tail.
    expect(state.payloads[0]!.path).toContain("chat_id=dead-chat")
    expect(state.payloads[0]!.body["parent_id"]).toBe("r-old")
    expect(promptOf(state.payloads[0])).toContain("trimmed tail")

    // Delivery 2 rides on a fresh chat: no parent, FULL prompt (never the tail).
    expect(state.chatsCreated).toBe(1)
    expect(state.completionsCalled).toBe(2)
    expect(state.payloads[1]!.path).toContain("chat_id=fresh-1")
    expect(state.payloads[1]!.body["parent_id"]).toBeNull()
    expect(promptOf(state.payloads[1])).toContain("FULL PROMPT WITH CONTEXT")
    expect(promptOf(state.payloads[1])).not.toContain("trimmed tail")

    // Thread state: fresh binding adopted, dead anchors dropped, the rolled-back
    // delivery left exactly one user node, and the turn committed its anchor.
    expect(thread.providerId).toBe("fresh-1")
    expect(thread.messages.some((message) => message.providerState?.["responseId"] === "r-old")).toBe(false)
    expect(thread.messages.some((message) => message.content.includes("trimmed tail"))).toBe(false)
    expect(thread.messages.filter((message) => message.role === "user")).toHaveLength(2) // u0 + recovered turn
    expect(thread.messages.at(-1)?.providerState).toEqual({ responseId: "r9" })
  })

  test("mid-stream CHAT_NOT_FOUND before any output recovers the same way", async () => {
    const state = newState()
    const session = sessionFor(
      [
        { kind: "sse", lines: [STALE_EVENT] },
        { kind: "sse", lines: [CREATED("r9", "fresh-1"), text("Recovered", "r9"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "dead-chat", responseId: "r-old" })

    const events = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL PROMPT" }))

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.some((event) => event.type === "text-delta")).toBe(true)
    expect(state.payloads[1]!.path).toContain("chat_id=fresh-1")
    expect(promptOf(state.payloads[1])).toBe("FULL PROMPT")
    expect(thread.providerId).toBe("fresh-1")
    // The dead stream was released locally.
    expect(state.aborts).toBe(1)
  })

  test("a non-chat Not_Found stream error preserves the live chat binding", async () => {
    const state = newState()
    const session = sessionFor(
      [
        { kind: "sse", lines: [MODEL_NOT_FOUND_EVENT] },
        { kind: "sse", lines: [CREATED("r2", "live-chat"), text("Next turn", "r2"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "live-chat", responseId: "r-old" })

    const events = await drain(session.runTurn({ thread, content: "trimmed tail", recoveryContent: "FULL PROMPT" }))
    const error = events.find((event) => event.type === "error") as { error: unknown } | undefined

    expect(error).toBeDefined()
    expect(isStaleChatError(error!.error)).toBe(false)
    expect(state.completionsCalled).toBe(1)
    expect(state.chatsCreated).toBe(0)
    expect(thread.providerId).toBe("live-chat")
    expect(thread.messages.some((message) => message.providerState?.["responseId"] === "r-old")).toBe(true)

    // The next turn still chains to the live chat instead of replaying full context.
    const next = await drain(session.runTurn({ thread, content: "next trimmed tail", recoveryContent: "FULL PROMPT" }))
    expect(next.some((event) => event.type === "error")).toBe(false)
    expect(state.payloads[1]!.path).toContain("chat_id=live-chat")
    expect(state.payloads[1]!.body["parent_id"]).toBe("r-old")
    expect(promptOf(state.payloads[1])).toBe("next trimmed tail")
    expect(state.chatsCreated).toBe(0)
  })

  test("a dead chat after partial output surfaces honestly and still drops the binding", async () => {
    const state = newState()
    const session = sessionFor(
      [{ kind: "sse", lines: [CREATED("r1", "dead-chat"), text("partial", "r1"), STALE_EVENT] }],
      state,
    )
    const thread = await seededThread(session, { providerId: "dead-chat", responseId: "r-old" })

    const events = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL" }))

    // The caller saw the partial text, so the turn cannot silently re-run.
    expect(events.some((event) => event.type === "text-delta")).toBe(true)
    const errorEvent = events.find((event) => event.type === "error") as { error: unknown } | undefined
    expect(errorEvent).toBeDefined()
    expect(isStaleChatError(errorEvent!.error)).toBe(true)
    expect(events.at(-1)?.type).toBe("done")
    expect(state.completionsCalled).toBe(1) // no hidden second delivery

    // The dead chat is unbound so the NEXT turn starts fresh with a full prompt;
    // the delivered user node stays in the mirror (upstream recorded it).
    expect(thread.providerId).toBeUndefined()
    expect(thread.messages.some((message) => message.providerState?.["responseId"] === "r-old")).toBe(false)
    expect(thread.messages.some((message) => message.role === "user" && message.content === "tail")).toBe(true)
    expect(thread.messages.at(-1)?.role).toBe("user")
  })

  test("a dead chat after response.created metadata alone surfaces honestly and drops the binding (issue 238)", async () => {
    const state = newState()
    const session = sessionFor(
      [{ kind: "sse", lines: [CREATED("r1", "dead-chat"), STALE_EVENT] }],
      state,
    )
    const thread = await seededThread(session, { providerId: "dead-chat", responseId: "r-old" })

    const events = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL" }))

    // response-metadata was emitted, committing stream identity; the stale error surfaces without silent re-run.
    expect(events.some((event) => event.type === "response-metadata")).toBe(true)
    expect(events.some((event) => event.type === "text-delta")).toBe(false)
    const errorEvent = events.find((event) => event.type === "error") as { error: unknown } | undefined
    expect(errorEvent).toBeDefined()
    expect(isStaleChatError(errorEvent!.error)).toBe(true)
    expect(events.at(-1)?.type).toBe("done")
    expect(state.completionsCalled).toBe(1)

    // Dead binding is cleared so the next turn starts fresh with the full prompt.
    expect(thread.providerId).toBeUndefined()
    expect(thread.messages.some((message) => message.providerState?.["responseId"] === "r-old")).toBe(false)
  })

  test("a dead chat after usage metadata alone surfaces honestly and drops the binding (issue 238)", async () => {
    const state = newState()
    const session = sessionFor(
      [{ kind: "sse", lines: [USAGE_EVENT, STALE_EVENT] }],
      state,
    )
    const thread = await seededThread(session, { providerId: "dead-chat", responseId: "r-old" })

    const events = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL" }))

    expect(events.some((event) => event.type === "usage")).toBe(true)
    expect(events.some((event) => event.type === "text-delta")).toBe(false)
    const errorEvent = events.find((event) => event.type === "error") as { error: unknown } | undefined
    expect(errorEvent).toBeDefined()
    expect(isStaleChatError(errorEvent!.error)).toBe(true)
    expect(state.completionsCalled).toBe(1)
    expect(thread.providerId).toBeUndefined()
    expect(thread.messages.some((message) => message.providerState?.["responseId"] === "r-old")).toBe(false)
  })

  test("a dead chat after reasoning-only output surfaces honestly and drops the binding (issue 238)", async () => {
    const state = newState()
    const thinking =
      'data: {"response_id":"r1","choices":[{"delta":{"phase":"thinking_summary","extra":{"summary_title":{"content":["Plan"]},"summary_thought":{"content":["Think first."]}}}}]}\n'
    const session = sessionFor(
      [{ kind: "sse", lines: [CREATED("r1", "dead-chat"), thinking, STALE_EVENT] }],
      state,
    )
    const thread = await seededThread(session, { providerId: "dead-chat", responseId: "r-old" })

    const events = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL" }))

    expect(events.some((event) => event.type === "thinking-delta")).toBe(true)
    expect(events.some((event) => event.type === "text-delta")).toBe(false)
    const errorEvent = events.find((event) => event.type === "error") as { error: unknown } | undefined
    expect(errorEvent).toBeDefined()
    expect(isStaleChatError(errorEvent!.error)).toBe(true)
    expect(state.completionsCalled).toBe(1)
    expect(thread.providerId).toBeUndefined()
  })

  test("a dead chat after tool-call output surfaces honestly and drops the binding (issue 238)", async () => {
    const state = newState()
    const toolCall =
      'data: {"response_id":"r1","choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"read_file","arguments":"{}"}}]}}]}\n'
    const session = sessionFor(
      [{ kind: "sse", lines: [CREATED("r1", "dead-chat"), toolCall, STALE_EVENT] }],
      state,
    )
    const thread = await seededThread(session, { providerId: "dead-chat", responseId: "r-old" })

    const events = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL" }))

    expect(events.some((event) => event.type === "tool-call")).toBe(true)
    const errorEvent = events.find((event) => event.type === "error") as { error: unknown } | undefined
    expect(errorEvent).toBeDefined()
    expect(isStaleChatError(errorEvent!.error)).toBe(true)
    expect(state.completionsCalled).toBe(1)
    expect(thread.providerId).toBeUndefined()
  })

  test("a stale fresh-chat recovery stops without a blind setup retry", async () => {
    const state = newState()
    const session = sessionFor([{ kind: "json", status: 200, body: DELETED_JSON }], state)
    const thread = await seededThread(session, { providerId: "dead-chat", responseId: "r-old" })

    const error = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL" })).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(isStaleChatError(error)).toBe(true)
    // One request on the dead chat and one on the fresh chat; stale is never
    // retried blindly against the same chat.
    expect(state.chatsCreated).toBe(1)
    expect(state.completionsCalled).toBe(2)
    expect(thread.providerId).toBeUndefined()
    expect(thread.messages.some((message) => message.content.includes("FULL"))).toBe(false)
    expect(thread.messages.some((message) => message.providerState?.["responseId"] === "r-old")).toBe(false)
  })

  test("the recovery re-merges a pending seed into the full prompt", async () => {
    const state = newState()
    const session = sessionFor(
      [
        { kind: "json", status: 200, body: DELETED_JSON },
        { kind: "sse", lines: [CREATED("r9", "fresh-1"), text("ok", "r9"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "dead-chat", seed: "Remember: blue" })

    const events = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL" }))

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(promptOf(state.payloads[0])).toContain("Remember: blue")
    expect(promptOf(state.payloads[0])).toContain("tail")
    // The rolled-back delivery restored the seed; the recovery re-merged it
    // with the FULL prompt, not the tail.
    expect(promptOf(state.payloads[1])).toContain("Remember: blue")
    expect(promptOf(state.payloads[1])).toContain("FULL")
    expect(promptOf(state.payloads[1])).not.toContain("tail")
    expect(thread.seedText).toBeUndefined()
  })

  test("pre-stream non-stale failures roll back the user node and restore the seed", async () => {
    const state = newState()
    const session = sessionFor(
      [
        {
          kind: "json",
          status: 401,
          body: JSON.stringify({ success: false, code: "Unauthorized", message: "login please" }),
        },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "c1", seed: "Remember: blue" })

    const error = await drain(session.runTurn({ thread, content: "tail" })).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect((error as { code?: string }).code).toBe("session_expired")
    expect(thread.messages).toHaveLength(0)
    expect(thread.seedText).toBe("Remember: blue")
    // The chat itself is alive; only dead chats get unbound.
    expect(thread.providerId).toBe("c1")
  })
})

describe("stale response/parent anchor (issue 232 binding contract)", () => {
  test("a dead anchor re-anchors the SAME chat once, with the FULL prompt", async () => {
    const state = newState()
    const session = sessionFor(
      [
        { kind: "json", status: 200, body: STALE_ANCHOR_JSON },
        { kind: "sse", lines: [CREATED("r9", "live-chat"), text("Re-anchored", "r9"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "live-chat", responseId: "r-old" })

    const events = await drain(
      session.runTurn({ thread, content: "trimmed tail", recoveryContent: "FULL PROMPT WITH CONTEXT" }),
    )

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.some((event) => event.type === "finish")).toBe(true)
    expect(events.at(-1)?.type).toBe("done")

    // Delivery 1 chained onto the anchor that upstream rejected.
    expect(state.payloads[0]!.path).toContain("chat_id=live-chat")
    expect(state.payloads[0]!.body["parent_id"]).toBe("r-old")
    expect(promptOf(state.payloads[0])).toContain("trimmed tail")

    // Delivery 2 keeps the live chat and only drops the anchor: no new chat,
    // no parent — and the full prompt, because a re-anchored branch carries no
    // upstream transcript of its own.
    expect(state.chatsCreated).toBe(0)
    expect(state.completionsCalled).toBe(2)
    expect(state.payloads[1]!.path).toContain("chat_id=live-chat")
    expect(state.payloads[1]!.body["parent_id"]).toBeNull()
    expect(promptOf(state.payloads[1])).toBe("FULL PROMPT WITH CONTEXT")
    expect(promptOf(state.payloads[1])).not.toContain("trimmed tail")

    // The chat stays bound; only the dead anchor is gone, and the turn
    // committed its own anchor for the next turn.
    expect(thread.providerId).toBe("live-chat")
    expect(thread.messages.some((message) => message.providerState?.["responseId"] === "r-old")).toBe(false)
    expect(thread.messages.filter((message) => message.role === "user")).toHaveLength(2) // u0 + re-anchored turn
    expect(thread.messages.some((message) => message.content.includes("trimmed tail"))).toBe(false)
    expect(thread.messages.at(-1)?.providerState).toEqual({ responseId: "r9" })
  })

  test("a mid-stream dead anchor before any output re-anchors the same chat", async () => {
    const state = newState()
    const session = sessionFor(
      [
        { kind: "sse", lines: [STALE_ANCHOR_EVENT] },
        { kind: "sse", lines: [CREATED("r9", "live-chat"), text("Re-anchored", "r9"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "live-chat", responseId: "r-old" })

    const events = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL PROMPT" }))

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.some((event) => event.type === "text-delta")).toBe(true)
    expect(state.chatsCreated).toBe(0)
    expect(state.completionsCalled).toBe(2)
    expect(state.payloads[1]!.body["parent_id"]).toBeNull()
    expect(promptOf(state.payloads[1])).toBe("FULL PROMPT")
    expect(thread.providerId).toBe("live-chat")
    // The dead stream was released locally.
    expect(state.aborts).toBe(1)
  })

  test("a dead anchor after partial output surfaces honestly and still drops the anchor", async () => {
    const state = newState()
    const session = sessionFor(
      [{ kind: "sse", lines: [CREATED("r1", "live-chat"), text("partial", "r1"), STALE_ANCHOR_EVENT] }],
      state,
    )
    const thread = await seededThread(session, { providerId: "live-chat", responseId: "r-old" })

    const events = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL" }))
    const errorEvent = events.find((event) => event.type === "error") as { error: unknown } | undefined

    // The caller saw output, so the turn cannot silently re-run.
    expect(events.some((event) => event.type === "text-delta")).toBe(true)
    expect(errorEvent).toBeDefined()
    expect(isStaleAnchorError(errorEvent!.error)).toBe(true)
    expect(state.completionsCalled).toBe(1)
    // The chat is still live and stays bound; only the anchor is dropped.
    expect(thread.providerId).toBe("live-chat")
    expect(thread.messages.some((message) => message.providerState?.["responseId"] === "r-old")).toBe(false)
  })

  test("no anchor recovery without a full prompt: the error surfaces instead of silently losing turns", async () => {
    const state = newState()
    const session = sessionFor([{ kind: "json", status: 200, body: STALE_ANCHOR_JSON }], state)
    const thread = await seededThread(session, { providerId: "live-chat", responseId: "r-old" })

    const error = await drain(session.runTurn({ thread, content: "trimmed tail" })).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(isStaleAnchorError(error)).toBe(true)
    // Re-anchoring with only the tail would silently drop every earlier turn
    // the trim had left to upstream memory, so nothing is re-sent.
    expect(state.completionsCalled).toBe(1)
    expect(state.chatsCreated).toBe(0)
    // The undelivered turn was rolled back and the dead anchor dropped, but
    // the live chat stays bound for the next turn.
    expect(thread.messages.some((message) => message.content.includes("trimmed tail"))).toBe(false)
    expect(thread.providerId).toBe("live-chat")
    expect(thread.messages.some((message) => message.providerState?.["responseId"] === "r-old")).toBe(false)
  })

  test("one recovery per turn: a dead chat after an anchor recovery is not recovered again", async () => {
    const state = newState()
    const session = sessionFor(
      [
        { kind: "json", status: 200, body: STALE_ANCHOR_JSON },
        { kind: "json", status: 200, body: DELETED_JSON },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "live-chat", responseId: "r-old" })

    const error = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL" })).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(isStaleChatError(error)).toBe(true)
    // Anchor recovery (delivery 2) then the dead-chat error: no fresh chat and
    // no third delivery.
    expect(state.completionsCalled).toBe(2)
    expect(state.chatsCreated).toBe(0)
    // The chat confirmed dead on the second delivery is unbound.
    expect(thread.providerId).toBeUndefined()
    expect(thread.messages.some((message) => message.content.includes("FULL"))).toBe(false)
  })

  test("an ambiguous Not_Found recovers nothing and keeps the whole binding", async () => {
    const state = newState()
    const session = sessionFor(
      [
        { kind: "json", status: 404, body: AMBIGUOUS_NOT_FOUND_JSON },
        { kind: "sse", lines: [CREATED("r2", "live-chat"), text("Next turn", "r2"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "live-chat", responseId: "r-old" })

    const error = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL PROMPT" })).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeDefined()
    expect(isStaleChatError(error)).toBe(false)
    expect(isStaleAnchorError(error)).toBe(false)
    expect(state.completionsCalled).toBe(1)
    expect(state.chatsCreated).toBe(0)
    expect(thread.providerId).toBe("live-chat")
    expect(thread.messages.some((message) => message.providerState?.["responseId"] === "r-old")).toBe(true)

    // Nothing was silently dropped: the next turn still chains to r-old.
    await drain(session.runTurn({ thread, content: "next", recoveryContent: "FULL PROMPT" }))
    expect(state.payloads[1]!.path).toContain("chat_id=live-chat")
    expect(state.payloads[1]!.body["parent_id"]).toBe("r-old")
  })

  test("the anchor recovery re-merges a pending seed into the full prompt", async () => {
    const state = newState()
    const session = sessionFor(
      [
        { kind: "json", status: 200, body: STALE_ANCHOR_JSON },
        { kind: "sse", lines: [CREATED("r9", "live-chat"), text("ok", "r9"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "live-chat", seed: "Remember: blue" })

    await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL" }))

    expect(promptOf(state.payloads[0])).toContain("Remember: blue")
    // The rolled-back delivery restored the seed; the retry re-merged it with
    // the FULL prompt, not the tail.
    expect(promptOf(state.payloads[1])).toContain("Remember: blue")
    expect(promptOf(state.payloads[1])).toContain("FULL")
    expect(promptOf(state.payloads[1])).not.toContain("tail")
    expect(thread.seedText).toBeUndefined()
  })
})

describe("upstream chat id adoption (issue 232)", () => {
  test("response-created chat_id replaces a divergent local binding", async () => {
    const state = newState()
    const session = sessionFor(
      [
        { kind: "sse", lines: [CREATED("r1", "c2-migrated"), text("hi", "r1"), DONE] },
        { kind: "sse", lines: [CREATED("r2", "c2-migrated"), text("again", "r2"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "c1" })

    await drain(session.runTurn({ thread, content: "first" }))
    expect(thread.providerId).toBe("c2-migrated")

    await drain(session.runTurn({ thread, content: "second" }))
    expect(state.payloads[1]!.path).toContain("chat_id=c2-migrated")
    expect(state.payloads[1]!.body["parent_id"]).toBe("r1")
    expect(state.chatsCreated).toBe(0)
  })

  test("a chat id reported outside response.created is adopted too", async () => {
    const state = newState()
    // The rotation never shows up in `response.created`: only chunk-level ids.
    const session = sessionFor(
      [
        {
          kind: "sse",
          lines: [
            'data: {"type":"response.created","response":{"id":"r1"}}\n',
            'data: {"response_id":"r1","chat_id":"c-rotated","choices":[{"delta":{"phase":"answer","content":"hi"}}]}\n',
            DONE,
          ],
        },
        { kind: "sse", lines: [CREATED("r2", "c-rotated"), text("again", "r2"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "c1" })

    await drain(session.runTurn({ thread, content: "first" }))
    expect(thread.providerId).toBe("c-rotated")

    await drain(session.runTurn({ thread, content: "second" }))
    expect(state.payloads[1]!.path).toContain("chat_id=c-rotated")
    expect(state.payloads[1]!.body["parent_id"]).toBe("r1")
    expect(state.chatsCreated).toBe(0)
  })

  test("the adopted chat id is persisted during the turn, not only at commit", async () => {
    const state = newState()
    const { session, puts } = sessionWithStore(
      [
        {
          kind: "sse",
          lines: [
            CREATED("r1", "c-adopted"),
            text("working", "r1"),
            `data: {"error":{"code":"E_BOOM","message":"kaput"}}\n`,
          ],
        },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "c1" })

    const events = await drain(session.runTurn({ thread, content: "first" }))
    expect(events.some((event) => event.type === "error")).toBe(true)

    // [undefined (thread created), "c1" (user node persisted before the
    // stream), "c-adopted" (adoption), "c-adopted" (end-of-turn commit)]: a
    // crash between adoption and commit cannot leave the stale id behind for
    // the next process to pick up.
    expect(puts[1]).toBe("c1")
    // Pins BOTH the adoption put and the end-of-turn commit put: deleting the
    // adoption persist leaves exactly one "c-adopted" put and fails here.
    expect(puts.filter((id) => id === "c-adopted")).toHaveLength(2)
    expect(thread.providerId).toBe("c-adopted")
  })
})

describe("honest empty and truncated answers (issue 232)", () => {
  test("an empty turn rolls back its user node and is not automatically retried", async () => {
    const state = newState()
    const session = sessionFor(
      [
        { kind: "sse", lines: [CREATED("r1", "fresh-1"), DONE] },
        { kind: "sse", lines: [CREATED("r2", "fresh-1"), text("Recovered", "r2"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session)

    const events = await drain(session.runTurn({ thread, content: "hi" }))

    expect(events.some((event) => event.type === "finish")).toBe(false)
    const errorEvent = events.find((event) => event.type === "error") as
      | { error: { code?: string; retryable?: boolean; message?: string } }
      | undefined
    expect(errorEvent?.error.code).toBe("invalid_response")
    expect(errorEvent?.error.retryable).toBe(false)
    expect(errorEvent?.error.message).toContain("empty response")
    expect(errorEvent?.error.message).toContain("rolled back from local thread history")
    expect(errorEvent?.error.message).not.toContain("Nothing was committed")
    expect(errorEvent?.error.message).not.toContain("retrying is safe")
    expect(events.at(-1)?.type).toBe("done")
    expect(state.completionsCalled).toBe(1)

    // No local prompt or assistant node remains; an explicit later attempt
    // creates only one user node rather than duplicating the failed turn.
    expect(thread.messages).toHaveLength(0)
    expect(thread.providerId).toBe("fresh-1")
    const retryEvents = await drain(session.runTurn({ thread, content: "hi" }))
    expect(retryEvents.some((event) => event.type === "error")).toBe(false)
    expect(state.completionsCalled).toBe(2)
    expect(thread.messages.filter((message) => message.role === "user")).toHaveLength(1)
    expect(thread.messages.filter((message) => message.role === "assistant")).toHaveLength(1)
  })

  test("a reasoning-only turn is not treated as empty", async () => {
    const state = newState()
    const thinking =
      'data: {"response_id":"r1","choices":[{"delta":{"phase":"thinking_summary","extra":{"summary_title":{"content":["Plan"]},"summary_thought":{"content":["Think first."]}}}}]}\n'
    const session = sessionFor([{ kind: "sse", lines: [CREATED("r1", "fresh-1"), thinking, DONE] }], state)
    const thread = await seededThread(session)

    const events = await drain(session.runTurn({ thread, content: "hi" }))

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.some((event) => event.type === "finish")).toBe(true)
    expect(thread.messages.at(-1)?.role).toBe("assistant")
  })

  test("a truncated >8k JSON error body never fabricates a login error", async () => {
    const state = newState()
    const truncatedBody = `{"success":false,"code":"InternalError","message":"upstream exploded: ${"z".repeat(9000)}`
    const session = sessionFor([{ kind: "json", status: 200, body: truncatedBody }], state)
    const thread = await seededThread(session, { providerId: "c1" })

    const error = (await drain(session.runTurn({ thread, content: "hi" })).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )) as { code?: string; message?: string; retryable?: boolean }

    expect(error.code).toBe("invalid_response")
    expect(error.message).toContain("truncated")
    expect(error.message).toContain("InternalError")
    expect(error.message?.toLowerCase()).not.toContain("login")
    // The undelivered turn was rolled back.
    expect(thread.messages).toHaveLength(0)
  })

  test("a truncated CHAT_NOT_FOUND body is salvaged and recovers", async () => {
    const state = newState()
    const truncatedStale = `{"success":false,"code":"CHAT_NOT_FOUND","message":"This chat has been deleted. ${"x".repeat(9000)}`
    const session = sessionFor(
      [
        { kind: "json", status: 200, body: truncatedStale },
        { kind: "sse", lines: [CREATED("r9", "fresh-1"), text("Recovered", "r9"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "dead-chat" })

    const events = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL" }))

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(state.payloads[1]!.path).toContain("chat_id=fresh-1")
    expect(promptOf(state.payloads[1])).toBe("FULL")
    expect(thread.providerId).toBe("fresh-1")
  })

  test("an empty non-stream body reports itself instead of demanding a login", async () => {
    const state = newState()
    const session = sessionFor([{ kind: "json", status: 200, body: "", contentType: "text/plain" }], state)
    const thread = await seededThread(session, { providerId: "c1" })

    const error = (await drain(session.runTurn({ thread, content: "hi" })).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )) as { code?: string; message?: string }

    expect(error.code).toBe("invalid_response")
    expect(error.message).toContain("<empty body>")
    expect(error.message?.toLowerCase()).not.toContain("login")
  })
})

const IN_PROGRESS_JSON = JSON.stringify({
  success: false,
  data: { code: "Bad_Request", details: "The chat is in progress!" },
})

function sessionWithBackoff(results: CompletionResult[], state: State, backoff: number[]): QwenWebSession {
  const store = new ThreadStore({
    file: path.join(os.tmpdir(), `qwen-webchat-inprogress-${Math.random().toString(36).slice(2)}.json`),
  })
  return new QwenWebSession({ transport: scriptedTransport(results, state), store, inProgressBackoffMs: backoff })
}

describe("chat still generating (issue 244)", () => {
  test("recovers when the upstream generation completes during the bounded wait", async () => {
    const state = newState()
    const session = sessionWithBackoff(
      [
        { kind: "json", status: 400, body: IN_PROGRESS_JSON },
        { kind: "json", status: 400, body: IN_PROGRESS_JSON },
        { kind: "sse", lines: [CREATED("r2", "chat-a"), text("Done", "r2"), DONE] },
      ],
      state,
      [1, 1, 1],
    )
    const thread = await seededThread(session, { providerId: "chat-a", responseId: "r1" })

    const events = await drain(session.runTurn({ thread, content: "next step" }))

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.some((event) => event.type === "finish")).toBe(true)
    expect(state.completionsCalled).toBe(3)
    expect(state.chatsCreated).toBe(0)
    expect(thread.providerId).toBe("chat-a")
    expect(thread.messages.filter((message) => message.content.includes("next step"))).toHaveLength(1)
    expect(thread.messages.at(-1)?.providerState).toEqual({ responseId: "r2" })
  })

  test("ends in a bounded, non-retryable terminal error and rolls the request back", async () => {
    const state = newState()
    const session = sessionWithBackoff([{ kind: "json", status: 400, body: IN_PROGRESS_JSON }], state, [1, 1])
    const thread = await seededThread(session, { providerId: "chat-a", responseId: "r1" })

    const failure = await drain(session.runTurn({ thread, content: "next step" })).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(QwenWebError.isInstance(failure)).toBe(true)
    const error = failure as QwenWebError
    expect(error.upstreamCode).toBe("chat_in_progress")
    expect(error.retryable).toBe(false)
    expect(state.completionsCalled).toBe(3)
    expect(state.chatsCreated).toBe(0)
    expect(thread.providerId).toBe("chat-a")
    expect(thread.messages.some((message) => message.content.includes("next step"))).toBe(false)
  })

  test("aborting during the wait stops re-sending and rolls the request back", async () => {
    const state = newState()
    const session = sessionWithBackoff([{ kind: "json", status: 400, body: IN_PROGRESS_JSON }], state, [60_000])
    const thread = await seededThread(session, { providerId: "chat-a", responseId: "r1" })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)

    const failure = await drain(session.runTurn({ thread, content: "next step", signal: controller.signal })).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(QwenWebError.isInstance(failure) && failure.code === "aborted").toBe(true)
    expect(state.completionsCalled).toBe(1)
    expect(thread.messages.some((message) => message.content.includes("next step"))).toBe(false)
  })

  test("asks the upstream once to stop the earlier generation when its id is known", async () => {
    const state = newState()
    const session = sessionWithBackoff(
      [
        { kind: "sse", lines: [CREATED("r-prev", "chat-a"), text("part", "r-prev"), DONE] },
        { kind: "json", status: 400, body: IN_PROGRESS_JSON },
        { kind: "json", status: 400, body: IN_PROGRESS_JSON },
        { kind: "sse", lines: [CREATED("r3", "chat-a"), text("ok", "r3"), DONE] },
      ],
      state,
      [1, 1, 1],
    )
    const thread = await seededThread(session, { providerId: "chat-a" })
    await drain(session.runTurn({ thread, content: "first" }))
    await drain(session.runTurn({ thread, content: "second" }))

    expect(state.stops.filter((p) => p.includes("/completions/stop"))).toHaveLength(1)
    expect(state.completionsCalled).toBe(4)
  })

  test("aborting while the stop request is pending does not wait for it", async () => {
    const state = newState()
    state.stopGate = new Promise(() => {}) // the stop request never returns
    const session = sessionWithBackoff(
      [
        { kind: "sse", lines: [CREATED("r-prev", "chat-a"), text("part", "r-prev"), DONE] },
        { kind: "json", status: 400, body: IN_PROGRESS_JSON },
      ],
      state,
      [1, 1],
    )
    const thread = await seededThread(session, { providerId: "chat-a" })
    await drain(session.runTurn({ thread, content: "first" }))
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const started = Date.now()

    const failure = await drain(session.runTurn({ thread, content: "second", signal: controller.signal })).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(QwenWebError.isInstance(failure) && failure.code === "aborted").toBe(true)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(state.stops.filter((p) => p.includes("/completions/stop"))).toHaveLength(1)
    expect(thread.messages.some((message) => message.content.includes("second"))).toBe(false)
  })

  test("a discarded chat's response id is never reused for the stop request", async () => {
    const state = newState()
    // The fresh chat comes back with the very id that was just discarded.
    state.newChatIds = ["chat-a"]
    const session = sessionWithBackoff(
      [
        { kind: "sse", lines: [CREATED("r-prev", "chat-a"), text("partial", "r-prev"), STALE_EVENT] },
        { kind: "json", status: 400, body: IN_PROGRESS_JSON },
        { kind: "sse", lines: [CREATED("r2", "chat-a"), text("ok", "r2"), DONE] },
      ],
      state,
      [1, 1, 1],
    )
    const thread = await seededThread(session, { providerId: "chat-a" })
    await drain(session.runTurn({ thread, content: "first" }))
    expect(thread.providerId).toBeUndefined() // the dead chat was unbound

    const events = await drain(session.runTurn({ thread, content: "second" }))

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(state.chatsCreated).toBe(1)
    expect(state.completionsCalled).toBe(3)
    // Nothing is known about the new chat's generation, so nothing is stopped:
    // `r-prev` belonged to the binding that was dropped with the dead chat.
    expect(state.stops.filter((p) => p.includes("/completions/stop"))).toHaveLength(0)
  })

  test("the stop request follows an adopted upstream chat id", async () => {
    const state = newState()
    const session = sessionWithBackoff(
      [
        { kind: "sse", lines: [CREATED("r1", "c2-migrated"), text("hi", "r1"), DONE] },
        { kind: "json", status: 400, body: IN_PROGRESS_JSON },
        { kind: "sse", lines: [CREATED("r2", "c2-migrated"), text("again", "r2"), DONE] },
      ],
      state,
      [1, 1, 1],
    )
    const thread = await seededThread(session, { providerId: "c1" })
    await drain(session.runTurn({ thread, content: "first" }))
    expect(thread.providerId).toBe("c2-migrated")

    await drain(session.runTurn({ thread, content: "second" }))

    const stops = state.stops.filter((p) => p.includes("/completions/stop"))
    expect(stops).toHaveLength(1)
    expect(stops[0]).toContain("chat_id=c2-migrated")
    expect(state.stopBodies).toEqual([{ chat_id: "c2-migrated", response_id: "r1" }])
    expect(state.completionsCalled).toBe(3)
  })
})
