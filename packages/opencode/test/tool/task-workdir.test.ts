import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Todo } from "@/session/todo"
import { Permission } from "@/permission"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
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
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Todo.node,
      Permission.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
  )

const it = testEffect(layer())

const FOREGROUND = {
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
})
