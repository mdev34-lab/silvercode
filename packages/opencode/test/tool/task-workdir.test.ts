import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Deferred, Effect, Exit } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "@/format"
import { Instruction } from "@/session/instruction"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Skill } from "@/skill"
import { SystemPrompt } from "@/session/system"
import { Todo } from "@/session/todo"
import { Permission } from "@/permission"
import { SessionTools } from "../../src/session/tools"
import { ToolCatalog } from "@/tool/catalog"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { Workdir } from "@/session/workdir"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * A delegated child's working folder.
 *
 * These are the regression controls for the whole contract: a child resolves
 * from the folder it was given, a parent and its siblings keep theirs, a resumed
 * task cannot silently move, and choosing a folder never buys an authorization -
 * including through nested delegation, where the ancestor's ruleset still
 * decides what the descendant may reach.
 */

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = () =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      FSUtil.node,
      Format.node,
      Instruction.node,
      LSP.node,
      MCP.node,
      Plugin.node,
      Provider.node,
      Question.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Skill.node,
      SystemPrompt.node,
      Todo.node,
      Permission.node,
      ToolCatalog.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
  )

const it = testEffect(layer())

const PROVIDER_CONFIG = {
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
        "gpt-5": {
          id: "gpt-5",
          name: "Test GPT-5",
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

const FOREGROUND = {
  ...PROVIDER_CONFIG,
  agent: {
    general: { background: false },
  },
}

const ops: TaskPromptOps = {
  cancel: () => Effect.void,
  resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
  prompt: (input) =>
    Effect.sync(() => {
      const id = MessageID.ascending()
      return {
        info: {
          id,
          role: "assistant" as const,
          parentID: input.messageID ?? MessageID.ascending(),
          sessionID: input.sessionID,
          mode: input.agent ?? "general",
          agent: input.agent ?? "general",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
          finish: "stop" as const,
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: id,
            sessionID: input.sessionID,
            type: "text" as const,
            text: "<silvercode-result>done</silvercode-result>",
          },
        ],
      } satisfies SessionV1.WithParts
    }),
}

const seed = Effect.fn("TaskWorkdirTest.seed")(function* (workdir?: string) {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Parent", metadata: workdir ? Workdir.select(undefined, workdir) : {} })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "work",
    model: ref,
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: chat.id,
    messageID: user.id,
    type: "text",
    text: "Research the requested information",
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "work",
    agent: "work",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  return { chat, assistant }
})

const dispatch = Effect.fn("TaskWorkdirTest.dispatch")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  directory?: string
  taskID?: string
}) {
  const tool = yield* TaskTool
  const def = yield* tool.init()
  return yield* def.execute(
    {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
      background: false,
      ...(input.directory === undefined ? {} : { directory: input.directory }),
      ...(input.taskID === undefined ? {} : { task_id: input.taskID }),
    },
    {
      sessionID: input.sessionID,
      messageID: input.messageID,
      agent: "work",
      abort: new AbortController().signal,
      extra: { promptOps: ops },
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    },
  )
})

/** The message a refused dispatch carries, so a test can pin why it refused. */
const failure = (exit: Exit.Exit<unknown, unknown>) => (exit._tag === "Failure" ? String(Cause.squash(exit.cause)) : "")

const mkdir = Effect.fn("TaskWorkdirTest.mkdir")(function* (directory: string) {
  const fs = yield* FSUtil.Service
  yield* fs.ensureDir(directory)
  return directory
})

describe("tool.task working folder", () => {
  it.instance(
    "task description and directory schema warn that shell defaults and relative workdir stay on the project directory",
    () =>
      Effect.gen(function* () {
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const dirSchema = ToolJsonSchema.fromSchema(def.parameters).properties?.directory
        const directoryDescription = typeof dirSchema === "object" ? (dirSchema.description ?? "") : ""

        // Both parent-facing surfaces must scope `directory` to file/search/edit
        // tools and disclose that shell still defaults to (and resolves relative
        // `workdir` from) the project directory unless given an absolute `workdir`.
        expect(def.description).toContain("(`read`, `grep`, `glob`, `edit`, `write`, `apply_patch`)")
        expect(def.description).toContain("Shell commands do NOT follow `directory` yet")
        expect(def.description).toContain("omitted `workdir` runs in the project directory")
        expect(def.description).toContain("a relative `workdir` resolves from the project directory")
        expect(def.description).toContain("pass an explicit absolute `workdir` and verify target paths")
        expect(def.description).toContain("can still affect the project directory")

        expect(directoryDescription).toContain(
          "file, search, and edit tools (read, grep, glob, edit, write, apply_patch)",
        )
        expect(directoryDescription).toContain(
          "Shell commands still default to the project directory and resolve relative workdir from the project directory",
        )
        expect(directoryDescription).toContain("explicit absolute workdir")
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "inherits the parent's folder when the call omits one",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const child = yield* mkdir(path.join(test.directory, "child"))
        const { chat, assistant } = yield* seed(child)
        const sessions = yield* Session.Service

        const result = yield* dispatch({ sessionID: chat.id, messageID: assistant.id })

        const spawned = yield* sessions.get(SessionID.make(String(result.metadata.sessionId)))
        expect(Workdir.read(spawned.metadata)).toBe(child)
        // The parent's own selection is never rewritten by a dispatch.
        expect(Workdir.read((yield* sessions.get(chat.id)).metadata)).toBe(child)
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "resolves a relative folder from the parent's folder, not the process cwd",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const parent = yield* mkdir(path.join(test.directory, "a"))
        const target = yield* mkdir(path.join(parent, "b"))
        const sibling = yield* mkdir(path.join(test.directory, "c"))
        const { chat, assistant } = yield* seed(parent)
        const sessions = yield* Session.Service
        const cwd = process.cwd()

        const relative = yield* dispatch({ sessionID: chat.id, messageID: assistant.id, directory: "b" })
        const up = yield* dispatch({ sessionID: chat.id, messageID: assistant.id, directory: "../c" })

        expect(Workdir.read((yield* sessions.get(SessionID.make(String(relative.metadata.sessionId)))).metadata)).toBe(
          target,
        )
        expect(Workdir.read((yield* sessions.get(SessionID.make(String(up.metadata.sessionId)))).metadata)).toBe(
          sibling,
        )
        // Resolving a child's folder must never move the process itself.
        expect(process.cwd()).toBe(cwd)
        expect(Workdir.read((yield* sessions.get(chat.id)).metadata)).toBe(parent)
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "sibling children keep their own folders",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const one = yield* mkdir(path.join(test.directory, "one"))
        const two = yield* mkdir(path.join(test.directory, "two"))
        const { chat, assistant } = yield* seed()
        const sessions = yield* Session.Service

        const first = yield* dispatch({ sessionID: chat.id, messageID: assistant.id, directory: one })
        const second = yield* dispatch({ sessionID: chat.id, messageID: assistant.id, directory: two })

        expect(Workdir.read((yield* sessions.get(SessionID.make(String(first.metadata.sessionId)))).metadata)).toBe(one)
        expect(Workdir.read((yield* sessions.get(SessionID.make(String(second.metadata.sessionId)))).metadata)).toBe(
          two,
        )
        // The project session that dispatched them works where it always did.
        expect(Workdir.read((yield* sessions.get(chat.id)).metadata)).toBeUndefined()
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "rejects a folder that does not exist or is not a directory",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "file.txt")
        yield* Effect.promise(() => Bun.write(file, "x"))
        const { chat, assistant } = yield* seed()

        const missing = yield* Effect.exit(
          dispatch({ sessionID: chat.id, messageID: assistant.id, directory: path.join(test.directory, "missing") }),
        )
        const notDirectory = yield* Effect.exit(
          dispatch({ sessionID: chat.id, messageID: assistant.id, directory: file }),
        )

        expect(missing._tag).toBe("Failure")
        expect(failure(missing)).toContain("does not exist")
        expect(notDirectory._tag).toBe("Failure")
        expect(failure(notDirectory)).toContain("not a directory")
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "a resumed task keeps its recorded folder and refuses a different one",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const one = yield* mkdir(path.join(test.directory, "one"))
        const two = yield* mkdir(path.join(test.directory, "two"))
        const { chat, assistant } = yield* seed()
        const sessions = yield* Session.Service

        const first = yield* dispatch({ sessionID: chat.id, messageID: assistant.id, directory: one })
        const id = SessionID.make(String(first.metadata.sessionId))

        const resumed = yield* dispatch({
          sessionID: chat.id,
          messageID: assistant.id,
          taskID: first.metadata.sessionId,
        })
        const same = yield* dispatch({
          sessionID: chat.id,
          messageID: assistant.id,
          taskID: first.metadata.sessionId,
          directory: one,
        })
        const moved = yield* Effect.exit(
          dispatch({ sessionID: chat.id, messageID: assistant.id, taskID: first.metadata.sessionId, directory: two }),
        )

        expect(resumed.metadata.sessionId).toBe(first.metadata.sessionId)
        expect(same.metadata.sessionId).toBe(first.metadata.sessionId)
        expect(Workdir.read((yield* sessions.get(id)).metadata)).toBe(one)
        // A different folder on resume is refused rather than silently applied.
        expect(moved._tag).toBe("Failure")
        expect(failure(moved)).toContain("already works in")
        expect(Workdir.read((yield* sessions.get(id)).metadata)).toBe(one)
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "a child created before folders were selectable keeps its creation folder",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const two = yield* mkdir(path.join(test.directory, "two"))
        const { chat, assistant } = yield* seed()
        const sessions = yield* Session.Service
        const legacy = yield* sessions.create({ parentID: chat.id, title: "Legacy child" })

        // No selection was ever recorded, so the folder it was created in stands.
        expect(Workdir.read(legacy.metadata)).toBeUndefined()
        expect(Workdir.of(legacy)).toBe(legacy.directory)

        yield* dispatch({ sessionID: chat.id, messageID: assistant.id, taskID: legacy.id })

        const resumed = yield* sessions.get(legacy.id)
        expect(Workdir.read(resumed.metadata)).toBeUndefined()
        expect(Workdir.of(resumed)).toBe(legacy.directory)

        const moved = yield* Effect.exit(
          dispatch({ sessionID: chat.id, messageID: assistant.id, taskID: legacy.id, directory: two }),
        )
        expect(moved._tag).toBe("Failure")
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "choosing a folder outside the project adds no permission",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const inside = yield* mkdir(path.join(test.directory, "inside"))
        const outer = yield* mkdir(
          path.join(path.dirname(test.directory), `outside-${Math.random().toString(36).slice(2)}`),
        )
        const { chat, assistant } = yield* seed()
        const sessions = yield* Session.Service

        const insideRun = yield* dispatch({ sessionID: chat.id, messageID: assistant.id, directory: inside })
        const outsideRun = yield* dispatch({ sessionID: chat.id, messageID: assistant.id, directory: outer })

        const a = yield* sessions.get(SessionID.make(String(insideRun.metadata.sessionId)))
        const b = yield* sessions.get(SessionID.make(String(outsideRun.metadata.sessionId)))

        // The folder decides where paths resolve, never what is allowed: both
        // children run under exactly the ruleset the parent would have given them.
        expect(b.permission).toEqual(a.permission)
        expect(b.permission?.some((rule) => rule.action === "allow" && String(rule.pattern).includes(outer))).toBe(
          false,
        )
        expect(Workdir.read(b.metadata)).toBe(outer)

        yield* Effect.promise(() => import("fs/promises").then((fs) => fs.rm(outer, { recursive: true, force: true })))
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "retains an existing external allow without extending it to a sibling",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const outer = yield* mkdir(
          path.join(path.dirname(test.directory), `outside-${Math.random().toString(36).slice(2)}`),
        )
        const sibling = `${outer}-sibling`
        const { chat, assistant } = yield* seed()
        const sessions = yield* Session.Service
        const permission = yield* Permission.Service
        const grant = {
          permission: "external_directory",
          pattern: path.join(outer, "*"),
          action: "allow" as const,
        }
        yield* sessions.setPermission({ sessionID: chat.id, permission: [grant] })

        const result = yield* dispatch({ sessionID: chat.id, messageID: assistant.id, directory: outer })
        const child = yield* sessions.get(SessionID.make(String(result.metadata.sessionId)))

        // An existing grant survives selection exactly; the selected path adds no new grant.
        expect(child.permission).toEqual(expect.arrayContaining([grant]))
        expect(child.permission?.filter((rule) => rule.permission === "external_directory")).toEqual([grant])
        expect(
          Permission.evaluate("external_directory", path.join(outer, "file.txt"), child.permission ?? []).action,
        ).toBe("allow")
        expect(
          Permission.evaluate("external_directory", path.join(sibling, "file.txt"), child.permission ?? []).action,
        ).toBe("ask")
        expect((yield* sessions.get(chat.id)).permission).toEqual([grant])
        expect((yield* permission.list()).length).toBe(0)

        yield* Effect.promise(() => import("fs/promises").then((fs) => fs.rm(outer, { recursive: true, force: true })))
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "a nested child cannot escape the ancestor's ruleset by choosing a folder",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const outer = yield* mkdir(
          path.join(path.dirname(test.directory), `outside-${Math.random().toString(36).slice(2)}`),
        )
        const { chat, assistant } = yield* seed()
        const sessions = yield* Session.Service

        // The intermediate child already carries the restrictions its parent
        // handed it. A grandchild is derived from THIS session, so a folder of its
        // own must not widen that floor.
        const child = yield* sessions.create({
          parentID: chat.id,
          title: "Child",
          metadata: Workdir.select(undefined, outer),
          permission: [{ permission: "external_directory", pattern: "*", action: "deny" }],
        })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: child.id,
          agent: "general",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: child.id,
          messageID: user.id,
          type: "text",
          text: "Research the requested information",
        })
        const childAssistant: SessionV1.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: child.id,
          mode: "general",
          agent: "general",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
        }
        yield* sessions.updateMessage(childAssistant)

        const grandchild = yield* dispatch({
          sessionID: child.id,
          messageID: childAssistant.id,
          directory: outer,
        })

        const spawned = yield* sessions.get(SessionID.make(String(grandchild.metadata.sessionId)))
        expect(Workdir.read(spawned.metadata)).toBe(outer)
        // The inherited deny survived the folder selection.
        expect(spawned.permission).toEqual(
          expect.arrayContaining([{ permission: "external_directory", pattern: "*", action: "deny" }]),
        )
        expect(
          spawned.permission?.some((rule) => rule.action === "allow" && String(rule.pattern).includes(outer)),
        ).toBe(false)

        yield* Effect.promise(() => import("fs/promises").then((fs) => fs.rm(outer, { recursive: true, force: true })))
      }),
    { config: { ...FOREGROUND, subagent_depth: 2 } },
  )

  it.instance(
    "a relative request resolves from the caller's folder, not the project it was dispatched from",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const outer = yield* mkdir(
          path.join(path.dirname(test.directory), `outside-${Math.random().toString(36).slice(2)}`),
        )
        const nested = yield* mkdir(path.join(outer, "nested"))
        // A caller that already works elsewhere: the same relative request has to
        // mean the same thing from here as it would from the project session.
        const { chat, assistant } = yield* seed(outer)
        const sessions = yield* Session.Service

        const child = yield* dispatch({ sessionID: chat.id, messageID: assistant.id, directory: "nested" })
        const spawned = yield* sessions.get(SessionID.make(String(child.metadata.sessionId)))

        expect(Workdir.read(spawned.metadata)).toBe(nested)
        // It resolved from the caller's folder, not from the project directory.
        expect(FSUtil.contains(test.directory, nested)).toBe(false)

        yield* Effect.promise(() => import("fs/promises").then((fs) => fs.rm(outer, { recursive: true, force: true })))
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "a resume compares the folder by the rules of the platform it runs on",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const folder = yield* mkdir(path.join(test.directory, "CaseFolder"))
        const { chat, assistant } = yield* seed()
        const sessions = yield* Session.Service

        const first = yield* dispatch({ sessionID: chat.id, messageID: assistant.id, directory: folder })
        const id = SessionID.make(String(first.metadata.sessionId))

        // Whether a respelling reaches the same folder is the file system's
        // answer, not ours: Windows - and any case-insensitive volume - resolves
        // it to one folder, while a case-sensitive volume names a second one.
        const insensitive = yield* Effect.promise(() =>
          import("fs/promises").then((fs) =>
            fs.stat(path.join(test.directory, "casefolder")).then(
              () => true,
              () => false,
            ),
          ),
        )
        if (!insensitive) yield* mkdir(path.join(test.directory, "casefolder"))

        const respelled = yield* Effect.exit(
          dispatch({
            sessionID: chat.id,
            messageID: assistant.id,
            taskID: first.metadata.sessionId,
            directory: path.join(test.directory, "casefolder"),
          }),
        )

        // Either way the task keeps the folder it was created in, so a case
        // difference can neither move a conversation nor be refused twice.
        expect(Workdir.read((yield* sessions.get(id)).metadata)).toBe(folder)
        if (insensitive) {
          expect(respelled._tag).toBe("Success")
        } else {
          expect(respelled._tag).toBe("Failure")
          expect(failure(respelled)).toContain("already works in")
        }
      }),
    { config: FOREGROUND },
  )

  describe("runtime tool and permission execution across foreground, background, resume, and nested tasks", () => {
    const posixOnlyInstance = process.platform === "win32" ? it.instance.skip : it.instance

    const put = Effect.fn("TaskWorkdirRuntime.put")(function* (file: string, content: string) {
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(file, content)
    })

    const get = (file: string) => Effect.promise(() => import("fs/promises").then((fs) => fs.readFile(file, "utf-8")))

    const siblingOutside = (projectDir: string, label: string) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const dir = path.join(
            path.dirname(projectDir),
            `opencode-task-ext-${label}-${Math.random().toString(36).slice(2)}`,
          )
          yield* fs.ensureDir(dir)
          return dir
        }),
        (dir) => Effect.promise(() => import("fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }))),
      )

    const recordAssistantTurn = Effect.fn("TaskWorkdirRuntime.recordAssistantTurn")(function* (
      sessionID: SessionID,
      agentName: string,
    ) {
      const sessions = yield* Session.Service
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: agentName,
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID,
        messageID: user.id,
        type: "text",
        text: "Run child turn",
      })
      const assistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: user.id,
        sessionID,
        mode: agentName,
        agent: agentName,
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
      }
      yield* sessions.updateMessage(assistant)
      return assistant
    })

    const resolveSessionTools = Effect.fn("TaskWorkdirRuntime.resolveSessionTools")(function* (
      sessionID: SessionID,
      promptOps: TaskPromptOps,
    ) {
      const sessions = yield* Session.Service
      const agents = yield* Agent.Service
      const provider = yield* Provider.Service
      const sys = yield* SystemPrompt.Service
      const session = yield* sessions.get(sessionID)
      const agentInfo = yield* agents.get(session.agent ?? "general")
      const model = yield* provider.getModel(ref.providerID, ref.modelID)
      const patchModel = yield* provider.getModel(ref.providerID, ModelV2.ID.make("gpt-5"))
      const assistant = yield* recordAssistantTurn(session.id, agentInfo.name)
      const env = (yield* sys.environment(model, Workdir.of(session)))[0]
      const messages = yield* sessions.messages({ sessionID: session.id })
      const processor = {
        message: assistant,
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
        waitForOtherTools: () => Effect.void,
      }
      const tools = yield* SessionTools.resolve({
        agent: agentInfo,
        model,
        session,
        processor,
        bypassAgentCheck: false,
        messages,
        promptOps,
      })
      const patchTools = yield* SessionTools.resolve({
        agent: agentInfo,
        model: patchModel,
        session,
        processor,
        bypassAgentCheck: false,
        messages,
        promptOps,
      })
      const callTool = <T = any>(name: string, args: Record<string, unknown>) =>
        Effect.gen(function* () {
          const entry = name === "apply_patch" ? patchTools[name] : tools[name]
          if (!entry?.execute) return yield* Effect.fail(new Error(`Tool ${name} missing on session ${session.id}`))
          return (yield* Effect.promise(() =>
            entry.execute!(args as never, {
              toolCallId: `call_${Math.random().toString(36).slice(2)}`,
              messages: [],
              abortSignal: new AbortController().signal,
            }),
          )) as T
        })
      return { session, assistant, env, tools, callTool }
    })

    const makeLiveOps = Effect.fn("TaskWorkdirRuntime.makeLiveOps")(function* (
      runChild: (ctx: {
        input: SessionPrompt.PromptInput
        session: Session.Info
        assistant: SessionV1.Assistant
        env: string
        callTool: <T = any>(name: string, args: Record<string, unknown>) => Effect.Effect<T, unknown>
        ops: TaskPromptOps
      }) => Effect.Effect<string, unknown, any>,
    ) {
      const bridge = yield* EffectBridge.make()
      const notifications: SessionPrompt.PromptInput[] = []
      const liveOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          bridge.run(
            Effect.gen(function* () {
              const hasSynthetic = input.parts.some((part) => part.type === "text" && part.synthetic === true)
              if (hasSynthetic) {
                notifications.push(input)
                const id = MessageID.ascending()
                return {
                  info: {
                    id,
                    role: "assistant" as const,
                    parentID: input.messageID ?? MessageID.ascending(),
                    sessionID: input.sessionID,
                    mode: input.agent ?? "work",
                    agent: input.agent ?? "work",
                    cost: 0,
                    path: { cwd: "/tmp", root: "/tmp" },
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                    modelID: ref.modelID,
                    providerID: ref.providerID,
                    time: { created: Date.now() },
                    finish: "stop" as const,
                  },
                  parts: [],
                } satisfies SessionV1.WithParts
              }
              const resolved = yield* resolveSessionTools(input.sessionID, liveOps)
              const summary = yield* runChild({
                input,
                session: resolved.session,
                assistant: resolved.assistant,
                env: resolved.env,
                callTool: resolved.callTool,
                ops: liveOps,
              })
              const id = MessageID.ascending()
              return {
                info: {
                  id,
                  role: "assistant" as const,
                  parentID: input.messageID ?? MessageID.ascending(),
                  sessionID: input.sessionID,
                  mode: input.agent ?? "general",
                  agent: input.agent ?? "general",
                  cost: 0,
                  path: { cwd: "/tmp", root: "/tmp" },
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  modelID: ref.modelID,
                  providerID: ref.providerID,
                  time: { created: Date.now() },
                  finish: "stop" as const,
                },
                parts: [
                  {
                    id: PartID.ascending(),
                    messageID: id,
                    sessionID: input.sessionID,
                    type: "text" as const,
                    text: `<silvercode-result>${summary}</silvercode-result>`,
                  },
                ],
              } satisfies SessionV1.WithParts
            }).pipe(Effect.orDie),
          ),
      }
      return { liveOps, notifications }
    })

    const dispatchLive = Effect.fn("TaskWorkdirRuntime.dispatchLive")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      promptOps: TaskPromptOps
      prompt?: string
      directory?: string
      taskID?: string
      background?: boolean
      agent?: string
    }) {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      return yield* def.execute(
        {
          description: "runtime folder check",
          prompt: input.prompt ?? "work in assigned folder",
          subagent_type: "general",
          ...(input.background === undefined ? {} : { background: input.background }),
          ...(input.directory === undefined ? {} : { directory: input.directory }),
          ...(input.taskID === undefined ? {} : { task_id: input.taskID }),
        },
        {
          sessionID: input.sessionID,
          messageID: input.messageID,
          agent: input.agent ?? "work",
          abort: new AbortController().signal,
          extra: { promptOps: input.promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
    })

    const autoRejectAsks = Effect.fn("TaskWorkdirRuntime.autoRejectAsks")(function* () {
      const events = yield* EventV2Bridge.Service
      const permissions = yield* Permission.Service
      const asked: PermissionV1.Request[] = []
      yield* Effect.acquireRelease(
        events.listen((event) => {
          if (event.type !== Permission.Event.Asked.type) return Effect.void
          const req = event.data as PermissionV1.Request
          asked.push(req)
          return permissions.reply({ requestID: req.id, reply: "reject" }).pipe(Effect.ignore)
        }),
        (unsubscribe) => unsubscribe,
      )
      return asked
    })

    it.instance(
      "executes foreground child and foreground resume tool turns in the selected folder",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const fgDir = yield* mkdir(path.join(test.directory, "fg-child"))
          yield* put(path.join(test.directory, "note.txt"), "project\n")
          yield* put(path.join(fgDir, "note.txt"), "fg-v1\n")
          yield* put(path.join(fgDir, "sub", "item.txt"), "fg-needle\n")

          const { liveOps } = yield* makeLiveOps(({ input, callTool }) =>
            Effect.gen(function* () {
              const text = input.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n")
              if (text.includes("FG_TURN_1")) {
                const seen = yield* callTool<{ output: string }>("read", { filePath: "note.txt" })
                expect(seen.output).toContain("fg-v1")
                const searched = yield* callTool<{ output: string }>("grep", { pattern: "fg-needle", path: "sub" })
                expect(searched.output).toContain("item.txt")
                yield* callTool("apply_patch", {
                  patchText: [
                    "*** Begin Patch",
                    "*** Update File: note.txt",
                    "@@",
                    "-fg-v1",
                    "+fg-v2",
                    "*** Add File: created.txt",
                    "+fg-created",
                    "*** End Patch",
                  ].join("\n"),
                })
                return "fg-1-ok"
              }
              const created = yield* callTool<{ output: string }>("read", { filePath: "created.txt" })
              expect(created.output).toContain("fg-created")
              yield* callTool("edit", { filePath: "note.txt", oldString: "fg-v2", newString: "fg-v3" })
              return "fg-2-ok"
            }),
          )

          const { chat, assistant } = yield* seed()
          const first = yield* dispatchLive({
            sessionID: chat.id,
            messageID: assistant.id,
            promptOps: liveOps,
            prompt: "FG_TURN_1",
            directory: "fg-child",
            background: false,
          })
          expect(first.metadata.background).toBe(false)
          expect(first.output).toContain("fg-1-ok")
          expect(yield* get(path.join(fgDir, "note.txt"))).toBe("fg-v2\n")

          const second = yield* dispatchLive({
            sessionID: chat.id,
            messageID: assistant.id,
            promptOps: liveOps,
            prompt: "FG_TURN_2",
            taskID: String(first.metadata.sessionId),
            background: false,
          })
          expect(second.metadata.background).toBe(false)
          expect(second.output).toContain("fg-2-ok")
          expect(yield* get(path.join(fgDir, "note.txt"))).toBe("fg-v3\n")
          expect(yield* get(path.join(test.directory, "note.txt"))).toBe("project\n")
        }),
      { config: FOREGROUND },
    )

    it.instance(
      "executes actual background, concurrent sibling, foreground, resumed, and legacy child tool turns in their recorded folders",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const anchor = yield* InstanceState.context
          const initialProcessCwd = process.cwd()
          const fs = yield* FSUtil.Service
          const sessions = yield* Session.Service
          const background = yield* BackgroundJob.Service

          const dirA = yield* mkdir(path.join(test.directory, "child-a"))
          const dirB = yield* mkdir(path.join(test.directory, "child-b"))

          yield* put(path.join(test.directory, "shared.txt"), "root-v1\n")
          yield* put(path.join(test.directory, "sub", "find.txt"), "needle-root\n")

          yield* put(path.join(dirA, "shared.txt"), "a-v1\n")
          yield* put(path.join(dirA, "sub", "find.txt"), "needle-a\n")
          yield* put(path.join(dirA, "drop.txt"), "drop-a\n")
          yield* put(path.join(dirA, "old", "move.txt"), "move-a1\n")

          yield* put(path.join(dirB, "shared.txt"), "b-v1\n")
          yield* put(path.join(dirB, "sub", "find.txt"), "needle-b\n")

          const gate = yield* Deferred.make<void>()
          const enteredA = yield* Deferred.make<void>()
          const enteredB = yield* Deferred.make<void>()

          const { liveOps, notifications } = yield* makeLiveOps(({ input, env, callTool }) =>
            Effect.gen(function* () {
              const promptText = input.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n")

              if (promptText.includes("BG_A_TURN_1")) {
                expect(env).toContain(
                  `Session working folder (Read, Grep, Glob, Edit, Write, ApplyPatch only): ${dirA}`,
                )
                expect(env).toContain(`Project directory (default Shell working directory): ${test.directory}`)
                yield* Deferred.succeed(enteredA, void 0)
                yield* Deferred.await(gate)

                const readRes = yield* callTool<{ output: string }>("read", { filePath: "shared.txt" })
                expect(readRes.output).toContain("a-v1")
                const grepRes = yield* callTool<{ output: string }>("grep", { pattern: "needle", path: "sub" })
                expect(grepRes.output).toContain("find.txt")
                expect(grepRes.output).toContain("needle-a")
                const globRes = yield* callTool<{ output: string }>("glob", { pattern: "*.txt", path: "sub" })
                expect(globRes.output).toContain(path.join(dirA, "sub", "find.txt"))

                yield* callTool("write", { filePath: "written.txt", content: "from-bg-a\n" })
                yield* callTool("edit", { filePath: "shared.txt", oldString: "a-v1", newString: "a-v2" })
                yield* callTool("apply_patch", {
                  patchText: [
                    "*** Begin Patch",
                    "*** Add File: patched/new.txt",
                    "+patched-a",
                    "*** Delete File: drop.txt",
                    "*** Update File: old/move.txt",
                    "*** Move to: moved/final.txt",
                    "@@",
                    "-move-a1",
                    "+move-a2",
                    "*** End Patch",
                  ].join("\n"),
                })
                return "bg-a-done"
              }

              if (promptText.includes("BG_B_TURN_1")) {
                expect(env).toContain(
                  `Session working folder (Read, Grep, Glob, Edit, Write, ApplyPatch only): ${dirB}`,
                )
                yield* Deferred.succeed(enteredB, void 0)
                yield* Deferred.await(gate)

                const readRes = yield* callTool<{ output: string }>("read", { filePath: "shared.txt" })
                expect(readRes.output).toContain("b-v1")
                const grepRes = yield* callTool<{ output: string }>("grep", { pattern: "needle", path: "sub" })
                expect(grepRes.output).toContain("needle-b")
                yield* callTool("write", { filePath: "written.txt", content: "from-bg-b\n" })
                yield* callTool("edit", { filePath: "shared.txt", oldString: "b-v1", newString: "b-v2" })
                return "bg-b-done"
              }

              if (promptText.includes("RESUME_A_TURN_2")) {
                // Omitted directory on resume must keep resolving inside dirA.
                const prev = yield* callTool<{ output: string }>("read", { filePath: "written.txt" })
                expect(prev.output).toContain("from-bg-a")
                yield* callTool("edit", { filePath: "shared.txt", oldString: "a-v2", newString: "a-v3-resumed" })
                return "resume-a-done"
              }

              if (promptText.includes("LEGACY_RESUME")) {
                const legacyRead = yield* callTool<{ output: string }>("read", { filePath: "shared.txt" })
                expect(legacyRead.output).toContain("root-v1")
                expect(legacyRead.output).not.toContain("a-v3-resumed")
                yield* callTool("write", { filePath: "legacy-out.txt", content: "legacy-wrote\n" })
                return "legacy-done"
              }

              return "unexpected"
            }),
          )

          const { chat, assistant } = yield* seed()

          // Launch two actual background sibling tasks concurrently.
          const launchA = yield* dispatchLive({
            sessionID: chat.id,
            messageID: assistant.id,
            promptOps: liveOps,
            prompt: "BG_A_TURN_1",
            directory: "child-a",
            background: true,
          })
          const launchB = yield* dispatchLive({
            sessionID: chat.id,
            messageID: assistant.id,
            promptOps: liveOps,
            prompt: "BG_B_TURN_1",
            directory: dirB,
            background: true,
          })

          // Both returned immediately in running background state while fibers are suspended at `gate`.
          expect(launchA.metadata.background).toBe(true)
          expect(launchB.metadata.background).toBe(true)
          expect(launchA.output).toContain('state="running"')
          expect(launchB.output).toContain('state="running"')
          yield* Deferred.await(enteredA)
          yield* Deferred.await(enteredB)

          // While both background children are in flight, the parent resolves relative tools in test.directory.
          const parentTools = yield* resolveSessionTools(chat.id, liveOps)
          expect(parentTools.env).toContain(`  Working directory: ${test.directory}`)
          const parentRead = yield* parentTools.callTool<{ output: string }>("read", { filePath: "shared.txt" })
          expect(parentRead.output).toContain("root-v1")
          yield* parentTools.callTool("write", { filePath: "written.txt", content: "from-parent\n" })

          // Let both background children finish and wait for their real BackgroundJob settlement.
          yield* Deferred.succeed(gate, void 0)
          const settledA = yield* background.wait({ id: String(launchA.metadata.jobId) })
          const settledB = yield* background.wait({ id: String(launchB.metadata.jobId) })
          expect(settledA.info?.status).toBe("completed")
          expect(settledB.info?.status).toBe("completed")
          expect(settledA.info?.output).toContain("bg-a-done")
          expect(settledB.info?.output).toContain("bg-b-done")

          // Verify isolated filesystem outcomes across parent, sibling A, and sibling B.
          expect(yield* get(path.join(test.directory, "shared.txt"))).toBe("root-v1\n")
          expect(yield* get(path.join(test.directory, "written.txt"))).toBe("from-parent\n")
          expect(yield* fs.existsSafe(path.join(test.directory, "patched", "new.txt"))).toBe(false)

          expect(yield* get(path.join(dirA, "shared.txt"))).toBe("a-v2\n")
          expect(yield* get(path.join(dirA, "written.txt"))).toBe("from-bg-a\n")
          expect(yield* get(path.join(dirA, "patched", "new.txt"))).toBe("patched-a\n")
          expect(yield* fs.existsSafe(path.join(dirA, "drop.txt"))).toBe(false)
          expect(yield* fs.existsSafe(path.join(dirA, "old", "move.txt"))).toBe(false)
          expect(yield* get(path.join(dirA, "moved", "final.txt"))).toBe("move-a2\n")

          expect(yield* get(path.join(dirB, "shared.txt"))).toBe("b-v2\n")
          expect(yield* get(path.join(dirB, "written.txt"))).toBe("from-bg-b\n")

          // Resume completed background child A with omitted `directory`: runs a second turn in dirA.
          const resumeLaunch = yield* dispatchLive({
            sessionID: chat.id,
            messageID: assistant.id,
            promptOps: liveOps,
            prompt: "RESUME_A_TURN_2",
            taskID: String(launchA.metadata.sessionId),
          })
          const settledResume = yield* background.wait({ id: String(resumeLaunch.metadata.jobId) })
          expect(settledResume.info?.status).toBe("completed")
          expect(yield* get(path.join(dirA, "shared.txt"))).toBe("a-v3-resumed\n")

          // Resuming child A with a different directory is refused without moving it.
          const refusedMove = yield* Effect.exit(
            dispatchLive({
              sessionID: chat.id,
              messageID: assistant.id,
              promptOps: liveOps,
              prompt: "SHOULD_NOT_RUN",
              taskID: String(launchA.metadata.sessionId),
              directory: dirB,
            }),
          )
          expect(Exit.isFailure(refusedMove)).toBe(true)
          expect(failure(refusedMove)).toContain("already works in")

          // A legacy child session without metadata.workdir executes relative tools in its creation directory,
          // even when resumed from a parent that works in `dirA`.
          const { chat: shiftedParent, assistant: shiftedAssistant } = yield* seed(dirA)
          const legacySession = yield* sessions.create({
            parentID: shiftedParent.id,
            title: "Legacy runtime child",
          })
          expect(Workdir.read(legacySession.metadata)).toBeUndefined()
          expect(legacySession.directory).toBe(test.directory)
          const legacyRun = yield* dispatchLive({
            sessionID: shiftedParent.id,
            messageID: shiftedAssistant.id,
            promptOps: liveOps,
            prompt: "LEGACY_RESUME",
            taskID: legacySession.id,
          })
          const settledLegacy = yield* background.wait({ id: String(legacyRun.metadata.jobId) })
          expect(settledLegacy.info?.status).toBe("completed")
          expect(yield* get(path.join(test.directory, "legacy-out.txt"))).toBe("legacy-wrote\n")
          expect(yield* fs.existsSafe(path.join(dirA, "legacy-out.txt"))).toBe(false)

          // Background notifications targeted the parent session, and instance/process anchors stayed put.
          expect(notifications.some((n) => n.sessionID === chat.id)).toBe(true)
          expect(yield* InstanceState.context).toEqual(anchor)
          expect(process.cwd()).toBe(initialProcessCwd)
        }),
      { config: PROVIDER_CONFIG },
    )

    it.instance(
      "nested delegation resolves relative and ancestor-relative folders without leaking across parent or siblings",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const initialCwd = process.cwd()
          const alpha = yield* mkdir(path.join(test.directory, "workspace", "alpha"))
          const nested = yield* mkdir(path.join(alpha, "nested"))
          const beta = yield* mkdir(path.join(test.directory, "workspace", "beta"))

          yield* put(path.join(test.directory, "marker.txt"), "root\n")
          yield* put(path.join(alpha, "marker.txt"), "alpha\n")
          yield* put(path.join(nested, "marker.txt"), "nested\n")
          yield* put(path.join(beta, "marker.txt"), "beta\n")

          const { liveOps } = yield* makeLiveOps(({ input, session, assistant, callTool, ops: nestedOps }) =>
            Effect.gen(function* () {
              const text = input.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n")

              if (text.includes("CHILD_ALPHA")) {
                const seen = yield* callTool<{ output: string }>("read", { filePath: "marker.txt" })
                expect(seen.output).toContain("alpha")
                yield* callTool("write", { filePath: "stamped.txt", content: "stamped-alpha\n" })

                // Dispatch two grandchildren from inside alpha: one nested ("nested") and one ancestor-relative ("../beta").
                yield* dispatchLive({
                  sessionID: session.id,
                  messageID: assistant.id,
                  promptOps: nestedOps,
                  prompt: "GRANDCHILD_NESTED",
                  directory: "nested",
                  agent: "general",
                })
                yield* dispatchLive({
                  sessionID: session.id,
                  messageID: assistant.id,
                  promptOps: nestedOps,
                  prompt: "GRANDCHILD_BETA",
                  directory: "../beta",
                  agent: "general",
                })

                // Child's own folder is unchanged after grandchild dispatches.
                const after = yield* callTool<{ output: string }>("read", { filePath: "marker.txt" })
                expect(after.output).toContain("alpha")
                return "alpha-done"
              }

              if (text.includes("GRANDCHILD_NESTED")) {
                const seen = yield* callTool<{ output: string }>("read", { filePath: "marker.txt" })
                expect(seen.output).toContain("nested")
                yield* callTool("write", { filePath: "stamped.txt", content: "stamped-nested\n" })
                return "nested-done"
              }

              if (text.includes("GRANDCHILD_BETA")) {
                const seen = yield* callTool<{ output: string }>("read", { filePath: "marker.txt" })
                expect(seen.output).toContain("beta")
                yield* callTool("apply_patch", {
                  patchText: "*** Begin Patch\n*** Add File: stamped.txt\n+stamped-beta\n*** End Patch",
                })
                return "beta-done"
              }

              return "noop"
            }),
          )

          const { chat, assistant } = yield* seed()
          const res = yield* dispatchLive({
            sessionID: chat.id,
            messageID: assistant.id,
            promptOps: liveOps,
            prompt: "CHILD_ALPHA",
            directory: path.join("workspace", "alpha"),
          })
          expect(res.output).toContain("alpha-done")

          expect(yield* get(path.join(alpha, "stamped.txt"))).toBe("stamped-alpha\n")
          expect(yield* get(path.join(nested, "stamped.txt"))).toBe("stamped-nested\n")
          expect(yield* get(path.join(beta, "stamped.txt"))).toBe("stamped-beta\n")
          expect(process.cwd()).toBe(initialCwd)
        }),
      { config: { ...FOREGROUND, subagent_depth: 2 } },
    )

    it.instance(
      "selecting an external folder grants no runtime trust and still prompts external_directory for every file tool",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const fs = yield* FSUtil.Service
          const permissions = yield* Permission.Service
          const outer = yield* siblingOutside(test.directory, "untrusted")
          yield* put(path.join(outer, "secret.txt"), "secret\n")
          yield* put(path.join(outer, "sub", "item.txt"), "needle\n")

          const asked = yield* autoRejectAsks()

          const { liveOps } = yield* makeLiveOps(({ callTool }) =>
            Effect.gen(function* () {
              const attempts = [
                callTool("read", { filePath: "secret.txt" }),
                callTool("grep", { pattern: "needle", path: "sub" }),
                callTool("glob", { pattern: "*.txt", path: "sub" }),
                callTool("write", { filePath: "created.txt", content: "nope\n" }),
                callTool("edit", { filePath: "secret.txt", oldString: "secret", newString: "tampered" }),
                callTool("apply_patch", {
                  patchText: "*** Begin Patch\n*** Add File: patched.txt\n+nope\n*** End Patch",
                }),
              ]
              for (const attempt of attempts) {
                const exit = yield* Effect.exit(attempt)
                expect(Exit.isFailure(exit)).toBe(true)
              }
              return "all-rejected"
            }),
          )

          const { chat, assistant } = yield* seed()
          const run = yield* dispatchLive({
            sessionID: chat.id,
            messageID: assistant.id,
            promptOps: liveOps,
            directory: outer,
          })
          expect(run.output).toContain("all-rejected")

          // Every single file/search/edit tool hit external_directory and left outer untouched.
          const extAsks = asked.filter((req) => req.permission === "external_directory")
          expect(extAsks).toHaveLength(6)
          expect(yield* get(path.join(outer, "secret.txt"))).toBe("secret\n")
          expect(yield* fs.existsSafe(path.join(outer, "created.txt"))).toBe(false)
          expect(yield* fs.existsSafe(path.join(outer, "patched.txt"))).toBe(false)
          expect((yield* permissions.list()).length).toBe(0)
        }),
      { config: FOREGROUND },
    )

    posixOnlyInstance(
      "selecting an internal symlink to an external folder canonicalizes and still requires external_directory at runtime",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const fs = yield* FSUtil.Service
          const outer = yield* siblingOutside(test.directory, "symlink")
          yield* put(path.join(outer, "secret.txt"), "secret\n")
          yield* Effect.promise(() =>
            import("fs/promises").then((fsp) => fsp.symlink(outer, path.join(test.directory, "escape-link"))),
          )

          const asked = yield* autoRejectAsks()
          const { liveOps } = yield* makeLiveOps(({ session, callTool }) =>
            Effect.gen(function* () {
              expect(Workdir.of(session)).toBe(outer)
              const readExit = yield* Effect.exit(callTool("read", { filePath: "secret.txt" }))
              const patchExit = yield* Effect.exit(
                callTool("apply_patch", {
                  patchText: "*** Begin Patch\n*** Add File: via-link.txt\n+blocked\n*** End Patch",
                }),
              )
              expect(Exit.isFailure(readExit)).toBe(true)
              expect(Exit.isFailure(patchExit)).toBe(true)
              return "symlink-gated"
            }),
          )

          const { chat, assistant } = yield* seed()
          const run = yield* dispatchLive({
            sessionID: chat.id,
            messageID: assistant.id,
            promptOps: liveOps,
            directory: "escape-link",
          })
          expect(run.output).toContain("symlink-gated")
          expect(asked.filter((req) => req.permission === "external_directory")).toHaveLength(2)
          expect(yield* fs.existsSafe(path.join(outer, "via-link.txt"))).toBe(false)
        }),
      { config: FOREGROUND },
    )

    it.instance(
      "inherited external_directory and edit denies block direct, background, resumed, and nested child execution",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const fs = yield* FSUtil.Service
          const sessions = yield* Session.Service
          const background = yield* BackgroundJob.Service
          const deniedOuter = yield* siblingOutside(test.directory, "denied")
          const deniedSub = yield* mkdir(path.join(deniedOuter, "nested"))
          const insideChild = yield* mkdir(path.join(test.directory, "inside-child"))

          yield* put(path.join(deniedOuter, "secret.txt"), "do-not-read\n")
          yield* put(path.join(deniedSub, "secret.txt"), "do-not-read-nested\n")
          yield* put(path.join(insideChild, "readable.txt"), "allowed-internal-read\n")

          const asked = yield* autoRejectAsks()

          const { liveOps } = yield* makeLiveOps(({ input, session, assistant, callTool, ops: nestedOps }) =>
            Effect.gen(function* () {
              const text = input.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n")

              if (text.includes("DIRECT_BG_DENIED")) {
                // External deny short-circuits without prompting, and internal edit deny blocks writes inside project.
                expect(Exit.isFailure(yield* Effect.exit(callTool("read", { filePath: "secret.txt" })))).toBe(true)
                expect(
                  Exit.isFailure(yield* Effect.exit(callTool("write", { filePath: "new.txt", content: "x\n" }))),
                ).toBe(true)

                const extGrandchild = yield* dispatchLive({
                  sessionID: session.id,
                  messageID: assistant.id,
                  promptOps: nestedOps,
                  prompt: "GRANDCHILD_EXTERNAL",
                  directory: "nested",
                  background: false,
                  agent: "general",
                })
                if (extGrandchild.metadata.background) {
                  const extSettled = yield* background.wait({ id: String(extGrandchild.metadata.jobId) })
                  expect(extSettled.info?.status).toBe("completed")
                }

                const intGrandchild = yield* dispatchLive({
                  sessionID: session.id,
                  messageID: assistant.id,
                  promptOps: nestedOps,
                  prompt: "GRANDCHILD_INTERNAL_EDIT_DENIED",
                  directory: insideChild,
                  background: false,
                  agent: "general",
                })
                if (intGrandchild.metadata.background) {
                  const intSettled = yield* background.wait({ id: String(intGrandchild.metadata.jobId) })
                  expect(intSettled.info?.status).toBe("completed")
                }
                return "bg-denied-verified"
              }

              if (text.includes("GRANDCHILD_EXTERNAL")) {
                expect(Exit.isFailure(yield* Effect.exit(callTool("read", { filePath: "secret.txt" })))).toBe(true)
                expect(Exit.isFailure(yield* Effect.exit(callTool("grep", { pattern: "do-not" })))).toBe(true)
                return "grandchild-external-blocked"
              }

              if (text.includes("GRANDCHILD_INTERNAL_EDIT_DENIED")) {
                // Internal read and open-folder writes work, while ancestor's scoped edit deny blocks `locked/*`.
                const okRead = yield* callTool<{ output: string }>("read", { filePath: "readable.txt" })
                expect(okRead.output).toContain("allowed-internal-read")
                yield* callTool("write", { filePath: "open/allowed.txt", content: "permitted\n" })
                expect(
                  Exit.isFailure(
                    yield* Effect.exit(callTool("write", { filePath: "locked/blocked.txt", content: "x\n" })),
                  ),
                ).toBe(true)
                expect(
                  Exit.isFailure(
                    yield* Effect.exit(
                      callTool("apply_patch", {
                        patchText: "*** Begin Patch\n*** Add File: locked/blocked-patch.txt\n+x\n*** End Patch",
                      }),
                    ),
                  ),
                ).toBe(true)
                return "grandchild-edit-blocked"
              }

              if (text.includes("RESUMED_DENIED")) {
                expect(Exit.isFailure(yield* Effect.exit(callTool("read", { filePath: "secret.txt" })))).toBe(true)
                return "resumed-blocked"
              }

              return "noop"
            }),
          )

          const { chat, assistant } = yield* seed()
          yield* sessions.setPermission({
            sessionID: chat.id,
            permission: [
              { permission: "external_directory", pattern: path.join(deniedOuter, "*"), action: "deny" },
              { permission: "edit", pattern: "inside-child/locked/*", action: "deny" },
            ],
          })

          const bgLaunch = yield* dispatchLive({
            sessionID: chat.id,
            messageID: assistant.id,
            promptOps: liveOps,
            prompt: "DIRECT_BG_DENIED",
            directory: deniedOuter,
            background: true,
          })
          expect(bgLaunch.metadata.background).toBe(true)
          const settledBg = yield* background.wait({ id: String(bgLaunch.metadata.jobId) })
          expect(settledBg.info?.status).toBe("completed")
          expect(settledBg.info?.output).toContain("bg-denied-verified")

          const resumed = yield* dispatchLive({
            sessionID: chat.id,
            messageID: assistant.id,
            promptOps: liveOps,
            prompt: "RESUMED_DENIED",
            taskID: String(bgLaunch.metadata.sessionId),
          })
          const settledResumed = yield* background.wait({ id: String(resumed.metadata.jobId) })
          expect(settledResumed.info?.status).toBe("completed")
          expect(settledResumed.info?.output).toContain("resumed-blocked")

          // Deny rules short-circuit in Permission.ask without publishing interactive prompts.
          expect(asked).toHaveLength(0)
          expect(yield* fs.existsSafe(path.join(deniedOuter, "new.txt"))).toBe(false)
          expect(yield* get(path.join(insideChild, "open", "allowed.txt"))).toBe("permitted\n")
          expect(yield* fs.existsSafe(path.join(insideChild, "locked", "blocked.txt"))).toBe(false)
          expect(yield* fs.existsSafe(path.join(insideChild, "locked", "blocked-patch.txt"))).toBe(false)
        }),
      { git: true, config: { ...PROVIDER_CONFIG, subagent_depth: 2 } },
    )

    it.instance(
      "inherited external allows work at runtime inside the allowed folder without extending to external siblings",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const fs = yield* FSUtil.Service
          const sessions = yield* Session.Service
          const permissions = yield* Permission.Service
          const allowedOuter = yield* siblingOutside(test.directory, "allowed")
          const siblingOuter = yield* siblingOutside(test.directory, "sibling")

          yield* put(path.join(allowedOuter, "doc.txt"), "allowed-v1\n")
          yield* put(path.join(allowedOuter, "sub", "item.txt"), "allowed-needle\n")
          yield* put(path.join(siblingOuter, "secret.txt"), "sibling-secret\n")

          const asked = yield* autoRejectAsks()
          const relSiblingDir = path.relative(allowedOuter, siblingOuter)
          const relSiblingSecret = path.relative(allowedOuter, path.join(siblingOuter, "secret.txt"))
          const relSiblingMove = path.relative(allowedOuter, path.join(siblingOuter, "moved.txt"))

          const { liveOps } = yield* makeLiveOps(({ callTool }) =>
            Effect.gen(function* () {
              // Permitted operations inside allowedOuter succeed with zero prompts.
              const readOk = yield* callTool<{ output: string }>("read", { filePath: "doc.txt" })
              expect(readOk.output).toContain("allowed-v1")
              const grepOk = yield* callTool<{ output: string }>("grep", { pattern: "allowed-needle", path: "sub" })
              expect(grepOk.output).toContain("item.txt")
              const globOk = yield* callTool<{ output: string }>("glob", { pattern: "*.txt", path: "sub" })
              expect(globOk.output).toContain(path.join(allowedOuter, "sub", "item.txt"))
              yield* callTool("write", { filePath: "created.txt", content: "allowed-write\n" })
              yield* callTool("edit", { filePath: "doc.txt", oldString: "allowed-v1", newString: "allowed-v2" })
              yield* callTool("apply_patch", {
                patchText: [
                  "*** Begin Patch",
                  "*** Add File: sub/patched.txt",
                  "+patched-inside-allow",
                  "*** End Patch",
                ].join("\n"),
              })

              // Relative escapes from allowedOuter into siblingOuter still prompt external_directory and fail on reject.
              expect(Exit.isFailure(yield* Effect.exit(callTool("read", { filePath: relSiblingSecret })))).toBe(true)
              expect(
                Exit.isFailure(yield* Effect.exit(callTool("grep", { pattern: "sibling", path: relSiblingDir }))),
              ).toBe(true)
              expect(
                Exit.isFailure(yield* Effect.exit(callTool("glob", { pattern: "*.txt", path: relSiblingDir }))),
              ).toBe(true)
              expect(
                Exit.isFailure(
                  yield* Effect.exit(
                    callTool("apply_patch", {
                      patchText: [
                        "*** Begin Patch",
                        "*** Update File: doc.txt",
                        `*** Move to: ${relSiblingMove}`,
                        "@@",
                        "-allowed-v2",
                        "+escaped",
                        "*** End Patch",
                      ].join("\n"),
                    }),
                  ),
                ),
              ).toBe(true)
              return "narrow-allow-verified"
            }),
          )

          const { chat, assistant } = yield* seed()
          const grant = {
            permission: "external_directory",
            pattern: path.join(allowedOuter, "*"),
            action: "allow" as const,
          }
          yield* sessions.setPermission({ sessionID: chat.id, permission: [grant] })

          const res = yield* dispatchLive({
            sessionID: chat.id,
            messageID: assistant.id,
            promptOps: liveOps,
            directory: allowedOuter,
          })
          expect(res.output).toContain("narrow-allow-verified")

          expect(yield* get(path.join(allowedOuter, "doc.txt"))).toBe("allowed-v2\n")
          expect(yield* get(path.join(allowedOuter, "created.txt"))).toBe("allowed-write\n")
          expect(yield* get(path.join(allowedOuter, "sub", "patched.txt"))).toBe("patched-inside-allow\n")
          expect(yield* fs.existsSafe(path.join(siblingOuter, "moved.txt"))).toBe(false)

          // Only the 4 siblingOuter traversal attempts prompted external_directory; allowedOuter prompted 0 times.
          const extAsks = asked.filter((req) => req.permission === "external_directory")
          expect(extAsks).toHaveLength(4)
          for (const req of extAsks) {
            expect(req.patterns.every((p) => p.includes(path.basename(siblingOuter)))).toBe(true)
          }
          expect((yield* sessions.get(chat.id)).permission).toEqual([grant])
          expect((yield* permissions.list()).length).toBe(0)
        }),
      { config: FOREGROUND },
    )
  })
})
