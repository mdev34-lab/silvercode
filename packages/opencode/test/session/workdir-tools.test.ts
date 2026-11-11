import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Exit, Layer } from "effect"
import path from "path"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionSummary } from "@/session/summary"
import { Snapshot } from "@/snapshot"
import { Todo } from "@/session/todo"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { MCP } from "@/mcp"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { SystemPrompt } from "@/session/system"
import { Workdir } from "@/session/workdir"
import { Skill } from "@/skill"
import { ShellID } from "@/tool/shell/id"
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
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

afterEach(async () => {
  await disposeAllInstances()
})

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const summaryStub = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionProjector.node,
      MessageV2.node,
      Snapshot.node,
      LLM.node,
      Env.node,
      Agent.node,
      Command.node,
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
      Git.node,
      Ripgrep.node,
      Format.node,
      Truncate.node,
      SessionProcessor.node,
      Image.node,
      SessionCompaction.node,
      SessionRevert.node,
      SessionSummary.node,
      Instruction.node,
      SystemPrompt.node,
      CrossSpawnSpawner.node,
      RuntimeFlags.node,
      testLLMServerNode,
    ]),
    [[SessionSummary.node, summaryStub]],
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

  it.instance(
    "a child's assembled environment and live tool descriptions never imply shell defaults to the child folder",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const provider = yield* Provider.Service
        const sys = yield* SystemPrompt.Service
        const childDir = path.join(test.directory, "child")
        const fs = yield* FSUtil.Service
        yield* fs.ensureDir(childDir)

        const child = yield* sessions.create({ title: "Child", metadata: Workdir.select(undefined, childDir) })
        const root = yield* sessions.create({ title: "Root" })
        const model = yield* provider.getModel(ref.providerID, ref.modelID)

        const childEnv = (yield* sys.environment(model, Workdir.of(child)))[0]
        const rootEnv = (yield* sys.environment(model, Workdir.of(root)))[0]
        const childTools = yield* resolveTools(child)
        const shellDescription = childTools[ShellID.ToolID]?.description ?? ""

        expect(shellDescription).toContain("Commands run in the working directory by default")
        expect(childEnv).not.toContain(`Working directory: ${childDir}`)
        expect(childEnv.split("\n").some((line) => line.startsWith("  Working directory:"))).toBe(false)
        expect(childEnv).toContain(
          `  Session working folder (Read, Grep, Glob, Edit, Write, ApplyPatch only): ${childDir}`,
        )
        expect(childEnv).toContain(`  Project directory (default Shell working directory): ${test.directory}`)
        expect(childEnv).toContain(`Shell commands do NOT default to ${childDir}`)
        expect(childEnv).toContain(`omitted \`workdir\` runs in ${test.directory}`)
        expect(childEnv).toContain(`a relative \`workdir\` also resolves from ${test.directory}`)
        expect(childEnv).toContain(`pass the explicit absolute \`workdir\` "${childDir}"`)

        expect(rootEnv).toContain(`  Working directory: ${test.directory}`)
        expect(rootEnv).not.toContain("Tool working-directory split")
      }),
    { config },
  )

  it.instance(
    "an external selection keeps the instance anchor and existing access decisions",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const anchor = yield* InstanceState.context
        const processDirectory = process.cwd()
        const sessions = yield* Session.Service
        const permissions = yield* Permission.Service
        const fs = yield* FSUtil.Service
        const allowed = yield* tmpdirScoped()
        const denied = yield* tmpdirScoped()
        yield* fs.writeWithDirs(path.join(allowed, "same.txt"), "allowed copy")
        yield* fs.writeWithDirs(path.join(denied, "same.txt"), "denied copy")
        const permission = [
          { permission: "external_directory", pattern: path.join(allowed, "*"), action: "allow" as const },
          { permission: "external_directory", pattern: path.join(denied, "*"), action: "deny" as const },
        ]
        const allowedChild = yield* sessions.create({
          title: "Allowed child",
          metadata: { workdir: allowed },
          permission,
        })
        const deniedChild = yield* sessions.create({
          title: "Denied child",
          metadata: { workdir: denied },
          permission,
        })

        expect(JSON.stringify(yield* readRelative(allowedChild))).toContain("allowed copy")
        const blocked = yield* Effect.exit(readRelative(deniedChild))
        expect(Exit.isFailure(blocked)).toBe(true)
        expect((yield* permissions.list()).length).toBe(0)
        // The resolution base changed, not the instance or its approval store.
        expect(yield* InstanceState.context).toEqual(anchor)
        expect(process.cwd()).toBe(processDirectory)
        expect(anchor.directory).toBe(test.directory)
      }),
    { config },
  )

  it.instance(
    "live SessionPrompt background delegation and resume run child tools in the selected folder while parent stays on the project",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const llm = yield* TestLLMServer
        const fs = yield* FSUtil.Service
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const background = yield* BackgroundJob.Service

        const childDir = path.join(test.directory, "live-child")
        yield* fs.writeWithDirs(path.join(test.directory, "same.txt"), "project copy\n")
        yield* fs.writeWithDirs(path.join(test.directory, "sub", "item.txt"), "project needle\n")
        yield* fs.writeWithDirs(path.join(childDir, "same.txt"), "child copy\n")
        yield* fs.writeWithDirs(path.join(childDir, "sub", "item.txt"), "child needle\n")

        yield* fs.writeWithDirs(
          path.join(test.directory, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            agent: {
              work: { finishTool: false },
              general: { finishTool: false },
            },
            provider: {
              test: {
                ...config.provider.test,
                options: { ...config.provider.test.options, baseURL: llm.url },
              },
            },
          }),
        )

        const bodyText = (body: Record<string, unknown>) => JSON.stringify(body)
        const isChildSession = (hit: { body: Record<string, unknown> }) =>
          bodyText(hit.body).includes("Session working folder (Read, Grep, Glob, Edit, Write, ApplyPatch only):")
        const isResumeChild = (hit: { body: Record<string, unknown> }) =>
          isChildSession(hit) && bodyText(hit.body).includes("LIVE_RESUME_MARKER")
        const isInitialChild = (hit: { body: Record<string, unknown> }) =>
          isChildSession(hit) && !bodyText(hit.body).includes("LIVE_RESUME_MARKER")
        const isResumeNotification = (hit: { body: Record<string, unknown> }) =>
          !isChildSession(hit) && bodyText(hit.body).includes("child-resumed-complete")
        const isParentResume = (hit: { body: Record<string, unknown> }) =>
          !isChildSession(hit) && bodyText(hit.body).includes("PARENT_RESUME_TURN") && !isResumeNotification(hit)
        const isBgNotification = (hit: { body: Record<string, unknown> }) =>
          !isChildSession(hit) &&
          bodyText(hit.body).includes("child-bg-complete") &&
          !isParentResume(hit) &&
          !isResumeNotification(hit)
        const isParentInitial = (hit: { body: Record<string, unknown> }) =>
          !isChildSession(hit) &&
          bodyText(hit.body).includes("LIVE_PARENT_START") &&
          !isBgNotification(hit) &&
          !isParentResume(hit) &&
          !isResumeNotification(hit)

        // Parent turn 1: dispatch background child into `live-child`, then read relative `same.txt` in project root.
        yield* llm.pushMatch(
          isParentInitial,
          reply().tool("task", {
            description: "delegate live child",
            prompt: "LIVE_CHILD_MARKER inspect child folder",
            subagent_type: "general",
            directory: "live-child",
            background: true,
          }),
          reply().tool("read", { filePath: "same.txt" }),
          reply().text("parent-dispatched").stop(),
        )

        // Background child turn 1: read relative `same.txt`, grep explicit relative `sub`, write `child-note.txt`, deliver result.
        yield* llm.pushMatch(
          isInitialChild,
          reply().tool("read", { filePath: "same.txt" }),
          reply().tool("grep", { pattern: "needle", path: "sub" }),
          reply().tool("write", { filePath: "child-note.txt", content: "written-in-bg\n" }),
          reply().text("<silvercode-result>child-bg-complete</silvercode-result>").stop(),
        )

        // Parent receives synthetic `<task_result>` notification when background child finishes.
        yield* llm.pushMatch(isBgNotification, reply().text("parent-saw-bg-notification").stop())

        const parent = yield* sessions.create({
          title: "Live Parent",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* prompt.prompt({
          sessionID: parent.id,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "LIVE_PARENT_START Research the requested information" }],
        })

        // Find the spawned background child and wait for both its BackgroundJob and parent `<task_result>` delivery.
        const kids = yield* sessions.children(parent.id)
        expect(kids).toHaveLength(1)
        const child = kids[0]
        if (!child) throw new Error("expected spawned child session")
        expect(Workdir.read(child.metadata)).toBe(childDir)

        const waited = yield* background.wait({ id: child.id })
        expect(waited.info?.status).toBe("completed")

        const notification = yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(parent.id)
            return msgs.find(
              (m) =>
                m.info.role === "user" &&
                m.parts.some((p) => p.type === "text" && p.synthetic === true && p.text.includes("child-bg-complete")),
            )
          }),
          "timed out waiting for live background task notification",
          "10 seconds",
        )
        expect(notification).toBeDefined()

        // Verify the parent's own `read` read `project copy`, while the background child read/wrote in `childDir`.
        const parentMsgs = yield* MessageV2.filterCompactedEffect(parent.id)
        const parentReadPart = parentMsgs
          .flatMap((m) => m.parts)
          .find(
            (p): p is SessionV1.ToolPart => p.type === "tool" && p.tool === "read" && p.state.status === "completed",
          )
        expect(parentReadPart?.state.status === "completed" ? parentReadPart.state.output : "").toContain(
          "project copy",
        )

        const childReadFile = yield* Effect.promise(() =>
          import("fs/promises").then((fsp) => fsp.readFile(path.join(childDir, "child-note.txt"), "utf-8")),
        )
        expect(childReadFile).toBe("written-in-bg\n")
        expect(yield* fs.existsSafe(path.join(test.directory, "child-note.txt"))).toBe(false)

        // Verify the live HTTP request sent for the child carried the split `<env>` working-folder block.
        const rawInputs = yield* llm.inputs
        const childReqBody = rawInputs.find((b) => {
          const s = JSON.stringify(b)
          return s.includes("LIVE_CHILD_MARKER") && !s.includes("LIVE_PARENT_START")
        })
        const childMessages = Array.isArray(childReqBody?.messages)
          ? (childReqBody.messages as Array<{ content?: unknown }>)
              .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
              .join("\n")
          : ""
        expect(childMessages).toContain(
          `Session working folder (Read, Grep, Glob, Edit, Write, ApplyPatch only): ${childDir}`,
        )
        expect(childMessages).toContain(`Project directory (default Shell working directory): ${test.directory}`)

        // Resume the completed background child via `task_id` (omitting `directory`): second live turn stays in `childDir`.
        yield* llm.pushMatch(
          isParentResume,
          reply().tool("task", {
            description: "resume live child",
            prompt: "LIVE_RESUME_MARKER update child file",
            subagent_type: "general",
            task_id: child.id,
          }),
          reply().text("parent-triggered-resume").stop(),
        )
        yield* llm.pushMatch(
          isResumeChild,
          reply().tool("read", { filePath: "child-note.txt" }),
          reply().tool("edit", { filePath: "same.txt", oldString: "child copy", newString: "child resumed copy" }),
          reply().text("<silvercode-result>child-resumed-complete</silvercode-result>").stop(),
        )
        yield* llm.pushMatch(isResumeNotification, reply().text("parent-saw-resume").stop())

        yield* prompt.prompt({
          sessionID: parent.id,
          agent: "work",
          model: ref,
          parts: [{ type: "text", text: "PARENT_RESUME_TURN continue child work" }],
        })

        const waitedResume = yield* background.wait({ id: child.id })
        expect(waitedResume.info?.status).toBe("completed")

        const childUpdated = yield* Effect.promise(() =>
          import("fs/promises").then((fsp) => fsp.readFile(path.join(childDir, "same.txt"), "utf-8")),
        )
        const projectUnchanged = yield* Effect.promise(() =>
          import("fs/promises").then((fsp) => fsp.readFile(path.join(test.directory, "same.txt"), "utf-8")),
        )
        expect(childUpdated).toBe("child resumed copy\n")
        expect(projectUnchanged).toBe("project copy\n")
      }),
  )
})
