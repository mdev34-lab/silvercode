import { ToolCatalog } from "@/tool/catalog"
import { applyPartDelta, applyPartUpdated } from "../../../tui/src/util/part"
import type { Part } from "@opencode-ai/sdk/v2"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Schema } from "effect"
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
import { httpError, raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { RepetitionGuard } from "../../src/session/llm/repetition-guard"
import {
  continuesPrompt,
  finishContinuationPromptID,
  resultChunks,
  textResult,
} from "../../src/session/subagent-result"
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
  ToolCatalog.node,
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
const FINISH_NUDGE_MARKER = "[WARNING] The turn ended without a successful finish call."

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
      expect(body).toContain("Think planning, then Code implementation, then a clean Review")
      expect(body).toContain("Prefer that route for programming")
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
      parts: [{ type: "text", text: "Generate the report again" }],
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
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID,
        sessionID: session.id,
        type: "text",
        text: "Save this attachment",
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

it.instance(
  "three identical calls in one assistant message reach the denied doom-loop permission",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        permission: { "*": "allow", doom_loop: "deny" },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const agents = yield* AgentSvc.Service
      const agent = yield* agents.get("build")
      expect(Permission.evaluate("doom_loop", "bash", agent.permission).action).toBe("deny")
      const session = yield* sessions.create({ title: "Doom-loop positive control" })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run the same harmless command three times" }],
      })

      const input = { command: "echo SHOULD_NOT_RUN", description: "doom-loop positive control", workdir: dir }
      // One provider response creates one assistant message with three real tool parts.
      // A separate llm.tool() reply for each call would not exercise the per-message guard.
      yield* llm.push(reply().tool("bash", input).tool("bash", input).tool("bash", input))
      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") throw new Error("expected an assistant result")
      // The guard's denied ask interrupts this model step after tool calls were issued.
      // That is the observable runtime signal (as opposed to an inferred structural window).
      expect(result.info.error).toBeDefined()
      expect(JSON.stringify(result.info.error)).toContain("ProviderStreamInterruptedAfterToolCallError")

      const messages = yield* sessions.messages({ sessionID: session.id })
      const repeated = messages
        .filter((message) => message.info.role === "assistant")
        .map((message) => message.parts.filter((part) => part.type === "tool" && part.tool === "bash"))
        .filter((parts) => parts.length === 3)
      expect(repeated).toHaveLength(1)
      expect(repeated[0]?.map((part) => part.type === "tool" && part.state.input)).toEqual([input, input, input])
    }),
  20_000,
)

it.instance(
  "a truncated write retry completes without a doom-loop ask under deny policy",
  () =>
    Effect.gen(function* () {
      // Keep `doom_loop` denied so any guard request halts this turn; the successful result
      // below is the runtime no-ask assertion.
      const { dir, llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        permission: { "*": "allow", doom_loop: "deny" },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service

      const session = yield* sessions.create({
        title: "Truncated write",
        permission: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "doom_loop", pattern: "*", action: "deny" },
        ],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "write the report" }],
      })

      const target = path.join(dir, "report.md")
      const first = "# Report\n\nline one\n"
      const second = "line two\n"
      const full = first + second

      // Step 1: a write call whose arguments are cut off inside `content` - the path
      // arrived complete, the body never did.
      yield* llm.toolRaw("write", `{"filePath":${JSON.stringify(target)},"content":"# Report\\n\\nline one\\nline two`)
      // Step 2: the model follows the recovery instruction - inspect, write the first
      // chunk, then append the rest with edit. A second `write` would replace the first
      // chunk, so the scripted continuation must not use one.
      yield* llm.tool("bash", { command: `test -e ${target} && echo exists || echo missing` })
      yield* llm.tool("write", { filePath: target, content: first })
      yield* llm.tool("edit", { filePath: target, oldString: "line one\n", newString: "line one\n" + second })
      yield* llm.text("done")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") throw new Error("expected an assistant result")
      expect(result.info.error).toBeUndefined()

      const parts = (yield* sessions.messages({ sessionID: session.id })).flatMap((message) => message.parts)
      const executions = parts.filter(
        (part): part is SessionV1.ToolPart => part.type === "tool" && part.state.status !== "pending",
      )
      const executionsOf = (name: string) => executions.filter((part) => part.tool === name)
      const repaired = parts.find((part) => part.type === "tool" && part.tool === "invalid")
      expect(repaired?.type).toBe("tool")
      if (repaired?.type !== "tool" || repaired.state.status !== "completed")
        throw new Error("expected a completed repair")
      expect(repaired.state.input).toMatchObject({ tool: "write" })
      expect(repaired.state.output).toContain(target)
      expect(repaired.state.output).toContain("did not execute")
      expect(repaired.state.output).toContain("wrote nothing")
      expect(repaired.state.output).toContain("first chunk")
      expect(repaired.state.output).toContain("append")
      expect(repaired.state.output).toContain("edit calls")
      expect(repaired.state.output).toContain("write replaces the entire file")
      // the fragment's unfinished body is never presented as recovered content: the
      // only echo of the raw text is the provider/parser error inside the parenthetical
      const recovered = repaired.state.output.slice(
        repaired.state.output.indexOf("Recovered from the partial arguments:"),
      )
      expect(recovered).not.toContain("line two")
      expect(recovered).not.toContain("Report")

      // the guided retry actually executed, in the shape the guidance asks for: `write`
      // for the first chunk, then an `edit` append - never a second full `write`
      const writes = executionsOf("write")
      expect(writes).toHaveLength(1)
      expect(writes[0]?.state.status === "completed" && writes[0].state.input).toMatchObject({ content: first })
      expect(executionsOf("edit")).toHaveLength(1)
      expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe(full)

      // The deny rule is live for the entire recovery. Completion with no assistant error
      // is runtime evidence that the single truncated write and guided retry did not ask.
      expect(parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
    }),
  20_000,
)

it.instance(
  "a truncated write for an existing file keeps what earlier calls wrote",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        permission: { "*": "allow", doom_loop: "deny" },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service

      const target = path.join(dir, "notes.md")
      const existing = "# Notes\n\nexisting line one\nexisting line two\n"
      const chunkOne = "appended chunk one\n"
      const chunkTwo = "appended chunk two\n"
      // An earlier call in this session already produced this content; the guidance must
      // not assume the path is empty just because this call wrote nothing.
      const session = yield* sessions.create({
        title: "Truncated write over existing file",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "extend the notes" }],
      })

      // Earlier bytes are created by a real tool call in this same session.
      yield* llm.tool("write", { filePath: target, content: existing })
      // Step 1: the next write call is cut off inside `content`.
      yield* llm.toolRaw("write", `{"filePath":${JSON.stringify(target)},"content":"# Notes\\n\\nreplacement`)
      // Step 2: the model follows the guidance - inspect the existing file, then append
      // each remaining chunk with edit. It never re-writes, so nothing already on disk is
      // replaced by a partial payload.
      yield* llm.tool("bash", { command: `cat ${target}` })
      yield* llm.tool("edit", {
        filePath: target,
        oldString: "existing line two\n",
        newString: "existing line two\n" + chunkOne,
      })
      yield* llm.tool("edit", { filePath: target, oldString: chunkOne, newString: chunkOne + chunkTwo })
      yield* llm.text("done")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") throw new Error("expected an assistant result")
      expect(result.info.error).toBeUndefined()

      const parts = (yield* sessions.messages({ sessionID: session.id })).flatMap((message) => message.parts)
      const executions = parts.filter(
        (part): part is SessionV1.ToolPart => part.type === "tool" && part.state.status !== "pending",
      )
      const repaired = executions.find((part) => part.tool === "invalid")
      if (repaired?.state.status !== "completed") throw new Error("expected a completed repair")
      // the guidance names the existing-file branch instead of instructing a fresh write
      expect(repaired.state.output).toContain("do not start over with write")
      expect(repaired.state.output).toContain("would discard what is already there")

      // The only executed write is the earlier content; this failed write did not replace it.
      const writes = executions.filter((part) => part.tool === "write")
      expect(writes).toHaveLength(1)
      expect(writes[0]?.state.status === "completed" && writes[0].state.input).toMatchObject({ content: existing })
      expect(executions.filter((part) => part.tool === "edit")).toHaveLength(2)

      // every byte that was already there survives, and both chunks landed after it
      expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe(existing + chunkOne + chunkTwo)
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

it.instance("settling durable orphans preserves streamed text in a live consumer", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id, { finish: "tool-calls" })
    let parts: Part[] | undefined
    const off = yield* events.listen((event) => {
      if (event.type === MessageV2.Event.PartUpdated.type) {
        const data = event.data as typeof MessageV2.Event.PartUpdated.data.Type
        if (data.part.messageID === seeded.assistant.id) parts = applyPartUpdated(parts, data.part as Part)
      }
      if (event.type === MessageV2.Event.PartDelta.type) {
        const data = event.data as typeof MessageV2.Event.PartDelta.data.Type
        if (data.messageID === seeded.assistant.id) parts = applyPartDelta(parts, data.partID, data.field, data.delta)
      }
      return Effect.void
    })
    const cases = (["text", "reasoning"] as const).flatMap((type) =>
      ["", "streamed "].map((durable) => ({ type, durable, id: PartID.ascending() })),
    )
    for (const item of cases) {
      yield* sessions.updatePart({
        id: item.id,
        sessionID: chat.id,
        messageID: seeded.assistant.id,
        type: item.type,
        text: item.durable,
        time: { start: 1 },
        metadata: { source: "provider" },
      })
      yield* sessions.updatePartDelta({
        sessionID: chat.id,
        messageID: seeded.assistant.id,
        partID: item.id,
        field: "text",
        delta: item.durable ? item.type : `streamed ${item.type}`,
      })
    }
    const before = yield* sessions.messages({ sessionID: chat.id })
    const durable = before.find((msg) => msg.info.id === seeded.assistant.id)!
    expect(
      durable.parts
        .filter((part) => cases.some((item) => item.id === part.id))
        .map((part) => ("text" in part ? part.text : null)),
    ).toEqual(cases.map((item) => item.durable))
    const identities = parts!.slice()
    yield* llm.text("recovered")
    yield* prompt.loop({ sessionID: chat.id })
    yield* off
    const after = yield* sessions.messages({ sessionID: chat.id })
    const stored = after.find((msg) => msg.info.id === seeded.assistant.id)!
    // Exercise the public schema's JSON encoding and decoding, not just the DB row.
    const encoded = Schema.encodeSync(SessionV1.WithParts)(stored)
    const decoded = Schema.decodeUnknownSync(SessionV1.WithParts)(JSON.parse(JSON.stringify(encoded)))
    for (const [index, item] of cases.entries()) {
      const current = parts!.find((part) => part.id === item.id)!
      expect(current).toBe(identities[index])
      expect(current).toMatchObject({
        id: item.id,
        type: item.type,
        text: `streamed ${item.type}`,
        time: { start: 1, end: expect.any(Number) },
        recovery: "orphaned",
        metadata: { source: "provider" },
      })
      expect(decoded.parts.find((part) => part.id === item.id)).toMatchObject({
        text: item.durable,
        recovery: "orphaned",
        metadata: { source: "provider" },
        time: { start: 1, end: expect.any(Number) },
      })
    }
  }),
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
    const msg = yield* user(chat.id, "Research the requested information")
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
    const msg = yield* user(chat.id, "Research the requested information")
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
      const msg = yield* user(chat.id, "Research the requested information")
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
      const msg = yield* user(chat.id, "Research the requested information")
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
      yield* user(chat.id, "Research the requested information")

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
      const msg = yield* user(chat.id, "Research the requested information")
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
          'd.unref();fs.writeFileSync(Bun.argv[1],String(d.pid));process.stdout.write("STARTED");process.exit(0)'
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
        parts: [{ type: "text", text: "Generate a report using the shell" }],
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
        parts: [{ type: "text", text: "Generate a report using the shell" }],
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
        parts: [{ type: "text", text: "Generate the report again" }],
      })
      yield* expectFreshRun(chat.id, result, interrupted)
    }),
  { git: true },
  30_000,
)

it.instance(
  "a prompt queued behind a run is not restarted after cancel (F2)",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const a = yield* prompt
        .prompt({ sessionID: chat.id, agent: "work", model: ref, parts: [{ type: "text", text: "first" }] })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt
        .prompt({ sessionID: chat.id, agent: "work", model: ref, parts: [{ type: "text", text: "second" }] })
        .pipe(Effect.forkChild)
      yield* Effect.sleep(100)
      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      yield* Effect.sleep(300)
      // Cancel must not be followed by a fresh provider call for the queued prompt.
      expect(yield* llm.hits).toHaveLength(1)
    }),
  10_000,
)

it.instance(
  "several prompts queued behind a run are all released by cancel without a new run (F2)",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const send = (text: string) =>
        prompt.prompt({ sessionID: chat.id, agent: "work", model: ref, parts: [{ type: "text", text }] })
      const a = yield* send("first").pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* send("second").pipe(Effect.forkChild)
      const c = yield* send("third").pipe(Effect.forkChild)
      // Both queued prompts are persisted, so each has joined or is about to join the run.
      while ((yield* sessions.messages({ sessionID: chat.id })).filter((m) => m.info.role === "user").length < 3)
        yield* Effect.yieldNow
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow
      yield* prompt.cancel(chat.id)
      const exits = yield* Effect.all([Fiber.await(a), Fiber.await(b), Fiber.await(c)])
      for (const exit of exits) expect(Exit.isSuccess(exit)).toBe(true)
      yield* Effect.sleep(300)
      expect(yield* llm.hits).toHaveLength(1)
    }),
  10_000,
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

it.instance(
  "queued prompt cancelled as soon as its user message is persisted does not start a run after cancel",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.hang
      yield* llm.text("fresh")

      const a = yield* prompt
        .prompt({ sessionID: chat.id, agent: "work", model: ref, parts: [{ type: "text", text: "first" }] })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      const secondID = MessageID.ascending()
      const persisted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const off = yield* events.listen((event) => {
        if (event.type !== SessionV1.Event.MessageUpdated.type) return Effect.void
        if (typeof event.data !== "object" || event.data === null) return Effect.void
        const sessionID = "sessionID" in event.data ? event.data.sessionID : undefined
        const info = "info" in event.data && typeof event.data.info === "object" ? event.data.info : null
        const id = info && "id" in info ? info.id : undefined
        if (sessionID !== chat.id || id !== secondID) return Effect.void
        return Deferred.succeed(persisted, void 0).pipe(Effect.andThen(Deferred.await(release)))
      })
      yield* Effect.addFinalizer(() => off)

      const b = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: secondID,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "second" }],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(persisted), "timed out waiting for queued message to persist")
      yield* prompt.cancel(chat.id)
      yield* Deferred.succeed(release, void 0)

      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitB)) {
        expect(exitB.value.info.role).toBe("assistant")
        if (exitB.value.info.role === "assistant") {
          expect(exitB.value.info.error?.name).toBe("MessageAbortedError")
        }
      }
      // The queued prompt must not consume the pre-queued "fresh" reply after cancel.
      expect(yield* llm.hits).toHaveLength(1)

      const interrupted = yield* abortedIDs(chat.id)
      expect(interrupted).toHaveLength(2)

      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "work",
        model: ref,
        parts: [{ type: "text", text: "after" }],
      })
      yield* expectFreshRun(chat.id, result, interrupted)
      expect(yield* llm.hits).toHaveLength(2)
    }),
  10_000,
)

it.instance(
  "queued prompt cancelled while resolving a file part does not start a run after cancel",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const reading = yield* Deferred.make<void>()
      const releaseRead = yield* Deferred.make<void>()
      const original = read.execute.bind(read)
      read.execute = (args, ctx) =>
        Deferred.succeed(reading, void 0).pipe(
          Effect.andThen(Deferred.await(releaseRead)),
          Effect.andThen(original(args, ctx)),
        )
      yield* Effect.addFinalizer(() => Effect.sync(() => void (read.execute = original)))

      const noteFile = path.join(dir, "queued-note.txt")
      yield* writeText(noteFile, "queued context\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.hang
      yield* llm.text("fresh")

      const a = yield* prompt
        .prompt({ sessionID: chat.id, agent: "work", model: ref, parts: [{ type: "text", text: "first" }] })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      const b = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "work",
          model: ref,
          parts: [
            { type: "text", text: "second with file" },
            { type: "file", url: `file://${noteFile}`, filename: "queued-note.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(reading), "timed out waiting for queued file resolution")
      yield* prompt.cancel(chat.id)
      yield* Deferred.succeed(releaseRead, void 0)

      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)

      const interrupted = yield* abortedIDs(chat.id)
      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "work",
        model: ref,
        parts: [{ type: "text", text: "after" }],
      })
      yield* expectFreshRun(chat.id, result, interrupted)
      expect(yield* llm.hits).toHaveLength(2)
    }),
  10_000,
)

it.instance(
  "cancel on an idle session while a prompt or command is still preparing prevents a provider run",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        command: {
          slowcmd: {
            template: "Read @idle-note.txt",
          },
        },
      }))
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const reading = yield* Deferred.make<void>()
      const releaseRead = yield* Deferred.make<void>()
      const original = read.execute.bind(read)
      read.execute = (args, ctx) =>
        Deferred.succeed(reading, void 0).pipe(
          Effect.andThen(Deferred.await(releaseRead)),
          Effect.andThen(original(args, ctx)),
        )
      yield* Effect.addFinalizer(() => Effect.sync(() => void (read.execute = original)))

      const noteFile = path.join(dir, "idle-note.txt")
      yield* writeText(noteFile, "idle context\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      const executed: unknown[] = []
      const off = yield* events.listen((event) => {
        if (event.type === Command.Event.Executed.type) executed.push(event.data)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)
      yield* llm.text("fresh")

      const first = yield* prompt
        .command({
          sessionID: chat.id,
          command: "slowcmd",
          arguments: "",
          agent: "work",
          model: `${ref.providerID}/${ref.modelID}`,
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(reading), "timed out waiting for command file resolution")
      // No runner exists yet because ensureRunning has not been called.
      yield* prompt.cancel(chat.id)
      yield* Deferred.succeed(releaseRead, void 0)

      const exit = yield* Fiber.await(first)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(executed).toHaveLength(0)
      expect(yield* llm.hits).toHaveLength(0)
      const interrupted = yield* abortedIDs(chat.id)

      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "work",
        model: ref,
        parts: [{ type: "text", text: "after" }],
      })
      yield* expectFreshRun(chat.id, result, interrupted)
      expect(yield* llm.hits).toHaveLength(1)
    }),
  { git: true },
  10_000,
)

it.instance(
  "cancel during loop handoff after an errored run prevents a queued prompt from starting a fresh run",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      const gate = yield* Deferred.make<void>()
      yield* llm.push(reply().wait(deferredAsPromise(gate)).text("partial").contentFilter())
      yield* llm.text("fresh")

      const a = yield* prompt
        .prompt({ sessionID: chat.id, agent: "work", model: ref, parts: [{ type: "text", text: "first" }] })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      const secondID = MessageID.ascending()
      const b = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: secondID,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "second" }],
        })
        .pipe(Effect.forkChild)

      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(Effect.map((msgs) => (msgs.some((m) => m.info.id === secondID) ? (true as const) : undefined))),
        "timed out waiting for second prompt to persist",
      )

      // When run 1 finishes with a content-filter error, Runner.onIdle deletes
      // the runner and publishes Idle before the queued caller re-enters
      // ensureRunning. Cancelling in that handoff gap must still prevent a fresh run.
      let cancelledInGap = false
      const off = yield* events.listen((event) => {
        if (cancelledInGap || event.type !== SessionStatus.Event.Idle.type) return Effect.void
        if (typeof event.data !== "object" || event.data === null) return Effect.void
        const sessionID = "sessionID" in event.data ? event.data.sessionID : undefined
        if (sessionID !== chat.id) return Effect.void
        cancelledInGap = true
        return prompt.cancelForeground(chat.id)
      })
      yield* Effect.addFinalizer(() => off)

      yield* Deferred.succeed(gate, void 0)

      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      expect(cancelledInGap).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
    }),
  10_000,
)

it.instance(
  "queued prompt finishing preparation during an in-flight cancel waits for the interrupted assistant to settle",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const runFile = path.join(dir, "run.txt")
      const queuedFile = path.join(dir, "queued.txt")
      yield* writeText(runFile, "run\n")
      yield* writeText(queuedFile, "queued\n")

      const toolStarted = yield* Deferred.make<void>()
      const interruptingRun = yield* Deferred.make<void>()
      const releaseInterrupt = yield* Deferred.make<void>()
      const queuedReading = yield* Deferred.make<void>()
      const releaseQueuedRead = yield* Deferred.make<void>()
      const original = read.execute.bind(read)
      read.execute = (args, ctx) => {
        if (args.filePath.endsWith("run.txt")) {
          return Deferred.succeed(toolStarted, void 0).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Deferred.succeed(interruptingRun, void 0).pipe(Effect.andThen(Deferred.await(releaseInterrupt))),
            ),
          )
        }
        return Deferred.succeed(queuedReading, void 0).pipe(
          Effect.andThen(Deferred.await(releaseQueuedRead)),
          Effect.andThen(original(args, ctx)),
        )
      }
      yield* Effect.addFinalizer(() => Effect.sync(() => void (read.execute = original)))

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.tool("read", { filePath: runFile })
      yield* llm.text("unexpected")

      const a = yield* prompt
        .prompt({ sessionID: chat.id, agent: "work", model: ref, parts: [{ type: "text", text: "first" }] })
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(toolStarted), "timed out waiting for active tool call")

      const secondID = MessageID.ascending()
      const b = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: secondID,
          agent: "work",
          model: ref,
          parts: [
            { type: "text", text: "second" },
            { type: "file", url: `file://${queuedFile}`, filename: "queued.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(queuedReading), "timed out waiting for queued file read")

      // Fork cancel so Runner.cancel drops the runner to Idle and enters Fiber.interrupt
      // while the interrupted assistant has not settled yet.
      const cancelFiber = yield* prompt.cancel(chat.id).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(interruptingRun), "timed out waiting for run interruption")

      // Let the queued prompt finish createUserMessage and enter loop while cancel is still in flight.
      yield* Deferred.succeed(releaseQueuedRead, void 0)
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(Effect.map((msgs) => (msgs.some((m) => m.info.id === secondID) ? (true as const) : undefined))),
        "timed out waiting for queued message to persist during cancel",
      )
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow

      yield* Deferred.succeed(releaseInterrupt, void 0)

      const [exitCancel, exitA, exitB] = yield* Effect.all([Fiber.await(cancelFiber), Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitCancel)).toBe(true)
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitB)) {
        expect(exitB.value.info.role).toBe("assistant")
        if (exitB.value.info.role === "assistant") {
          expect(exitB.value.info.error?.name).toBe("MessageAbortedError")
          expect(exitB.value.info.time.completed).toBeDefined()
        }
      }
      expect(yield* llm.hits).toHaveLength(1)
    }),
  10_000,
)

it.instance(
  "awaitCancel stays pending while cancel is settling background jobs",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const state = yield* SessionRunState.Service
      const background = yield* BackgroundJob.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.hang
      const run = yield* prompt
        .prompt({ sessionID: chat.id, agent: "work", model: ref, parts: [{ type: "text", text: "first" }] })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      const interruptingBackground = yield* Deferred.make<void>()
      const releaseBackground = yield* Deferred.make<void>()
      yield* background.start({
        id: chat.id,
        type: "task",
        metadata: { sessionId: chat.id },
        run: Effect.never.pipe(
          Effect.onInterrupt(() =>
            Deferred.succeed(interruptingBackground, void 0).pipe(Effect.andThen(Deferred.await(releaseBackground))),
          ),
        ),
      })

      const cancelling = yield* prompt.cancel(chat.id).pipe(Effect.forkChild)
      yield* awaitWithTimeout(
        Deferred.await(interruptingBackground),
        "timed out waiting for background job interruption",
      )

      const settled = yield* Deferred.make<void>()
      const waiting = yield* state
        .awaitCancel(chat.id)
        .pipe(Effect.andThen(Deferred.succeed(settled, void 0)), Effect.forkChild)
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow
      const settledDuringBackgroundCancel = yield* Deferred.isDone(settled)

      yield* Deferred.succeed(releaseBackground, void 0)
      yield* Effect.all([Fiber.await(cancelling), Fiber.await(waiting), Fiber.await(run)])
      expect(settledDuringBackgroundCancel).toBe(false)
    }),
  10_000,
)

noLLMServer.instance("cancel settles when a background interrupt finalizer re-enters cancel", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* background.start({
      id: chat.id,
      type: "task",
      metadata: { sessionId: chat.id },
      run: Effect.never.pipe(Effect.onInterrupt(() => prompt.cancel(chat.id))),
    })

    yield* awaitWithTimeout(
      prompt.cancel(chat.id),
      "cancel deadlocked while a background interrupt finalizer re-entered cancel",
      "1 second",
    )
    expect((yield* background.get(chat.id))?.status).toBe("cancelled")
  }),
)

it.instance(
  "cancel during background teardown does not mark a replacement run idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const background = yield* BackgroundJob.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const interruptingBackground = yield* Deferred.make<void>()
      const releaseBackground = yield* Deferred.make<void>()

      yield* background.start({
        id: chat.id,
        type: "task",
        metadata: { sessionId: chat.id },
        run: Effect.never.pipe(
          Effect.onInterrupt(() =>
            Deferred.succeed(interruptingBackground, void 0).pipe(Effect.andThen(Deferred.await(releaseBackground))),
          ),
        ),
      })
      yield* llm.hang

      const cancelling = yield* prompt.cancel(chat.id).pipe(Effect.forkChild)
      yield* awaitWithTimeout(
        Deferred.await(interruptingBackground),
        "timed out waiting for background job interruption",
      )

      // The session was idle when cancel began. A prompt submitted after that
      // cancel must be allowed to become the replacement run while teardown is
      // still yielding.
      const replacement = yield* prompt
        .prompt({ sessionID: chat.id, agent: "work", model: ref, parts: [{ type: "text", text: "replacement" }] })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      yield* Deferred.succeed(releaseBackground, void 0)
      yield* Fiber.join(cancelling)
      const statusAfterCancel = (yield* status.get(chat.id)).type

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(replacement)
      expect(statusAfterCancel).toBe("busy")
    }),
  10_000,
)

it.instance(
  "prompt cancelled during preparation returns an aborted assistant for its own user message",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const reading = yield* Deferred.make<void>()
      const releaseRead = yield* Deferred.make<void>()
      const original = read.execute.bind(read)
      read.execute = (args, ctx) =>
        Deferred.succeed(reading, void 0).pipe(
          Effect.andThen(Deferred.await(releaseRead)),
          Effect.andThen(original(args, ctx)),
        )
      yield* Effect.addFinalizer(() => Effect.sync(() => void (read.execute = original)))

      const noteFile = path.join(dir, "cancelled-prompt.txt")
      yield* writeText(noteFile, "prompt context\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const seeded = yield* seed(chat.id, { finish: "stop" })
      yield* sessions.updateMessage({
        ...seeded.assistant,
        time: { ...seeded.assistant.time, completed: Date.now() },
      })
      yield* llm.text("unexpected")

      const messageID = MessageID.ascending()
      const pending = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID,
          agent: "work",
          model: ref,
          parts: [
            { type: "text", text: "cancel this prompt" },
            { type: "file", url: `file://${noteFile}`, filename: "cancelled-prompt.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(reading), "timed out waiting for prompt file resolution")
      yield* prompt.cancel(chat.id)
      yield* Deferred.succeed(releaseRead, void 0)
      const result = yield* Fiber.join(pending)

      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") throw new Error("expected an aborted assistant result")
      expect(result.info.parentID).toBe(messageID)
      expect(result.info.error?.name).toBe("MessageAbortedError")
      expect(result.info.time.completed).toBeDefined()
      expect(result.parts.some((part) => part.type === "text" && part.text === "hi there")).toBe(false)

      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const own = msgs.find((msg) => msg.info.role === "assistant" && msg.info.parentID === messageID)
      expect(own?.info.id).toBe(result.info.id)
      expect(own?.info.role === "assistant" && own.info.error?.name).toBe("MessageAbortedError")
      expect(yield* llm.hits).toHaveLength(0)
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
      sessions
        .messages({ sessionID: chat.id })
        .pipe(
          Effect.map((msgs) =>
            msgs.flatMap((m) =>
              m.parts.flatMap((p) => (p.type === "tool" && p.state.status === "completed" ? [p.state.output] : [])),
            ),
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
      yield* user(chat.id, "Research the requested information")

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
      yield* llm.push(
        reply()
          .tool("bash", { command: `printf 'replay\\n' >> ${JSON.stringify(target)}` })
          .cut()
          .item(),
      )
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

it.instance(
  "cancel while edit permission is pending removes the request and prevents a late write",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        permission: { "*": "allow", edit: "ask" },
        permission_timeout: { enabled: false },
      }))
      const file = path.join(dir, "abort-locked.txt")
      yield* Effect.promise(() => Bun.write(file, "ORIGINAL_CONTENT\n"))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.push(reply().tool("read", { filePath: file }))
      yield* llm.push(
        reply().tool("edit", { filePath: file, oldString: "ORIGINAL_CONTENT", newString: "ABORTED_TURN_OVERWRITE" }),
      )
      yield* user(chat.id, "Read and revise the report")
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        permission.list().pipe(Effect.map((items) => items.find((r) => r.sessionID === chat.id))),
        "edit permission did not arrive",
      )
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(first)
      const remaining = yield* permission.list()
      // Probe the stale UI reply even if it should now be rejected.
      yield* permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.ignore)
      yield* Effect.sleep("100 millis")
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("ORIGINAL_CONTENT\n")
      expect(remaining.some((r) => r.id === request.id)).toBe(false)
      // A fresh edit of the same path must acquire the prior turn's semaphore.
      yield* llm.push(
        reply().tool("edit", { filePath: file, oldString: "ORIGINAL_CONTENT", newString: "FRESH_TURN_WRITE" }),
      )
      yield* llm.text("fresh done")
      yield* user(chat.id, "Revise the report")
      const fresh = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const next = yield* pollWithTimeout(
        permission.list().pipe(Effect.map((items) => items.find((r) => r.sessionID === chat.id))),
        "fresh edit remained locked",
      )
      yield* permission.reply({ requestID: next.id, reply: "once" })
      yield* Fiber.join(fresh).pipe(Effect.timeout("5 seconds"))
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("FRESH_TURN_WRITE\n")
    }),
  { timeout: 20000 },
)

it.instance(
  "cancel while a question is pending removes it before a stale answer can complete the tool",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const questions = yield* Question.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.push(
        reply().tool("question", {
          questions: [
            { question: "Continue?", header: "Choice", options: [{ label: "Yes", description: "Continue" }] },
          ],
        }),
      )
      yield* user(chat.id, "ask a question")
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        questions.list().pipe(Effect.map((items) => items.find((r) => r.sessionID === chat.id))),
        "question did not arrive",
      )
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(first)
      expect((yield* questions.list()).some((r) => r.id === request.id)).toBe(false)
      const late = yield* questions.reply({ requestID: request.id, answers: [["Yes"]] }).pipe(Effect.exit)
      expect(Exit.isFailure(late)).toBe(true)
    }),
  { timeout: 20000 },
)

const itAbortMcp = testEffect(makeHttp({ mcpTools: { probe_lookup: mcpTool("lookup", "Look up a note") } }))
itAbortMcp.instance(
  "cancel while an MCP permission is pending removes it before late approval",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        permission: { "*": "allow", probe_lookup: "ask" },
        permission_timeout: { enabled: false },
        tool_search: { enabled: false },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permissions = yield* Permission.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.push(reply().tool("probe_lookup", { query: "milk" }))
      yield* user(chat.id, "look up note")
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        permissions.list().pipe(Effect.map((items) => items.find((r) => r.sessionID === chat.id))),
        "MCP permission did not arrive",
      )
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(first)
      expect((yield* permissions.list()).some((r) => r.id === request.id)).toBe(false)
      const late = yield* permissions.reply({ requestID: request.id, reply: "once" }).pipe(Effect.exit)
      expect(Exit.isFailure(late)).toBe(true)
    }),
  { timeout: 20000 },
)

it.instance(
  "cancel while bash permission is pending cannot run the command on late approval",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        permission: { "*": "allow", bash: "ask" },
        permission_timeout: { enabled: false },
      }))
      const file = path.join(dir, "aborted-command.txt")
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permissions = yield* Permission.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.push(
        reply().tool("bash", {
          command: "echo SHOULD_NOT_RUN > aborted-command.txt",
          description: "write marker",
          workdir: dir,
        }),
      )
      yield* user(chat.id, "Write a report marker")
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        permissions.list().pipe(Effect.map((items) => items.find((r) => r.sessionID === chat.id))),
        "bash permission did not arrive",
      )
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(first)
      const late = yield* permissions.reply({ requestID: request.id, reply: "once" }).pipe(Effect.exit)
      expect(Exit.isFailure(late)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
    }),
  { timeout: 20000 },
)
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
      title: "Child",
      parentID: parent.id,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const plan = "Create the scene, place the camera, then validate the HTML."
    yield* llm.push(reply().text(`<silvercode-result>${plan}</silvercode-result>`).tool("glob", { pattern: "*" }))
    yield* llm.push(reply().tool("finish", { reason: "success", result: "Task completed" }).stop())
    const result = yield* prompt.prompt({
      sessionID: child.id,
      agent: "general",
      model: ref,
      parts: [{ type: "text", text: "Plan the scene, inspect file names, then finish." }],
    })
    expect(yield* llm.calls).toBe(2)
    expectCompletedFinish(result)
    const history = yield* sessions.messages({ sessionID: child.id })
    expect(
      history.some(
        (message) =>
          message.info.id !== result.info.id &&
          message.parts.some((part) => part.type === "text" && part.text.includes(plan)),
      ),
    ).toBe(true)
    expectNoFinishNudge(history)
  }),
)

it.instance(
  "cancel registered custom tool permission prevents a late side effect",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.OPENCODE_DISABLE_CONFIG_DEP_INSTALL
        process.env.OPENCODE_DISABLE_CONFIG_DEP_INSTALL = "1"
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const tools = path.join(dir, ".opencode", "tools")
          const marker = path.join(dir, "plugin-late-write.txt")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(tools, "plugin_write.ts"),
              `export default {
      description: "Request permission then write a marker", args: {},
      async execute(args, ctx) {
        await ctx.ask({ permission: "plugin_write", patterns: ["*"], always: ["*"], metadata: {} })
        await Bun.write(${JSON.stringify(marker)}, "LATE_SIDE_EFFECT")
        return "written"
      }
    }`,
            ),
          )
          const { llm } = yield* useServerConfig((url) => ({
            ...providerCfg(url),
            permission: { "*": "allow", plugin_write: "ask" },
            permission_timeout: { enabled: false },
            tool_search: { enabled: false },
          }))
          expect((yield* (yield* ToolRegistry.Service).all()).some((t) => t.id === "plugin_write")).toBe(true)
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const permissions = yield* Permission.Service
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.push(reply().tool("plugin_write", {}))
          yield* user(chat.id, "Generate a report with the custom tool")
          const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          const request = yield* pollWithTimeout(
            permissions.list().pipe(Effect.map((items) => items.find((r) => r.sessionID === chat.id))),
            "custom tool permission did not arrive",
          )
          yield* prompt.cancel(chat.id)
          yield* Fiber.await(first)
          const remaining = yield* permissions.list()
          yield* permissions.reply({ requestID: request.id, reply: "once" }).pipe(Effect.ignore)
          yield* Effect.sleep("100 millis")
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
          expect(remaining.some((r) => r.id === request.id)).toBe(false)
          // Cancellation must not poison the next legitimate plugin invocation.
          yield* llm.push(reply().tool("plugin_write", {}))
          yield* llm.text("approved plugin invocation completed")
          yield* user(chat.id, "Generate the report again with approval")
          const fresh = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          const next = yield* pollWithTimeout(
            permissions.list().pipe(Effect.map((items) => items.find((r) => r.sessionID === chat.id))),
            "fresh custom tool permission did not arrive",
          )
          yield* permissions.reply({ requestID: next.id, reply: "once" })
          yield* Fiber.join(fresh).pipe(Effect.timeout("5 seconds"))
          expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("LATE_SIDE_EFFECT")
        }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OPENCODE_DISABLE_CONFIG_DEP_INSTALL
          else process.env.OPENCODE_DISABLE_CONFIG_DEP_INSTALL = previous
        }),
    ),
  { timeout: 20000 },
)

withMcpTools.instance(
  "captured MCP executor still runs after the request becomes programming (advisory workflow)",
  () =>
    Effect.gen(function* () {
      yield* useServerConfig((url) => ({
        ...providerCfg(url),
        tool_search: { enabled: false },
        permission: { "*": "allow" },
      }))
      const sessions = yield* Session.Service
      const agents = yield* AgentSvc.Service
      const provider = yield* ProviderSvc.Service
      const chat = yield* sessions.create({ title: "overlap" })
      const seeded = yield* seed(chat.id)
      yield* user(chat.id, "Research notes and write a report")
      const { SessionTools } = yield* Effect.promise(() => import("../../src/session/tools"))
      const tools = yield* SessionTools.resolve({
        agent: yield* agents.get("work"),
        model: yield* provider.getModel(ref.providerID, ref.modelID),
        session: chat,
        processor: {
          message: seeded.assistant,
          updateToolCall: () => Effect.succeed(undefined),
          completeToolCall: () => Effect.void,
          waitForOtherTools: () => Effect.void,
        },
        bypassAgentCheck: false,
        messages: yield* sessions.messages({ sessionID: chat.id }),
        promptOps: {
          resolvePromptParts: () => Effect.succeed([]),
          cancel: () => Effect.void,
          prompt: () => Effect.die("No child expected"),
        },
      })
      const execute = tools.notes_search_notes?.execute
      expect(execute).toBeDefined()
      yield* user(chat.id, "Implement API endpoint")
      const exit = yield* Effect.tryPromise(() =>
        execute!({ query: "private" }, { toolCallId: "old", messages: [], abortSignal: new AbortController().signal }),
      ).pipe(Effect.exit)
      // Classification is guidance, not a gate: the captured MCP call runs after the request turns into programming.
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).not.toContain("Task scope changed")
    }),
)

withMcpTools.instance("an explicit permission deny still removes the MCP tool whatever the classification", () =>
  Effect.gen(function* () {
    yield* useServerConfig((url) => ({
      ...providerCfg(url),
      tool_search: { enabled: false },
      permission: { "*": "allow", notes_search_notes: "deny" },
    }))
    const sessions = yield* Session.Service
    const agents = yield* AgentSvc.Service
    const provider = yield* ProviderSvc.Service
    const chat = yield* sessions.create({ title: "overlap" })
    const seeded = yield* seed(chat.id)
    yield* user(chat.id, "Research notes and write a report")
    const { SessionTools } = yield* Effect.promise(() => import("../../src/session/tools"))
    const tools = yield* SessionTools.resolve({
      agent: yield* agents.get("work"),
      model: yield* provider.getModel(ref.providerID, ref.modelID),
      session: chat,
      processor: {
        message: seeded.assistant,
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
        waitForOtherTools: () => Effect.void,
      },
      bypassAgentCheck: false,
      messages: yield* sessions.messages({ sessionID: chat.id }),
      promptOps: {
        resolvePromptParts: () => Effect.succeed([]),
        cancel: () => Effect.void,
        prompt: () => Effect.die("No child expected"),
      },
    })
    const execute = tools.notes_search_notes?.execute
    yield* user(chat.id, "Implement API endpoint")
    // The tool is offered; the deny is enforced at execution, whatever the classification.
    expect(execute).toBeDefined()
    const exit = yield* Effect.tryPromise(() =>
      execute!({ query: "private" }, { toolCallId: "deny", messages: [], abortSignal: new AbortController().signal }),
    ).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause).toLowerCase()).toMatch(/denied|deny|permission/)
  }),
)

// ---------------------------------------------------------------------------
// Regression for #292: ESC interruption must not poison the next prompt.
// Deterministic (no wall-clock sleeps, only Deferred coordination) - covers
// the core streaming case. Queued/background/fresh-cancel are covered by
// existing tests; this one specifically verifies the next prompt after ESC
// starts a clean run and is not poisoned by the previous cancellation.
// ---------------------------------------------------------------------------
it.instance(
  "ESC interrupt does not poison next prompt - streaming case starts clean run (#292)",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Interrupt resume #292" })

      // Simulate Work agent streaming (hang) - user presses ESC to interrupt.
      // Queue both the hanging response and the fresh response before starting,
      // mirroring the existing 'prompt after cancel during streaming' pattern.
      yield* llm.hang
      yield* llm.text("Second answer")
      const first = yield* prompt
        .prompt({ sessionID: chat.id, agent: "work", model: ref, parts: [{ type: "text", text: "First prompt" }] })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)
      yield* llm.wait(1)

      // ESC: cancel active run - must preserve cancelled turn as interrupted.
      yield* prompt.cancel(chat.id)
      const exitFirst = yield* Fiber.await(first)
      expect(Exit.isSuccess(exitFirst)).toBe(true)
      if (Exit.isSuccess(exitFirst)) {
        expect(exitFirst.value.info.role).toBe("assistant")
        if (exitFirst.value.info.role === "assistant")
          expect(exitFirst.value.info.error?.name).toBe("MessageAbortedError")
      }
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const s = yield* SessionStatus.Service
          const cur = yield* s.get(chat.id)
          return cur.type === "idle" ? (true as const) : undefined
        }),
        `session ${chat.id} never became idle after cancel`,
      )
      const interruptedBefore = yield* abortedIDs(chat.id)
      expect(interruptedBefore.length).toBe(1)
      // The hanging request was consumed, so hits should be 1 (the hang).
      expect(yield* llm.hits).toHaveLength(1)

      // Next prompt after ESC must start a clean run (not interrupted) and
      // consume the queued fresh response. This is the core #292 check:
      // cancellation state from the previous run must not poison the next.
      const second = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "work",
        model: ref,
        parts: [{ type: "text", text: "Second prompt" }],
      })
      expect(second.info.role).toBe("assistant")
      if (second.info.role === "assistant") {
        expect(second.info.error).toBeUndefined()
        expect(second.info.finish).toBeDefined()
      }
      expect(interruptedBefore.includes(second.info.id)).toBe(false)
      // After the fresh run, hits should be 2 (hang + fresh).
      expect(yield* llm.hits).toHaveLength(2)
      expect((yield* abortedIDs(chat.id)).length).toBe(1)

      // Verify a third prompt after another cancel also stays clean (fresh-cancel on idle).
      yield* prompt.cancel(chat.id)
      yield* llm.text("Third answer")
      const third = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "work",
        model: ref,
        parts: [{ type: "text", text: "Third prompt" }],
      })
      expect(third.info.role).toBe("assistant")
      if (third.info.role === "assistant") expect(third.info.error).toBeUndefined()
      expect(yield* llm.hits).toHaveLength(3)
    }),
  { git: true },
  10_000,
)

// ---------------------------------------------------------------------------
// Issue #738: repetition-guard recovery at the run-loop level
// ---------------------------------------------------------------------------

// A non-periodic fragment above MIN_UNIT_CHARS so the guard confirms it at its
// full length; a small prefix streams first so some text is persisted before
// the guard aborts.
const RECOVERY_PREFIX = "Here is the persisted prefix: "
const RECOVERY_FRAGMENT = "x".repeat(59) + "y"

const loopingReply = () =>
  reply()
    .text(RECOVERY_PREFIX)
    .text(RECOVERY_FRAGMENT)
    .text(RECOVERY_FRAGMENT)
    .text(RECOVERY_FRAGMENT)
    .text(RECOVERY_FRAGMENT)

// Recovery messages are identified by the runner's own lineage marker, not by
// their text, so the tests cannot confuse them with other synthetic messages.
const repetitionRecoveriesIn = (messages: SessionV1.WithParts[]) =>
  messages.filter(
    (message) =>
      message.info.role === "user" &&
      message.parts.some(
        (part) => part.type === "text" && part.synthetic === true && part.metadata?.repetitionRecovery !== undefined,
      ),
  )

it.instance(
  "repetition-guard recovery injects one synthetic recovery message and continues the turn",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        agent: "work",
        model: { providerID: ref.providerID, id: ref.modelID },
      })

      const normalReply = reply().text("The model recovered and continued with the task.").stop()

      yield* llm.push(loopingReply(), normalReply)
      const task = yield* user(chat.id, "please do the task")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const messages = yield* sessions.messages({ sessionID: chat.id })
      const assistantMessages = messages.filter((m) => m.info.role === "assistant")

      // The aborted generation kept its persisted partial text and surfaced the error.
      const first = assistantMessages[0]
      expect(first).toBeDefined()
      if (first && first.info.role === "assistant") {
        const persisted = first.parts
          .filter((p) => p.type === "text")
          .map((p) => (typeof p.text === "string" ? p.text : ""))
          .join("")
        expect(persisted).toContain(RECOVERY_PREFIX)
        expect(first.info.error).toBeDefined()
      }

      // Exactly one synthetic recovery user message, with the repeated-fragment
      // detail and an honest account of what happened (never "nothing happened").
      const recoveries = repetitionRecoveriesIn(messages)
      expect(recoveries).toHaveLength(1)
      const [recovery] = recoveries
      const [recoveryPart] = recovery.parts
      expect(recoveryPart.type).toBe("text")
      if (recoveryPart.type === "text") {
        expect(recoveryPart.text).toContain("cut off by the repetition guard")
        expect(recoveryPart.text).toContain(`${RECOVERY_FRAGMENT.length}-character fragment`)
        expect(recoveryPart.text).toContain("preserved in the transcript")
        // The earlier copies of the fragment were already streamed and are
        // still in the transcript; the recovery may not claim they vanished.
        expect(recoveryPart.text).toContain("including the earlier copies of that fragment")
        expect(recoveryPart.text).not.toContain("discarded")
        expect(recoveryPart.text).toContain("Do not repeat that fragment again")
        expect(recoveryPart.text).toContain("emit the pending tool call")
        // Recognised continuation lineage: the recovery belongs to the prompt it
        // resumes, so provenance/subagent success and the budget can follow it.
        expect(recoveryPart.metadata?.repetitionRecovery).toEqual({ promptID: task.id, attempt: 1 })
      }

      // Exactly two model requests: the aborted generation and the one recovery.
      expect(yield* llm.calls).toBe(2)
      expect(yield* llm.pending).toBe(0)
      expect(yield* llm.misses).toEqual([])

      // The errored generation's persisted text stays visible to the recovery
      // request instead of being erased by the errored-assistant conversion
      // filter. Only transcript state is replayed; nothing is re-executed.
      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs[1])).toContain(RECOVERY_PREFIX)

      // The recovery generation completed without a second guard trip and with no
      // tool activity, so the doom-loop detector (3 identical completed tool calls)
      // can never be satisfied by a single recovery.
      const last = assistantMessages[assistantMessages.length - 1]
      expect(last).toBeDefined()
      if (last && last.info.role === "assistant") expect(last.info.error).toBeUndefined()
      expect(assistantMessages.flatMap((m) => m.parts.filter((p) => p.type === "tool")).length).toBe(0)
    }),
  { config: cfg },
)

it.instance(
  "repetition-guard recovery: a second guard trip terminates with the error surfaced",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        agent: "work",
        model: { providerID: ref.providerID, id: ref.modelID },
      })

      // Both responses loop: one recovery is allowed, the second trip must stop.
      yield* llm.push(loopingReply(), loopingReply())
      const task = yield* user(chat.id, "please do the task")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const messages = yield* sessions.messages({ sessionID: chat.id })
      const assistantMessages = messages.filter((m) => m.info.role === "assistant")

      // Exactly one recovery was attempted; the turn did not loop forever.
      expect(assistantMessages).toHaveLength(2)
      expect(repetitionRecoveriesIn(messages)).toHaveLength(1)
      // The second trip surfaces the error and stops deterministically, without
      // asking the model a third time.
      expect(yield* llm.calls).toBe(2)
      expect(yield* llm.pending).toBe(0)
      const last = assistantMessages[assistantMessages.length - 1]
      expect(last).toBeDefined()
      if (last && last.info.role === "assistant") {
        expect(last.info.error).toBeDefined()
        expect(RepetitionGuard.isStoredError(last.info.error)).toBe(true)
      }
      // An idle resume of the same prompt returns its terminal result; it does
      // not reset the recovery budget or spend a third provider request.
      const resumed = yield* prompt.loop({ sessionID: chat.id, messageID: task.id })
      expect(resumed.info.id).toBe(result.info.id)
      expect(yield* llm.calls).toBe(2)
      expect(yield* llm.misses).toEqual([])
      const status = yield* SessionStatus.Service
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
    }),
  { config: cfg },
)

// OpenAI-compatible SSE chunk, matching the shape the provider adapter parses.
const sseChunk = (delta: Record<string, unknown>, finish?: string) => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
})

it.instance(
  "repetition-guard recovery keeps a completed tool call visible in the recovery request",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        agent: "work",
        model: { providerID: ref.providerID, id: ref.modelID },
      })
      const callID = "call_guard_tool"
      const { directory } = yield* TestInstance
      const markerFile = path.join(directory, "repetition-tool-executions.txt")
      const toolDone = yield* Deferred.make<void>()
      // Head: the tool call streams and completes. Tail (after the gate): the
      // same generation loops and trips the guard.
      yield* llm.push(
        raw({
          head: [
            sseChunk({ role: "assistant" }),
            sseChunk({
              tool_calls: [{ index: 0, id: callID, type: "function", function: { name: "bash", arguments: "" } }],
            }),
            sseChunk({
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: JSON.stringify({
                      command:
                        "printf 'executed\\n' >> repetition-tool-executions.txt; printf 'TOOL_MARKER_CONTENT\\n'",
                      description: "write marker",
                    }),
                  },
                },
              ],
            }),
          ],
          wait: deferredAsPromise(toolDone),
          tail: [
            sseChunk({ content: RECOVERY_PREFIX }),
            sseChunk({ content: RECOVERY_FRAGMENT }),
            sseChunk({ content: RECOVERY_FRAGMENT }),
            sseChunk({ content: RECOVERY_FRAGMENT }),
            sseChunk({ content: RECOVERY_FRAGMENT }),
            sseChunk({}, "tool_calls"),
          ],
        }),
        reply().text("The model recovered with the tool result in hand.").stop(),
      )

      yield* user(chat.id, "please run the marker command")
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      // Wait for the completed bash tool call before opening the gate, so the
      // part is settled before the guard aborts the stream (the reported shape).
      yield* pollWithTimeout(
        sessions.messages({ sessionID: chat.id }).pipe(
          Effect.map((msgs) => {
            const part = msgs.flatMap((m) => m.parts).find((candidate) => candidate.type === "tool")
            return part && part.type === "tool" && part.state.status === "completed" ? true : undefined
          }),
        ),
        "timed out waiting for the guard-trip tool call to complete",
      )
      yield* Deferred.succeed(toolDone, void 0)
      yield* Fiber.join(fiber)

      // The aborted generation's tool call executed exactly once and stayed the
      // only call in the transcript.
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const toolParts = messages.flatMap((m) => m.parts.filter((p) => p.type === "tool"))
      expect(toolParts).toHaveLength(1)
      expect(toolParts[0]?.state.status).toBe("completed")

      // The recovery request sees the completed call and its recorded output,
      // instead of the errored-assistant filter erasing the generation and
      // letting the model re-issue a finished call.
      expect(yield* llm.calls).toBe(2)
      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs).toHaveLength(2)
      const recoveryRequest = JSON.stringify(inputs[1])
      expect(recoveryRequest).toContain(callID)
      // One output occurrence plus the command's literal marker in its input.
      expect(recoveryRequest.match(/TOOL_MARKER_CONTENT/g)).toHaveLength(2)
      expect(yield* Effect.promise(() => readFile(markerFile, "utf8"))).toBe("executed\n")
      expect(yield* llm.pending).toBe(0)
      expect(yield* llm.misses).toEqual([])
    }),
  { config: cfg },
  20_000,
)

it.instance(
  "repetition-guard recovery: an HTTP 400 that quotes the guard text is not a guard trip",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        agent: "work",
        model: { providerID: ref.providerID, id: ref.modelID },
      })

      // A provider rejection whose message quotes the guard text must not be
      // mistaken for the harness's own abort (typed identity, not text match).
      yield* llm.push(
        httpError(400, {
          error: {
            message: `${RepetitionGuard.REPETITION_MESSAGE}: the model streamed the same 96-character fragment 3 times in a row`,
            type: "invalid_request_error",
            code: "invalid_request_error",
          },
        }),
      )
      yield* user(chat.id, "please do the task")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.error?.name).toBe("APIError")
        expect(RepetitionGuard.isStoredError(result.info.error)).toBe(false)
      }

      // No recovery request, no synthetic recovery message: the failure is
      // surfaced once as the provider reported it.
      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(repetitionRecoveriesIn(messages)).toHaveLength(0)
      expect(messages.filter((m) => m.info.role === "assistant")).toHaveLength(1)
      expect(yield* llm.calls).toBe(1)
    }),
  { config: cfg },
  20_000,
)

// ---------------------------------------------------------------------------
// Issue #738 / #410: a prompt queued while a guard trip is being recovered is
// a NEW prompt, not a retry. Each caller must settle on the response to its own
// prompt, and the queued prompt must actually be answered exactly once.
// ---------------------------------------------------------------------------

const settled = <A>(fibers: readonly [Fiber.Fiber<A, unknown>, Fiber.Fiber<A, unknown>], message: string) =>
  awaitWithTimeout(Effect.all([Fiber.await(fibers[0]), Fiber.await(fibers[1])]), message, "15 seconds")

function assistantExit(exit: Exit.Exit<SessionV1.WithParts, unknown>) {
  expect(Exit.isSuccess(exit)).toBe(true)
  if (Exit.isFailure(exit)) throw new Error("prompt caller failed")
  expect(exit.value.info.role).toBe("assistant")
  if (exit.value.info.role !== "assistant") throw new Error("prompt caller did not receive an assistant")
  return { ...exit.value, info: exit.value.info }
}

const textParts = (message: SessionV1.WithParts) =>
  message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))

it.instance(
  "repetition-guard recovery: a prompt queued before the first trip keeps its own turn",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        agent: "work",
        model: { providerID: ref.providerID, id: ref.modelID },
      })

      const gate = yield* Deferred.make<void>()
      // Gen1 streams only after the gate opens, so the queued prompt lands
      // before the guard can trip.
      yield* llm.push(
        loopingReply().wait(deferredAsPromise(gate)),
        reply().text("Answered the queued request on its own turn.").stop(),
      )

      const primaryID = MessageID.ascending()
      const primary = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: primaryID,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "please do the task" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      const queuedID = MessageID.ascending()
      const queued = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: queuedID,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "queued before the guard tripped" }],
        })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((msgs) =>
              msgs.some((msg) => msg.info.role === "user" && msg.info.id === queuedID) ? true : undefined,
            ),
          ),
        "timed out waiting for the queued prompt to save",
      )

      yield* Deferred.succeed(gate, void 0)
      const [exitPrimary, exitQueued] = yield* settled([primary, queued], "queued callers never settled")

      const primaryResult = assistantExit(exitPrimary)
      const queuedResult = assistantExit(exitQueued)
      expect(primaryResult.info.parentID).toBe(primaryID)
      expect(RepetitionGuard.isStoredError(primaryResult.info.error)).toBe(true)
      expect(textParts(primaryResult).join("")).toContain(RECOVERY_PREFIX)
      expect(queuedResult.info.parentID).toBe(queuedID)
      expect(queuedResult.info.error).toBeUndefined()
      expect(textParts(queuedResult)).toEqual(["Answered the queued request on its own turn."])

      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(messages.find((message) => message.info.id === primaryResult.info.id)).toEqual(primaryResult)
      expect(messages.find((message) => message.info.id === queuedResult.info.id)).toEqual(queuedResult)
      expect(continuesPrompt(messages, primaryResult, primaryID)).toBe(true)
      expect(continuesPrompt(messages, queuedResult, queuedID)).toBe(true)
      expect(continuesPrompt(messages, queuedResult, primaryID)).toBe(false)
      // No synthetic continuation was injected after the newer real input.
      expect(repetitionRecoveriesIn(messages)).toHaveLength(0)
      const assistants = messages.filter((message) => message.info.role === "assistant")
      expect(assistants).toHaveLength(2)
      expect(assistants.flatMap((message) => message.parts.filter((part) => part.type === "tool"))).toHaveLength(0)
      // The aborted prompt spends exactly one request: no recovery was granted
      // to it once newer real input was waiting, and the queued prompt is a new
      // turn rather than a second attempt at the aborted one.
      expect(yield* llm.calls).toBe(2)
      expect(yield* llm.pending).toBe(0)
      expect(yield* llm.misses).toEqual([])
      const status = yield* SessionStatus.Service
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })

      // The queued input was neither dropped nor answered with another prompt's
      // continuation: its own request carries it and no recovery nudge.
      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs[0])).toContain("please do the task")
      expect(JSON.stringify(inputs[0])).not.toContain("queued before the guard tripped")
      expect(JSON.stringify(inputs[1])).toContain("queued before the guard tripped")
      expect(JSON.stringify(inputs[1])).not.toContain("cut off by the repetition guard")
      // It stays visible in the durable transcript with its exact text.
      const queuedMessage = messages.find((message) => message.info.id === queuedID)!
      expect(queuedMessage.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
        "queued before the guard tripped",
      ])
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "repetition-guard recovery: a prompt queued during a recovery that trips again gets its own turn",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        agent: "work",
        model: { providerID: ref.providerID, id: ref.modelID },
      })

      const gate = yield* Deferred.make<void>()
      yield* llm.push(
        loopingReply(),
        // The single allowed recovery is gated so the queued prompt lands while
        // it is generating, and this recovery trips too.
        loopingReply().wait(deferredAsPromise(gate)),
        reply().text("Answered the queued request on its own turn.").stop(),
      )

      const primaryID = MessageID.ascending()
      const primary = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: primaryID,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "please do the task" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(2)
      yield* waitForBusy(chat.id)

      const queuedID = MessageID.ascending()
      const queued = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: queuedID,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "queued during the recovery" }],
        })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((msgs) =>
              msgs.some((msg) => msg.info.role === "user" && msg.info.id === queuedID) ? true : undefined,
            ),
          ),
        "timed out waiting for the queued prompt to save",
      )

      yield* Deferred.succeed(gate, void 0)
      const [exitPrimary, exitQueued] = yield* settled([primary, queued], "queued callers never settled")

      const primaryResult = assistantExit(exitPrimary)
      const queuedResult = assistantExit(exitQueued)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const recoveries = repetitionRecoveriesIn(messages)
      expect(recoveries).toHaveLength(1)
      const [recovery] = recoveries
      const recoveryID = recovery.info.id
      // The exhausted lineage ends on its own surfaced error, and the caller
      // waiting on it settles there instead of borrowing the newer answer.
      expect(primaryResult.info.parentID).toBe(recoveryID)
      expect(RepetitionGuard.isStoredError(primaryResult.info.error)).toBe(true)
      expect(textParts(primaryResult).join("")).toContain(RECOVERY_PREFIX)
      expect(queuedResult.info.parentID).toBe(queuedID)
      expect(queuedResult.info.error).toBeUndefined()
      expect(textParts(queuedResult)).toEqual(["Answered the queued request on its own turn."])
      expect(messages.find((message) => message.info.id === primaryResult.info.id)).toEqual(primaryResult)
      expect(messages.find((message) => message.info.id === queuedResult.info.id)).toEqual(queuedResult)
      expect(continuesPrompt(messages, primaryResult, primaryID)).toBe(true)
      expect(continuesPrompt(messages, queuedResult, queuedID)).toBe(true)
      expect(continuesPrompt(messages, queuedResult, primaryID)).toBe(false)
      const [recoveryPart] = recovery.parts
      expect(recoveryPart?.type === "text" ? recoveryPart.metadata?.repetitionRecovery : undefined).toEqual({
        promptID: primaryID,
        attempt: 1,
      })

      const assistants = messages.filter((message) => message.info.role === "assistant")
      expect(assistants).toHaveLength(3)
      expect(assistants.flatMap((message) => message.parts.filter((part) => part.type === "tool"))).toHaveLength(0)
      // Two requests for the aborted lineage (trip plus its one recovery) and
      // one new request that answers the queued prompt; nothing replayed, no
      // manual follow-up needed, no unbounded re-entry.
      expect(yield* llm.calls).toBe(3)
      expect(yield* llm.pending).toBe(0)
      expect(yield* llm.misses).toEqual([])
      const status = yield* SessionStatus.Service
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
      // The continuation was created before the queued input, never after it.
      const order = messages.map((message) => message.info.id)
      expect(order.indexOf(recoveryID)).toBeLessThan(order.indexOf(queuedID))
      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs).toHaveLength(3)
      expect(JSON.stringify(inputs[0])).toContain("please do the task")
      expect(JSON.stringify(inputs[1])).toContain("cut off by the repetition guard")
      expect(JSON.stringify(inputs[1])).not.toContain("queued during the recovery")
      expect(JSON.stringify(inputs[2])).toContain("queued during the recovery")
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "repetition-guard recovery: a successful recovery and a queued prompt each settle on their own answer",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        agent: "work",
        model: { providerID: ref.providerID, id: ref.modelID },
      })

      const gate = yield* Deferred.make<void>()
      yield* llm.push(
        loopingReply(),
        reply().text("Recovered and finished the task.").stop().wait(deferredAsPromise(gate)),
        reply().text("Answered the queued request on its own turn.").stop(),
      )

      const primaryID = MessageID.ascending()
      const primary = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: primaryID,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "please do the task" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(2)
      yield* waitForBusy(chat.id)

      const queuedID = MessageID.ascending()
      const queued = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: queuedID,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "queued during the recovery" }],
        })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((msgs) =>
              msgs.some((msg) => msg.info.role === "user" && msg.info.id === queuedID) ? true : undefined,
            ),
          ),
        "timed out waiting for the queued prompt to save",
      )

      yield* Deferred.succeed(gate, void 0)
      const [exitPrimary, exitQueued] = yield* settled([primary, queued], "queued callers never settled")

      const primaryResult = assistantExit(exitPrimary)
      const queuedResult = assistantExit(exitQueued)

      const messages = yield* sessions.messages({ sessionID: chat.id })
      const recoveries = repetitionRecoveriesIn(messages)
      expect(recoveries).toHaveLength(1)
      const [recovery] = recoveries
      const recoveryID = recovery.info.id

      // Primary caller settles on the recovery that continued its prompt.
      expect(primaryResult.info.parentID).toBe(recoveryID)
      expect(primaryResult.info.error).toBeUndefined()
      expect(textParts(primaryResult)).toEqual(["Recovered and finished the task."])
      // Queued caller settles on the answer to its own prompt.
      expect(queuedResult.info.parentID).toBe(queuedID)
      expect(queuedResult.info.error).toBeUndefined()
      expect(textParts(queuedResult)).toEqual(["Answered the queued request on its own turn."])
      expect(messages.find((message) => message.info.id === primaryResult.info.id)).toEqual(primaryResult)
      expect(messages.find((message) => message.info.id === queuedResult.info.id)).toEqual(queuedResult)
      expect(continuesPrompt(messages, primaryResult, primaryID)).toBe(true)
      expect(continuesPrompt(messages, queuedResult, queuedID)).toBe(true)
      expect(continuesPrompt(messages, queuedResult, primaryID)).toBe(false)

      const assistants = messages.filter((message) => message.info.role === "assistant")
      expect(assistants).toHaveLength(3)
      expect(assistants.flatMap((message) => message.parts.filter((part) => part.type === "tool"))).toHaveLength(0)
      expect(yield* llm.calls).toBe(3)
      expect(yield* llm.pending).toBe(0)
      expect(yield* llm.misses).toEqual([])
      const status = yield* SessionStatus.Service
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })

      // The queued prompt's own turn keeps the lineage it inherited: the
      // original prompt, the synthetic continuation and the recovered answer are
      // all still in its request, and it is asked once.
      const queuedRequest = JSON.stringify(turnInputs(yield* llm.inputs)[2])
      expect(queuedRequest).toContain("please do the task")
      expect(queuedRequest).toContain("cut off by the repetition guard")
      expect(queuedRequest).toContain("Recovered and finished the task.")
      expect(queuedRequest).toContain("queued during the recovery")
      // The one recovery declares the prompt it continued.
      const [recoveryPart] = recovery.parts
      expect(recoveryPart?.type === "text" ? recoveryPart.metadata?.repetitionRecovery : undefined).toEqual({
        promptID: primaryID,
        attempt: 1,
      })
    }),
  { config: cfg },
  30_000,
)

// ---------------------------------------------------------------------------
// Issue #738 countercontrols: the generation target is explicit, so a stored
// recovery is answered before a later prompt, an older unanswered caller is
// answered instead of a no-progress fallback, and a silent no-reply marker
// cannot suppress the one recovery it has no caller to receive.
// ---------------------------------------------------------------------------

const seedUser = (sessionID: SessionID, text: string, created: number) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const msg = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "work",
      model: ref,
      time: { created },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      text,
    })
    return msg
  })

const seedAborted = (sessionID: SessionID, parentID: MessageID, created: number, text = "partial output") =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const msg: SessionV1.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      parentID,
      sessionID,
      mode: "work",
      agent: "work",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created, completed: created },
      error: new NamedError.Unknown({
        message: `${RepetitionGuard.REPETITION_MESSAGE}: the model streamed the same 60-character fragment 3 times in a row`,
        ref: RepetitionGuard.ERROR_REF,
      }).toObject(),
    }
    yield* sessions.updateMessage(msg)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      text,
    })
    return msg
  })

const seedRecovery = (sessionID: SessionID, promptID: MessageID, created: number, text = "recovery instruction") =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const msg = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "work",
      model: ref,
      time: { created },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      synthetic: true,
      text,
      metadata: { repetitionRecovery: { promptID, attempt: 1 } },
    })
    return msg
  })

const seedAnswer = (sessionID: SessionID, parentID: MessageID, created: number, text: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const msg: SessionV1.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      parentID,
      sessionID,
      mode: "work",
      agent: "work",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created, completed: created },
      finish: "stop",
    }
    yield* sessions.updateMessage(msg)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      text,
    })
    return msg
  })

it.instance(
  "repetition-guard recovery: an owed recovery is answered before a prompt stored after it",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Owed recovery" })
      const base = Date.now()

      // The historical shape: the first prompt tripped, its one recovery was
      // stored, and a second prompt landed after it but was never answered.
      const first = yield* seedUser(chat.id, "first prompt", base)
      yield* seedAborted(chat.id, first.id, base + 1)
      const recovery = yield* seedRecovery(chat.id, first.id, base + 2)
      const second = yield* seedUser(chat.id, "second prompt", base + 3)

      yield* llm.push(
        reply().text("Recovered the first prompt.").stop(),
        reply().text("Answered the second prompt.").stop(),
      )

      const result = yield* prompt.loop({ sessionID: chat.id, messageID: second.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") throw new Error("expected an assistant result")
      expect(result.info.parentID).toBe(second.id)
      expect(result.info.error).toBeUndefined()
      expect(textParts(result)).toEqual(["Answered the second prompt."])

      // The stored recovery consumed the recovery request itself; the later
      // prompt did not steal it, and the recovery no longer dangles.
      const stored = yield* sessions.messages({ sessionID: chat.id })
      const recoveryAnswer = stored.find(
        (message) => message.info.role === "assistant" && message.info.parentID === recovery.id,
      )
      expect(recoveryAnswer).toBeDefined()
      if (!recoveryAnswer || recoveryAnswer.info.role !== "assistant") throw new Error("missing recovery answer")
      expect(recoveryAnswer.info.error).toBeUndefined()
      expect(textParts(recoveryAnswer)).toEqual(["Recovered the first prompt."])
      expect(repetitionRecoveriesIn(stored)).toHaveLength(1)

      // The original caller settles on its own lineage's answer.
      const original = yield* prompt.loop({ sessionID: chat.id, messageID: first.id })
      expect(original.info.id).toBe(recoveryAnswer.info.id)

      expect(yield* llm.calls).toBe(2)
      expect(yield* llm.pending).toBe(0)
      expect(yield* llm.misses).toEqual([])

      // The recovery generation is scoped to its own history: the prompt that
      // arrived after it is not quoted into that request, and the second
      // generation carries both the recovery answer and its own prompt.
      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs[0])).toContain("first prompt")
      expect(JSON.stringify(inputs[0])).toContain("recovery instruction")
      expect(JSON.stringify(inputs[0])).not.toContain("second prompt")
      expect(JSON.stringify(inputs[1])).toContain("second prompt")
      // The second prompt predates the recovery's answer, so that answer is not
      // quoted into its request either direction of the lineage.
      expect(JSON.stringify(inputs[1])).not.toContain("Recovered the first prompt.")

      const assistants = stored.filter((message) => message.info.role === "assistant")
      expect(assistants).toHaveLength(3)
      expect(assistants.flatMap((message) => message.parts.filter((part) => part.type === "tool"))).toHaveLength(0)
      const status = yield* SessionStatus.Service
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
    }),
  { config: cfg },
  20_000,
)

it.instance(
  "repetition-guard recovery: an earlier-created prompt stored later is still answered, not failed",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Late persisted prompt" })
      const base = Date.now()

      const first = yield* seedUser(chat.id, "first prompt", base)
      yield* seedAborted(chat.id, first.id, base + 1)
      // The recovery belongs to the first prompt and carries an answer.
      const recovery = yield* seedRecovery(chat.id, first.id, base + 2)
      const firstAnswer = yield* seedAnswer(chat.id, recovery.id, base + 3, "Answer for the first prompt.")
      // The second prompt was created before the recovery but stored after it
      // (asynchronous parts), so the newest message by creation time is the
      // already answered recovery while this caller is still waiting.
      const second = yield* seedUser(chat.id, "second prompt", base + 1)
      expect(second.id > recovery.id).toBe(true)

      yield* llm.push(reply().text("Answered the second prompt.").stop())
      const result = yield* prompt.loop({ sessionID: chat.id, messageID: second.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") throw new Error("expected an assistant result")
      expect(result.info.parentID).toBe(second.id)
      expect(result.info.error).toBeUndefined()
      expect(result.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
        "Answered the second prompt.",
      ])
      expect(result.info.id).not.toBe(firstAnswer.id)
      expect(result.info.id).not.toBe(recovery.id)

      // The possible answer was generated: one request, no no-progress error,
      // and the first lineage's stored answer is untouched.
      expect(yield* llm.calls).toBe(1)
      expect(yield* llm.pending).toBe(0)
      expect(yield* llm.misses).toEqual([])
      const stored = yield* sessions.messages({ sessionID: chat.id })
      const storedFirst = stored.find((message) => message.info.id === firstAnswer.id)
      expect(storedFirst?.info.role).toBe("assistant")
      if (storedFirst?.info.role === "assistant") expect(storedFirst.info.error).toBeUndefined()
      expect(storedFirst?.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))).toEqual([
        "Answer for the first prompt.",
      ])
      expect(stored.find((message) => message.info.id === result.info.id)).toEqual(result)
      expect(repetitionRecoveriesIn(stored)).toHaveLength(1)
      expect(continuesPrompt(stored, result, second.id)).toBe(true)
      expect(continuesPrompt(stored, result, first.id)).toBe(false)
      const status = yield* SessionStatus.Service
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
    }),
  { config: cfg },
  20_000,
)

it.instance(
  "repetition-guard recovery: a silent no-reply marker does not suppress the one recovery",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Silent marker" })
      const gate = yield* Deferred.make<void>()

      // The guard trip happens while a background task injects a silent marker
      // (noReply) - a message with no caller waiting for it.
      yield* llm.push(
        loopingReply().wait(deferredAsPromise(gate)),
        reply().text("Recovered after the silent marker.").stop(),
      )
      const primaryID = MessageID.ascending()
      const primary = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: primaryID,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "please do the task" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      const marker = yield* prompt.prompt({
        sessionID: chat.id,
        noReply: true,
        agent: "work",
        model: ref,
        parts: [{ type: "text", text: "Background task completed silently", synthetic: true }],
      })
      yield* Deferred.succeed(gate, void 0)
      const result = assistantExit(yield* awaitWithTimeout(Fiber.await(primary), "primary never settled", "15 seconds"))

      // The sole recovery still runs for the prompt that actually tripped.
      const stored = yield* sessions.messages({ sessionID: chat.id })
      const recoveries = repetitionRecoveriesIn(stored)
      expect(recoveries).toHaveLength(1)
      const [recovery] = recoveries
      expect(result.info.parentID).toBe(recovery.info.id)
      expect(result.info.error).toBeUndefined()
      expect(textParts(result)).toEqual(["Recovered after the silent marker."])
      expect(recovery.parts).toHaveLength(1)
      const [recoveryPart] = recovery.parts
      expect(recoveryPart?.type === "text" ? recoveryPart.metadata?.repetitionRecovery : undefined).toEqual({
        promptID: primaryID,
        attempt: 1,
      })

      // The marker is persisted with its caller intent and text, has no answer,
      // and did not take the recovery's generation.
      const storedMarker = stored.find((message) => message.info.id === marker.info.id)
      expect(storedMarker?.info.role === "user" ? storedMarker.info.noReply : undefined).toBe(true)
      expect(
        stored.find((message) => message.info.role === "assistant" && message.info.parentID === marker.info.id),
      ).toBe(undefined)
      expect(storedMarker?.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))).toEqual([
        "Background task completed silently",
      ])

      expect(yield* llm.calls).toBe(2)
      expect(yield* llm.pending).toBe(0)
      expect(yield* llm.misses).toEqual([])
      // The silent marker is context for the recovery, not a caller to answer.
      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs[1])).toContain("cut off by the repetition guard")
      expect(JSON.stringify(inputs[1])).toContain("Background task completed silently")

      // Re-entering an answered lineage does not spend a third request or start
      // a busy/idle churn loop.
      const resumed = yield* prompt.loop({ sessionID: chat.id, messageID: primaryID })
      expect(resumed.info.id).toBe(result.info.id)
      expect(yield* llm.calls).toBe(2)
      const status = yield* SessionStatus.Service
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
    }),
  { config: cfg },
  20_000,
)

it.instance(
  "repetition-guard recovery: a synthetic prompt with its own caller keeps priority",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Synthetic caller" })
      const gate = yield* Deferred.make<void>()

      // Synthetic parts do not mean "no caller": this prompt is awaited and
      // must get its own turn instead of being dropped as if it were a marker.
      yield* llm.push(
        loopingReply().wait(deferredAsPromise(gate)),
        reply().text("Answered the synthetic queued prompt.").stop(),
      )
      const primaryID = MessageID.ascending()
      const primary = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: primaryID,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "please do the task" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      const queuedID = MessageID.ascending()
      const queued = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: queuedID,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "synthetic queued prompt", synthetic: true }],
        })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((msgs) =>
              msgs.some((msg) => msg.info.role === "user" && msg.info.id === queuedID) ? true : undefined,
            ),
          ),
        "timed out waiting for the synthetic prompt to save",
      )

      yield* Deferred.succeed(gate, void 0)
      const [exitPrimary, exitQueued] = yield* settled([primary, queued], "callers never settled")
      const primaryResult = assistantExit(exitPrimary)
      const queuedResult = assistantExit(exitQueued)

      expect(primaryResult.info.parentID).toBe(primaryID)
      expect(RepetitionGuard.isStoredError(primaryResult.info.error)).toBe(true)
      expect(queuedResult.info.parentID).toBe(queuedID)
      expect(queuedResult.info.error).toBeUndefined()
      expect(textParts(queuedResult)).toEqual(["Answered the synthetic queued prompt."])

      const stored = yield* sessions.messages({ sessionID: chat.id })
      // No recovery was injected after awaited input, and the synthetic prompt
      // is still present verbatim.
      expect(repetitionRecoveriesIn(stored)).toHaveLength(0)
      expect(
        stored
          .find((message) => message.info.id === queuedID)
          ?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      ).toEqual(["synthetic queued prompt"])
      expect(yield* llm.calls).toBe(2)
      expect(yield* llm.pending).toBe(0)
      expect(yield* llm.misses).toEqual([])
      const inputs = turnInputs(yield* llm.inputs)
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs[1])).toContain("synthetic queued prompt")
      expect(JSON.stringify(inputs[1])).not.toContain("cut off by the repetition guard")
      const status = yield* SessionStatus.Service
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
    }),
  { config: cfg },
  20_000,
)

it.instance(
  "repetition-guard recovery: a stored answer for another prompt is never returned to an unanswered caller",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const chat = yield* sessions.create({ title: "Historical recovery" })

      // Older transcripts can contain the original bug: a recovery for the first
      // prompt was saved after a second real prompt. Its answer belongs to the
      // first prompt, and the second has no answer at all.
      const primary = yield* user(chat.id, "first prompt")
      const aborted: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: primary.id,
        sessionID: chat.id,
        mode: "work",
        agent: "work",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now(), completed: Date.now() },
        error: new NamedError.Unknown({
          message: RepetitionGuard.REPETITION_MESSAGE,
          ref: RepetitionGuard.ERROR_REF,
        }).toObject(),
      }
      yield* sessions.updateMessage(aborted)
      const queued = yield* user(chat.id, "second prompt")
      const continuation = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "work",
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: continuation.id,
        sessionID: chat.id,
        type: "text",
        synthetic: true,
        text: "Recovery for the first prompt",
        metadata: { repetitionRecovery: { promptID: primary.id, attempt: 1 } },
      })
      const otherAnswer: SessionV1.Assistant = {
        ...aborted,
        id: MessageID.ascending(),
        parentID: continuation.id,
        error: undefined,
        finish: "stop",
        time: { created: Date.now(), completed: Date.now() },
      }
      yield* sessions.updateMessage(otherAnswer)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: otherAnswer.id,
        sessionID: chat.id,
        type: "text",
        text: "This answer belongs to the first prompt.",
      })

      // The second prompt is unanswered, so the run must generate its answer
      // instead of returning the first lineage's stored answer or failing the
      // caller preemptively with a no-progress error.
      yield* llm.push(reply().text("Answered the second prompt.").stop())

      let idleRuns = 0
      const off = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type !== SessionStatus.Event.Idle.type) return
          if (typeof event.data !== "object" || event.data === null || !("sessionID" in event.data)) return
          if (event.data.sessionID === chat.id) idleRuns++
        }),
      )
      yield* Effect.addFinalizer(() => off)

      const result = yield* awaitWithTimeout(
        prompt.loop({ sessionID: chat.id, messageID: queued.id }),
        "unanswered caller never settled",
        "10 seconds",
      )
      // Exactly one run settles the caller: no joined-run churn, no manual retry.
      expect(idleRuns).toBe(1)
      expect(yield* llm.calls).toBe(1)
      expect(yield* llm.pending).toBe(0)
      expect(yield* llm.misses).toEqual([])
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") throw new Error("expected an assistant result for the second prompt")
      // The answer belongs to the caller that waited: never the first prompt's.
      expect(result.info.id).not.toBe(otherAnswer.id)
      expect(result.info.parentID).toBe(queued.id)
      expect(result.info.error).toBeUndefined()
      expect(result.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
        "Answered the second prompt.",
      ])
      const stored = yield* sessions.messages({ sessionID: chat.id })
      expect(stored.find((message) => message.info.id === result.info.id)).toEqual(result)
      // The first lineage's stored answer is untouched and no extra recovery
      // instruction was injected for it.
      expect(
        stored
          .find((message) => message.info.id === otherAnswer.id)
          ?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      ).toEqual(["This answer belongs to the first prompt."])
      expect(repetitionRecoveriesIn(stored)).toHaveLength(1)
      // Ownership is the parent link; the historical out-of-order recovery
      // between the prompt and its answer is a boundary, so the safe direction
      // is that the answer never continues the first prompt.
      expect(continuesPrompt(stored, result, primary.id)).toBe(false)
      const status = yield* SessionStatus.Service
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
    }),
  { config: cfg },
  20_000,
)

// The guard budget must be spent on model turns, never on re-deriving the same
// turn. The runner injects the nudge and then reads the transcript back to pick
// the next generation target; if that read does not place the nudge after the
// assistant that triggered it, the loop would select the same prompt again,
// append another nudge, and burn all three nudges without a single request. A
// stored timestamp can produce exactly that shape (a clock step between the
// generation and the nudge), and it is the shape CI reported for the retry-wait
// fixture: three nudges, the terminal guard error, and no request after the
// first. The loop therefore keeps the continuation it injected in flight.
it.instance("a finish nudge owns the next generation even when the stored transcript places it early", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), agent: { work: { finishTool: true } } }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const seeded = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "work",
      noReply: true,
      parts: [{ type: "text", text: "Bom dia" }],
    })
    const real = Date.now
    let skew = 0
    Date.now = () => real() + skew
    yield* Effect.ensuring(
      Effect.gen(function* () {
        // Stepping the clock back once the first answer is on the wire stores
        // every later message before the assistant it belongs to.
        yield* llm.push(reply().text("FIRST_ANSWER_TEXT").onSend(() => void (skew = -60_000)))
        yield* llm.push(reply().text("b"))
        yield* llm.push(reply().text("c"))
        yield* llm.push(reply().text("d"))

        const result = yield* prompt.loop({ sessionID: chat.id, messageID: seeded.info.id })
        const hits = yield* llm.hits
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const nudges = messages.filter(
          (message) =>
            message.info.role === "user" &&
            message.parts.some((part) => part.type === "text" && part.text.includes(FINISH_NUDGE_MARKER)),
        )
        const bodies = hits.map((hit) => JSON.stringify(hit.body))

        // One request for the prompt and one for each nudge: the guard asked the
        // model every time it spent a nudge.
        expect(hits).toHaveLength(4)
        const nudgeBodies = bodies.filter((body) => body.includes(FINISH_NUDGE_MARKER))
        expect(nudgeBodies).toHaveLength(3)
        // Each nudge still continues the answer it follows: the injected
        // continuation is where the run put it, not where the stored timestamp
        // does.
        for (const body of nudgeBodies) expect(body).toContain("FIRST_ANSWER_TEXT")
        // The budget itself is unchanged, so the turn still stops, bounded.
        expect(nudges).toHaveLength(3)
        expect(result.info.role).toBe("assistant")
        if (result.info.role === "assistant") {
          expect(result.info.finish).toBe("error")
          expect(result.info.error?.name).toBe("UnknownError")
          if (result.info.error?.name === "UnknownError") {
            expect(result.info.error.data.message).toContain("did not complete the required finish tool after 3 nudges")
          }
        }
      }),
      Effect.sync(() => void (Date.now = real)),
    )
  }),
  { config: cfg },
  30_000,
)
// Issue #783: the finish nudge is the runner's own continuation of the turn it
// follows, and the run injects it only because the turn ended without finish.
// The answer that obeys it answers the prompt the turn belongs to. Two things
// used to go wrong once finish completed on that first nudge:
//
// - Ownership: the assistant that completed finish has the nudge as its parent,
//   so `prompt()` settled the caller on the *pre-nudge* answer instead - an
//   answer that ended without finish, i.e. the run returned an incomplete
//   looking result while the finish it had completed sat on another message.
// - Chronology: turn selection and the finish check read the transcript back by
//   stored creation time. A clock step between the turn's first answer and the
//   nudge stores the nudge (and the answer that completes finish) *before* the
//   prompt, so the loop re-derived the spent prompt, spent the remaining nudge
//   budget on new requests, and stamped the terminal guard error over the turn:
//   three spurious generations after a finish that had already succeeded.
//
// Both are the same fix: the run keeps its own continuation and the answer it
// made for it in flight and in the order it created them, ends on the generation
// that completed finish, and names the prompt the continuation belongs to so the
// caller settles on that answer. Only the ownership path (a real waiting caller)
// can observe the first; the rollback below is the positive control for the
// second.
it.instance("a finish that completes on the first nudge settles the caller that asked the prompt", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), agent: { work: { finishTool: true } } }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* llm.text("FIRST_ANSWER_TEXT")
    yield* llm.tool("finish", { reason: "success", result: "all done" })

    const result = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "work",
      parts: [{ type: "text", text: "hello" }],
    })
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const hits = yield* llm.hits
    const nudges = messages.filter((message) => finishContinuationPromptID(message) !== undefined)

    // One request for the prompt and exactly one generation for the nudge: the
    // turn ends when finish completes, so there is no further request and no
    // second nudge.
    expect(hits).toHaveLength(2)
    expect(hits[0]?.body && JSON.stringify(hits[0].body).includes(FINISH_NUDGE_MARKER)).toBe(false)
    expect(JSON.stringify(hits[1]?.body)).toContain(FINISH_NUDGE_MARKER)
    expect(JSON.stringify(hits[1]?.body)).toContain("FIRST_ANSWER_TEXT")
    expect(nudges).toHaveLength(1)

    // finish ran once, and the answer that carries it is the answer the caller
    // got: the run completed the turn, so it must not hand back the pre-nudge
    // stop that ended without finish.
    const finishes = messages
      .flatMap((message) => message.parts)
      .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "finish")
    expect(finishes).toHaveLength(1)
    expect(finishes[0]?.state.status).toBe("completed")
    expect(result.info.role).toBe("assistant")
    expect(result.info.id).toBe(finishes[0]?.messageID)
    if (result.info.role === "assistant") expect(result.info.finish).not.toBe("error")
    expect(result.parts.some((part) => part.type === "tool" && part.tool === "finish" && part.state.status === "completed")).toBe(
      true,
    )

    // The continuation declares the prompt whose turn it extends, so ownership
    // survives a later read of the persisted transcript.
    const asked = messages.find((message) => message.info.role === "user")
    expect(nudges[0] ? finishContinuationPromptID(nudges[0]) : undefined).toBe(asked?.info.id)
    expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
  }),
  { config: cfg },
  30_000,
)

it.instance("a finish that completes on the first nudge stops the run when the stored order is rolled back", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), agent: { work: { finishTool: true } } }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const real = Date.now
    let skew = 0
    Date.now = () => real() + skew
    yield* Effect.ensuring(
      Effect.gen(function* () {
        // Stepping the clock back once the first answer is on the wire stores
        // the nudge and the answer that completes finish before the prompt.
        yield* llm.push(reply().text("FIRST_ANSWER_TEXT").stop().onSend(() => void (skew = -60_000)))
        yield* llm.push(reply().tool("finish", { reason: "success", result: "all done" }))
        // Queued in case the run keeps generating: any request past the two the
        // turn needs is the spurious work this control exists to catch.
        yield* llm.text("EXTRA_GENERATION")
        yield* llm.text("EXTRA_GENERATION")
        yield* llm.text("EXTRA_GENERATION")

        const result = yield* prompt.prompt({
          sessionID: chat.id,
          agent: "work",
          parts: [{ type: "text", text: "hello" }],
        })
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const hits = yield* llm.hits
        const nudges = messages.filter((message) => finishContinuationPromptID(message) !== undefined)
        const asked = messages.find((message) => message.info.role === "user" && finishContinuationPromptID(message) === undefined)

        // The rollback really did invert the stored order: the nudge sits before
        // the prompt it continues, which is the shape that used to re-derive the
        // spent prompt.
        const nudgeAt = messages.findIndex((message) => finishContinuationPromptID(message) !== undefined)
        const askedAt = messages.findIndex((message) => message.info.id === asked?.info.id)
        expect(nudgeAt).toBeGreaterThanOrEqual(0)
        expect(askedAt).toBeGreaterThan(nudgeAt)

        // Two requests: the prompt and the one nudge generation. The successful
        // finish ends the turn, so no budget is spent and no terminal error is
        // stamped over it.
        expect(hits).toHaveLength(2)
        expect(nudges).toHaveLength(1)
        const finishes = messages
          .flatMap((message) => message.parts)
          .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "finish")
        expect(finishes).toHaveLength(1)
        expect(finishes[0]?.state.status).toBe("completed")
        expect(result.info.role).toBe("assistant")
        expect(result.info.id).toBe(finishes[0]?.messageID)
        if (result.info.role === "assistant") {
          expect(result.info.finish).not.toBe("error")
          expect(result.info.error).toBeUndefined()
        }
        expect(messages.some((message) => message.info.role === "assistant" && message.info.error !== undefined)).toBe(false)
        expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
      }),
      Effect.sync(() => void (Date.now = real)),
    )
  }),
  { config: cfg },
  30_000,
)

// Fresh #790 controls: real callers, persisted runner markers, finish execution,
// and idle re-entry. These deliberately do not reuse the older marker-less fixtures.
it.instance(
  "lineage: a silent marker does not steal a finish continuation",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), agent: { work: { finishTool: true } } }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "silent continuation" })
      const gate = yield* Deferred.make<void>()
      yield* llm.push(
        reply().text("P1 progress").stop(),
        reply().text("P1 done").tool("finish", { reason: "success", result: "P1 done" }).wait(deferredAsPromise(gate)),
      )
      const p1 = yield* prompt
        .prompt({ sessionID: chat.id, agent: "work", parts: [{ type: "text", text: "P1" }] })
        .pipe(Effect.forkChild)
      yield* llm.wait(2)
      const marker = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "work",
        noReply: true,
        parts: [{ type: "text", text: "SILENT_CONTEXT", synthetic: true }],
      })
      yield* Deferred.succeed(gate, void 0)
      const result = assistantExit(yield* awaitWithTimeout(Fiber.await(p1), "P1 never settled", "15 seconds"))
      const stored = yield* sessions.messages({ sessionID: chat.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.finish).not.toBe("error")
      expectCompletedFinish(result)
      expect(
        stored.some((message) => message.info.role === "assistant" && message.info.parentID === marker.info.id),
      ).toBe(false)
      expect(JSON.stringify(turnInputs(yield* llm.inputs))).not.toContain("finishContinuation")
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "lineage: mixed recovery and finish nudges cannot reset the recovery budget",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), agent: { work: { finishTool: true } } }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "mixed recovery" })
      yield* llm.push(
        loopingReply(),
        reply().text("recovered but no finish").stop(),
        loopingReply(),
        reply().text("EXTRA_RECOVERY"),
      )
      const result = yield* prompt.prompt({ sessionID: chat.id, agent: "work", parts: [{ type: "text", text: "P1" }] })
      const stored = yield* sessions.messages({ sessionID: chat.id })
      expect(yield* llm.calls).toBe(3)
      expect(repetitionRecoveriesIn(stored)).toHaveLength(1)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(RepetitionGuard.isStoredError(result.info.error)).toBe(true)
      expect(yield* llm.pending).toBe(1)
      if (result.info.role !== "assistant") throw new Error("expected an assistant result")
      const resumed = yield* prompt.loop({ sessionID: chat.id, messageID: result.info.parentID })
      expect(resumed.info.id).toBe(result.info.id)
      expect(yield* llm.calls).toBe(3)
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "lineage: queued P2 gets its own three finish nudges after P1 spends its budget",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), agent: { work: { finishTool: true } } }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "per prompt budget" })
      const gate = yield* Deferred.make<void>()
      for (let i = 0; i < 4; i++)
        yield* llm.push(
          reply()
            .text("P1 no finish")
            .stop()
            .wait(i === 3 ? deferredAsPromise(gate) : Promise.resolve()),
        )
      for (let i = 0; i < 4; i++) yield* llm.push(reply().text("P2 no finish").stop())
      const p1ID = MessageID.ascending()
      const p1 = yield* prompt
        .prompt({ sessionID: chat.id, messageID: p1ID, agent: "work", parts: [{ type: "text", text: "P1" }] })
        .pipe(Effect.forkChild)
      yield* llm.wait(4)
      const p2ID = MessageID.ascending()
      const p2 = yield* prompt
        .prompt({ sessionID: chat.id, messageID: p2ID, agent: "work", parts: [{ type: "text", text: "P2" }] })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(Effect.map((msgs) => (msgs.some((msg) => msg.info.id === p2ID) ? true : undefined))),
        "P2 never persisted",
      )
      yield* Deferred.succeed(gate, void 0)
      const [r1, r2] = yield* settled([p1, p2], "budget callers never settled")
      const a1 = assistantExit(r1),
        a2 = assistantExit(r2)
      const stored = yield* sessions.messages({ sessionID: chat.id })
      const nudges = stored.filter((message) => finishContinuationPromptID(message) !== undefined)
      expect(yield* llm.calls).toBe(8)
      expect(nudges.filter((message) => finishContinuationPromptID(message) === p1ID)).toHaveLength(3)
      expect(nudges.filter((message) => finishContinuationPromptID(message) === p2ID)).toHaveLength(3)
      expect(a1.info.error?.name).toBe("UnknownError")
      expect(a2.info.error?.name).toBe("UnknownError")
      expect(continuesPrompt(stored, a1, p1ID)).toBe(true)
      expect(continuesPrompt(stored, a2, p2ID)).toBe(true)
      expect(continuesPrompt(stored, a2, p1ID)).toBe(false)
      expect((yield* prompt.loop({ sessionID: chat.id, messageID: p1ID })).info.id).toBe(a1.info.id)
      expect((yield* prompt.loop({ sessionID: chat.id, messageID: p2ID })).info.id).toBe(a2.info.id)
      expect(yield* llm.calls).toBe(8)
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "lineage: async P2 cannot settle on P1 finish after a clock rollback",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), agent: { work: { finishTool: true } } }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "async finish ownership" })
      const gate = yield* Deferred.make<void>()
      const real = Date.now
      let skew = 0
      Date.now = () => real() + skew
      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* llm.push(
            reply().text("P1 progress").stop(),
            reply()
              .text("P1 done")
              .tool("finish", { reason: "success", result: "P1 done" })
              .wait(deferredAsPromise(gate)),
            reply().text("P2 progress").stop(),
            reply().text("P2 done").tool("finish", { reason: "success", result: "P2 done" }),
          )
          const p1ID = MessageID.ascending()
          const p1 = yield* prompt
            .prompt({ sessionID: chat.id, messageID: p1ID, agent: "work", parts: [{ type: "text", text: "P1" }] })
            .pipe(Effect.forkChild)
          yield* llm.wait(2)
          const p2ID = MessageID.ascending()
          const p2 = yield* prompt
            .prompt({ sessionID: chat.id, messageID: p2ID, agent: "work", parts: [{ type: "text", text: "P2" }] })
            .pipe(Effect.forkChild)
          yield* pollWithTimeout(
            sessions
              .messages({ sessionID: chat.id })
              .pipe(Effect.map((msgs) => (msgs.some((msg) => msg.info.id === p2ID) ? true : undefined))),
            "P2 never persisted",
          )
          skew = -60_000
          yield* Deferred.succeed(gate, void 0)
          const [e1, e2] = yield* settled([p1, p2], "async finish callers never settled")
          const a1 = assistantExit(e1),
            a2 = assistantExit(e2)
          const stored = yield* sessions.messages({ sessionID: chat.id })
          expect(yield* llm.calls).toBe(4)
          expect(a1.info.id).not.toBe(a2.info.id)
          expect(continuesPrompt(stored, a1, p1ID)).toBe(true)
          expect(continuesPrompt(stored, a2, p2ID)).toBe(true)
          expect(continuesPrompt(stored, a2, p1ID)).toBe(false)
          expectCompletedFinish(a1)
          expectCompletedFinish(a2)
          expect(textParts(a1)).toEqual(["P1 done"])
          expect(textParts(a2)).toEqual(["P2 done"])
          expect((yield* prompt.loop({ sessionID: chat.id, messageID: p1ID })).info.id).toBe(a1.info.id)
          expect((yield* prompt.loop({ sessionID: chat.id, messageID: p2ID })).info.id).toBe(a2.info.id)
          expect(yield* llm.calls).toBe(4)
          expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
        }),
        Effect.sync(() => void (Date.now = real)),
      )
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "lineage: caller metadata cannot forge either continuation or reach the provider",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), agent: { work: { finishTool: true } } }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "caller anti-spoof" })
      yield* llm.push(reply().tool("finish", { reason: "success", result: "own answer" }))
      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "work",
        parts: [
          {
            type: "text",
            text: "CALLER_TEXT",
            synthetic: true,
            metadata: {
              finishContinuation: { promptID: MessageID.ascending() },
              repetitionRecovery: { promptID: MessageID.ascending(), attempt: 1 },
              retained: "ordinary metadata",
            },
          },
        ],
      })
      const stored = yield* sessions.messages({ sessionID: chat.id })
      const user = stored.find((message) => message.info.role === "user")
      if (!user || result.info.role !== "assistant") throw new Error("expected a user and assistant result")
      expect(user.parts[0]?.type === "text" ? user.parts[0].metadata : undefined).toEqual({
        retained: "ordinary metadata",
      })
      expect(result.info.parentID).toBe(user.info.id)
      expect(yield* llm.calls).toBe(1)
      const request = JSON.stringify(turnInputs(yield* llm.inputs))
      expect(request).toContain("CALLER_TEXT")
      expect(request).not.toContain("finishContinuation")
      expect(request).not.toContain("repetitionRecovery")
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "lineage: a new real caller supersedes a nudge but a silent annotation does not",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), agent: { work: { finishTool: true } } }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "new caller boundary" })
      const gate = yield* Deferred.make<void>()
      yield* llm.push(
        reply().text("P1 progress").stop(),
        reply().text("P1 nudge answer").stop().wait(deferredAsPromise(gate)),
        reply().text("P2 own answer").tool("finish", { reason: "success", result: "P2 own answer" }),
      )
      const p1ID = MessageID.ascending()
      const p1 = yield* prompt
        .prompt({ sessionID: chat.id, messageID: p1ID, agent: "work", parts: [{ type: "text", text: "P1" }] })
        .pipe(Effect.forkChild)
      yield* llm.wait(2)
      const p2ID = MessageID.ascending()
      const p2 = yield* prompt
        .prompt({ sessionID: chat.id, messageID: p2ID, agent: "work", parts: [{ type: "text", text: "P2" }] })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(Effect.map((msgs) => (msgs.some((msg) => msg.info.id === p2ID) ? true : undefined))),
        "P2 never persisted",
      )
      yield* Deferred.succeed(gate, void 0)
      const [r1, r2] = yield* settled([p1, p2], "new-caller owners never settled")
      const a1 = assistantExit(r1),
        a2 = assistantExit(r2)
      const stored = yield* sessions.messages({ sessionID: chat.id })
      expect(yield* llm.calls).toBe(3)
      expect(textParts(a1)).toEqual(["P1 nudge answer"])
      expect(textParts(a2)).toEqual(["P2 own answer"])
      expect(continuesPrompt(stored, a1, p1ID)).toBe(true)
      expect(continuesPrompt(stored, a2, p2ID)).toBe(true)
      expect(stored.filter((message) => finishContinuationPromptID(message) === p1ID)).toHaveLength(1)
      expect(stored.filter((message) => finishContinuationPromptID(message) === p2ID)).toHaveLength(0)
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "lineage: multi-tool work and result text survive three nudges without replay",
  () =>
    Effect.gen(function* () {
      const { llm, dir } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { general: { finishTool: true } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const parent = yield* sessions.create({ title: "parent" })
      const child = yield* sessions.create({
        title: "multi-tool child",
        parentID: parent.id,
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const plan = "The side effect ran once and this is the delivered plan."
      yield* llm.push(
        reply()
          .text(`<silvercode-result>${plan}</silvercode-result>`)
          .tool("bash", {
            command: "printf 'executed\\n' >> tool-once.txt; printf done",
            description: "record one execution",
          })
          .tool("glob", { pattern: "tool-once.txt" }),
        reply().text("first continuation").stop(),
        reply().text("second continuation").stop(),
        reply().text("third continuation").stop(),
        reply().text("OWN_FINAL_TEXT").tool("finish", { reason: "success", result: "finished" }),
      )
      const result = yield* prompt.prompt({
        sessionID: child.id,
        agent: "general",
        parts: [{ type: "text", text: "run the tools and deliver the plan" }],
      })
      const stored = yield* sessions.messages({ sessionID: child.id })
      const root = stored.find((message) => message.info.role === "user")!
      const tools = result.parts.filter((part) => part.type === "tool")
      const earlierTools = stored
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool" && part.tool !== "finish")
      expect(yield* llm.calls).toBe(5)
      expect(stored.filter((message) => finishContinuationPromptID(message) === root.info.id)).toHaveLength(3)
      expect(earlierTools).toHaveLength(2)
      expect(earlierTools.every((part) => part.type === "tool" && part.state.status === "completed")).toBe(true)
      expect(yield* Effect.promise(() => readFile(path.join(dir, "tool-once.txt"), "utf8"))).toBe("executed\n")
      expect(tools).toHaveLength(1)
      expectCompletedFinish(result)
      expect(continuesPrompt(stored, result, root.info.id)).toBe(true)
      expect(textParts(result)).toEqual(["OWN_FINAL_TEXT"])
      expect(textResult(resultChunks(stored, result))).toEqual({ ok: true, text: plan })
      expect((yield* prompt.loop({ sessionID: child.id, messageID: root.info.id })).info.id).toBe(result.info.id)
      expect(yield* llm.calls).toBe(5)
      expect(yield* status.get(child.id)).toEqual({ type: "idle" })
      expect(yield* status.get(parent.id)).toEqual({ type: "idle" })
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "lineage: cancellation during a nudge settles its own caller without a replacement request",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), agent: { work: { finishTool: true } } }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "cancel nudged turn" })
      yield* llm.push(
        reply().text("before nudge").stop(),
        reply()
          .text("must not settle")
          .wait(new Promise<void>(() => {})),
      )
      const p1ID = MessageID.ascending()
      const p1 = yield* prompt
        .prompt({ sessionID: chat.id, messageID: p1ID, agent: "work", parts: [{ type: "text", text: "P1" }] })
        .pipe(Effect.forkChild)
      yield* llm.wait(2)
      yield* prompt.cancel(chat.id)
      const result = assistantExit(
        yield* awaitWithTimeout(Fiber.await(p1), "cancelled caller never settled", "15 seconds"),
      )
      const stored = yield* sessions.messages({ sessionID: chat.id })
      const nudges = stored.filter((message) => finishContinuationPromptID(message) === p1ID)
      expect(yield* llm.calls).toBe(2)
      expect(nudges).toHaveLength(1)
      if (result.info.role !== "assistant") throw new Error("expected an assistant result")
      expect(result.info.parentID).toBe(nudges[0]!.info.id)
      expect(result.info.error?.name).toBe("MessageAbortedError")
      expect(continuesPrompt(stored, result, p1ID)).toBe(true)
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
    }),
  { config: cfg },
  30_000,
)
