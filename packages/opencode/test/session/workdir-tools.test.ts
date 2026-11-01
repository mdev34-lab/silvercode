import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import path from "path"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { Todo } from "@/session/todo"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { MCP } from "@/mcp"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { Skill } from "@/skill"
import { ToolRegistry } from "@/tool/registry"
import { ToolCatalog } from "@/tool/catalog"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "@/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MessageID } from "@/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      Agent.node,
      Permission.node,
      Plugin.node,
      Config.node,
      Provider.node,
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
      Ripgrep.node,
      Format.node,
      Truncate.node,
      Instruction.node,
      CrossSpawnSpawner.node,
      RuntimeFlags.node,
    ]),
  ),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const config = {
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
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
}

/**
 * The handoff from a session record to the tools that run inside it.
 *
 * Everything else asserts one side of this boundary: the selection model, the
 * tools' own resolution, and the task tool's records. This is the join - the
 * same `read` call reading a different file for a child that was given a folder
 * than for the project session it was dispatched from - so a wiring change that
 * silently dropped the folder would fail here rather than only in the field.
 */
const resolveTools = Effect.fn("WorkdirToolsTest.resolveTools")(function* (session: Session.Info) {
  const agents = yield* Agent.Service
  const provider = yield* Provider.Service
  const sessions = yield* Session.Service
  const { SessionTools } = yield* Effect.promise(() => import("../../src/session/tools"))
  return yield* SessionTools.resolve({
    agent: yield* agents.get("work"),
    model: yield* provider.getModel(ref.providerID, ref.modelID),
    session,
    processor: {
      message: { id: MessageID.ascending() } as never,
      updateToolCall: () => Effect.succeed(undefined),
      completeToolCall: () => Effect.void,
      waitForOtherTools: () => Effect.void,
    },
    bypassAgentCheck: false,
    messages: yield* sessions.messages({ sessionID: session.id }),
    promptOps: {
      resolvePromptParts: () => Effect.succeed([]),
      cancel: () => Effect.void,
      prompt: () => Effect.die("No child expected"),
    },
  })
})

const readRelative = Effect.fn("WorkdirToolsTest.readRelative")(function* (session: Session.Info) {
  const tools = yield* resolveTools(session)
  const execute = tools.read?.execute
  if (!execute) return yield* Effect.die("read tool missing")
  return yield* Effect.promise(() =>
    execute({ filePath: "same.txt" }, { toolCallId: "cwd", messages: [], abortSignal: new AbortController().signal }),
  )
})

describe("session working folder reaches tool execution", () => {
  it.instance(
    "a child reads from its folder while the project session reads from the project",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const fs = yield* FSUtil.Service
        yield* fs.writeWithDirs(path.join(test.directory, "child", "same.txt"), "child copy")
        yield* fs.writeWithDirs(path.join(test.directory, "same.txt"), "project copy")

        const seed = Effect.fnUntraced(function* (title: string, metadata?: Record<string, string>) {
          const session = yield* sessions.create({ title, metadata })
          yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: session.id,
            agent: "work",
            model: ref,
            time: { created: Date.now() },
          })
          return session
        })

        const child = yield* seed("Child", { workdir: path.join(test.directory, "child") })
        const root = yield* seed("Root")
        const childRead = yield* readRelative(child)
        const rootRead = yield* readRelative(root)

        // Same relative path, same project, two different files: the folder the
        // session was created with is what decides.
        expect(JSON.stringify(childRead)).toContain("child copy")
        expect(JSON.stringify(childRead)).not.toContain("project copy")
        expect(JSON.stringify(rootRead)).toContain("project copy")
      }),
    { config },
  )
})
