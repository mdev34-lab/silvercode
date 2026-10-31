import { SessionV1 } from "@opencode-ai/core/v1/session"
import { applyPartDelta, applyPartUpdated } from "../../../tui/src/util/part"
import type { Part } from "@opencode-ai/sdk/v2"
import { pathToFileURL } from "url"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { tool } from "ai"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { Permission } from "../../src/permission"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { HeadlessRunRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "work",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const waitFor = <A, E>(check: Effect.Effect<A | undefined, E>, message: string) =>
  Effect.gen(function* () {
    const stop = Date.now() + 500
    while (Date.now() < stop) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(message))
  })

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "work",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "work",
    agent: "work",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const
const env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  replacements,
)

const it = testEffect(env)

const providerErrorLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
        LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
        LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {}, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-1",
          name: "lookup",
          result: { type: "error", value: "provider boom" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const providerErrorEnv = LayerNode.compile(root, [...replacements, [LLM.node, providerErrorLLM]])
const itProviderError = testEffect(providerErrorEnv)

const fragmentFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "thinking" }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "partial" }),
        LLMEvent.providerError({ message: "provider boom" }),
      ),
  }),
)
const fragmentFailureEnv = LayerNode.compile(root, [...replacements, [LLM.node, fragmentFailureLLM]])
const itFragmentFailure = testEffect(fragmentFailureEnv)

// One tool call whose execution fails with `error`: the shape the processor sees when a
// permission ask inside a tool is rejected or left unanswered until the countdown expires.
const failedToolCallEnv = (error: Error) =>
  LayerNode.compile(root, [
    ...replacements,
    [
      LLM.node,
      Layer.succeed(
        LLM.Service,
        LLM.Service.of({
          stream: () =>
            Stream.make(
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.toolInputStart({ id: "call-1", name: "bash" }),
              LLMEvent.toolInputEnd({ id: "call-1", name: "bash" }),
              LLMEvent.toolCall({ id: "call-1", name: "bash", input: { command: "rm -rf /" } }),
              LLMEvent.toolError({ id: "call-1", name: "bash", message: error.message, error }),
              LLMEvent.stepFinish({ index: 0, reason: "stop" }),
              LLMEvent.finish({ reason: "stop" }),
            ),
        }),
      ),
    ],
  ])
const itPermissionTimeout = testEffect(failedToolCallEnv(new PermissionV1.TimedOutError({ seconds: 45 })))
const itPermissionRejected = testEffect(failedToolCallEnv(new PermissionV1.RejectedError()))

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.TextPart => part.type === "text")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for text part",
        )
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = (yield* MessageV2.parts(msg.id)).find((part): part is SessionV1.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry OpenAI-compatible midstream server errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(raw({ chunks: [{ error: { type: "server_error", code: "server_error", message: "xxx" } }] }))
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry midstream server error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry midstream server error" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID === chat.id && data.status.type === "retry") states.push(data.status.attempt)
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        yield* off

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests complete AI SDK tool calls when native flag is off", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => ({
                title: "Weather lookup",
                output: `result:${input.query}`,
                metadata: { source: "test" },
              }),
            }),
          },
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "test" })
        expect(call.state.time.start).toBeDefined()
        expect(call.state.time.end).toBeDefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for tool part",
        )
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== Session.Event.Error.type) return Effect.void
          const data = evt.data as typeof Session.Event.Error.data.Type
          if (data.sessionID !== chat.id || !data.error) return Effect.void
          errs.push(data.error.name)
          seen.resolve()
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        yield* off

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itProviderError.live("session.processor effect tests fail provider-executed error results", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider tool error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "provider tool error" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") expect(call.state.error).toBe("provider boom")
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(MessageV2.Event.Updated.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

// Shared body for the two permission failures: the only difference is whether the turn
// survives the failed tool call.
const permissionFailureTurn = (expected: SessionProcessor.Result, error: string) =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "permission failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "permission failure" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value).toBe(expected)
        expect(handle.message.error).toBeUndefined()
        expect(call?.state.status).toBe("error")
        if (call?.state.status !== "error") return
        expect(call.state.error).toContain(error)
      }),
    { config: cfg },
  )

itPermissionTimeout.live("session.processor effect tests continue the turn when a permission prompt times out", () =>
  // An expired countdown only fails the tool call, so `ctx.blocked` stays false and the
  // model gets to pick another approach.
  permissionFailureTurn("continue", "automatically denied"),
)

itPermissionRejected.live("session.processor effect tests stop the turn when permission is rejected", () =>
  permissionFailureTurn("stop", "The user rejected permission"),
)

itFragmentFailure.live("session.processor effect tests retain partial legacy parts without v2 events", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "provider failure" }],
            tools: {},
          }),
        ).toBe("stop")
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        expect(parts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "partial" }),
            expect.objectContaining({ type: "reasoning", text: "thinking" }),
          ]),
        )
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(Session.Event.Error.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

function delayedEvents(items: Array<[number, LLMEvent]>) {
  return Stream.fromIterable(items).pipe(
    Stream.mapEffect(([ms, event]) =>
      ms > 0 ? Effect.sleep(`${ms} millis`).pipe(Effect.as(event)) : Effect.succeed(event),
    ),
  )
}

function processorWithLLM(stream: () => Stream.Stream<LLMEvent>) {
  return testEffect(
    LayerNode.compile(root, [
      ...replacements,
      [
        LLM.node,
        Layer.succeed(
          LLM.Service,
          LLM.Service.of({
            stream,
          }),
        ),
      ],
    ]),
  )
}

const runProcessor = Effect.fn("test.runProcessor")(function* (dir: string, text: string) {
  const { processors, session, provider } = yield* boot()
  const chat = yield* session.create({})
  const parent = yield* user(chat.id, text)
  const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
  const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
  const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
  const value = yield* handle.process({
    user: {
      id: parent.id,
      sessionID: chat.id,
      role: "user",
      time: parent.time,
      agent: parent.agent,
      model: { providerID: ref.providerID, modelID: ref.modelID },
    } satisfies SessionV1.User,
    sessionID: chat.id,
    model: mdl,
    agent: agent(),
    system: [],
    messages: [{ role: "user", content: text }],
    tools: {},
  })
  const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
  return { value, handle, stored }
})


it.live("text-complete plugins can truncate or delete streamed text", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const file = path.join(dir, "rewrite-plugin.ts")
        yield* Effect.promise(() =>
          Bun.write(
            file,
            `export default async () => ({
          "experimental.text.complete": async (_input, output) => {
            output.text = output.text.endsWith("prefix") ? "Hello" : ""
          },
        })`,
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              ...providerCfg(llm.url),
              plugin: [pathToFileURL(file).href],
            }),
          ),
        )
        const events = yield* EventV2Bridge.Service
        const seen = new Map<string, Part[]>()
        const off = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type) {
            const data = event.data as typeof MessageV2.Event.PartUpdated.data.Type
            seen.set(data.part.messageID, applyPartUpdated(seen.get(data.part.messageID), data.part as Part))
          }
          if (event.type === MessageV2.Event.PartDelta.type) {
            const data = event.data as typeof MessageV2.Event.PartDelta.data.Type
            const parts = applyPartDelta(seen.get(data.messageID), data.partID, data.field, data.delta)
            if (parts) seen.set(data.messageID, parts)
          }
          return Effect.void
        })
        for (const [input, expected] of [
          ["Hello secret prefix", "Hello"],
          ["Hello secret deletion", ""],
        ]) {
          yield* llm.text(input)
          const result = yield* runProcessor(dir, "hi")
          const stored = result.stored.parts.find((part) => part.type === "text")
          expect(stored).toMatchObject({ text: expected, time: { end: expect.any(Number) } })
          expect(seen.get(result.stored.info.id)?.find((part) => part.type === "text")).toMatchObject({
            text: expected,
          })
        }
        yield* off
      }),
    { config: (url) => providerCfg(url) },
  ),
)

const itStreamingMetrics = processorWithLLM(() =>
  delayedEvents([
    [0, LLMEvent.stepStart({ index: 0 })],
    [0, LLMEvent.textStart({ id: "text-1" })],
    [80, LLMEvent.textDelta({ id: "text-1", text: "hello" })],
    [120, LLMEvent.textEnd({ id: "text-1" })],
    [
      0,
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: { inputTokens: 12, outputTokens: 24 },
      }),
    ],
    [0, LLMEvent.finish({ reason: "stop", usage: { inputTokens: 12, outputTokens: 24 } })],
  ]),
)

const itBurstMetrics = processorWithLLM(() =>
  Stream.make(
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text-1" }),
    LLMEvent.textDelta({ id: "text-1", text: "hello" }),
    LLMEvent.textEnd({ id: "text-1" }),
    LLMEvent.stepFinish({
      index: 0,
      reason: "stop",
      usage: { inputTokens: 12, outputTokens: 24 },
    }),
    LLMEvent.finish({ reason: "stop", usage: { inputTokens: 12, outputTokens: 24 } }),
  ),
)

const itMissingUsageMetrics = processorWithLLM(() =>
  delayedEvents([
    [0, LLMEvent.stepStart({ index: 0 })],
    [0, LLMEvent.textStart({ id: "text-1" })],
    [80, LLMEvent.textDelta({ id: "text-1", text: "hello" })],
    [80, LLMEvent.textEnd({ id: "text-1" })],
    [0, LLMEvent.stepFinish({ index: 0, reason: "stop" })],
    [0, LLMEvent.finish({ reason: "stop" })],
  ]),
)

const itMissingOutputMetrics = processorWithLLM(() =>
  Stream.make(
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 12, outputTokens: 24 } }),
    LLMEvent.finish({ reason: "stop", usage: { inputTokens: 12, outputTokens: 24 } }),
  ),
)

itStreamingMetrics.live(
  "session.processor records streaming TTFT and tokens/sec on the assistant message",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { value, handle, stored } = yield* runProcessor(dir, "metrics")
          expect(value).toBe("continue")
          expect(handle.message.ttft).toBeGreaterThanOrEqual(50)
          expect(handle.message.ttft).toBeLessThan(2000)
          expect(handle.message.tokensPerSecond).toBeGreaterThan(20)
          expect(handle.message.tokensPerSecond).toBeLessThan(2000)
          expect(stored.info.role).toBe("assistant")
          if (stored.info.role !== "assistant") return
          expect(stored.info.ttft).toBe(handle.message.ttft)
          expect(stored.info.tokensPerSecond).toBe(handle.message.tokensPerSecond)
        }),
      { config: cfg },
    ),
  { timeout: 15000 },
)

itBurstMetrics.live("session.processor omits tokens/sec for a same-tick non-streaming burst", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { handle, stored } = yield* runProcessor(dir, "burst")
        expect(handle.message.ttft).toBeGreaterThanOrEqual(0)
        if (handle.message.tokensPerSecond !== undefined) {
          expect(handle.message.tokensPerSecond).toBeGreaterThan(0)
          expect(Number.isFinite(handle.message.tokensPerSecond)).toBe(true)
        }
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role !== "assistant") return
        expect(stored.info.ttft).toBe(handle.message.ttft)
        expect(stored.info.tokensPerSecond).toBe(handle.message.tokensPerSecond)
      }),
    { config: cfg },
  ),
)

itMissingUsageMetrics.live(
  "session.processor omits tokens/sec when the provider reports no usage",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { handle, stored } = yield* runProcessor(dir, "no usage")
          expect(handle.message.ttft).toBeGreaterThanOrEqual(50)
          expect(handle.message.tokensPerSecond).toBeUndefined()
          expect(stored.info.role).toBe("assistant")
          if (stored.info.role !== "assistant") return
          expect(stored.info.ttft).toBe(handle.message.ttft)
          expect(stored.info.tokensPerSecond).toBeUndefined()
        }),
      { config: cfg },
    ),
  { timeout: 15000 },
)

itMissingOutputMetrics.live("session.processor omits generation metrics when no output is produced", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { handle, stored } = yield* runProcessor(dir, "empty")
        expect(handle.message.ttft).toBeUndefined()
        expect(handle.message.tokensPerSecond).toBeUndefined()
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role !== "assistant") return
        expect(stored.info.ttft).toBeUndefined()
        expect(stored.info.tokensPerSecond).toBeUndefined()
      }),
    { config: cfg },
  ),
)

for (const scenario of [
  { name: "stale false output", persistedWrites: true, returnedReview: { writesFiles: false } },
  { name: "output with no writes flag", persistedWrites: true, returnedReview: {} },
  { name: "new true output", persistedWrites: false, returnedReview: { writesFiles: true } },
]) {
  it.live(`session.processor preserves child writes with ${scenario.name}`, () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          yield* llm.tool("lookup", { query: "weather" })

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "tool")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const delivery = defer<{ title: string; output: string; metadata: Record<string, unknown> }>()
          const run = yield* handle
            .process({
              user: {
                id: parent.id,
                sessionID: chat.id,
                role: "user",
                time: parent.time,
                agent: parent.agent,
                model: { providerID: ref.providerID, modelID: ref.modelID },
              } satisfies SessionV1.User,
              sessionID: chat.id,
              model: mdl,
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "tool" }],
              tools: {
                lookup: tool({
                  description: "Look up information",
                  inputSchema: z.object({ query: z.string() }),
                  execute: async () => delivery.promise,
                }),
              },
            })
            .pipe(Effect.forkChild)

          // The background return was computed before the child's write event.
          // Persist that late evidence before letting the stale return complete.
          const running = yield* waitFor(
            session
              .messages({ sessionID: chat.id, limit: 50 })
              .pipe(
                Effect.map((messages) =>
                  messages
                    .flatMap((m) => m.parts)
                    .find(
                      (part): part is SessionV1.ToolPart => part.type === "tool" && part.state.status === "running",
                    ),
                ),
              ),
            "timed out waiting for running task",
          )
          if (running.state.status !== "running") throw new Error("expected running tool")
          yield* session.updatePart({
            ...running,
            state: {
              ...running.state,
              metadata: {
                source: "live",
                lateEvidence: "child-write",
                reviewLoop: { writesFiles: scenario.persistedWrites, childSession: "child" },
              },
            },
          })
          delivery.resolve({
            title: "Weather lookup",
            output: "result:weather",
            metadata: {
              source: "returned",
              reviewLoop: { ...scenario.returnedReview, outcome: "background" },
            },
          })
          const value = yield* Fiber.join(run)

          const parts = yield* MessageV2.parts(msg.id)
          const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

          expect(value).toBe("continue")
          expect(yield* llm.calls).toBe(1)
          expect(call?.callID).toBe("call_1")
          expect(call?.tool).toBe("lookup")
          expect(call?.state.status).toBe("completed")
          if (call?.state.status !== "completed") return
          expect(call.state.input).toEqual({ query: "weather" })
          expect(call.state.output).toBe("result:weather")
          expect(call.state.title).toBe("Weather lookup")
          expect(call.state.metadata).toEqual({
            source: "returned",
            lateEvidence: "child-write",
            reviewLoop: {
              writesFiles: true,
              childSession: "child",
              outcome: "background",
            },
          })
          expect(call.state.time.start).toBeDefined()
          expect(call.state.time.end).toBeDefined()
        }),
      { config: (url) => providerCfg(url) },
    ),
  )
}

// A failed argument stream has not executed a tool, so retry is safe, but its
// registered pending call must not remain a sibling finish waits on forever.
let retryPendingCalls = 0
let retryPendingHandle: SessionProcessor.Handle
const itRetryPending = processorWithLLM(() => {
  retryPendingCalls++
  if (retryPendingCalls === 1) return Stream.make(
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: "abandoned-arguments", name: "bash" }),
  ).pipe(Stream.concat(Stream.die(new SessionV1.APIError({ message: "temporary argument stream error", isRetryable: true }))))
  return Stream.fromEffect(retryPendingHandle.waitForOtherTools("finish-retry")).pipe(
    Stream.flatMap(() => Stream.make(
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.stepFinish({ index: 0, reason: "stop" }),
      LLMEvent.finish({ reason: "stop" }),
    )),
  )
})
itRetryPending.live("clears abandoned argument calls before retry so finish can settle", () =>
  provideTmpdirInstance((dir) => Effect.gen(function* () {
    retryPendingCalls = 0
    const { processors, session, provider } = yield* boot()
    const chat = yield* session.create({})
    const parent = yield* user(chat.id, "argument retry")
    const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
    const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
    retryPendingHandle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
    const result = yield* retryPendingHandle.process({ user: parent as SessionV1.User,
      sessionID: chat.id, model: mdl, agent: agent(), system: [],
      messages: [{ role: "user", content: "argument retry" }], tools: {},
    }).pipe(Effect.timeout("8 seconds"), Effect.exit)
    expect(retryPendingCalls).toBe(2)
    expect(Exit.isSuccess(result)).toBe(true)
    const parts = yield* MessageV2.parts(msg.id)
    expect(parts.some((part) => part.type === "tool" && part.callID === "abandoned-arguments")).toBe(false)
  }), { config: cfg }), { timeout: 15000 })

let runningRetryCalls = 0
let runningRetryHandle: SessionProcessor.Handle
const itRetryRunning = processorWithLLM(() => {
  runningRetryCalls++
  if (runningRetryCalls === 1) return Stream.make(
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: "metadata-running", name: "bash" }),
  ).pipe(Stream.concat(Stream.fromEffect(
    runningRetryHandle.updateToolCall("metadata-running", (part) => ({ ...part,
      state: { status: "running", input: { command: "already started" }, time: { start: Date.now() }, metadata: { evidence: "retained" } },
    })).pipe(Effect.andThen(Effect.die(new SessionV1.APIError({ message: "temporary metadata stream error", isRetryable: true })))),
  )))
  return Stream.fromEffect(runningRetryHandle.completeToolCall("metadata-running", {
    title: "started tool", output: "RUNNING_EVIDENCE", metadata: { evidence: "retained" },
  })).pipe(Stream.flatMap(() => Stream.make(
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  )))
})
itRetryRunning.live("preserves a metadata-promoted running call during retry cleanup", () =>
  provideTmpdirInstance((dir) => Effect.gen(function* () {
    runningRetryCalls = 0
    const { processors, session, provider } = yield* boot()
    const chat = yield* session.create({})
    const parent = yield* user(chat.id, "running retry")
    const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
    const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
    runningRetryHandle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
    yield* runningRetryHandle.process({ user: parent as SessionV1.User, sessionID: chat.id, model: mdl,
      agent: agent(), system: [], messages: [{ role: "user", content: "running retry" }], tools: {},
    }).pipe(Effect.timeout("8 seconds"))
    const parts = yield* MessageV2.parts(msg.id)
    const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === "metadata-running")
    expect(runningRetryCalls).toBe(2)
    expect(call?.state.status).toBe("completed")
    if (call?.state.status === "completed") expect(call.state.output).toBe("RUNNING_EVIDENCE")
  }), { config: cfg }), { timeout: 15000 })

const headlessEnv = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  [
    [SessionSummary.node, summary],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ],
)
const itHeadless = testEffect(headlessEnv)

itHeadless.live(
  "halts immediately with APIError in headless mode when provider retry-after exceeds maxDelay",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.error(
            429,
            {
              type: "error",
              error: {
                type: "FreeUsageLimitError",
                message: "Free usage limit reached. Subscribe to OpenCode Go for higher limits.",
              },
              metadata: {},
            },
            { "retry-after": "42504" },
          )

          const { processors, session, provider } = yield* boot()
          const status = yield* SessionStatus.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "Reply with exactly: OK")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

          const result = yield* handle
            .process({
              user: parent as SessionV1.User,
              sessionID: chat.id,
              model: mdl,
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "Reply with exactly: OK" }],
              tools: {},
            })
            .pipe(Effect.provideService(HeadlessRunRef, {}), Effect.timeout("5 seconds"))

          expect(result).toBe("stop")
          expect(yield* llm.calls).toBe(1)
          expect(handle.message.error?.name).toBe("APIError")
          if (handle.message.error?.name === "APIError") {
            expect(handle.message.error.data.message).toContain("Free usage limit reached")
          }
          expect(yield* MessageV2.parts(msg.id)).toEqual([])
          expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
        }),
      { config: (url) => providerCfg(url) },
    ),
  { timeout: 15000 },
)

const nonHeadlessOverrideEnv = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  [
    [SessionSummary.node, summary],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, retryMaxDelayMs: 50 })],
  ],
)
const itNonHeadlessOverride = testEffect(nonHeadlessOverrideEnv)

itNonHeadlessOverride.live(
  "ignores retryMaxDelayMs outside headless runs so interactive sessions keep retry status",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.error(
            429,
            {
              type: "error",
              error: {
                type: "FreeUsageLimitError",
                message: "Free usage limit reached. Subscribe to OpenCode Go for higher limits.",
              },
              metadata: {},
            },
            { "retry-after": "1" },
          )
          yield* llm.text("RECOVERED_INTERACTIVE")

          const { processors, session, provider } = yield* boot()
          const events = yield* EventV2Bridge.Service
          const retryActions: Array<string | undefined> = []
          yield* events.listen((event) => {
            if (event.type !== SessionStatus.Event.Status.type) return Effect.void
            const data = event.data as { status?: SessionStatus.Info }
            if (data.status?.type === "retry") retryActions.push(data.status.action?.reason)
            return Effect.void
          })

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "Reply with exactly: OK")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

          const result = yield* handle
            .process({
              user: parent as SessionV1.User,
              sessionID: chat.id,
              model: mdl,
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "Reply with exactly: OK" }],
              tools: {},
            })
            .pipe(Effect.timeout("8 seconds"))

          expect(result).toBe("continue")
          expect(yield* llm.calls).toBe(2)
          expect(handle.message.error).toBeUndefined()
          expect(retryActions).toEqual(["free_tier_limit"])
        }),
      { config: (url) => providerCfg(url) },
    ),
  { timeout: 15000 },
)

// ---------------------------------------------------------------------------
// Doom-loop guard (#725)
// ---------------------------------------------------------------------------

// The permission stub records every ask instead of waiting on the real prompt, so a
// test can assert exactly when the guard fires. The LLM stub replays one scripted
// model response per `process` call.
const doomEnv = (asks: PermissionV1.AskInput[], script: LLMEvent[][]) =>
  LayerNode.compile(root, [
    ...replacements,
    [
      Permission.node,
      Layer.succeed(
        Permission.Service,
        Permission.Service.of({
          ask: (input) => Effect.sync(() => void asks.push(input)),
          reply: () => Effect.void,
          list: () => Effect.succeed([]),
          denies: () => Effect.succeed(false),
        }),
      ),
    ],
    [
      LLM.node,
      Layer.succeed(
        LLM.Service,
        LLM.Service.of({
          stream: () => Stream.fromIterable(script.shift() ?? []),
        }),
      ),
    ],
  ])

const doomCall = (id: string, name: string, input: Record<string, unknown>, outcome: "error" | "completed") => [
  LLMEvent.toolInputStart({ id, name }),
  LLMEvent.toolInputEnd({ id, name }),
  LLMEvent.toolCall({ id, name, input }),
  outcome === "completed"
    ? LLMEvent.toolResult({
        id,
        name,
        result: { type: "json", value: { output: "ok", title: name, metadata: {} } },
      })
    : LLMEvent.toolError({ id, name, message: "boom" }),
]

const doomText = (id: string, text: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

// One user turn. Each `send` runs one scripted model response as its own assistant
// message, which is the generation step the guard reads back for repeats.
const doomTurn = (dir: string) =>
  Effect.gen(function* () {
    const { processors, session, provider } = yield* boot()
    const chat = yield* session.create({})
    let activeUser = yield* user(chat.id, "look it up")
    const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
    const send = Effect.fnUntraced(function* () {
      const msg = yield* assistant(chat.id, activeUser.id, path.resolve(dir))
      const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
      yield* handle.process({
        user: activeUser,
        sessionID: chat.id,
        model: mdl,
        agent: agent(),
        system: [],
        messages: [{ role: "user", content: "look it up" }],
        tools: {},
      })
      return msg
    })
    const nudge = Effect.fnUntraced(function* (text: string) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "work",
        model: ref,
        time: { created: Date.now() },
      } satisfies SessionV1.User)
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: chat.id,
        type: "text",
        text,
        synthetic: true,
      })
      activeUser = msg
      return msg
    })
    const nextTurn = Effect.fnUntraced(function* (text: string) {
      activeUser = yield* user(chat.id, text)
      return activeUser
    })
    return { send, nudge, nextTurn }
  })

const lookup = { query: "same" }

const batchAsks: PermissionV1.AskInput[] = []
const itDoomBatch = testEffect(
  doomEnv(batchAsks, [
    [
      LLMEvent.stepStart({ index: 0 }),
      ...doomCall("batch-1", "lookup", lookup, "error"),
      ...doomCall("batch-2", "lookup", lookup, "error"),
      ...doomCall("batch-3", "lookup", lookup, "error"),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ],
  ]),
)

itDoomBatch.live(
  "session.processor doom loop ignores identical calls fanned out in one batch",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { send } = yield* doomTurn(dir)
          const msg = yield* send()

          const calls = (yield* MessageV2.parts(msg.id)).filter((part) => part.type === "tool")
          expect(calls).toHaveLength(3)
          expect(calls.every((part) => part.type === "tool" && part.state.status === "error")).toBe(true)
          expect(batchAsks).toHaveLength(0)
        }),
      { config: cfg },
    ),
  { timeout: 15000 },
)

const repeatAsks: PermissionV1.AskInput[] = []
const itDoomRepeat = testEffect(
  doomEnv(
    repeatAsks,
    Array.from({ length: 3 }, (_, index) => [
      LLMEvent.stepStart({ index: 0 }),
      ...doomCall(`repeat-${index}`, "lookup", lookup, "error"),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ]),
  ),
)

itDoomRepeat.live(
  "session.processor doom loop asks once the same failing call repeats across steps",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { send } = yield* doomTurn(dir)

          yield* send()
          yield* send()
          expect(repeatAsks).toHaveLength(0)

          yield* send()
          expect(repeatAsks).toHaveLength(1)
          expect(repeatAsks[0]).toMatchObject({
            permission: "doom_loop",
            patterns: ["lookup"],
            metadata: { tool: "lookup", input: lookup },
          })
        }),
      { config: cfg },
    ),
  { timeout: 15000 },
)

// Repeating an identical failing parallel batch across three steps is still a genuine
// multi-step loop: multiple calls inside one step must not displace earlier steps.
const batchLoopAsks: PermissionV1.AskInput[] = []
const itDoomBatchLoop = testEffect(
  doomEnv(
    batchLoopAsks,
    Array.from({ length: 3 }, (_, step) => [
      LLMEvent.stepStart({ index: 0 }),
      ...doomCall(`batch-loop-${step}-a`, "lookup", lookup, "error"),
      ...doomCall(`batch-loop-${step}-b`, "lookup", lookup, "error"),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ]),
  ),
)

itDoomBatchLoop.live(
  "session.processor doom loop asks when an identical failing batch repeats across steps",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { send } = yield* doomTurn(dir)

          yield* send()
          expect(batchLoopAsks).toHaveLength(0)

          yield* send()
          expect(batchLoopAsks).toHaveLength(0)

          yield* send()
          expect(batchLoopAsks).toHaveLength(1)
          expect(batchLoopAsks[0]).toMatchObject({
            permission: "doom_loop",
            patterns: ["lookup"],
            metadata: { tool: "lookup", input: lookup },
          })
        }),
      { config: cfg },
    ),
  { timeout: 15000 },
)

const completedAsks: PermissionV1.AskInput[] = []
const itDoomCompleted = testEffect(
  doomEnv(
    completedAsks,
    Array.from({ length: 3 }, (_, index) => [
      LLMEvent.stepStart({ index: 0 }),
      ...doomCall(`ok-${index}`, "lookup", lookup, "completed"),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ]),
  ),
)

itDoomCompleted.live(
  "session.processor doom loop ignores identical successful calls across steps",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { send } = yield* doomTurn(dir)

          const first = yield* send()
          const second = yield* send()
          const third = yield* send()

          for (const msg of [first, second, third]) {
            const calls = (yield* MessageV2.parts(msg.id)).filter((part) => part.type === "tool")
            expect(calls).toHaveLength(1)
            expect(calls[0]?.type === "tool" && calls[0].state.status).toBe("completed")
          }
          expect(completedAsks).toHaveLength(0)
        }),
      { config: cfg },
    ),
  { timeout: 15000 },
)

// The placeholder `experimental_repairToolCall` substitutes when a deferred tool was
// called before its catalog entry was loaded: it never ran, it tells the model to
// retry the real tool, and its input is identical every time it appears.
const deferredRepair = { tool: "websearch", error: "websearch exists and has been loaded — call it again" }
const otherDeferredRepair = { tool: "codesearch", error: "codesearch exists and has been loaded — call it again" }

const repairAsks: PermissionV1.AskInput[] = []
const itDoomRepair = testEffect(
  doomEnv(repairAsks, [
    [
      // The reported shape: identical repair placeholders back to back in one response.
      LLMEvent.stepStart({ index: 0 }),
      ...doomCall("repair-1", "invalid", deferredRepair, "error"),
      ...doomCall("repair-2", "invalid", deferredRepair, "error"),
      ...doomCall("repair-3", "invalid", deferredRepair, "error"),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      // ... and the same placeholder repeated across responses, which only the
      // placeholder exclusion keeps out of the failure streak.
      LLMEvent.stepStart({ index: 1 }),
      ...doomCall("repair-4", "invalid", otherDeferredRepair, "error"),
      LLMEvent.stepFinish({ index: 1, reason: "tool-calls" }),
      LLMEvent.stepStart({ index: 2 }),
      ...doomCall("repair-5", "invalid", otherDeferredRepair, "error"),
      LLMEvent.stepFinish({ index: 2, reason: "tool-calls" }),
      LLMEvent.stepStart({ index: 3 }),
      ...doomCall("repair-6", "invalid", otherDeferredRepair, "error"),
      LLMEvent.stepFinish({ index: 3, reason: "tool-calls" }),
      // The instructed retry: now that the tool is loaded it runs, and it fails.
      LLMEvent.stepStart({ index: 4 }),
      ...doomCall("retry", "websearch", lookup, "error"),
      LLMEvent.stepFinish({ index: 4, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ],
  ]),
)

itDoomRepair.live(
  "session.processor doom loop ignores deferred-tool repair placeholders and their instructed retry",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { send } = yield* doomTurn(dir)
          const msg = yield* send()

          const calls = (yield* MessageV2.parts(msg.id)).filter((part) => part.type === "tool")
          expect(calls.filter((part) => part.type === "tool" && part.tool === "invalid")).toHaveLength(6)
          expect(calls.filter((part) => part.type === "tool" && part.tool === "websearch")).toHaveLength(1)
          expect(repairAsks).toHaveLength(0)
        }),
      { config: cfg },
    ),
  { timeout: 15000 },
)

// A repair placeholder between two real failures is not an attempt at the tool, so it
// must neither count as a failure nor break the streak of a genuine loop.
const placeholderAsks: PermissionV1.AskInput[] = []
const itDoomPlaceholder = testEffect(
  doomEnv(placeholderAsks, [
    [
      LLMEvent.stepStart({ index: 0 }),
      ...doomCall("real-1", "lookup", lookup, "error"),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ],
    [
      LLMEvent.stepStart({ index: 0 }),
      ...doomCall("repair", "invalid", deferredRepair, "error"),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ],
    [
      LLMEvent.stepStart({ index: 0 }),
      ...doomCall("real-2", "lookup", lookup, "error"),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ],
    [
      LLMEvent.stepStart({ index: 0 }),
      ...doomCall("real-3", "lookup", lookup, "error"),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ],
  ]),
)

itDoomPlaceholder.live(
  "session.processor doom loop skips repair placeholders in a real failure streak",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { send } = yield* doomTurn(dir)

          yield* send() // lookup fails
          yield* send() // deferred-tool repair placeholder, not an attempt at lookup
          yield* send() // lookup fails again
          expect(placeholderAsks).toHaveLength(0)

          // The two real failures before this call are in separate steps; the
          // placeholder between them is not evidence either way.
          yield* send()
          expect(placeholderAsks).toHaveLength(1)
          expect(placeholderAsks[0]).toMatchObject({ permission: "doom_loop", patterns: ["lookup"] })
        }),
      { config: cfg },
    ),
  { timeout: 20000 },
)

const mixedAsks: PermissionV1.AskInput[] = []
const itDoomMixed = testEffect(
  doomEnv(
    mixedAsks,
    (["error", "completed", "error", "error", "error"] as const).map((outcome, index) => [
      LLMEvent.stepStart({ index: 0 }),
      ...doomCall(`mixed-${index}`, "lookup", lookup, outcome),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ]),
  ),
)

itDoomMixed.live(
  "session.processor doom loop counts only failures, so a success in between breaks the streak",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { send } = yield* doomTurn(dir)

          yield* send() // error
          yield* send() // completed: progress, not a failure to count
          yield* send() // error
          yield* send() // error
          expect(mixedAsks).toHaveLength(0)

          // The evidence is now the two failures right before this call, in separate steps.
          yield* send()
          expect(mixedAsks).toHaveLength(1)
          expect(mixedAsks[0]).toMatchObject({ permission: "doom_loop", patterns: ["lookup"] })
        }),
      { config: cfg },
    ),
  { timeout: 20000 },
)

// Synthetic finish/stagnation nudges and intervening tool-less text steps stay inside
// the active user turn, whereas a new real user message resets the failure streak.
const nudgeAsks: PermissionV1.AskInput[] = []
const itDoomNudges = testEffect(
  doomEnv(nudgeAsks, [
    [
      LLMEvent.stepStart({ index: 0 }),
      ...doomCall("nudge-fail-1", "lookup", lookup, "error"),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ],
    doomText("prose-1", "still thinking"),
    doomText("prose-2", "still thinking"),
    doomText("prose-3", "still thinking"),
    doomText("prose-4", "still thinking"),
    [
      LLMEvent.stepStart({ index: 0 }),
      ...doomCall("nudge-fail-2", "lookup", lookup, "error"),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ],
    [
      LLMEvent.stepStart({ index: 0 }),
      ...doomCall("nudge-fail-3", "lookup", lookup, "error"),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ],
    [
      LLMEvent.stepStart({ index: 0 }),
      ...doomCall("new-turn-fail", "lookup", lookup, "error"),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ],
  ]),
)

itDoomNudges.live(
  "session.processor doom loop keeps streak across synthetic nudges and tool-less steps but resets on real user turn",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { send, nudge, nextTurn } = yield* doomTurn(dir)

          yield* send() // first lookup failure
          for (let i = 0; i < 4; i++) {
            yield* nudge("Call the finish tool when done.")
            yield* send() // tool-less assistant text
          }
          yield* nudge("Stop repeating and call finish.")
          yield* send() // second lookup failure across >6 intervening messages
          expect(nudgeAsks).toHaveLength(0)

          yield* nudge("Stop repeating and call finish.")
          yield* send() // third lookup failure in the same real user turn
          expect(nudgeAsks).toHaveLength(1)
          expect(nudgeAsks[0]).toMatchObject({ permission: "doom_loop", patterns: ["lookup"] })

          // A real user prompt starts a fresh turn, so the prior streak does not carry over.
          yield* nextTurn("try it again now")
          yield* send()
          expect(nudgeAsks).toHaveLength(1)
        }),
      { config: cfg },
    ),
  { timeout: 20000 },
)
