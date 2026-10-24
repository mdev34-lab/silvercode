import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { readdir, readFile } from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"

import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { PASTE_FILE_DIRECTORY, PASTE_INLINE_MAX_BYTES } from "../../src/session/paste-file"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "@opencode-ai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"

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

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

// Minimal MCP tool wired to a stub client, enough for SessionTools to convert and call it.
function mcpTool(name: string, description: string) {
  return {
    def: {
      name,
      description,
      inputSchema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false },
    },
    client: {
      callTool: async () => ({ content: [{ type: "text", text: "note: buy milk" }] }),
    },
  } as unknown as MCP.McpTool
}

// Records every MCP getPrompt call (as "client/name") so tests can assert
// when command templates are resolved against the MCP server.
const mcpPromptCalls: string[] = []

type McpPrompt = { name: string; description?: string; client: string }
type McpPromptResult = { messages: Array<{ role: "user" | "assistant"; content: { type: "text"; text: string } }> }

function makeMcp(
  instructions: MCP.ServerInstructions[] = [],
  tools: Record<string, MCP.McpTool> = {},
  prompts: Record<string, McpPrompt> = {},
  getPrompt: (
    client: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<McpPromptResult | undefined> = () => Effect.succeed(undefined),
) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed(instructions),
      tools: () => Effect.succeed(tools),
      prompts: () => Effect.succeed(prompts),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: (client: string, name: string, args?: Record<string, string>) =>
        Effect.sync(() => {
          mcpPromptCalls.push(`${client}/${name}`)
        }).pipe(Effect.andThen(getPrompt(client, name, args))),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

function makePrompt(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(promptRoot, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(promptRoot, replacements)
}

function makeHttp(input?: {
  mcpInstructions?: MCP.ServerInstructions[]
  mcpTools?: Record<string, MCP.McpTool>
  mcpPrompts?: Record<string, McpPrompt>
  mcpGetPrompt?: (
    client: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<McpPromptResult | undefined>
  processor?: "blocking"
}) {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions, input?.mcpTools, input?.mcpPrompts, input?.mcpGetPrompt)],
    [RuntimeFlags.node, runtimeFlags],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(root, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(root, replacements)
}

function makeHttpNoLLMServer(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  return makePrompt(input)
}

const it = testEffect(makeHttp())
const noLLMServer = testEffect(makeHttpNoLLMServer())
const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))

// Runners with an MCP prompt registered, for the command execution tests.
// The TUI launcher lists commands from the command endpoint and executes the
// selection through SessionPrompt.command, so these assert the full
// discovery -> execution path against an MCP-backed command.
const mcpReviewPrompts = {
  "probe-mcp:review": { name: "review", description: "Review changes via MCP", client: "probe-mcp" },
}
const itMcpPrompt = testEffect(
  makeHttp({
    mcpPrompts: mcpReviewPrompts,
    mcpGetPrompt: (client, name) =>
      Effect.succeed({
        messages: [{ role: "user", content: { type: "text", text: `MCP review output for ${name}` } }],
      }),
  }),
)
// Mirrors MCP.withClient's failure semantics: the request is made but the
// error is swallowed and the prompt resolves to undefined.
const itMcpPromptUnavailable = testEffect(
  makeHttp({
    mcpPrompts: mcpReviewPrompts,
    mcpGetPrompt: () => Effect.succeed(undefined),
  }),
)
const withMcpInstructions = testEffect(
  makeHttp({
    mcpInstructions: [
      {
        name: "guide-server",
        instructions: "Use lookup before mutate.",
        tools: ["guide-server_lookup"],
      },
    ],
  }),
)
const withMcpTools = testEffect(
  makeHttp({
    mcpTools: {
      notes_search_notes: mcpTool("search_notes", "Search the user's notes and return matching entries"),
      attachments_list: mcpTool("attachments_list", "External MCP attachment list"),
      attachments_save: mcpTool("attachments_save", "External MCP attachment save"),
    },
  }),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
// The default agents opt out of the finish tool here: these tests script
// loop mechanics with minimal replies and assert exact request counts, so the
// finish gate (covered by the dedicated finish-tool tests below) stays off.
const cfg = {
  agent: {
    work: { finishTool: false },
    general: { finishTool: false },
    plan: { finishTool: false },
  },
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

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped
// inside Runner.startShell's serialized transition, so cancel can't no-op once
// we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
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

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "work",
    agent: "work",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "loop exits for a completed parent turn with nonmonotonic message IDs",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const userID = MessageID.make("msg_z_user")
      const assistantID = MessageID.make("msg_a_assistant")
      yield* sessions.updateMessage({
        id: userID,
        role: "user",
        sessionID: chat.id,
        agent: "work",
        model: ref,
        time: { created: 100 },
      })
      yield* sessions.updateMessage({
        id: assistantID,
        role: "assistant",
        parentID: userID,
        sessionID: chat.id,
        mode: "work",
        agent: "work",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: 200, completed: 201 },
        finish: "stop",
      })

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(result.info.id).toBe(assistantID)
    }),
  { config: cfg },
)

it.instance("loop exits without an LLM request for interrupted orphan tool calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: seeded.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "interrupted-call",
      tool: "edit",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      },
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.id).toBe(seeded.assistant.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "work",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

it.instance(
  "review loop targets the default primary agent regardless of its name",
  () =>
    Effect.gen(function* () {
      // Simulate the default agent being renamed away from "build" (e.g. build -> work):
      // the review loop must follow the default primary agent, not the legacy name.
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        default_agent: "work",
        agent: {
          work: {
            name: "work",
            mode: "all",
            description: "The default agent",
          },
        },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        agent: "work",
        model: { providerID: ref.providerID, id: ref.modelID },
      })
      yield* llm.hang
      const session = yield* Session.Service
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "work",
        model: ref,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: chat.id,
        type: "text",
        text: "hello",
      })

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for the model request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      // The scope contract is injected for the default primary only; the Review
      // Loop policy itself waits until the session has written files.
      expect(body).not.toContain("## Review Loop")
      expect(body).toContain("## Todo as scope contract")
      expect(body).toContain("first tool call")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

it.instance(
  "review loop is not injected for a non-default primary agent",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        agent: "plan",
        model: { providerID: ref.providerID, id: ref.modelID },
      })
      yield* llm.hang
      const session = yield* Session.Service
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "plan",
        model: ref,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: chat.id,
        type: "text",
        text: "hello",
      })

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for the model request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).not.toContain("## Review Loop")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

it.instance(
  "loop includes STE-lite reply style by default",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for STE-lite request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).toContain("Do not apply this style to deliverables")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

it.instance(
  "loop omits STE-lite reply style when disabled",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), ste_lite: false }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for STE-lite off request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).not.toContain("Do not apply this style to deliverables")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

it.instance(
  "loop omits STE-lite from compaction generations",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const compaction = yield* SessionCompaction.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* seed(chat.id, { finish: "stop" })
      yield* compaction.create({
        sessionID: chat.id,
        agent: "work",
        model: ref,
        auto: true,
      })
      yield* llm.hang

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for compaction request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).not.toContain("Do not apply this style to deliverables")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

withMcpInstructions.instance(
  "loop includes MCP instructions in model system context",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for MCP instruction request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).toContain('<server name=\\"guide-server\\">')
      expect(body).toContain("Use lookup before mutate.")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

it.instance(
  "assembled primary system prompt carries the delegation nudge",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for the model request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).toContain("delegate planning to `think` once, at the start")
      expect(body).toContain("delegate each implementation step to `code`")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

it.instance("legacy prompt emits message events without session.next events", () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      agent: "plan",
      model: { providerID: ProviderV2.ID.make("old"), id: ModelV2.ID.make("old-model") },
    })
    const seen: string[] = []
    const off = yield* events.listen((event) => {
      seen.push(event.type)
      return Effect.void
    })

    const first = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "work",
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    const second = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "work",
      noReply: true,
      parts: [{ type: "text", text: "again" }],
    })
    yield* off

    expect(first.info.role).toBe("user")
    expect(second.info.role).toBe("user")
    if (first.info.role === "user" && second.info.role === "user") {
      expect(first.info.model).toEqual(ref)
      expect(second.info.model).toEqual(ref)
    }
    expect(yield* sessions.get(chat.id)).toMatchObject({
      agent: "work",
      model: { providerID: ref.providerID, id: ref.modelID },
    })
    expect(seen).toContain(Session.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.PartUpdated.type)
    expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
  }),
)

it.instance("loop surfaces content-filter finishes as session errors", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const expected = {
      name: "ContentFilterError",
      data: { message: "The response was blocked by the provider's content filter" },
    } satisfies NonNullable<SessionV1.Assistant["error"]>
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
      return Effect.void
    })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "work",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("partial response").contentFilter())

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    yield* off

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("content-filter")
      expect(result.info.error).toEqual(expected)
      expect(stored.info.error).toEqual(result.info.error)
      expect(errors).toContainEqual(expected)
    }
    expect(result.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "partial response" })]),
    )
  }),
)

it.instance("loop stops provider overflow instead of auto-compacting when disabled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { auto: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "work",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error?.name).toBe("ContextOverflowError")
      expect(result.info.finish).toBe("error")
    }
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
  }),
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "work",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(
          LayerNode.compile(SessionV2.node, [
            [SessionExecution.node, SessionExecution.noopLayer],
            [LocationServiceMap.node, locationServiceMapLayer],
          ]),
        ),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

// Paste-to-File: the TUI composer sends large pasted text as a
// data:text/plain file part. Admission must keep the full content in a
// managed file and inline a bounded preview, while small pastes keep the
// legacy inline behavior.
function pasteDir(sessionID: string) {
  return path.join(Global.Path.data, PASTE_FILE_DIRECTORY, sessionID)
}

noLLMServer.instance(
  "large data:text/plain paste is saved to a managed file with a bounded preview",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Paste to file" })

      const content = "SilverCode paste to file marker line. ".repeat(4000)
      expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(PASTE_INLINE_MAX_BYTES)

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "work",
        noReply: true,
        parts: [
          { type: "text", text: "please read this document" },
          {
            type: "file",
            mime: "text/plain",
            filename: "paste-1.txt",
            url: `data:text/plain;base64,${Buffer.from(content, "utf8").toString("base64")}`,
          },
        ],
      })

      const messages = yield* sessions.messages({ sessionID: chat.id })
      const parts = messages.flatMap((message) => message.parts)
      const syntheticTexts = parts
        .filter((part): part is SessionV1.TextPart => part.type === "text" && part.synthetic === true)
        .map((part) => part.text)

      // A note pointing the model at the full file...
      const note = syntheticTexts.find((text) => text.includes("was saved to"))
      expect(note).toBeDefined()
      expect(note).toContain("Large pasted text file: paste-1.txt")
      expect(note).toContain(pasteDir(chat.id))
      // ...and a bounded preview that keeps head and tail of the content.
      const preview = syntheticTexts.find((text) => text.includes("content truncated"))
      expect(preview).toBeDefined()
      expect(Buffer.byteLength(preview!, "utf8")).toBeLessThanOrEqual(PASTE_INLINE_MAX_BYTES)
      expect(preview).toContain(content.split(" ")[0])
      expect(preview).toContain(content.trim().split(" ").slice(-3).join(" "))
      expect(preview).toContain(pasteDir(chat.id))
      // The file part itself is retained on the message.
      const fileParts = parts.filter((part) => part.type === "file")
      expect(fileParts).toHaveLength(1)
      expect(fileParts[0]).toMatchObject({ mime: "text/plain", filename: "paste-1.txt" })

      // The full content is on disk, byte for byte.
      const files = (yield* Effect.promise(() => readdir(pasteDir(chat.id)))).filter((file) =>
        file.startsWith("paste-"),
      )
      expect(files).toHaveLength(1)
      const saved = yield* Effect.promise(() => readFile(path.join(pasteDir(chat.id), files[0]), "utf8"))
      expect(saved).toBe(content)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "small data:text/plain paste keeps the legacy inline behavior",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Paste to file small" })

      // Exactly at the inline budget: still inlined in full, no file written.
      const content = "a".repeat(PASTE_INLINE_MAX_BYTES)
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(PASTE_INLINE_MAX_BYTES)

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "work",
        noReply: true,
        parts: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: `data:text/plain;base64,${Buffer.from(content, "utf8").toString("base64")}`,
          },
        ],
      })

      const messages = yield* sessions.messages({ sessionID: chat.id })
      const parts = messages.flatMap((message) => message.parts)
      const syntheticTexts = parts
        .filter((part): part is SessionV1.TextPart => part.type === "text" && part.synthetic === true)
        .map((part) => part.text)

      // Legacy shape: synthetic Read-tool note + the full decoded content.
      expect(syntheticTexts).toEqual(expect.arrayContaining([expect.stringContaining("Called the Read tool"), content]))
      expect(syntheticTexts.find((text) => text.includes("Large pasted text file"))).toBeUndefined()
      // Paste to File never ran: no paste-*.txt managed file. The attachment
      // store may still hold a materialized copy of the file part itself —
      // that is the managed-attachment path every file part gets, not the
      // large-paste feature under test here.
      const names = yield* Effect.promise(() =>
        readdir(pasteDir(chat.id)).then(
          (entries) => entries,
          (error) =>
            error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
              ? ([] as string[])
              : Promise.reject(error),
        ),
      )
      expect(names.filter((name) => name.startsWith("paste-"))).toEqual([])
    }),
  { config: cfg },
)

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "work",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "work",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "work",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "work",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

const toolNames = (body: Record<string, unknown> | undefined) => {
  const tools = (body?.tools ?? []) as { function?: { name?: string } }[]
  return tools.map((entry) => entry.function?.name).filter((name): name is string => !!name)
}

it.instance("defers non-core tools until tool_search discovers them", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Tool search",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "download a webpage" }],
    })
    yield* llm.tool("tool_search", { query: "fetch a url webpage" })
    yield* llm.text("done")

    yield* prompt.loop({ sessionID: session.id })

    const hits = yield* llm.hits
    const first = toolNames(hits[0]?.body)
    expect(first).toContain("tool_search")
    expect(first).toContain("read")
    expect(first).not.toContain("webfetch")

    const second = toolNames(hits[1]?.body)
    expect(second).toContain("webfetch")
  }),
)

it.instance(
  "discovers and invokes native attachment under its exact model-facing identity",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Native attachment",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "list the files I attached" }],
      })
      yield* llm.tool("tool_search_regex", { pattern: "^attachment$" })
      yield* llm.tool("attachment", { action: "list" })
      yield* llm.text("There are no attachments.")

      const result = yield* prompt.loop({ sessionID: session.id })
      const hits = yield* llm.hits

      expect(toolNames(hits[0]?.body)).not.toContain("attachment")
      expect(toolNames(hits[1]?.body)).toContain("attachment")
      expect(toolNames(hits[1]?.body)).not.toContain("attachments_list")
      expect(toolNames(hits[1]?.body)).not.toContain("attachments_save")

      const messages = yield* sessions.messages({ sessionID: session.id })
      const call = messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.tool === "attachment")
      expect(call).toBeDefined()
      if (call?.type === "tool") {
        expect(call.state.status).toBe("completed")
        if (call.state.status === "completed") {
          expect(call.state.output).toContain("No attachments in this session")
          expect(call.state.metadata).toMatchObject({ action: "list", attachments: [] })
        }
      }
      expect(result.info.role).toBe("assistant")
    }),
  20_000,
)

withMcpTools.instance(
  "serializes native attachment distinctly from similarly named MCP tools",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), tool_search: { enabled: false } }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Native and MCP attachments",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "list attachments" }],
      })
      yield* llm.text("done")

      yield* prompt.loop({ sessionID: session.id })

      const names = toolNames((yield* llm.hits)[0]?.body)
      expect(names.filter((name) => name === "attachment")).toHaveLength(1)
      expect(names.filter((name) => name === "attachments_list")).toHaveLength(1)
      expect(names.filter((name) => name === "attachments_save")).toHaveLength(1)
    }),
  20_000,
)

it.instance(
  "permission filtering does not conflate attachment visibility with edit tools",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), tool_search: { enabled: false } }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Attachment visibility",
        permission: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "edit", pattern: "*", action: "deny" },
        ],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "list attachments without changing files" }],
      })
      yield* llm.text("done")

      yield* prompt.loop({ sessionID: session.id })

      const names = toolNames((yield* llm.hits)[0]?.body)
      expect(names).toContain("attachment")
      expect(names).not.toContain("edit")
      expect(names).not.toContain("write")
      expect(names).not.toContain("attachments_list")
      expect(names).not.toContain("attachments_save")
    }),
  20_000,
)

it.instance(
  "attachment save remains gated by canonical edit permission",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        tool_search: { enabled: false },
        permission: { "*": "allow", edit: "deny" },
      }))
      const fsys = yield* FSUtil.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Attachment save denied" })
      const user = yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [
          { type: "text", text: "save this attachment" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,YXR0YWNobWVudCBjb250ZW50",
          },
        ],
      })
      const attachment = user.parts.find((part) => part.type === "file")
      if (!attachment || attachment.type !== "file") throw new Error("expected prompt attachment")
      const target = path.join(dir, "saved-note.txt")

      yield* llm.tool("attachment", { action: "list" })
      yield* llm.tool("attachment", { action: "save", id: attachment.id, path: "saved-note.txt" })
      yield* llm.text("I could not save it without edit permission.")
      yield* prompt.loop({ sessionID: session.id })

      const messages = yield* sessions.messages({ sessionID: session.id })
      const calls = messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool" && part.tool === "attachment")
      const list = calls.find((part) => part.type === "tool" && part.state.input.action === "list")
      const save = calls.find((part) => part.type === "tool" && part.state.input.action === "save")
      expect(list).toBeDefined()
      if (list?.type === "tool") {
        expect(list.state.status).toBe("completed")
        if (list.state.status === "completed") {
          expect(list.state.metadata).toMatchObject({
            action: "list",
            attachments: [{ managed_id: attachment.id }],
          })
        }
      }
      expect(save).toBeDefined()
      if (save?.type === "tool") expect(save.state.status).toBe("error")
      expect(yield* fsys.existsSafe(target)).toBe(false)
    }),
  20_000,
)

it.instance(
  "attachment save copies managed bytes after edit authorization",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        tool_search: { enabled: false },
        permission: { "*": "allow" },
      }))
      const fsys = yield* FSUtil.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Attachment save allowed" })
      const user = yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [
          { type: "text", text: "save this attachment" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,YXR0YWNobWVudCBjb250ZW50",
          },
        ],
      })
      const attachment = user.parts.find((part) => part.type === "file")
      if (!attachment || attachment.type !== "file") throw new Error("expected prompt attachment")
      const target = path.join(dir, "saved-note.txt")

      yield* llm.tool("attachment", { action: "save", id: attachment.id, path: "saved-note.txt" })
      yield* llm.text("Saved.")
      yield* prompt.loop({ sessionID: session.id })

      const messages = yield* sessions.messages({ sessionID: session.id })
      const save = messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.tool === "attachment")
      expect(save).toBeDefined()
      if (save?.type === "tool") {
        expect(save.state.status).toBe("completed")
        if (save.state.status === "completed") {
          expect(save.state.output).toContain("Saved attachment to saved-note.txt")
          expect(save.state.metadata).toMatchObject({ action: "save", resource: "saved-note.txt" })
        }
      }
      expect(yield* fsys.readFileStringSafe(target)).toBe("attachment content")
    }),
  20_000,
)

it.instance(
  "historical legacy attachments remain listable and lazily saveable",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        tool_search: { enabled: false },
        permission: { "*": "allow" },
      }))
      const fsys = yield* FSUtil.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Historical attachment" })
      const messageID = MessageID.ascending()
      const attachmentID = PartID.ascending()
      yield* sessions.updateMessage({
        id: messageID,
        role: "user",
        sessionID: session.id,
        agent: "work",
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: attachmentID,
        messageID,
        sessionID: session.id,
        type: "file",
        mime: "text/plain",
        filename: "historical.txt",
        url: "data:text/plain;base64,aGlzdG9yaWNhbCBjb250ZW50",
      })
      const target = path.join(dir, "historical.txt")

      yield* llm.tool("attachment", { action: "list" })
      yield* llm.tool("attachment", { action: "save", id: attachmentID, path: "historical.txt" })
      yield* llm.text("Saved the historical attachment.")
      yield* prompt.loop({ sessionID: session.id })

      const messages = yield* sessions.messages({ sessionID: session.id })
      const calls = messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool" && part.tool === "attachment")
      const list = calls.find((part) => part.type === "tool" && part.state.input.action === "list")
      const save = calls.find((part) => part.type === "tool" && part.state.input.action === "save")
      expect(list).toBeDefined()
      if (list?.type === "tool") {
        expect(list.state.status).toBe("completed")
        if (list.state.status === "completed") {
          expect(list.state.metadata).toMatchObject({
            action: "list",
            attachments: [{ managed_id: attachmentID, name: "historical.txt", unavailable: true }],
          })
        }
      }
      expect(save).toBeDefined()
      if (save?.type === "tool") expect(save.state.status).toBe("completed")
      expect(yield* fsys.readFileStringSafe(target)).toBe("historical content")
    }),
  20_000,
)

it.instance("keeps every tool loaded when tool search is disabled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), tool_search: { enabled: false } }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Tool search off",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "download a webpage" }],
    })
    yield* llm.text("done")

    yield* prompt.loop({ sessionID: session.id })

    const names = toolNames((yield* llm.hits)[0]?.body)
    expect(names).toContain("webfetch")
    expect(names).not.toContain("tool_search")
  }),
)

withMcpTools.instance(
  "system prompt lists hidden tool names in an available_tools block",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Tool overview",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "what is in my notes?" }],
      })
      yield* llm.text("done")

      yield* prompt.loop({ sessionID: session.id })

      const body = JSON.stringify((yield* llm.hits)[0]?.body)
      expect(body).toContain("<available_tools>")
      expect(body).toContain("notes_search_notes")
      expect(body).toContain("</available_tools>")
    }),
  20_000,
)

it.instance(
  "omits the available_tools block when tool search is disabled",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), tool_search: { enabled: false } }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Tool overview off",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "download a webpage" }],
      })
      yield* llm.text("done")

      yield* prompt.loop({ sessionID: session.id })

      const body = JSON.stringify((yield* llm.hits)[0]?.body)
      expect(body).not.toContain("<available_tools>")
    }),
  20_000,
)

withMcpTools.instance(
  "calling a deferred tool by name discovers it and reports it is now loaded",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Deferred by name",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "list my notes" }],
      })
      // The model calls the deferred MCP tool directly, by exact name, without tool_search.
      yield* llm.tool("notes_search_notes", { query: "milk" })
      yield* llm.text("done")

      const result = yield* prompt.loop({ sessionID: session.id })
      const hits = yield* llm.hits

      // the repair routed to `invalid` with a message that the tool now exists
      const messages = yield* sessions.messages({ sessionID: session.id })
      const call = messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.tool === "invalid")
      expect(call).toBeDefined()
      if (call?.type === "tool") {
        expect(call.state.status).toBe("completed")
        if (call.state.status === "completed") {
          expect(call.state.output).toContain("notes_search_notes exists and has been loaded")
        }
      }

      // the repair discovered the tool, so the next request carries it
      expect(toolNames(hits[0]?.body)).not.toContain("notes_search_notes")
      expect(toolNames(hits[1]?.body)).toContain("notes_search_notes")
      expect(result.info.role).toBe("assistant")
    }),
  20_000,
)

withMcpTools.instance(
  "an MCP tool discovered by tool_search is callable on the next step",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "MCP discovery",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "what is in my notes?" }],
      })
      yield* llm.tool("tool_search", { query: "search notes" })
      yield* llm.tool("notes_search_notes", { query: "milk" })
      yield* llm.text("you need milk")

      const result = yield* prompt.loop({ sessionID: session.id })
      const hits = yield* llm.hits

      // step 1: the MCP tool is not in the request at all
      expect(toolNames(hits[0]?.body)).not.toContain("notes_search_notes")
      // step 2: discovery made it visible
      expect(toolNames(hits[1]?.body)).toContain("notes_search_notes")

      // and it actually ran, rather than just appearing in the schema
      const messages = yield* sessions.messages({ sessionID: session.id })
      const call = messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.tool === "notes_search_notes")
      expect(call).toBeDefined()
      if (call?.type === "tool") {
        expect(call.state.status).toBe("completed")
        if (call.state.status === "completed") expect(call.state.output).toContain("buy milk")
      }
      expect(result.info.role).toBe("assistant")
    }),
  20_000,
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "work",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "work",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

// Finish tool gating

it.instance(
  "loop nudges the model to call finish when it ends its turn without the finish tool",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { work: { finishTool: true } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("working on it")
      yield* llm.tool("finish", { reason: "success", result: "all done" })

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(2)
      const hits = yield* llm.hits
      expect(toolNames(hits[0]?.body)).toContain("finish")
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        const finish = result.parts.find(
          (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "finish",
        )
        expect(finish?.state.status).toBe("completed")
      }
      const messages = yield* sessions.messages({ sessionID: session.id })
      const nudges = messages.filter(
        (msg) =>
          msg.info.role === "user" &&
          msg.parts.some((part) => part.type === "text" && part.synthetic && part.text.includes("finish")),
      )
      expect(nudges.length).toBe(1)
    }),
  { timeout: 30_000 },
)

it.instance(
  "loop stops after a bounded number of finish nudges when the model never calls finish",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { work: { finishTool: true } },
      }))
      const events = yield* EventV2Bridge.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "Bom dia" }],
      })
      yield* llm.text("Bom dia! Como posso ajudar?")
      yield* llm.text("Bom dia! Como posso ajudar?")
      yield* llm.text("Bom dia! Como posso ajudar?")
      yield* llm.text("Bom dia! Como posso ajudar?")

      const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
      const off = yield* events.listen((event) => {
        if (event.type !== Session.Event.Error.type) return Effect.void
        const data = event.data as typeof Session.Event.Error.data.Type
        if (data.sessionID === session.id && data.error) errors.push(data.error)
        return Effect.void
      })
      const result = yield* prompt.loop({ sessionID: session.id })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: result.info.id })
      const messages = yield* sessions.messages({ sessionID: session.id })
      yield* off

      expect(yield* llm.calls).toBe(4)
      expect(toolNames((yield* llm.hits)[0]?.body)).toContain("finish")
      expect(yield* status.get(session.id)).toEqual({ type: "idle" })
      expect(result.info.role).toBe("assistant")
      expect(stored.info.role).toBe("assistant")
      if (result.info.role === "assistant" && stored.info.role === "assistant") {
        expect(result.info.finish).toBe("error")
        expect(result.info.error?.name).toBe("UnknownError")
        if (result.info.error?.name === "UnknownError") {
          expect(result.info.error.data.message).toContain("did not complete the required finish tool after 3 nudges")
          expect(result.info.error.data.message).toContain("Set agent.<name>.finishTool to false")
        }
        expect(stored.info.error).toEqual(result.info.error)
        if (result.info.error) expect(errors).toContainEqual(result.info.error)
        expect(result.parts).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "text", text: "Bom dia! Como posso ajudar?" })]),
        )
      }
      const nudges = messages.filter(
        (msg) =>
          msg.info.role === "user" &&
          msg.parts.some((part) => part.type === "text" && part.synthetic && part.text.includes("finish")),
      )
      expect(nudges).toHaveLength(3)
    }),
  { timeout: 30_000 },
)

it.instance(
  "loop reports a declined review finish as incomplete after the shared nudge limit",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Review without a report envelope",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "work-review",
        noReply: true,
        parts: [{ type: "text", text: "Review the changes and report your findings." }],
      })
      yield* llm.text("I am reviewing the requested changes.")
      yield* llm.tool("finish", { reason: "success", result: "Needs fixes, but no report envelope." })
      yield* llm.text("I am still checking the changed files.")
      yield* llm.tool("finish", { reason: "success", result: "The report is still missing its envelope." })
      yield* llm.text("The review report is not ready yet.")
      yield* llm.tool("finish", { reason: "success", result: "This is another invalid report." })
      yield* llm.text("I need another pass before reporting.")

      const result = yield* prompt.loop({ sessionID: session.id })
      const messages = yield* sessions.messages({ sessionID: session.id })

      expect(yield* llm.calls).toBe(7)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.finish).toBe("error")
        expect(result.info.error?.name).toBe("UnknownError")
        if (result.info.error?.name === "UnknownError") {
          expect(result.info.error.data.message).toContain("did not complete the required finish tool after 3 nudges")
          expect(result.info.error.data.message).not.toContain("did not call the required finish tool")
        }
      }
      const finishes = messages
        .flatMap((message) => message.parts)
        .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "finish")
      expect(finishes).toHaveLength(3)
      expect(finishes.map((part) => part.state.status)).toEqual(["error", "error", "error"])
      for (const finish of finishes) {
        if (finish.state.status === "error") expect(finish.state.error).toContain("Review finish rejected")
      }
      const nudges = messages.filter(
        (msg) =>
          msg.info.role === "user" &&
          msg.parts.some((part) => part.type === "text" && part.synthetic && part.text.includes("finish")),
      )
      expect(nudges).toHaveLength(3)
    }),
  { timeout: 30_000 },
)

noLLMServer.instance(
  "loop exits without an LLM request when the finish tool already completed",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const seeded = yield* seed(chat.id, { finish: "tool-calls" })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: seeded.assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "finish-call",
        tool: "finish",
        state: {
          status: "completed",
          input: { reason: "success", result: "done" },
          output: "done",
          title: "Task completed",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.id).toBe(seeded.assistant.id)
    }),
  { config: { ...cfg, agent: { work: { finishTool: true } } } },
)

it.instance(
  "run exit settles crash-orphaned running parts",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const seeded = yield* seed(chat.id, { finish: "tool-calls" })
      const orphanPartID = PartID.ascending()
      yield* sessions.updatePart({
        id: orphanPartID,
        messageID: seeded.assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "stuck-bash",
        tool: "bash",
        state: {
          status: "running",
          input: { command: "sleep 100" },
          title: "sleep",
          metadata: {},
          time: { start: 1 },
        },
      })

      yield* llm.text("recovered")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const seededMsg = msgs.find((msg) => msg.info.id === seeded.assistant.id)
      if (!seededMsg || seededMsg.info.role !== "assistant") throw new Error("expected seeded assistant")
      expect(seededMsg.info.time.completed).toBeDefined()
      const orphan = seededMsg.parts.find((part) => part.id === orphanPartID)
      if (!orphan || orphan.type !== "tool" || orphan.state.status !== "error")
        throw new Error("expected orphaned tool to settle as error")
      expect(orphan.state.metadata?.interrupted).toBe(true)
      const seededText = seededMsg.parts.find((part) => part.type === "text")
      if (!seededText || seededText.type !== "text") throw new Error("expected seeded text part")
      expect(seededText.time?.end).toBeDefined()
    }),
  { timeout: 30_000 },
)

it.instance(
  "finish does not end the turn while another tool call is still running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { work: { finishTool: true } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const seeded = yield* seed(chat.id, { finish: "tool-calls" })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: seeded.assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "stuck-bash",
        tool: "bash",
        state: {
          status: "running",
          input: { command: "sleep 100" },
          title: "sleep",
          metadata: {},
          time: { start: 1 },
        },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: seeded.assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "finish-call",
        tool: "finish",
        state: {
          status: "completed",
          input: { reason: "success", result: "done" },
          output: "done",
          title: "Task completed",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      })
      yield* llm.hang

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "finish ended the turn while a tool call was still running", "10 seconds")
      yield* Fiber.interrupt(fiber)
      expect(yield* llm.calls).toBeGreaterThanOrEqual(1)
    }),
  { timeout: 30_000 },
)

it.instance(
  "finish does not end the turn while another tool call is still running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { work: { finishTool: true } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const seeded = yield* seed(chat.id, { finish: "tool-calls" })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: seeded.assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "stuck-bash",
        tool: "bash",
        state: {
          status: "running",
          input: { command: "sleep 100" },
          title: "sleep",
          metadata: {},
          time: { start: 1 },
        },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: seeded.assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "finish-call",
        tool: "finish",
        state: {
          status: "completed",
          input: { reason: "success", result: "done" },
          output: "done",
          title: "Task completed",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      })
      yield* llm.hang

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "finish ended the turn while a tool call was still running", "10 seconds")
      yield* Fiber.interrupt(fiber)
      expect(yield* llm.calls).toBeGreaterThanOrEqual(1)
    }),
  { timeout: 30_000 },
)

it.instance(
  "loop nudges repeated EOS turns until the agent step cap waives the finish requirement",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { work: { finishTool: true, steps: 3 } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("not done yet")
      yield* llm.text("still not done")
      yield* llm.text("final answer")

      const result = yield* prompt.loop({ sessionID: session.id })

      // Two EOS turns are nudged, the third runs at the step cap and exits.
      expect(yield* llm.calls).toBe(3)
      const hits = yield* llm.hits
      expect(toolNames(hits[0]?.body)).toContain("finish")
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
      const messages = yield* sessions.messages({ sessionID: session.id })
      const nudges = messages.filter(
        (msg) =>
          msg.info.role === "user" &&
          msg.parts.some((part) => part.type === "text" && part.synthetic && part.text.includes("finish")),
      )
      expect(nudges.length).toBe(2)
    }),
  { timeout: 30_000 },
)

it.instance("loop ends on end-of-stream when the agent opts out of the finish tool", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: { work: { finishTool: false } },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "work",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })

    expect(yield* llm.calls).toBe(1)
    const hits = yield* llm.hits
    expect(toolNames(hits[0]?.body)).not.toContain("finish")
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
  }),
)

// Every user turn is a task from the execution protocol's perspective, so the
// model must call finish even for conversational turns that need no other
// tools. When the model ends a turn by calling finish alongside its final text,
// the loop must terminate in that same turn without injecting a nudge. These
// tests lock in that "no tools needed" never means "finish is unnecessary".

const expectNoFinishNudge = (messages: SessionV1.WithParts[]) => {
  const nudges = messages.filter(
    (msg) =>
      msg.info.role === "user" &&
      msg.parts.some((part) => part.type === "text" && part.synthetic && part.text.includes("finish")),
  )
  expect(nudges.length).toBe(0)
}

const expectCompletedFinish = (result: SessionV1.WithParts) => {
  const finish = result.parts.find((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "finish")
  expect(finish?.state.status).toBe("completed")
}

it.instance(
  "a simple greeting answered with the finish tool in the same turn completes without a nudge",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { work: { finishTool: true } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "Hello." }],
      })
      yield* llm.push(
        reply()
          .text("Hello! How can I help you today?")
          .tool("finish", { reason: "success", result: "Greeted the user." })
          .stop(),
      )

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(1)
      const hits = yield* llm.hits
      expect(toolNames(hits[0]?.body)).toContain("finish")
      // The contract is surfaced to the model: the finish tool description must
      // spell out that every reply ends with finish, not just coding tasks.
      expect(JSON.stringify(hits[0]?.body)).toContain("end of every reply")
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text.includes("How can I help"))).toBe(true)
        expectCompletedFinish(result)
      }
      const messages = yield* sessions.messages({ sessionID: session.id })
      expectNoFinishNudge(messages)
    }),
  { timeout: 30_000 },
)

it.instance(
  "a simple factual question answered with the finish tool in the same turn completes without a nudge",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { work: { finishTool: true } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "What is the capital of France?" }],
      })
      yield* llm.push(
        reply().text("Paris.").tool("finish", { reason: "success", result: "The capital of France is Paris." }).stop(),
      )

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(1)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "Paris.")).toBe(true)
        expectCompletedFinish(result)
      }
      const messages = yield* sessions.messages({ sessionID: session.id })
      expectNoFinishNudge(messages)
    }),
  { timeout: 30_000 },
)

it.instance(
  "a conversational/explanatory answer that needs no tools still ends with the finish tool in the same turn",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { work: { finishTool: true } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "Explain what an agent loop is." }],
      })
      yield* llm.push(
        reply()
          .text("An agent loop repeatedly calls the model until the task reaches a terminal state.")
          .tool("finish", { reason: "success", result: "Explained the agent loop." })
          .stop(),
      )

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(1)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text.includes("agent loop"))).toBe(true)
        expectCompletedFinish(result)
      }
      const messages = yield* sessions.messages({ sessionID: session.id })
      expectNoFinishNudge(messages)
    }),
  { timeout: 30_000 },
)

it.instance(
  "a normal coding task that uses a tool finishes in the same turn without a nudge or a duplicate finish",
  () =>
    Effect.gen(function* () {
      if (!(yield* hasBash)) return
      const { dir, llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { work: { finishTool: true } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "Write the version to a file and confirm it." }],
      })
      yield* llm.tool("bash", { command: "printf 1 > version.txt", timeout: 5_000, workdir: path.resolve(dir) })
      yield* llm.push(
        reply()
          .text("Wrote version.txt.")
          .tool("finish", { reason: "success", result: "Wrote the version file." })
          .stop(),
      )

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text.includes("Wrote version.txt"))).toBe(true)
        expectCompletedFinish(result)
      }
      const messages = yield* sessions.messages({ sessionID: session.id })
      expectNoFinishNudge(messages)
      const finishParts = messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool" && part.tool === "finish")
      expect(finishParts.length).toBe(1)
    }),
  { timeout: 30_000 },
)

it.instance(
  "a task that uses other tools finishes cleanly in the same turn as its final answer",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { work: { finishTool: true } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "List the text files in this project." }],
      })
      yield* llm.tool("glob", { pattern: "**/*.txt" })
      yield* llm.push(
        reply().text("Found the files.").tool("finish", { reason: "success", result: "Listed the text files." }).stop(),
      )

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expectCompletedFinish(result)
      }
      const messages = yield* sessions.messages({ sessionID: session.id })
      expectNoFinishNudge(messages)
    }),
  { timeout: 30_000 },
)

it.instance(
  "an edge case where the task cannot be completed normally still terminates with the finish tool",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { work: { finishTool: true } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "Delete the database file that does not exist." }],
      })
      yield* llm.push(
        reply()
          .text("No such file exists, so there is nothing to delete.")
          .tool("finish", { reason: "success", result: "Nothing to delete — the database file does not exist." })
          .stop(),
      )

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(1)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expectCompletedFinish(result)
      }
      const messages = yield* sessions.messages({ sessionID: session.id })
      expectNoFinishNudge(messages)
    }),
  { timeout: 30_000 },
)

it.instance("failed background subtask preserves metadata and surfaces the error", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: {
        work: { finishTool: false },
        general: {
          model: "test/missing-model",
          finishTool: false,
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    // The parent continues after dispatching the subtask; the extra call is
    // the notification turn that surfaces the background failure.
    expect(yield* llm.calls).toBeGreaterThanOrEqual(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    // The subtask is dispatched in the background, so metadata is preserved
    // on the completed tool part instead of an in-band error state.
    const tool = completedTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.metadata?.background).toBe(true)
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("missing-model"),
    })

    // The child failure is surfaced through the background notification
    // mechanism as a synthetic user message.
    const notification = yield* pollWithTimeout(
      Effect.gen(function* () {
        const all = yield* MessageV2.filterCompactedEffect(chat.id)
        return all.find(
          (item) =>
            item.info.role === "user" &&
            item.parts.some((part) => part.type === "text" && part.synthetic && part.text.includes("<task_error>")),
        )
      }),
      "timed out waiting for background task error notification",
      "10 seconds",
    )
    const textPart = notification.parts.find((part) => part.type === "text" && part.synthetic)
    const text = textPart?.type === "text" ? textPart.text : ""
    expect(text).toContain("<task_error>")
    expect(text.length).toBeGreaterThan(0)
  }),
)

it.instance("subtask child inherits parent session external_directory allow", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Parent",
      permission: [{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }],
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    yield* prompt.loop({ sessionID: chat.id })

    const kids = yield* sessions.children(chat.id)
    expect(kids).toHaveLength(1)
    const child = kids[0]!
    const rules = child.permission ?? []
    expect(rules).toEqual(
      expect.arrayContaining([{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }]),
    )
    expect(Permission.evaluate("external_directory", "/tmp/allowed/file", rules).action).toBe("allow")
    expect(Permission.evaluate("task", "anything", rules).action).toBe("deny")
  }),
)

noLLMServer.instance("prompt tools replace previous prompt tool rules", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt tools" })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "work",
      noReply: true,
      tools: { bash: false },
      parts: [{ type: "text", text: "first" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "work",
      noReply: true,
      tools: { read: true },
      parts: [{ type: "text", text: "second" }],
    })

    const reloaded = yield* sessions.get(session.id)
    expect(reloaded.permission).toEqual([{ permission: "read", pattern: "*", action: "allow" }])
    expect(Permission.evaluate("bash", "anything", reloaded.permission ?? []).action).toBe("ask")
  }),
)

it.instance(
  "running subtask preserves metadata when dispatched in the background",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      // Subagents run in the background by default, so the subtask tool part
      // completes with background metadata while the child keeps running.
      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find(
            (part): part is CompletedToolPart =>
              part.type === "tool" && part.state.status === "completed" && part.state.metadata?.background === true,
          )
          if (tool?.state.metadata?.sessionId) return tool
          return undefined
        }),
        "timed out waiting for background subtask metadata",
      )

      expect(tool.state.metadata?.background).toBe(true)
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      // Cancelling the parent also cancels its running background task.
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  5_000,
)

it.instance(
  "cancelForeground interrupts the loop but leaves background subagents running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const background = yield* BackgroundJob.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      // Wait until the background subagent has been dispatched and is running.
      const job = yield* pollWithTimeout(
        Effect.gen(function* () {
          const jobs = yield* background.list()
          return jobs.find(
            (item) => item.type === "task" && item.status === "running" && item.metadata?.parentSessionId === chat.id,
          )
        }),
        "timed out waiting for background subagent dispatch",
      )
      expect(job.metadata?.parentSessionId).toBe(chat.id)

      // Foreground-only interrupt: the parent loop stops, the subagent keeps
      // running.
      yield* prompt.cancelForeground(chat.id)
      yield* Fiber.await(fiber)

      const afterForeground = yield* background.list()
      expect(
        afterForeground.some(
          (item) => item.type === "task" && item.status === "running" && item.metadata?.parentSessionId === chat.id,
        ),
      ).toBe(true)

      // Background-only interrupt: the subagent stops without touching the
      // already-idle foreground.
      yield* prompt.cancelBackground(chat.id)
      const afterBackground = yield* background.list()
      expect(
        afterBackground.some(
          (item) => item.type === "task" && item.status === "running" && item.metadata?.parentSessionId === chat.id,
        ),
      ).toBe(false)
    }),
  10_000,
)

it.instance(
  "running task tool preserves metadata when dispatched in the background",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      // A task tool call without `background` is dispatched asynchronously:
      // the tool part is completed immediately with background metadata while
      // the parent continues with its next turn.
      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const parts = msgs
            .filter((item) => item.info.role === "assistant")
            .flatMap((item) =>
              item.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task"),
            )
          return parts.find(
            (part): part is CompletedToolPart =>
              part.state.status === "completed" &&
              part.state.metadata?.background === true &&
              part.state.metadata?.sessionId,
          )
        }),
        "timed out waiting for background task metadata",
      )

      expect(tool.state.metadata?.background).toBe(true)
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000,
)

it.instance(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  3_000,
)

// Cancel semantics

it.instance("cancel interrupts loop and resolves with an assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* seed(chat.id)

    yield* llm.hang

    yield* user(chat.id, "more")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
    }
  }),
)

it.instance("cancel records MessageAbortedError on interrupted process", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hello")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const info = exit.value.info
      if (info.role === "assistant") {
        expect(info.error?.name).toBe("MessageAbortedError")
      }
    }
  }),
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { config: cfg },
  3_000,
)

noLLMServer.instance(
  "cancel finalizes subtask tool state",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const original = task.execute
      task.execute = (_args, ctx) =>
        Effect.callback<never>((_resume) => {
          ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
          if (ctx.abort.aborted) succeedVoid(aborted)
          succeedVoid(ready)
          return Effect.sync(() => succeedVoid(aborted))
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const { prompt, chat } = yield* boot()
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for task tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* awaitWithTimeout(Deferred.await(aborted), "timed out waiting for task tool abort", "10 seconds")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = toolPart(taskMsg.parts)
      expect(tool?.type).toBe("tool")
      if (!tool) return

      expect(tool.state.status).not.toBe("running")
      expect(taskMsg.info.time.completed).toBeDefined()
      expect(taskMsg.info.finish).toBeDefined()
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "cancel propagates from slash command subtask to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg?.parts.find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.state.status === "completed" && part.state.metadata?.background === true,
      )
      const sessionID = tool?.state.metadata?.sessionId
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  10_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  10_000,
)

// Queue semantics

noLLMServer.instance(
  "concurrent loop callers get same result",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      yield* seed(chat.id, { finish: "stop" })

      const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
        concurrency: "unbounded",
      })

      expect(a.info.id).toBe(b.info.id)
      expect(a.info.role).toBe("assistant")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

it.instance("concurrent loop callers all receive same error result", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    // A non-retryable HTTP error: the loop surfaces it immediately instead of
    // entering the retry backoff a mid-stream failure now takes.
    yield* llm.error(400, { error: { message: "boom" } })
    yield* user(chat.id, "hello")

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })
    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
  }),
)

it.instance("prompt submitted during an active run is included in the next LLM input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.push(reply().wait(deferredAsPromise(gate)).tool("first", { value: "first" }))
    yield* llm.text("second")

    const a = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "work",
        model: ref,
        parts: [{ type: "text", text: "first" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const id = MessageID.ascending()
    const b = yield* prompt
      .prompt({
        sessionID: chat.id,
        messageID: id,
        agent: "work",
        model: ref,
        parts: [{ type: "text", text: "second" }],
      })
      .pipe(Effect.forkChild)

    yield* pollWithTimeout(
      sessions
        .messages({ sessionID: chat.id })
        .pipe(
          Effect.map((msgs) => (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined)),
        ),
      "timed out waiting for second prompt to save",
    )

    yield* Deferred.succeed(gate, void 0)

    const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
    expect(Exit.isSuccess(ea)).toBe(true)
    expect(Exit.isSuccess(eb)).toBe(true)
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const assistants = msgs.filter((msg) => msg.info.role === "assistant")
    expect(assistants).toHaveLength(2)
    const last = assistants.at(-1)
    if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
    expect(last.info.parentID).toBe(id)
    expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    const messages = inputs.at(-1)?.messages
    if (!Array.isArray(messages)) throw new Error("expected LLM messages")
    expect(messages.at(-1)).toEqual({ role: "user", content: "second" })
  }),
)

// A second/third model so mid-task switches are observable on the request
// stream; `high` variants exercise thinking-effort switches.
const switchModel = (id: string, name: string) => ({
  id,
  name,
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  release_date: "2025-01-01",
  limit: { context: 100000, output: 10000 },
  cost: { input: 0, output: 0 },
  options: {},
  variants: { high: { reasoningEffort: "high" } },
})

function switchProviderCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        models: {
          ...cfg.provider.test.models,
          "test-model": { ...cfg.provider.test.models["test-model"], variants: { high: { reasoningEffort: "high" } } },
          "test-model-b": switchModel("test-model-b", "Test Model B"),
          "test-model-c": switchModel("test-model-c", "Test Model C"),
        },
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const modelB = { providerID: ref.providerID, modelID: ModelV2.ID.make("test-model-b") }
const modelC = { providerID: ref.providerID, modelID: ModelV2.ID.make("test-model-c") }

// Title generation issues its own request; filter it out so request
// assertions only cover the agent turns under test.
const turnInputs = (inputs: Record<string, unknown>[]) =>
  inputs.filter((body) => !JSON.stringify(body).includes("Generate a title for this conversation"))

it.instance(
  "model change during a running task applies at the next agent turn",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(switchProviderCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        title: "Switch",
      })

      yield* llm.push(reply().wait(deferredAsPromise(gate)).tool("first", { value: "first" }))
      yield* llm.text("second")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      // Turn one is still streaming; the selection changes mid-task.
      yield* sessions.setAgentModel({
        sessionID: chat.id,
        agent: "work",
        model: { providerID: modelB.providerID, id: modelB.modelID, variant: "default" },
        time: Date.now(),
      })

      yield* Deferred.succeed(gate, void 0)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs).toHaveLength(2)
      expect(inputs[0]?.model).toBe("test-model")
      expect(inputs[1]?.model).toBe("test-model-b")

      const assistants = (yield* sessions.messages({ sessionID: chat.id })).filter(
        (msg) => msg.info.role === "assistant",
      )
      expect(assistants).toHaveLength(2)
      const first = assistants[0]?.info
      const second = assistants[1]?.info
      if (first?.role !== "assistant" || second?.role !== "assistant") throw new Error("expected assistant messages")
      expect(first.modelID).toBe(ModelV2.ID.make("test-model"))
      expect(second.modelID).toBe(ModelV2.ID.make("test-model-b"))
      expect(second.providerID).toBe(ref.providerID)
    }),
  15_000,
)

it.instance(
  "thinking effort change during a running task applies at the next agent turn",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(switchProviderCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        title: "Effort",
      })

      yield* llm.push(reply().wait(deferredAsPromise(gate)).tool("first", { value: "first" }))
      yield* llm.text("second")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      yield* sessions.setAgentModel({
        sessionID: chat.id,
        agent: "work",
        model: { providerID: ref.providerID, id: ref.modelID, variant: "high" },
        time: Date.now(),
      })

      yield* Deferred.succeed(gate, void 0)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs).toHaveLength(2)
      // Same model for both turns; only the effort changed.
      expect(inputs[0]?.model).toBe("test-model")
      expect(inputs[1]?.model).toBe("test-model")

      const assistants = (yield* sessions.messages({ sessionID: chat.id })).filter(
        (msg) => msg.info.role === "assistant",
      )
      expect(assistants).toHaveLength(2)
      const first = assistants[0]?.info
      const second = assistants[1]?.info
      if (first?.role !== "assistant" || second?.role !== "assistant") throw new Error("expected assistant messages")
      expect(first.variant).toBeUndefined()
      expect(second.variant).toBe("high")
      expect(second.modelID).toBe(ModelV2.ID.make("test-model"))
    }),
  15_000,
)

it.instance(
  "model and effort changed together give the next turn one consistent snapshot",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(switchProviderCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        title: "Both",
      })

      yield* llm.push(reply().wait(deferredAsPromise(gate)).tool("first", { value: "first" }))
      yield* llm.text("second")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      yield* sessions.setAgentModel({
        sessionID: chat.id,
        agent: "work",
        model: { providerID: modelB.providerID, id: modelB.modelID, variant: "high" },
        time: Date.now(),
      })

      yield* Deferred.succeed(gate, void 0)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs).toHaveLength(2)
      expect(inputs[0]?.model).toBe("test-model")
      expect(inputs[1]?.model).toBe("test-model-b")

      const assistants = (yield* sessions.messages({ sessionID: chat.id })).filter(
        (msg) => msg.info.role === "assistant",
      )
      const second = assistants[1]?.info
      if (second?.role !== "assistant") throw new Error("expected second assistant message")
      // The new model and new effort arrive on the same turn, not split
      // across turns.
      expect(second.modelID).toBe(ModelV2.ID.make("test-model-b"))
      expect(second.variant).toBe("high")
    }),
  15_000,
)

it.instance(
  "rapid mid-task changes apply only the latest selection",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(switchProviderCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        title: "Rapid",
      })

      yield* llm.push(reply().wait(deferredAsPromise(gate)).tool("first", { value: "first" }))
      yield* llm.text("second")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      yield* sessions.setAgentModel({
        sessionID: chat.id,
        agent: "work",
        model: { providerID: modelB.providerID, id: modelB.modelID, variant: "default" },
        time: Date.now(),
      })
      yield* sessions.setAgentModel({
        sessionID: chat.id,
        agent: "work",
        model: { providerID: modelC.providerID, id: modelC.modelID, variant: "default" },
        time: Date.now(),
      })

      yield* Deferred.succeed(gate, void 0)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs).toHaveLength(2)
      expect(inputs[0]?.model).toBe("test-model")
      // The intermediate selection is never replayed.
      expect(inputs[1]?.model).toBe("test-model-c")
    }),
  15_000,
)

it.instance(
  "turns keep the original configuration when no mid-task change happens",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(switchProviderCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Unchanged",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* llm.tool("first", { value: "first" })
      yield* llm.text("second")

      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "work",
        model: ref,
        parts: [{ type: "text", text: "hello" }],
      })
      expect(result.info.role).toBe("assistant")

      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs).toHaveLength(2)
      expect(inputs[0]?.model).toBe("test-model")
      expect(inputs[1]?.model).toBe("test-model")

      const session = yield* sessions.get(chat.id)
      expect(session.model).toEqual({ id: ref.modelID, providerID: ref.providerID, variant: "default" })
    }),
  15_000,
)

it.instance(
  "mid-task model change does not leak into another session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(switchProviderCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const one = yield* sessions.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        title: "One",
      })
      const two = yield* sessions.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        title: "Two",
      })

      yield* llm.push(reply().wait(deferredAsPromise(gate)).tool("first", { value: "first" }))
      yield* llm.text("second")
      yield* llm.text("other session")

      const fiber = yield* prompt
        .prompt({
          sessionID: one.id,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)
      yield* waitForBusy(one.id)

      yield* sessions.setAgentModel({
        sessionID: one.id,
        agent: "work",
        model: { providerID: modelB.providerID, id: modelB.modelID, variant: "default" },
        time: Date.now(),
      })

      yield* Deferred.succeed(gate, void 0)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      // Session two was never updated and still runs on its own selection.
      const other = yield* sessions.get(two.id)
      expect(other.model).toBeUndefined()

      yield* prompt.prompt({
        sessionID: two.id,
        agent: "work",
        model: ref,
        parts: [{ type: "text", text: "hello" }],
      })

      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs).toHaveLength(3)
      expect(inputs[0]?.model).toBe("test-model")
      expect(inputs[1]?.model).toBe("test-model-b")
      expect(inputs[2]?.model).toBe("test-model")
    }),
  15_000,
)

it.instance(
  "concurrently running sessions keep independent selections",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(switchProviderCfg)
      const gateA = yield* Deferred.make<void>()
      const gateB = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const one = yield* sessions.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        title: "Concurrent One",
      })
      const two = yield* sessions.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        title: "Concurrent Two",
      })

      yield* llm.push(reply().wait(deferredAsPromise(gateA)).tool("first", { value: "first" }))
      yield* llm.push(reply().wait(deferredAsPromise(gateB)).tool("first", { value: "first" }))
      yield* llm.text("a second")
      yield* llm.text("b second")

      const fiberA = yield* prompt
        .prompt({
          sessionID: one.id,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "a first" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)

      const fiberB = yield* prompt
        .prompt({
          sessionID: two.id,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "b first" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(2)
      yield* waitForBusy(one.id)
      yield* waitForBusy(two.id)

      // Only session one's selection changes, while both tasks are mid-turn.
      yield* sessions.setAgentModel({
        sessionID: one.id,
        agent: "work",
        model: { providerID: modelB.providerID, id: modelB.modelID, variant: "default" },
        time: Date.now(),
      })

      yield* Deferred.succeed(gateA, void 0)
      const exitA = yield* Fiber.await(fiberA)
      expect(Exit.isSuccess(exitA)).toBe(true)

      yield* Deferred.succeed(gateB, void 0)
      const exitB = yield* Fiber.await(fiberB)
      expect(Exit.isSuccess(exitB)).toBe(true)

      // Requests arrive as: A turn1, B turn1, A turn2, B turn2.
      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs).toHaveLength(4)
      expect(inputs[0]?.model).toBe("test-model")
      expect(inputs[1]?.model).toBe("test-model")
      expect(inputs[2]?.model).toBe("test-model-b")
      expect(inputs[3]?.model).toBe("test-model")

      const other = yield* sessions.get(two.id)
      expect(other.model).toEqual({ id: ref.modelID, providerID: ref.providerID, variant: "default" })
    }),
  15_000,
)

it.instance(
  "stored selection recorded for another agent does not apply to the running task",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(switchProviderCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        title: "Agent scope",
      })

      yield* llm.push(reply().wait(deferredAsPromise(gate)).tool("first", { value: "first" }))
      yield* llm.text("second")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      // The selection is recorded for a different agent than the one running
      // the task; the task must keep its own configuration.
      yield* sessions.setAgentModel({
        sessionID: chat.id,
        agent: "plan",
        model: { providerID: modelB.providerID, id: modelB.modelID, variant: "default" },
        time: Date.now(),
      })

      yield* Deferred.succeed(gate, void 0)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs).toHaveLength(2)
      expect(inputs[0]?.model).toBe("test-model")
      expect(inputs[1]?.model).toBe("test-model")
    }),
  15_000,
)

it.instance(
  "compaction triggered after a mid-task switch uses the new selection",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(switchProviderCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        title: "Compact",
      })

      // A tool-calls finish keeps the loop iterating, so the next iteration
      // reaches the overflow check and schedules compaction.
      yield* llm.push(
        reply().wait(deferredAsPromise(gate)).tool("first", { value: "first" }).usage({ input: 200_000, output: 100 }),
      )
      yield* llm.hang

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      yield* sessions.setAgentModel({
        sessionID: chat.id,
        agent: "work",
        model: { providerID: modelB.providerID, id: modelB.modelID, variant: "default" },
        time: Date.now(),
      })

      yield* Deferred.succeed(gate, void 0)

      // The overflowed turn schedules compaction with the turn's selection.
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((msgs) =>
              msgs.some((msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction"))
                ? (true as const)
                : undefined,
            ),
          ),
        "timed out waiting for the compaction turn",
        "10 seconds",
      )
      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const compaction = msgs.find(
        (msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction"),
      )
      if (!compaction || compaction.info.role !== "user") throw new Error("expected compaction user message")
      expect(compaction.info.model).toEqual({ providerID: modelB.providerID, modelID: modelB.modelID })

      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

function subtaskSwitchCfg(url: string) {
  const base = switchProviderCfg(url)
  return {
    ...base,
    agent: {
      ...base.agent,
      // The subagent's configured model is missing, so the background child
      // fails fast without consuming responses queued for the parent loop.
      general: { model: "test/missing-model", finishTool: false },
    },
  }
}

it.instance(
  "subtask turns receive the mid-task selection snapshot",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(subtaskSwitchCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        title: "Subtask",
      })

      yield* llm.push(reply().wait(deferredAsPromise(gate)).tool("first", { value: "first" }))
      yield* llm.text("done")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      // Both the selection change and a follow-up subtask instruction land
      // while turn one is still streaming, so the subtask turn must start from
      // the same snapshot as the next agent turn.
      yield* sessions.setAgentModel({
        sessionID: chat.id,
        agent: "work",
        model: { providerID: modelB.providerID, id: modelB.modelID, variant: "high" },
        time: Date.now(),
      })
      const followup = yield* user(chat.id, "and look into the cache key path")
      yield* addSubtask(chat.id, followup.id)

      yield* Deferred.succeed(gate, void 0)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const subtaskMsg = msgs.find((msg) => msg.info.role === "assistant" && msg.info.agent === "general")
      if (!subtaskMsg || subtaskMsg.info.role !== "assistant") throw new Error("expected subtask assistant message")
      // The subtask keeps its own model but receives the snapshot's effort.
      expect(subtaskMsg.info.modelID).toBe(ref.modelID)
      expect(subtaskMsg.info.variant).toBe("high")

      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs[0]?.model).toBe("test-model")
      expect(inputs.some((input) => input.model === "test-model-b")).toBe(true)
    }),
  15_000,
)

it.instance("assertNotBusy fails with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service
    yield* llm.hang

    const chat = yield* sessions.create({})
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics

it.instance("shell rejects with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* prompt.shell({ sessionID: chat.id, agent: "work", command: "echo hi" }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "work",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "work",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "work",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "work",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    ),
  { config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "work",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "work",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "work", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell returns promptly when a command leaves a detached child holding stdio open",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const pidFile = path.join(
          Global.Path.data,
          `bang-detached-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`,
        )
        const squote = (text: string) => `'${text}'`
        const bin = `"${process.execPath.replaceAll("\\", "/")}"`
        // Spawn a long-lived detached child that inherits stdio (keeps the
        // shell's stdout pipe open), print, then exit immediately.
        const code =
          'const cp=require("node:child_process");const fs=require("node:fs");' +
          'const d=cp.spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{detached:true,stdio:"inherit"});' +
          "d.unref();fs.writeFileSync(Bun.argv[1],String(d.pid));process.stdout.write(\"STARTED\");process.exit(0)"
        const command = `${bin} -e ${squote(code)} ${squote(pidFile)}`

        const start = Date.now()
        const result = yield* prompt.shell({ sessionID: chat.id, agent: "work", command })
        const elapsed = Date.now() - start

        // Reap the detached daemon so the pipe closes and it does not leak.
        const pid = yield* pollWithTimeout(
          Effect.promise(async () => {
            try {
              const value = await readFile(pidFile, "utf-8")
              return value ? Number(value) : false
            } catch {
              return false
            }
          }),
          "timed out waiting for the detached child pid file",
        )
        yield* Effect.sync(() => {
          try {
            process.kill(Number(pid), "SIGKILL")
          } catch {}
        })

        const text = result.parts
          .map((part) => (part.type === "tool" && part.state.status === "completed" ? part.state.output : ""))
          .join("")
        expect(text).toContain("STARTED")
        // Returned after a bounded post-exit idle window, not by waiting on the
        // daemon's inherited pipe (60s).
        expect(elapsed).toBeLessThan(20_000)
      }),
    ),
  { config: cfg },
  40_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "work", command: "sleep 0.2" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

it.instance(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "work", command: "sleep 0.2" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

itMcpPrompt.instance(
  "executes an MCP command from the command list through the session command path, resolving the prompt lazily",
  () =>
    Effect.gen(function* () {
      mcpPromptCalls.length = 0
      const { llm } = yield* useServerConfig(providerCfg)
      const { prompt, chat } = yield* boot()
      const command = yield* Command.Service

      // The TUI launcher lists commands from the command endpoint; the MCP
      // command is listed without resolving its (lazy) prompt template.
      const listed = (yield* command.list()).find((c) => c.name === "probe-mcp:review")
      expect(listed).toBeDefined()
      expect(listed?.description).toBe("Review changes via MCP")
      expect(mcpPromptCalls).toHaveLength(0)

      // The TUI executes the selection via POST /session/:id/command...
      yield* llm.text("done")
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "probe-mcp:review",
        arguments: "",
      })
      expect(result.info.role).toBe("assistant")

      // ...which resolved the MCP prompt exactly once, at execution...
      expect(mcpPromptCalls).toEqual(["probe-mcp/review"])
      // ...and the expanded prompt reached the model.
      const inputs = yield* llm.inputs
      expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("MCP review output for review")
    }),
  undefined,
  30_000,
)

itMcpPromptUnavailable.instance(
  "keeps an MCP command listed when its prompt is unavailable and degrades execution to the arguments",
  () =>
    Effect.gen(function* () {
      mcpPromptCalls.length = 0
      const { llm } = yield* useServerConfig(providerCfg)
      const { prompt, chat } = yield* boot()
      const command = yield* Command.Service

      // The command still appears in the launcher view despite the prompt
      // being unavailable.
      expect((yield* command.list()).find((c) => c.name === "probe-mcp:review")).toBeDefined()
      expect(mcpPromptCalls).toHaveLength(0)

      yield* llm.text("done")
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "probe-mcp:review",
        arguments: "fix the flaky build",
      })
      expect(result.info.role).toBe("assistant")

      // Execution attempted the prompt...
      expect(mcpPromptCalls).toEqual(["probe-mcp/review"])
      // ...and, with the prompt unavailable (legacy MCP error-swallowing
      // semantics), the user's arguments become the prompt instead of a
      // silent empty command.
      const inputs = yield* llm.inputs
      expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("fix the flaky build")
      expect(JSON.stringify(inputs.at(-1)?.messages)).not.toContain("MCP review output")
    }),
  undefined,
  30_000,
)

unixNoLLMServer(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".shell-ready")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "work", command: ": > '.shell-ready'; sleep 30" })
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          afs.existsSafe(ready).pipe(Effect.map((exists) => (exists ? (true as const) : undefined))),
          "shell never created readiness marker",
        )

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "work",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted bash truncation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })

      yield* llm.tool("bash", {
        command:
          'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; printf truncation-ready; sleep 30',
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant")
          const tool = assistant ? toolPart(assistant.parts) : undefined
          if (tool?.state.status === "running" && tool.state.metadata?.output.includes("truncation-ready")) return true
        }),
        "timed out waiting for truncated shell output",
      )
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) return

      const tool = completedTool(exit.value.parts)
      if (!tool) return

      expect(tool.state.metadata.truncated).toBe(true)
      expect(typeof tool.state.metadata.outputPath).toBe("string")
      expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
      expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
      expect(tool.state.output).not.toContain("Tool execution aborted")
    }),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "work", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain("User aborted the command")
      }

      yield* Fiber.await(sh)
    }),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt.shell({ sessionID: chat.id, agent: "work", command: "sleep 30" }).pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "work", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "work",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "work",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/opencode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "work",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance("records aborted errors when prompt is cancelled mid-stream", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt cancel regression" })

    yield* llm.hang

    const fiber = yield* prompt
      .prompt({
        sessionID: session.id,
        agent: "work",
        parts: [{ type: "text", text: "Cancel me" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(session.id)
    yield* prompt.cancel(session.id)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
      if (exit.value.info.role === "assistant") {
        expect(exit.value.info.error?.name).toBe("MessageAbortedError")
      }
    }

    const msgs = yield* sessions.messages({ sessionID: session.id })
    const last = msgs.findLast((msg) => msg.info.role === "assistant")
    expect(last?.info.role).toBe("assistant")
    if (last?.info.role === "assistant") {
      expect(last.info.error?.name).toBe("MessageAbortedError")
    }
  }),
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        model: { providerID: ProviderV2.ID.make("opencode"), modelID: ModelV2.ID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "work",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("work")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)

// ESC recovery (issue #292): an interrupted turn stays in history, and the next
// prompt in the same session starts a fresh run.

const expectFreshRun = Effect.fn("test.expectFreshRun")(function* (
  chatID: SessionID,
  result: SessionV1.WithParts,
  interruptedIDs: MessageID[],
) {
  expect(result.info.role).toBe("assistant")
  if (result.info.role !== "assistant") return
  expect(result.info.error).toBeUndefined()
  expect(result.info.finish).toBe("stop")
  expect(interruptedIDs).not.toContain(result.info.id)
  expect(result.parts.some((p) => p.type === "text" && p.text === "fresh")).toBe(true)
  const status = yield* SessionStatus.Service
  expect((yield* status.get(chatID)).type).toBe("idle")
  const msgs = yield* MessageV2.filterCompactedEffect(chatID)
  const aborted = msgs.filter((m) => m.info.role === "assistant" && m.info.error?.name === "MessageAbortedError")
  expect(aborted.map((m) => m.info.id)).toEqual(interruptedIDs)
})

const abortedIDs = (chatID: SessionID) =>
  Effect.gen(function* () {
    const msgs = yield* MessageV2.filterCompactedEffect(chatID)
    return msgs
      .filter((m) => m.info.role === "assistant" && m.info.error?.name === "MessageAbortedError")
      .map((m) => m.info.id)
  })

it.instance(
  "prompt after cancel during streaming starts a fresh run and keeps the interrupted entry",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "first")
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForBusy(chat.id)
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(first)
      const interrupted = yield* abortedIDs(chat.id)
      expect(interrupted).toHaveLength(1)

      yield* llm.text("fresh")
      yield* user(chat.id, "second")
      const result = yield* prompt.loop({ sessionID: chat.id })
      yield* expectFreshRun(chat.id, result, interrupted)
      expect(yield* llm.hits).toHaveLength(2)
    }),
  10_000,
)

it.instance(
  "repeated cancel and prompt cycles never poison the next run",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      for (let i = 0; i < 3; i++) {
        yield* llm.hang
        yield* user(chat.id, `prompt ${i}`)
        const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(i + 1)
        yield* waitForBusy(chat.id)
        // A second ESC while the first is still being handled is a no-op.
        yield* prompt.cancel(chat.id)
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(run)
        expect(yield* abortedIDs(chat.id)).toHaveLength(i + 1)
      }
      const interrupted = yield* abortedIDs(chat.id)
      yield* llm.text("fresh")
      yield* user(chat.id, "final")
      const result = yield* prompt.loop({ sessionID: chat.id })
      yield* expectFreshRun(chat.id, result, interrupted)
    }),
  15_000,
)

it.instance(
  "prompt after cancel during tool work starts a fresh run",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })
      yield* llm.tool("bash", { command: "sleep 30", timeout: 30_000, workdir: path.resolve(dir) })
      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant")
          const tool = assistant ? toolPart(assistant.parts) : undefined
          if (tool?.state.status === "running") return true
        }),
        "timed out waiting for the bash tool to run",
      )
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(run)
      const interrupted = yield* abortedIDs(chat.id)
      expect(interrupted.length).toBeLessThanOrEqual(1)

      yield* llm.text("fresh")
      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "work",
        parts: [{ type: "text", text: "again" }],
      })
      yield* expectFreshRun(chat.id, result, interrupted)
    }),
  { git: true },
  30_000,
)

it.instance(
  "queued prompts are released by cancel and the next prompt runs once",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "first")
      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* user(chat.id, "queued")
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)
      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      const interrupted = yield* abortedIDs(chat.id)
      expect(interrupted).toHaveLength(1)

      yield* llm.text("fresh")
      yield* user(chat.id, "after")
      const result = yield* prompt.loop({ sessionID: chat.id })
      yield* expectFreshRun(chat.id, result, interrupted)
      // One hung request plus exactly one fresh run: no duplicate loops.
      expect(yield* llm.hits).toHaveLength(2)
    }),
  10_000,
)

// Context reduction runs on the real request path: the model sees a projection, canonical history
// stays intact, and the projection is re-derived on every turn.
it.instance("loop sends a reduced context projection and keeps canonical history intact across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => {
      const base = providerCfg(url)
      return {
        ...base,
        provider: {
          ...base.provider,
          test: {
            ...base.provider.test,
            models: {
              "test-model": {
                ...base.provider.test.models["test-model"],
                limit: { context: 12000, output: 500 },
              },
            },
          },
        },
      }
    })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const big = (n: number) => `OUT${n}-` + "x".repeat(6000)
    for (let i = 0; i < 10; i++) {
      const seeded = yield* seed(chat.id, { finish: "stop" })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: seeded.assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: `call-${i}`,
        tool: "bash",
        state: {
          status: "completed",
          input: { command: `echo ${i}` },
          output: big(i),
          title: "bash",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      })
    }
    const canonical = () =>
      sessions.messages({ sessionID: chat.id }).pipe(
        Effect.map((msgs) =>
          msgs.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool" && p.state.status === "completed" ? [p.state.output] : []))),
        ),
      )
    const before = yield* canonical()
    expect(before).toHaveLength(10)

    const sizes: number[] = []
    for (const turn of ["one", "two"]) {
      yield* prompt.prompt({ sessionID: chat.id, agent: "work", noReply: true, parts: [{ type: "text", text: turn }] })
      yield* llm.text(`reply ${turn}`)
      yield* prompt.loop({ sessionID: chat.id })
      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs.length).toBeGreaterThan(0)
      const body = JSON.stringify(inputs.at(-1))
      sizes.push(body.length)
      // the oldest output is reduced in the request, the newest is kept in full
      expect(body).not.toContain(big(0))
      expect(body).toContain(big(9))
      expect(body.split("x".repeat(6000)).length - 1).toBeLessThan(10)
    }
    // canonical history still holds every full output after both turns
    const after = yield* canonical()
    expect(after).toEqual(before)
    // the request does not grow with the turn: the projection is re-derived, not accumulated
    expect(sizes[1]).toBeLessThan(sizes[0] + 2000)
  }),
)

it.instance(
  "retries a stream death after a completed tool step with the tool result riding the retry's history",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const target = path.join(dir, "side-effect.txt")
      // Step 1 completes normally with a tool call the SDK executes; the
      // step-2 stream then dies. Retrying THAT step is safe only because its
      // request carries the executed result - prove the result rides the
      // retry's history and the command never runs twice.
      yield* llm.tool("bash", { command: `printf 'once\\n' >> ${JSON.stringify(target)}` })
      yield* llm.cut()
      yield* llm.text("recovered after retry")
      yield* user(chat.id, "hello")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(yield* llm.calls).toBe(3)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.error).toBeUndefined()
      }
      const hits = yield* llm.hits
      expect(JSON.stringify(hits[2]?.body)).toContain("once")
      const fs = yield* FSUtil.Service
      expect((yield* fs.readFileStringSafe(target))?.trim()).toBe("once")
    }),
  { timeout: 30_000 },
)

it.instance(
  "does not retry a stream that dies with tool calls still pending",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const target = path.join(dir, "no-replay.txt")
      // The stream announces a tool call and then dies before the step
      // resolves. Whether or not the SDK already executed the call, a retry
      // would issue it again: the turn must end as a terminal interruption
      // instead, and the command must never run twice.
      yield* llm.push(reply().tool("bash", { command: `printf 'replay\\n' >> ${JSON.stringify(target)}` }).cut().item())
      yield* user(chat.id, "hello")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(yield* llm.calls).toBe(1)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.error).toBeDefined()
        expect(JSON.stringify(result.info.error)).toContain("not retried so tool side effects are not repeated")
      }
      const fs = yield* FSUtil.Service
      const content = (yield* fs.readFileStringSafe(target)) ?? ""
      expect(content.split("\n").filter((line) => line.trim() === "replay").length).toBeLessThanOrEqual(1)
    }),
  { timeout: 30_000 },
)

it.instance(
  "retries the turn when the response stream fails mid-generation",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      // First attempt dies with the in-band error frame a gateway emits when
      // its stream is cut; the retry must issue a fresh request and complete
      // the turn. A raw transport drop on a provider without a transport
      // guard ends as an unretried "unknown" finish instead (see the Zen
      // adapter's truncation guard).
      yield* llm.cut("reasoning stream timed out after 1m without new tokens")
      yield* llm.text("recovered after retry")
      yield* user(chat.id, "hello")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.error).toBeUndefined()
      }
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const texts = messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
      expect(texts.join("")).toContain("recovered after retry")
    }),
  { timeout: 30_000 },
)

it.instance(
  "does not retry a completed response whose provider omitted the finish reason",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      // A provider may complete a response without transmitting a finish
      // reason; the SDK surfaces that as an "unknown" finish. The usage
      // accounting still arrives with the completed response, so the turn
      // must end here - retrying would replay the completed work.
      yield* llm.push(reply().text("completed without finish metadata").usage({ input: 10, output: 5 }))
      yield* user(chat.id, "hello")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(yield* llm.calls).toBe(1)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.error).toBeUndefined()
      }
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const texts = messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
      expect(texts.join("")).toContain("completed without finish metadata")
    }),
  { timeout: 30_000 },
)

it.instance(
  "does not retry a completed response that carried neither finish reason nor usage",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      // The weakest legitimate completion a provider can send: content, then
      // a clean stream end with no finish reason and no usage accounting.
      // Nothing here proves interruption, so the turn must complete, not
      // retry - a retry would replay the completed work.
      yield* llm.push(reply().text("bare completion"))
      yield* user(chat.id, "hello")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(yield* llm.calls).toBe(1)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.error).toBeUndefined()
      }
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const texts = messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
      expect(texts.join("")).toContain("bare completion")
    }),
  { timeout: 30_000 },
)

it.instance("cancel while edit permission is pending removes the request and prevents a late write", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), permission: { "*": "allow", edit: "ask" }, permission_timeout: { enabled: false } }))
    const file = path.join(dir, "abort-locked.txt")
    yield* Effect.promise(() => Bun.write(file, "ORIGINAL_CONTENT\n"))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const permission = yield* Permission.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.push(reply().tool("read", { filePath: file }))
    yield* llm.push(reply().tool("edit", { filePath: file, oldString: "ORIGINAL_CONTENT", newString: "ABORTED_TURN_OVERWRITE" }))
    yield* user(chat.id, "read and edit")
    const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    const request = yield* pollWithTimeout(permission.list().pipe(Effect.map((items) => items.find((r) => r.sessionID === chat.id))), "edit permission did not arrive")
    yield* prompt.cancel(chat.id)
    yield* Fiber.await(first)
    const remaining = yield* permission.list()
    // Probe the stale UI reply even if it should now be rejected.
    yield* permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.ignore)
    yield* Effect.sleep("100 millis")
    expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("ORIGINAL_CONTENT\n")
    expect(remaining.some((r) => r.id === request.id)).toBe(false)
    // A fresh edit of the same path must acquire the prior turn's semaphore.
    yield* llm.push(reply().tool("edit", { filePath: file, oldString: "ORIGINAL_CONTENT", newString: "FRESH_TURN_WRITE" }))
    yield* llm.text("fresh done")
    yield* user(chat.id, "fresh edit")
    const fresh = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    const next = yield* pollWithTimeout(permission.list().pipe(Effect.map((items) => items.find((r) => r.sessionID === chat.id))), "fresh edit remained locked")
    yield* permission.reply({ requestID: next.id, reply: "once" })
    yield* Fiber.join(fresh).pipe(Effect.timeout("5 seconds"))
    expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("FRESH_TURN_WRITE\n")
  }), { timeout: 20000 })

it.instance("cancel while a question is pending removes it before a stale answer can complete the tool", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const questions = yield* Question.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.push(reply().tool("question", { questions: [{ question: "Continue?", header: "Choice", options: [{ label: "Yes", description: "Continue" }] }] }))
    yield* user(chat.id, "ask a question")
    const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    const request = yield* pollWithTimeout(questions.list().pipe(Effect.map((items) => items.find((r) => r.sessionID === chat.id))), "question did not arrive")
    yield* prompt.cancel(chat.id)
    yield* Fiber.await(first)
    expect((yield* questions.list()).some((r) => r.id === request.id)).toBe(false)
    const late = yield* questions.reply({ requestID: request.id, answers: [["Yes"]] }).pipe(Effect.exit)
    expect(Exit.isFailure(late)).toBe(true)
  }), { timeout: 20000 })

const itAbortMcp = testEffect(makeHttp({ mcpTools: { probe_lookup: mcpTool("lookup", "Look up a note") } }))
itAbortMcp.instance("cancel while an MCP permission is pending removes it before late approval", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), permission: { "*": "allow", probe_lookup: "ask" }, permission_timeout: { enabled: false }, tool_search: { enabled: false } }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const permissions = yield* Permission.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.push(reply().tool("probe_lookup", { query: "milk" }))
    yield* user(chat.id, "look up note")
    const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    const request = yield* pollWithTimeout(permissions.list().pipe(Effect.map((items) => items.find((r) => r.sessionID === chat.id))), "MCP permission did not arrive")
    yield* prompt.cancel(chat.id)
    yield* Fiber.await(first)
    expect((yield* permissions.list()).some((r) => r.id === request.id)).toBe(false)
    const late = yield* permissions.reply({ requestID: request.id, reply: "once" }).pipe(Effect.exit)
    expect(Exit.isFailure(late)).toBe(true)
  }), { timeout: 20000 })

it.instance("cancel while bash permission is pending cannot run the command on late approval", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), permission: { "*": "allow", bash: "ask" }, permission_timeout: { enabled: false } }))
    const file = path.join(dir, "aborted-command.txt")
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const permissions = yield* Permission.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.push(reply().tool("bash", { command: "echo SHOULD_NOT_RUN > aborted-command.txt", description: "write marker", workdir: dir }))
    yield* user(chat.id, "write marker")
    const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    const request = yield* pollWithTimeout(permissions.list().pipe(Effect.map((items) => items.find((r) => r.sessionID === chat.id))), "bash permission did not arrive")
    yield* prompt.cancel(chat.id)
    yield* Fiber.await(first)
    const late = yield* permissions.reply({ requestID: request.id, reply: "once" }).pipe(Effect.exit)
    expect(Exit.isFailure(late)).toBe(true)
    expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
  }), { timeout: 20000 })
it.instance("a child can finish on the next generation after writing its result envelope", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: { general: { finishTool: true } },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "Parent" })
    const child = yield* sessions.create({
      title: "Child", parentID: parent.id,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const plan = "Create the scene, place the camera, then validate the HTML."
    yield* llm.push(reply().text(`<silvercode-result>${plan}</silvercode-result>`).tool("glob", { pattern: "*" }))
    yield* llm.push(reply().tool("finish", { reason: "success", result: "Task completed" }).stop())
    const result = yield* prompt.prompt({
      sessionID: child.id, agent: "general", model: ref,
      parts: [{ type: "text", text: "Plan the scene, inspect file names, then finish." }],
    })
    expect(yield* llm.calls).toBe(2)
    expectCompletedFinish(result)
    const history = yield* sessions.messages({ sessionID: child.id })
    expect(history.some((message) => message.info.id !== result.info.id && message.parts.some(
      (part) => part.type === "text" && part.text.includes(plan),
    ))).toBe(true)
    expectNoFinishNudge(history)
  }),
)
