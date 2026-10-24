import { afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Todo } from "@/session/todo"
import { Permission } from "@/permission"

import { FinishTool, type Reason } from "../../src/tool/finish"
import {
  delegatableAgents,
  describeAgents,
  makeParameters,
  subagentTypeDescription,
  TaskTool,
  type TaskPromptOps,
} from "../../src/tool/task"
import { ToolJsonSchema } from "../../src/tool/json-schema"

type LooseTaskPromptOps = Omit<TaskPromptOps, "prompt"> & {
  prompt(input: Parameters<TaskPromptOps["prompt"]>[0]): Effect.Effect<any, any, any>
}
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = <R = never>(
  flags: Partial<RuntimeFlags.Info> = {},
  extra: LayerNode.Replacement[] = [],
  roots: LayerNode.Node<R>[] = [],
) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
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
      ...roots,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)], ...extra],
  )

const it = testEffect(layer())

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "work",
    model: ref,
    time: { created: Date.now() },
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
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function replyParts(input: SessionPrompt.PromptInput, texts: string[]): SessionV1.WithParts {
  const replied = reply(input, texts[0] ?? "")
  return {
    ...replied,
    parts: texts.map((text) => ({
      id: PartID.ascending(),
      messageID: replied.info.id,
      sessionID: input.sessionID,
      type: "text" as const,
      text,
    })),
  }
}

const REVIEW_REPORT = {
  version: 1,
  revision: "uncommitted",
  assessment: "needs-fixes",
  summary: "The loop skips the first cache entry.",
  findings: [
    {
      severity: "important",
      title: "Off-by-one skips the first entry",
      file: "src/cache.ts",
      line: 42,
      detail: "Start at 0.",
    },
  ],
}

const reviewEnvelope = (report: Record<string, unknown> = REVIEW_REPORT) =>
  ["<silvercode-review>", JSON.stringify(report, null, 2), "</silvercode-review>"].join("\n")

const REVIEW_ANALYSIS = "### Assessment\n\n**Ready to proceed?** Needs fixes"

const REVIEW_REPORT_APPROVED = { ...REVIEW_REPORT, assessment: "approved", summary: "No findings.", findings: [] }
const REVIEW_ANALYSIS_APPROVED = "### Assessment\n\n**Ready to proceed?** Approved"

function reviewOps(chunks: string[]): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) => Effect.sync(() => replyParts(input, chunks)),
  }
}

function reviewRunOps(chunks: string[], summary = "done"): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        const replied = replyParts(input, chunks)
        const now = Date.now()
        const finish: SessionV1.ToolPart = {
          id: PartID.ascending(),
          messageID: replied.info.id,
          sessionID: input.sessionID,
          type: "tool",
          tool: "finish",
          callID: "finish-call",
          state: {
            status: "completed",
            input: { result: summary },
            output: summary,
            title: "finish",
            metadata: {},
            time: { start: now, end: now },
          },
        }
        return { ...replied, parts: [...replied.parts, finish] }
      }),
  }
}

/**
 * Scripts a child run that ends through a completed finish call declaring
 * `reason`, which is the only place the parent-facing termination is read from.
 */
/**
 * Scripts a review child that both delivers the canonical envelope and leaves
 * file writes behind. A reviewer sitting at the depth limit cannot review its
 * own writes, so its ending is an unreviewed handoff to the parent.
 */
function reviewWriteOps(chunks: string[], summary = "done"): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        const replied = replyParts(input, chunks)
        const now = Date.now()
        const write: SessionV1.ToolPart = {
          id: PartID.ascending(),
          messageID: replied.info.id,
          sessionID: input.sessionID,
          type: "tool",
          tool: "edit",
          callID: "edit-call",
          state: {
            status: "completed",
            input: { filePath: "src/cache.ts" },
            output: "edited",
            title: "edit",
            metadata: { reviewLoop: { writesFiles: true } },
            time: { start: now, end: now },
          },
        }
        const finish: SessionV1.ToolPart = {
          id: PartID.ascending(),
          messageID: replied.info.id,
          sessionID: input.sessionID,
          type: "tool",
          tool: "finish",
          callID: "finish-call",
          state: {
            status: "completed",
            input: { result: summary },
            output: summary,
            title: "finish",
            metadata: {},
            time: { start: now, end: now },
          },
        }
        return { ...replied, parts: [...replied.parts, write, finish] }
      }),
  }
}

function finishRunOps(reason: Reason, text: string, summary = text): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        const replied = reply(input, text)
        const now = Date.now()
        const finish: SessionV1.ToolPart = {
          id: PartID.ascending(),
          messageID: replied.info.id,
          sessionID: input.sessionID,
          type: "tool",
          tool: "finish",
          callID: "finish-call",
          state: {
            status: "completed",
            input: { reason, result: summary },
            output: summary,
            title: "finish",
            metadata: {},
            time: { start: now, end: now },
          },
        }
        return { ...replied, parts: [...replied.parts, finish] }
      }),
  }
}

/** The termination element the parent reads out of a `<task>` envelope. */
function terminationOf(envelope: string) {
  return envelope.match(/<termination reason="[a-z_]+">.*<\/termination>/)?.[0]
}

/**
 * Synchronous delegation is opt-in per agent: `agent.<name>.background: false`
 * is what lets a subagent run in its parent's foreground. Tests that exercise the
 * foreground path therefore carry this config, and tests that do not leave it out
 * and get the background default. `review` is the single reviewer after the
 * specialist consolidation, so a generic `review` dispatch reads exactly this
 * entry.
 */
const FOREGROUND = {
  agent: {
    general: { background: false },
    review: { background: false },
  },
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("work")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("work")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "subagent_type parameter enumerates the caller's delegatable agents",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("work")
        const registry = yield* ToolRegistry.Service
        const task = (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)
        expect(task).toBeDefined()
        const schema = ToolJsonSchema.fromTool(task!) as {
          properties: { subagent_type: { description: string } }
        }
        const description = schema.properties.subagent_type.description
        // Generated from the agent registry, same permission-filtered list the
        // tool description appends: no primary agents, no denied names.
        expect(description).toContain("think - Planning specialist.")
        expect(description).toContain("zebra - Zebra agent")
        expect(description).not.toContain("work - General-purpose workhorse")
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "subagent_type parameter hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("work")
        const registry = yield* ToolRegistry.Service
        const task = (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)
        const schema = ToolJsonSchema.fromTool(task!) as {
          properties: { subagent_type: { description: string } }
        }
        const description = schema.properties.subagent_type.description
        expect(description).toContain("alpha - Alpha agent")
        expect(description).not.toContain("zebra - Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "subagent_type parameter honors a per-call ruleset deny",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("work")
        const registry = yield* ToolRegistry.Service
        const task = (
          yield* registry.tools({
            ...ref,
            agent: build,
            permission: Permission.fromConfig({ task: { zebra: "deny" } }),
          })
        ).find((tool) => tool.id === TaskTool.id)
        const schema = ToolJsonSchema.fromTool(task!) as {
          properties: { subagent_type: { description: string } }
        }
        const description = schema.properties.subagent_type.description
        expect(description).toContain("alpha - Alpha agent")
        expect(description).not.toContain("zebra - Zebra agent")
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "execute resumes an existing task session from task_id",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: child.id,
            background: false,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const kids = yield* sessions.children(chat.id)
        expect(kids).toHaveLength(1)
        expect(kids[0]?.id).toBe(child.id)
        expect(result.metadata.sessionId).toBe(child.id)
        expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
        expect(seen?.sessionID).toBe(child.id)
        expect(seen?.variant).toBe("xhigh")
      }),
    { config: FOREGROUND },
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance(
    "execute cancels child session when abort signal fires",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const ready = defer<SessionPrompt.PromptInput>()
        const cancelled = defer<SessionID>()
        const abort = new AbortController()
        const promptOps: TaskPromptOps = {
          cancel: (sessionID) =>
            Effect.sync(() => {
              cancelled.resolve(sessionID)
            }),
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.promise(() => {
              ready.resolve(input)
              return cancelled.promise
            }).pipe(Effect.as(reply(input, "cancelled"))),
        }

        const fiber = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              background: false,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "work",
              abort: abort.signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.forkChild)

        const input = yield* Effect.promise(() => ready.promise)
        abort.abort()
        expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "execute creates a child when task_id does not exist",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: "ses_missing",
            background: false,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const kids = yield* sessions.children(chat.id)
        expect(kids).toHaveLength(1)
        expect(kids[0]?.id).toBe(result.metadata.sessionId)
        expect(result.metadata.sessionId).not.toBe("ses_missing")
        expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
        expect(seen?.sessionID).toBe(result.metadata.sessionId)
      }),
    { config: FOREGROUND },
  )

  it.instance("rejects primary agent targets at the execution seam", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      for (const subagent_type of ["work"]) {
        let asked = 0
        const exit = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "work",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: () =>
                Effect.sync(() => {
                  asked++
                  throw new Error("permission prompt should not run for primary targets")
                }),
            },
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(asked).toBe(0)
        if (!Exit.isFailure(exit)) continue
        expect(Cause.pretty(exit.cause)).toContain(`Agent type ${subagent_type} is a primary agent`)
      }
    }),
  )

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("runs background tasks without requiring an experimental flag", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.background).toBe(true)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
    }),
  )

  // The parent has no way to end its turn while a background child runs unless
  // it is told which finish reason yields instead of terminating. The launch
  // result is where that instruction has to land, because it is the only text
  // the model reads back from the call that started the child.
  it.instance("background launch tells the parent how to yield while the child runs", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain('state="running"')
      expect(result.output).toContain('call finish with reason "waiting_for_subagent"')
      // Scoped to a parent that has not finished: delivering a completed result
      // while a background task keeps running is still the normal ending, and
      // nothing may read the new reason as the only way out.
      expect(result.output).toContain('If your own task is complete, call finish with reason "success" as usual')
      expect(result.output).toContain("does not hold your result back")
      // Scoped to the main session: the wait is refused for a session that is
      // itself a subagent with nothing of its own running, so the instruction
      // must not send one to try it - and it must name the one case where a
      // subagent's yield is accepted (#222).
      expect(result.output).toContain("the main session can call finish")
      expect(result.output).toContain(
        "A subagent may yield the same way only for background subagents it launched itself",
      )
      expect(result.output).toContain("its job stays running until they report")
      expect(result.output).toContain('it must deliver with "success" or "failure" instead')
    }),
  )

  const runReview = (promptOps: TaskPromptOps) =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      return yield* def.execute(
        {
          description: "review cache fix",
          prompt: "review the cache fix",
          subagent_type: "review",
          background: false,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
    })

  it.instance(
    "delivers the review report envelope as the canonical result",
    () =>
      Effect.gen(function* () {
        const result = yield* runReview(reviewRunOps([`${REVIEW_ANALYSIS}\n\n${reviewEnvelope()}`]))

        expect(result.output).toContain(REVIEW_ANALYSIS)
        expect(result.output).toContain("<silvercode-review>")
        expect(result.output).toContain('"needs-fixes"')
        // Exactly one canonical envelope is persisted.
        expect(result.output.match(/<silvercode-review>/g)).toHaveLength(1)
        // The report is associated with the reviewed revision and the child
        // session so the parent knows which work unit was reviewed.
        expect(result.metadata.review.report).toEqual(REVIEW_REPORT)
        expect(result.metadata.review.revision).toBe("uncommitted")
        expect(result.metadata.review.sessionId).toBe(result.metadata.sessionId)
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "a review child that hands off unreviewed writes keeps its canonical report",
    () =>
      Effect.gen(function* () {
        const result = yield* runReview(reviewWriteOps([`${REVIEW_ANALYSIS}\n\n${reviewEnvelope()}`]))

        // The canonical envelope is still the delivery.
        expect(result.output).toContain("<silvercode-review>")
        expect(result.output.match(/<silvercode-review>/g)).toHaveLength(1)
        // The handoff is declared, and it never reads as an approval.
        expect(result.metadata.review.verdict).toBe("pending")
        expect(result.metadata.review.termination).toBe("review-pending")
        expect(result.metadata.reviewLoop).toEqual({
          writesFiles: true,
          handoff: "pending",
          sessionId: result.metadata.sessionId,
        })
        expect(result.output).toContain("UNREVIEWED")
        // The report the parent paid for survives that handoff, and so does what
        // it was about: the reviewed revision and the child that produced it.
        expect(result.metadata.review.report).toEqual(REVIEW_REPORT)
        expect(result.metadata.review.revision).toBe("uncommitted")
        expect(result.metadata.review.sessionId).toBe(result.metadata.sessionId)
      }),
    { config: FOREGROUND },
  )

  // The Approved variant the Needs-fixes fixture could not distinguish: the
  // handoff keeps the report association, yet it can never read as an approval
  // of the child's own edits - the verdict the part declares stays pending.
  it.instance(
    "a review child that hands off unreviewed writes keeps its canonical Approved report",
    () =>
      Effect.gen(function* () {
        const result = yield* runReview(
          reviewWriteOps([`${REVIEW_ANALYSIS_APPROVED}\n\n${reviewEnvelope(REVIEW_REPORT_APPROVED)}`]),
        )

        expect(result.output).toContain("<silvercode-review>")
        expect(result.output.match(/<silvercode-review>/g)).toHaveLength(1)
        // The handoff is declared, and it never reads as an approval.
        expect(result.metadata.review.verdict).toBe("pending")
        expect(result.metadata.review.termination).toBe("review-pending")
        expect(result.metadata.reviewLoop).toEqual({
          writesFiles: true,
          handoff: "pending",
          sessionId: result.metadata.sessionId,
        })
        expect(result.output).toContain("UNREVIEWED")
        // The Approved report the parent paid for survives that handoff, and so
        // does what it was about: the reviewed revision and the child.
        expect(result.metadata.review.report).toEqual(REVIEW_REPORT_APPROVED)
        expect(result.metadata.review.revision).toBe("uncommitted")
        expect(result.metadata.review.sessionId).toBe(result.metadata.sessionId)
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "a trailing empty text part does not erase the review report",
    () =>
      Effect.gen(function* () {
        const result = yield* runReview(reviewRunOps([`${REVIEW_ANALYSIS}\n\n${reviewEnvelope()}`, "", "   \n"]))

        expect(result.output).toContain("<silvercode-review>")
        expect(result.metadata.review.report).toEqual(REVIEW_REPORT)
        expect(result.output).toContain(REVIEW_ANALYSIS)
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "a review report before the final text part is still delivered",
    () =>
      Effect.gen(function* () {
        const result = yield* runReview(reviewRunOps([reviewEnvelope(), "Closing observations after the report."]))

        expect(result.output).toContain("Closing observations after the report.")
        expect(result.output).toContain("<silvercode-review>")
        expect(result.metadata.review.report).toEqual(REVIEW_REPORT)
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "a missing review report envelope fails delivery explicitly",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(runReview(reviewRunOps([REVIEW_ANALYSIS, ""])))

        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return
        const error = Cause.pretty(exit.cause)
        expect(error).toContain("Review delivery failed")
        expect(error).toContain("no <silvercode-review> report envelope was found")
        // The human-readable analysis is preserved in the failure, bounded.
        expect(error).toContain(REVIEW_ANALYSIS)
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "a review run that ends without a completed finish call fails explicitly",
    () =>
      Effect.gen(function* () {
        // The envelope is present in the text, but no finish tool part completed:
        // termination without a successful finish must not silently become a
        // completed review.
        const exit = yield* Effect.exit(runReview(reviewOps([`${REVIEW_ANALYSIS}\n\n${reviewEnvelope()}`])))

        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return
        const error = Cause.pretty(exit.cause)
        expect(error).toContain("Review delivery failed")
        expect(error).toContain("ended without a completed finish call")
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "a malformed review report envelope fails delivery explicitly",
    () =>
      Effect.gen(function* () {
        const malformed = ["<silvercode-review>", "{ not json", "</silvercode-review>"].join("\n")
        const exit = yield* Effect.exit(runReview(reviewRunOps([`${REVIEW_ANALYSIS}\n\n${malformed}`])))

        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return
        const error = Cause.pretty(exit.cause)
        expect(error).toContain("Review delivery failed")
        expect(error).toContain("the envelope content is not a JSON object")
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "an unknown review report schema version fails delivery explicitly",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          runReview(reviewRunOps([`${REVIEW_ANALYSIS}\n\n${reviewEnvelope({ ...REVIEW_REPORT, version: 2 })}`])),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return
        const error = Cause.pretty(exit.cause)
        expect(error).toContain("Review delivery failed")
        expect(error).toContain("unknown report schema version 2")
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "a zero-finding review delivers a valid report",
    () =>
      Effect.gen(function* () {
        const clean = { ...REVIEW_REPORT, assessment: "approved", summary: "Nothing to report.", findings: [] }
        const result = yield* runReview(reviewRunOps([`${REVIEW_ANALYSIS}\n\n${reviewEnvelope(clean)}`]))

        expect(result.output).toContain('"approved"')
        expect(result.metadata.review.report).toEqual(clean)
        expect(result.metadata.review.report.findings).toEqual([])
      }),
    { config: FOREGROUND },
  )

  it.instance("a background review with no report envelope surfaces an explicit delivery failure", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const injected = defer<SessionPrompt.PromptInput>()

      const promptOps: TaskPromptOps = {
        ...reviewOps([REVIEW_ANALYSIS]),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.sync(() => {
                injected.resolve(input)
                return reply(input, "notified")
              })
            : Effect.sync(() => replyParts(input, [REVIEW_ANALYSIS])),
      }

      const result = yield* def.execute(
        {
          description: "review cache fix",
          prompt: "review the cache fix",
          subagent_type: "review",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("error")
      expect(waited.info?.error).toContain("Review delivery failed")
      const notification = yield* Effect.promise(() => injected.promise)
      if (notification.parts[0]?.type === "text") {
        expect(notification.parts[0].text).toContain("<task_error>")
        expect(notification.parts[0].text).toContain("Review delivery failed")
      }
    }),
  )

  it.instance("default task invocations run asynchronously without blocking the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: {
            // The child never finishes; the parent must still return.
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.background).toBe(true)
      expect(result.metadata.sessionId).toBeDefined()
      expect(result.output).toContain(`state="running"`)
      expect(result.output).toContain("You will be notified automatically")
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
    }),
  )

  it.instance(
    "explicit foreground execution (background=false) waits for the child result",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const started = defer<SessionID>()
        const done = defer<void>()
        const promptOps: TaskPromptOps = {
          ...stubOps(),
          prompt: (input) =>
            Effect.promise(async () => {
              started.resolve(input.sessionID)
              await done.promise
              return reply(input, "foreground done")
            }),
        }

        const fiber = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              background: false,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "work",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.forkChild)

        // While the child is still running the job must be foreground and the
        // parent must still be blocked; background-only jobs immediately set
        // metadata.background=true, and a foreground one records the opposite rather
        // than nothing, which is what lets the review loop read the outcome instead of
        // inferring it from the request.
        const sessionID = yield* Effect.promise(() => started.promise)
        const job = yield* jobs.get(sessionID)
        expect(job?.status).toBe("running")
        expect(job?.metadata?.background).toBe(false)

        done.resolve()
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.metadata.background).toBe(false)
          expect(exit.value.output).toContain(`state="completed"`)
          expect(exit.value.output).toContain("foreground done")
        }
        expect((yield* jobs.get(sessionID))?.status).toBe("completed")
      }),
    { config: FOREGROUND },
  )

  it.instance("multiple background tasks run concurrently", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const startA = defer<void>()
      const startB = defer<void>()
      const doneA = defer<void>()
      const doneB = defer<void>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Effect.promise(async () => {
            const text = input.parts[0]?.type === "text" ? input.parts[0].text : ""
            const isA = text.includes("task A")
            ;(isA ? startA : startB).resolve()
            await (isA ? doneA : doneB).promise
            return reply(input, text)
          }),
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "work",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const resultA = yield* def.execute(
        { description: "task A", prompt: "investigate task A", subagent_type: "general" },
        context,
      )
      const resultB = yield* def.execute(
        { description: "task B", prompt: "investigate task B", subagent_type: "general" },
        context,
      )

      expect(resultA.metadata.sessionId).not.toBe(resultB.metadata.sessionId)
      yield* Effect.promise(() => startA.promise)
      yield* Effect.promise(() => startB.promise)

      expect((yield* jobs.get(resultA.metadata.sessionId))?.status).toBe("running")
      expect((yield* jobs.get(resultB.metadata.sessionId))?.status).toBe("running")

      doneA.resolve()
      doneB.resolve()
      const waitedA = yield* jobs.wait({ id: resultA.metadata.sessionId, timeout: 1_000 })
      const waitedB = yield* jobs.wait({ id: resultB.metadata.sessionId, timeout: 1_000 })
      expect(waitedA.info?.status).toBe("completed")
      expect(waitedB.info?.status).toBe("completed")
      expect(waitedA.info?.output).toContain("task A")
      expect(waitedB.info?.output).toContain("task B")
    }),
  )

  it.instance("background task failures are surfaced to the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const injected = defer<SessionPrompt.PromptInput>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.sync(() => {
                injected.resolve(input)
                return reply(input, "notified")
              })
            : Effect.fail(new Error("boom")).pipe(Effect.orDie),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("error")
      expect(waited.info?.error).toBe("boom")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.sessionID).toBe(chat.id)
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") {
        expect(notification.parts[0].text).toContain("<task_error>")
        expect(notification.parts[0].text).toContain("boom")
      }
    }),
  )

  it.instance(
    "promotes a running foreground task without restarting it",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const ready = yield* Deferred.make<void>()
        const done = yield* Deferred.make<void>()
        const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
        let runs = 0
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) => {
            if (input.sessionID === chat.id) {
              return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
            }
            return Effect.gen(function* () {
              runs += 1
              yield* Deferred.succeed(ready, undefined)
              yield* Deferred.await(done)
              return reply(input, "background done")
            })
          },
        }

        const fiber = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              background: false,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "work",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.forkChild)

        yield* Deferred.await(ready)
        const job = (yield* jobs.list())[0]
        expect(job).toBeDefined()
        if (!job) throw new Error("task job not found")
        expect(job.metadata?.parentSessionId).toBe(chat.id)
        yield* jobs.promote(job.id)

        const result = yield* Fiber.join(fiber)
        expect(result.metadata.background).toBe(true)
        expect(result.output).toContain(`state="running"`)
        expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
        expect(runs).toBe(1)

        yield* Deferred.succeed(done, undefined)
        expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
        expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
        expect(runs).toBe(1)
      }),
    { config: FOREGROUND },
  )

  it.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  it.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "work",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  it.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  it.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  it.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )

  // A user cancelling the subagent they are watching reaches the runtime as a
  // cancel of that child session. The parent is blocked on this tool call, and
  // a free-form failure would leave it re-deriving the outcome from prose; the
  // typed termination is what lets it continue orchestration knowing the child
  // did not succeed.
  it.instance(
    "cancelling a blocking subagent returns a typed cancellation to the parent",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const runState = yield* SessionRunState.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const started = defer<SessionID>()
        const cancelled = defer<SessionID>()
        const promptOps: TaskPromptOps = {
          cancel: (sessionID) =>
            Effect.sync(() => {
              cancelled.resolve(sessionID)
            }),
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.sync(() => {
              started.resolve(input.sessionID)
            }).pipe(Effect.andThen(Effect.never)),
        }

        const fiber = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              background: false,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "work",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.forkChild)

        const child = yield* Effect.promise(() => started.promise)
        expect((yield* jobs.get(child))?.status).toBe("running")

        yield* runState.cancel(child)

        const result = yield* Fiber.join(fiber)
        expect(result.metadata.termination.reason).toBe("cancelled")
        expect(result.output).toContain(`<task id="${child}" state="cancelled">`)
        expect(result.output).toContain('<termination reason="cancelled">')
        expect(result.output).toContain("cancelled by the user")
        // The cancel reached the child's execution handle itself, not only the
        // envelope handed back to the parent.
        expect((yield* jobs.get(child))?.status).toBe("cancelled")
        expect(yield* Effect.promise(() => cancelled.promise)).toBe(child)
      }),
    { config: FOREGROUND },
  )

  it.instance("a cancelled background subagent notifies the parent with a typed cancellation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const injected = defer<SessionPrompt.PromptInput>()
      const started = defer<SessionID>()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.sync(() => {
                injected.resolve(input)
                return reply(input, "notified")
              })
            : Effect.sync(() => {
                started.resolve(input.sessionID)
              }).pipe(Effect.andThen(Effect.never)),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      const child = result.metadata.sessionId
      yield* Effect.promise(() => started.promise)

      yield* runState.cancel(child)

      expect((yield* jobs.wait({ id: child, timeout: 1_000 })).info?.status).toBe("cancelled")
      const notification = yield* Effect.promise(() => injected.promise)
      const text = notification.parts[0]?.type === "text" ? notification.parts[0].text : ""
      expect(notification.sessionID).toBe(chat.id)
      expect(text).toMatch(new RegExp(`<task id="${child}" run="${child}@\\d+" state="cancelled">`))
      expect(text).toContain("<summary>Background task cancelled: inspect bug</summary>")
      expect(text).toContain('<termination reason="cancelled">')
      expect(text).toContain("cancelled by the user")
    }),
  )

  // Ctrl+C (or the parent's own double-Esc) cancels the parent run, and the
  // teardown sweeps up every job underneath it. Reporting those cancellations
  // back would prompt the session that is stopping and undo the interrupt, so
  // an ancestor-driven cancel must be swallowed while a targeted one is not.
  it.instance("a parent teardown sweeps a background subagent without notifying the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const injections: string[] = []
      const silent: SessionPrompt.PromptInput[] = []
      const started = defer<SessionID>()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.sync(() => {
                if (input.noReply) {
                  silent.push(input)
                  return reply(input, "recorded without waking")
                }
                const part = input.parts[0]
                injections.push(part?.type === "text" ? part.text : "")
                return reply(input, "notified")
              })
            : Effect.sync(() => {
                started.resolve(input.sessionID)
              }).pipe(Effect.andThen(Effect.never)),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      const child = result.metadata.sessionId
      yield* Effect.promise(() => started.promise)

      yield* runState.cancel(chat.id)

      const swept = yield* jobs.wait({ id: child, timeout: 1_000 })
      expect(swept.info?.status).toBe("cancelled")
      // The tag is what distinguishes "the user stopped this child" from "the
      // session above it stopped and took the child with it".
      expect(swept.info?.cancelledByTeardown).toBe(true)

      // The job has settled, so the watcher has everything it needs to deliver
      // a notification. It must never do so, teardown cancels are dropped.
      const notified = yield* pollWithTimeout(
        Effect.sync(() => (injections.length > 0 ? injections.join("\n") : undefined)),
        "a teardown cancel notified the parent",
        "250 millis",
      ).pipe(Effect.exit)
      expect(Exit.isFailure(notified)).toBe(true)
      expect(injections).toEqual([])
      expect(silent).toHaveLength(1)
      const receipt = silent[0]?.parts[0]
      expect(receipt?.type === "text" && receipt.text).toContain('state="cancelled"')
      expect(receipt?.type === "text" && receipt.metadata?.backgroundNoReply).toBe(true)
    }),
  )

  // Session removal is a teardown too: the whole tree is going away, so the
  // jobs it sweeps must carry the same marker the run-state path sets (#413).
  it.instance("removing a session sweeps a background subagent without notifying the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const injections: string[] = []
      const silent: SessionPrompt.PromptInput[] = []
      const started = defer<SessionID>()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.sync(() => {
                if (input.noReply) {
                  silent.push(input)
                  return reply(input, "recorded without waking")
                }
                const part = input.parts[0]
                injections.push(part?.type === "text" ? part.text : "")
                return reply(input, "notified")
              })
            : Effect.sync(() => {
                started.resolve(input.sessionID)
              }).pipe(Effect.andThen(Effect.never)),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      const child = result.metadata.sessionId
      yield* Effect.promise(() => started.promise)

      yield* sessions.remove(chat.id)

      const swept = yield* jobs.wait({ id: child, timeout: 1_000 })
      expect(swept.info?.status).toBe("cancelled")
      expect(swept.info?.cancelledByTeardown).toBe(true)

      // The job has settled, so the watcher has everything it needs to deliver
      // a notification. It must never wake the parent; the envelope is
      // recorded silently to resolve the row.
      const notified = yield* pollWithTimeout(
        Effect.sync(() => (injections.length > 0 ? injections.join("\n") : undefined)),
        "a removal cancel notified the parent",
        "250 millis",
      ).pipe(Effect.exit)
      expect(Exit.isFailure(notified)).toBe(true)
      expect(injections).toEqual([])
      expect(silent).toHaveLength(1)
      const receipt = silent[0]?.parts[0]
      expect(receipt?.type === "text" && receipt.text).toContain('state="cancelled"')
      expect(receipt?.type === "text" && receipt.metadata?.backgroundNoReply).toBe(true)
    }),
  )

  // Double-Esc is scoped to the trace it is pressed in. Cancelling one child
  // must not reach the sibling's job or the parent's own run, and the parent
  // must still be driven by the sibling's completion afterwards.
  it.instance("cancelling one subagent leaves its sibling and the parent's orchestration intact", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed("Isolation")
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const injections: string[] = []
      const delivered = defer<void>()
      const runningB = defer<void>()
      const gates = new Map<string, () => void>()
      const hold = (key: string) => {
        const entry = defer<void>()
        gates.set(key, () => entry.resolve())
        return entry.promise
      }
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Effect.sync(() => {
              const part = input.parts[0]
              injections.push(part?.type === "text" ? part.text : "")
              if (injections.length === 2) delivered.resolve()
              return reply(input, "notified")
            })
          }
          const text = input.parts[0]?.type === "text" ? input.parts[0].text : ""
          const key = text.includes("task B") ? "B" : "A"
          const gate = hold(key)
          if (key === "B") runningB.resolve()
          return Effect.promise(() => gate).pipe(Effect.as(reply(input, `${key} done`)))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "work",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const a = yield* def.execute(
        { description: "task A", prompt: "investigate task A", subagent_type: "general" },
        context,
      )
      const b = yield* def.execute(
        { description: "task B", prompt: "investigate task B", subagent_type: "general" },
        context,
      )
      yield* Effect.promise(() => runningB.promise)

      yield* runState.cancel(a.metadata.sessionId)

      expect((yield* jobs.get(a.metadata.sessionId))?.status).toBe("cancelled")
      expect((yield* jobs.get(b.metadata.sessionId))?.status).toBe("running")

      gates.get("B")?.()
      expect((yield* jobs.wait({ id: b.metadata.sessionId, timeout: 1_000 })).info?.status).toBe("completed")

      yield* Effect.promise(() => delivered.promise)
      expect(injections.find((text) => text.includes('state="cancelled"'))).toContain(
        "<summary>Background task cancelled: task A</summary>",
      )
      expect(injections.find((text) => text.includes('state="completed"'))).toContain("task B")
    }),
  )

  it.instance(
    "a declared terminal reason delivers the same termination in the background and the foreground",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const tool = yield* TaskTool
        const def = yield* tool.init()
        for (const reason of ["subagent_wait", "failure", "success"] as const) {
          const { chat, assistant } = yield* seed(`Parity ${reason}`)
          const injected = defer<SessionPrompt.PromptInput>()
          const child = finishRunOps(reason, "child done")
          const context = (promptOps: TaskPromptOps) => ({
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          })
          const params = {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          }

          const foreground = yield* def.execute({ ...params, background: false }, context(child))
          expect(foreground.metadata.termination.reason).toBe(reason)
          expect(terminationOf(foreground.output)).toBeDefined()

          const background = yield* def.execute(
            { ...params, background: true },
            context({
              ...child,
              prompt: (input) =>
                input.sessionID === chat.id
                  ? Effect.sync(() => {
                      injected.resolve(input)
                      return reply(input, "notified")
                    })
                  : child.prompt(input),
            }),
          )
          yield* jobs.wait({ id: background.metadata.sessionId, timeout: 1_000 })
          const notification = yield* Effect.promise(() => injected.promise)
          const delivered = notification.parts[0]?.type === "text" ? notification.parts[0].text : ""

          expect(delivered).toContain("child done")
          // The contract: both delivery paths expose the same termination to the
          // parent. These two assertions are what fail if the paths diverge, and
          // the parity check alone would also pass if both sides rendered nothing.
          expect(terminationOf(foreground.output)).toContain(`<termination reason="${reason}">`)
          expect(terminationOf(delivered)).toBe(terminationOf(foreground.output))
          if (reason === "subagent_wait") {
            expect(terminationOf(delivered)).toContain("not in flight")
          }
        }
      }),
    { config: FOREGROUND },
  )

  // Synchronous execution is a configuration choice, not a tool argument: a stuck
  // child must not be able to hold the parent's execution path just because the
  // caller asked to wait for it. Only `agent.<name>.background: false` in
  // opencode.json lets a subagent block, and it blocks by default for that agent.
  it.instance("a background=false request is ignored for a subagent that is not opted in", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: false,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          // The child never finishes; the parent must still return.
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(result.output).toContain("The task is running in the background")
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
    }),
  )

  it.instance(
    "an opted-in subagent waits for the result without being asked to",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const promptOps = stubOps({ text: "opted in" })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        // No `background` request: the agent's own configuration decides, and the
        // result is delivered in this call rather than by a later notification. The
        // part records that outcome, so a reader never has to guess it from the
        // missing argument.
        expect(result.metadata.background).toBe(false)
        expect(result.output).toContain(`state="completed"`)
        expect(result.output).toContain("opted in")
        expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("completed")
      }),
    { config: FOREGROUND },
  )

  it.instance(
    "an opted-in subagent still runs in the background when asked for it",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: () => Effect.never,
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.metadata.background).toBe(true)
        expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      }),
    { config: FOREGROUND },
  )

  // Opt-in is per subagent: configuring one delegate does not change another, and
  // an unconfigured reviewer takes the background default.
  it.instance(
    "synchronous opt-in is configured per subagent",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const context = (promptOps: TaskPromptOps) => ({
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })

        const review = yield* def.execute(
          {
            description: "review cache fix",
            prompt: "review the cache fix",
            subagent_type: "review",
          },
          context(reviewRunOps([`${REVIEW_ANALYSIS}\n\n${reviewEnvelope()}`])),
        )
        const general = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: false,
          },
          context({
            ...stubOps(),
            prompt: () => Effect.never,
          }),
        )

        // The reviewer was opted in, so its report came back in the tool result.
        expect(review.metadata.background).toBe(false)
        expect(review.output).toContain("<silvercode-review>")
        expect(review.metadata.review.report).toEqual(REVIEW_REPORT)
        // `general` was not, so the same synchronous request became a launch.
        expect(general.metadata.background).toBe(true)
        expect(general.output).toContain(`state="running"`)
        expect((yield* jobs.get(general.metadata.sessionId))?.status).toBe("running")
      }),
    { config: { agent: { review: { background: false } } } },
  )

  // A routed review dispatch can be configured under two names, and they can
  // disagree, so the precedence is pinned here: the agent that actually runs
  // decides, and the requested name is only the fallback for a runner that says
  // nothing. `work-review` is what a `review` request from Work runs as.
  it.instance(
    "the running reviewer's own config overrides an opt-in written under the requested name",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "review cache fix",
            prompt: "review the cache fix",
            subagent_type: "review",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: () => Effect.never,
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        // `agent.review.background: false` still says the run should be waited on,
        // and the reviewer that runs says it should not. The launch wins: the
        // parent is notified rather than held, which is the whole point of
        // background being the default.
        expect(result.metadata.background).toBe(true)
        expect(result.output).toContain(`state="running"`)
        expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      }),
    {
      config: {
        agent: {
          review: { background: false },
          "work-review": { background: true },
        },
      },
    },
  )

  it.instance(
    "configuring the reviewer that runs opts in a request that named it indirectly",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "review cache fix",
            prompt: "review the cache fix",
            subagent_type: "review",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: { promptOps: reviewRunOps([`${REVIEW_ANALYSIS}\n\n${reviewEnvelope()}`]) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        // Nothing was requested about execution mode, and the name the caller
        // used is not configured at all: the runner's own opt-in is enough, and it is
        // recorded as a foreground delivery rather than left implied.
        expect(result.metadata.background).toBe(false)
        expect(result.output).toContain(`state="completed"`)
        expect(result.metadata.review.report).toEqual(REVIEW_REPORT)
        expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("completed")
      }),
    { config: { agent: { "work-review": { background: false } } } },
  )

  // Both modes end through the same finish contract: the termination the child
  // declared is delivered identically whether the parent waited for it or was
  // notified of it.
  it.instance(
    "a synchronous subagent delivers the same result and termination as a background one",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const injected = defer<SessionPrompt.PromptInput>()
        const child = finishRunOps("failure", "child done")
        const params = {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        }
        const sync = yield* def.execute(params, {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps: child },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })
        const notify: TaskPromptOps = {
          ...child,
          prompt: (input) =>
            input.sessionID === chat.id
              ? Effect.sync(() => {
                  injected.resolve(input)
                  return reply(input, "notified")
                })
              : child.prompt(input),
        }
        const queued = yield* def.execute(
          { ...params, background: true },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: { promptOps: notify },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        yield* jobs.wait({ id: queued.metadata.sessionId, timeout: 1_000 })
        const notification = yield* Effect.promise(() => injected.promise)
        const delivered = notification.parts[0]?.type === "text" ? notification.parts[0].text : ""

        expect(terminationOf(sync.output)).toContain('<termination reason="failure">')
        expect(terminationOf(delivered)).toBe(terminationOf(sync.output))
        expect(delivered).toContain("child done")
        expect(sync.output).toContain("child done")
        expect(sync.metadata.termination.reason).toBe("failure")
        expect(queued.metadata.background).toBe(true)
      }),
    { config: FOREGROUND },
  )

  // A declared yield has no delivered counterpart: the finish tool refuses the
  // wait for a session that is itself a subagent, so a child should not declare
  // it at all, and a transcript that still does must not put a provisional
  // result on the wire as a terminal one. The result text still arrives - what
  // is dropped is the termination element and its metadata.
  it.instance(
    "a declared yield delivers no termination to the parent",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const { chat, assistant } = yield* seed("Yield drop")
        const injected = defer<SessionPrompt.PromptInput>()
        const child = finishRunOps("waiting_for_subagent", "child yielded")
        const context = (promptOps: TaskPromptOps) => ({
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })
        const params = {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        }

        const foreground = yield* def.execute({ ...params, background: false }, context(child))
        expect(foreground.output).toContain("child yielded")
        expect(terminationOf(foreground.output)).toBeUndefined()
        expect(foreground.metadata.termination).toBeUndefined()

        const background = yield* def.execute(
          { ...params, background: true },
          context({
            ...child,
            prompt: (input) =>
              input.sessionID === chat.id
                ? Effect.sync(() => {
                    injected.resolve(input)
                    return reply(input, "notified")
                  })
                : child.prompt(input),
          }),
        )
        yield* jobs.wait({ id: background.metadata.sessionId, timeout: 1_000 })
        const notification = yield* Effect.promise(() => injected.promise)
        const delivered = notification.parts[0]?.type === "text" ? notification.parts[0].text : ""

        expect(delivered).toContain("child yielded")
        expect(terminationOf(delivered)).toBeUndefined()
      }),
    { config: FOREGROUND },
  )
})

describe("tool.task - storage failures", () => {
  for (const outcome of ["completed", "defect"] as const) {
    it.instance(`history recovery failure propagates after ${outcome} and unsubscribes`, () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const events = yield* EventV2Bridge.Service
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
        const historyError = new Error("History storage defect")
        const taskError = new Error("Child execution defect")
        let unsubscribed = 0
        let recovered = 0
        let runExit: Exit.Exit<string, unknown> | undefined
        const tool = yield* TaskTool.pipe(
          Effect.provideService(Session.Service, {
            ...sessions,
            messages: (input) => {
              if (input.sessionID !== child.id) return sessions.messages(input)
              recovered++
              return Effect.die(historyError)
            },
          }),
          Effect.provideService(EventV2Bridge.Service, {
            ...events,
            listen: (listener) =>
              events.listen(listener).pipe(
                Effect.map((unsubscribe) =>
                  unsubscribe.pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        unsubscribed++
                      }),
                    ),
                  ),
                ),
              ),
          }),
          Effect.provideService(BackgroundJob.Service, {
            ...jobs,
            start: (input) =>
              jobs.start({
                ...input,
                run: input.run.pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      runExit = exit
                    }),
                  ),
                ),
              }),
          }),
        )
        const def = yield* tool.init()
        const exit = yield* def
          .execute(
            {
              description: "inspect",
              prompt: "inspect",
              subagent_type: "general",
              task_id: child.id,
              background: false,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "work",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
              extra: {
                promptOps: {
                  ...stubOps(),
                  prompt: (input: SessionPrompt.PromptInput) =>
                    outcome === "defect" ? Effect.die(taskError) : Effect.succeed(reply(input, "done")),
                },
              },
            },
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(recovered).toBe(1)
        expect(unsubscribed).toBe(1)
        expect((yield* jobs.get(child.id))?.status).toBe("error")
        expect(runExit && Exit.isFailure(runExit)).toBe(true)
        if (!runExit || Exit.isSuccess(runExit)) return
        expect(runExit.cause.reasons).toContainEqual(expect.objectContaining({ _tag: "Die", defect: historyError }))
        if (outcome === "defect") {
          expect(runExit.cause.reasons).toContainEqual(expect.objectContaining({ _tag: "Die", defect: taskError }))
          expect(runExit.cause.reasons).toHaveLength(2)
        }
        if (outcome === "completed" && Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain(historyError.message)
        }
      }),
      { config: FOREGROUND },
    )
  }

  for (const failure of ["storage", "not-found-defect"] as const) {
    it.instance(`resume ${failure} does not replace or mutate the requested child`, () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({
          parentID: chat.id,
          title: "Existing child",
          metadata: { effort: "fast" },
        })
        const before = yield* sessions.get(child.id)
        const error =
          failure === "storage" ? new Error("Resume storage defect") : new NotFoundError({ message: "NotFound defect" })
        let created = 0
        let metadataWrites = 0
        let prompted = 0
        const tool = yield* TaskTool.pipe(
          Effect.provideService(Session.Service, {
            ...sessions,
            get: (id) => (id === child.id ? Effect.die(error) : sessions.get(id)),
            create: (input) => {
              created++
              return sessions.create(input)
            },
            setMetadata: (input) => {
              metadataWrites++
              return sessions.setMetadata(input)
            },
          }),
        )
        const def = yield* tool.init()
        const exit = yield* def
          .execute(
            {
              description: "inspect",
              prompt: "inspect",
              subagent_type: "general",
              task_id: child.id,
              effort: "thorough",
              background: false,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "work",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
              extra: { promptOps: stubOps({ onPrompt: () => prompted++ }) },
            },
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(exit.cause.reasons).toContainEqual(expect.objectContaining({ _tag: "Die", defect: error }))
        expect(created).toBe(0)
        expect(metadataWrites).toBe(0)
        expect(prompted).toBe(0)
        expect(yield* sessions.get(child.id)).toEqual(before)
        expect((yield* sessions.children(chat.id)).map((child) => child.id)).toEqual([child.id])
      }),
    )
  }

  it.instance("resume typed NotFound creates a child for a genuinely missing task", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const missing = SessionID.make("ses_missing_storage_test")
      const lookup = yield* sessions.get(missing).pipe(Effect.exit)
      expect(Exit.isFailure(lookup)).toBe(true)
      if (Exit.isFailure(lookup))
        expect(lookup.cause.reasons).toContainEqual(
          expect.objectContaining({ _tag: "Fail", error: expect.any(NotFoundError) }),
        )
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { description: "inspect", prompt: "inspect", subagent_type: "general", task_id: missing, background: false },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
          extra: { promptOps: stubOps() },
        },
      )
      const children = yield* sessions.children(chat.id)
      expect(children).toHaveLength(1)
      expect(result.metadata.sessionId).toBe(children[0]?.id)
      expect(result.metadata.sessionId).not.toBe(missing)
      expect(result.output).toContain('state="completed"')
    }),
    { config: FOREGROUND },
  )
})

describe("tool.task - child write handoff", () => {
  for (const outcome of ["completed", "error", "background"] as const) {
    it.instance(
      `projects child writes before ${outcome} delivery`,
      () =>
        Effect.gen(function* () {
          const { chat, assistant } = yield* seed()
          const sessions = yield* Session.Service
          const parentPart: SessionV1.ToolPart = {
            id: PartID.ascending(),
            sessionID: chat.id,
            messageID: assistant.id,
            type: "tool",
            tool: "task",
            callID: "parent-write-task",
            state: {
              status: "running",
              input: { subagent_type: "general", background: false },
              time: { start: Date.now() },
            },
          }
          yield* sessions.updatePart(parentPart)
          const jobs = yield* BackgroundJob.Service
          const tool = yield* TaskTool
          const def = yield* tool.init()
          let observed: Record<string, any> = {}
          const promptOps: TaskPromptOps = {
            ...stubOps(),
            prompt: (input) =>
              Effect.gen(function* () {
                const response = reply(input, "changed files")
                yield* sessions.updateMessage(response.info)
                const part: SessionV1.ToolPart = {
                  id: PartID.ascending(),
                  sessionID: input.sessionID,
                  messageID: response.info.id,
                  type: "tool",
                  tool: "write",
                  callID: "child-write",
                  state: {
                    status: "completed",
                    input: {},
                    output: "written",
                    title: "write",
                    metadata: { reviewLoop: { writesFiles: true } },
                    time: { start: Date.now(), end: Date.now() },
                  },
                }
                yield* sessions.updatePart(part)
                const parentHistory = yield* sessions.messages({ sessionID: chat.id })
                const persisted = parentHistory.flatMap((m) => m.parts).find((p) => p.id === parentPart.id)
                expect(
                  persisted?.type === "tool" &&
                    persisted.state.status === "running" &&
                    persisted.state.metadata?.reviewLoop?.writesFiles,
                ).toBe(true)
                if (outcome === "error") return yield* Effect.fail(new Error("Child crashed after write"))
                return { ...response, parts: [...response.parts, part] }
              }).pipe(Effect.orDie),
          }
          const exit = yield* def
            .execute(
              { description: "write", prompt: "write", subagent_type: "general", background: outcome === "background" },
              {
                callID: "parent-write-task",
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "work",
                abort: new AbortController().signal,
                extra: { promptOps },
                messages: [],
                metadata: (value) =>
                  Effect.sync(() => {
                    observed = value.metadata ?? {}
                  }),
                ask: () => Effect.void,
              },
            )
            .pipe(Effect.exit)
          if (outcome === "background" && Exit.isSuccess(exit)) {
            yield* jobs.wait({ id: exit.value.metadata.sessionId })
          }
          const parentHistory = yield* sessions.messages({ sessionID: chat.id })
          const persisted = parentHistory.flatMap((m) => m.parts).find((p) => p.id === parentPart.id)
          expect(
            persisted?.type === "tool" &&
              persisted.state.status === "running" &&
              persisted.state.metadata?.reviewLoop?.writesFiles,
          ).toBe(true)
          if (outcome === "completed") {
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.metadata.review?.termination).toBe("review-pending")
              expect(exit.value.output).toContain("UNREVIEWED")
            }
          } else if (outcome === "error") expect(Exit.isFailure(exit)).toBe(true)
          else expect(Exit.isSuccess(exit)).toBe(true)
        }),
      { config: FOREGROUND },
    )
  }
})

// Force the reverse ordering through the real store: projectWrites captures a
// running snapshot, completion commits, then the projection resumes.
class ReverseGate extends Context.Service<
  ReverseGate,
  {
    current?: { partID: PartID; sessionID: SessionID; ready: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
  }
>()("TaskTest.ReverseGate") {}
const reverseGateNode = LayerNode.make({
  service: ReverseGate,
  layer: Layer.sync(ReverseGate, () => ({})),
  deps: [],
})
// Preserve the real node's service, implementation, dependency array and types.
// Only its resolver identity changes, preventing the replacement from cycling.
const reverseBase = { ...Session.node, name: "@opencode/Session.reverseBase" }
const reverseSession = LayerNode.make({
  service: Session.Service,
  layer: Layer.effect(
    Session.Service,
    Effect.gen(function* () {
      const base = yield* Session.Service
      const reverseGate = yield* ReverseGate
      return Session.Service.of({
        ...base,
        messages: (input) =>
          Effect.gen(function* () {
            const messages = yield* base.messages(input)
            const gate = reverseGate.current
            if (
              gate &&
              input.sessionID === gate.sessionID &&
              messages
                .flatMap((message) => message.parts)
                .some((part) => part.id === gate.partID && part.type === "tool" && part.state.status === "running")
            ) {
              reverseGate.current = undefined
              yield* Deferred.succeed(gate.ready, undefined)
              yield* Deferred.await(gate.release)
            }
            return messages
          }),
      })
    }),
  ),
  deps: [reverseBase, reverseGateNode],
})
const itReverse = testEffect(layer({}, [[Session.node, reverseSession]], [reverseGateNode]))

itReverse.instance(
  "child write projection preserves completion committed after its running snapshot",
  () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const sessions = yield* Session.Service
      const reverseGate = yield* ReverseGate
      expect(reverseBase.dependencies).toBe(Session.node.dependencies)
      expect(reverseBase.implementation).toBe(Session.node.implementation)
      expect(reverseBase.service).toBe(Session.node.service)
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const running: SessionV1.ToolPart = {
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: assistant.id,
        type: "tool",
        tool: "task",
        callID: "reverse-order",
        state: { status: "running", input: { subagent_type: "general" }, time: { start: 1 } },
      }
      yield* sessions.updatePart(running)
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const timeline: string[] = []
      const run = yield* def
        .execute(
          { description: "write", prompt: "write", subagent_type: "general", background: false },
          {
            callID: running.callID,
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: (input: SessionPrompt.PromptInput) =>
                  Effect.gen(function* () {
                    const response = reply(input, "changed files")
                    yield* sessions.updateMessage(response.info)
                    reverseGate.current = { partID: running.id, sessionID: chat.id, ready, release }
                    yield* sessions.updatePart({
                      id: PartID.ascending(),
                      sessionID: input.sessionID,
                      messageID: response.info.id,
                      type: "tool",
                      tool: "write",
                      callID: "child-reverse-write",
                      state: {
                        status: "completed",
                        input: {},
                        output: "written",
                        title: "write",
                        metadata: { reviewLoop: { writesFiles: true } },
                        time: { start: 1, end: 2 },
                      },
                    })
                    timeline.push("projection persisted")
                    return response
                  }),
              } satisfies TaskPromptOps,
            },
          },
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      timeline.push("running snapshot captured")
      yield* sessions.modifyPart({ partID: running.id, messageID: assistant.id, sessionID: chat.id }, (part) =>
        part?.type === "tool"
          ? {
              ...part,
              state: {
                status: "completed",
                input: part.state.input,
                output: "canonical result",
                title: "canonical title",
                time: { start: 1, end: 99 },
                metadata: { completion: "kept", reviewLoop: { report: "kept" } },
              },
            }
          : undefined,
      )
      timeline.push("completion persisted")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(run)
      const persisted = yield* sessions.getPart({ partID: running.id, messageID: assistant.id, sessionID: chat.id })
      expect(timeline).toEqual(["running snapshot captured", "completion persisted", "projection persisted"])
      expect(persisted?.type).toBe("tool")
      if (persisted?.type !== "tool") return
      expect(persisted.state.status).toBe("completed")
      if (persisted.state.status !== "completed") return
      expect(persisted.state.output).toBe("canonical result")
      expect(persisted.state.title).toBe("canonical title")
      expect(persisted.state.time).toEqual({ start: 1, end: 99 })
      expect(persisted.state.metadata.completion).toBe("kept")
      expect(persisted.state.metadata.reviewLoop).toMatchObject({ writesFiles: true, report: "kept" })
    }),
  { config: FOREGROUND },
)

// A subagent can yield for background subagents it launched itself (#222). Its
// run ends at the yield but its work does not: the job stays running, the child
// is resumed by the report one of those subagents delivered, and the parent
// receives exactly one delivery - the child's terminal result - so no
// provisional envelope ever claims to be the run's outcome.
it.instance("a child that yields for its own subagents keeps its job running and delivers its final result once", () =>
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service
    const { chat, assistant } = yield* seed("Nested wait")
    const tool = yield* TaskTool
    const def = yield* tool.init()

    const grandchild = SessionID.make("ses_grandchild_nested")
    const report = defer<string>()
    const childTurns = { count: 0 }
    const childPrompts: SessionPrompt.PromptInput[] = []
    const parentPrompts: SessionPrompt.PromptInput[] = []

    const finishPart = (
      messageID: MessageID,
      sessionID: SessionID,
      reason: string,
      result: string,
    ): SessionV1.ToolPart => {
      const now = Date.now()
      return {
        id: PartID.ascending(),
        messageID,
        sessionID,
        type: "tool",
        tool: "finish",
        callID: PartID.ascending(),
        state: {
          status: "completed",
          input: { reason, result },
          output: result,
          title: result,
          metadata: {},
          time: { start: now, end: now },
        },
      }
    }

    const promptOps: TaskPromptOps = {
      cancel: () => Effect.void,
      resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
      prompt: (input) => {
        if (input.sessionID === chat.id) {
          parentPrompts.push(input)
          return Effect.sync(() => reply(input, "notified"))
        }
        childPrompts.push(input)
        childTurns.count++
        if (childTurns.count === 1)
          return Effect.gen(function* () {
            // What the child's own task tool did during this turn: launch a
            // background subagent that is still running when the child yields.
            yield* jobs.start({
              id: grandchild,
              type: "task",
              title: "grandchild work",
              metadata: { parentSessionId: input.sessionID, sessionId: grandchild, background: true },
              run: Effect.promise(() => report.promise).pipe(Effect.as("grandchild result")),
            })
            const replied = reply(input, "waiting for the grandchild")
            return {
              ...replied,
              parts: [
                ...replied.parts,
                finishPart(replied.info.id, input.sessionID, "waiting_for_subagent", "waiting"),
              ],
            }
          })
        const replied = reply(input, "child final result")
        return Effect.sync(() => ({
          ...replied,
          parts: [...replied.parts, finishPart(replied.info.id, input.sessionID, "success", "child final result")],
        }))
      },
    }

    const launched = yield* def.execute(
      { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
      {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "work",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      },
    )
    const child = SessionID.make(launched.metadata.sessionId)

    // Parked: the child's first turn ended at its yield while its own subagent
    // keeps running, so the job is still running and the status says the
    // session is not finished - a parent may wait on it again.
    yield* pollWithTimeout(
      Effect.gen(function* () {
        const job = yield* jobs.get(child)
        if (job?.status !== "running" || childTurns.count !== 1) return undefined
        const current = yield* status.get(child)
        return current.type === "busy" ? true : undefined
      }),
      "child job did not stay running while its subagent runs",
    )
    // No provisional delivery: the parent hears about the child once, and only
    // when the child actually terminates.
    expect(parentPrompts).toHaveLength(0)

    report.resolve("released")

    const settled = yield* jobs.wait({ id: child, timeout: 5_000 })
    expect(settled.info?.status).toBe("completed")
    expect(settled.info?.output).toContain("child final result")

    yield* pollWithTimeout(
      Effect.sync(() => (parentPrompts.length === 1 ? true : undefined)),
      "the child's final result was not delivered to the parent",
    )
    const delivery = parentPrompts[0]
    const delivered = delivery?.parts[0]?.type === "text" ? delivery.parts[0].text : ""
    expect(delivery?.sessionID).toBe(chat.id)
    expect(delivered).toMatch(new RegExp(`<task id="${child}" run="${child}@\\d+" state="completed">`))
    expect(delivered).toContain("child final result")
    expect(delivered).toContain('<termination reason="success">')

    // The resumed turn was prompted by the report its own subagent delivered:
    // same envelope the notification path injects, addressed to the child.
    const resume = childPrompts[1]
    const resumed = resume?.parts[0]?.type === "text" ? resume.parts[0].text : ""
    expect(childPrompts).toHaveLength(2)
    expect(resumed).toMatch(new RegExp(`<task id="${grandchild}" run="${grandchild}@\\d+" state="completed">`))
    expect(resumed).toContain("grandchild result")
    expect(resumed).toContain("Background task completed: grandchild work")

    // The parked status did not outlive the park.
    expect((yield* status.get(child)).type).toBe("idle")
  }),
)

// A report can settle while the child's turn is still running: the child
// launched a background subagent, the subagent finished, and the child's turn
// then ends in a yield. The parked job delivers that report itself - the
// notification path stands down for a session that is a running task job's
// subject - so the child is resumed exactly once and its final result still
// reaches its own parent.
it.instance(
  "a report that settled while the child's turn ran is delivered when the child parks",
  () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed("Mid-turn report")
      const childTool = yield* TaskTool
      const childDef = yield* childTool.init()
      const nestedTool = yield* TaskTool
      const nestedDef = yield* nestedTool.init()

      const report = defer<string>()
      const childPrompts: SessionPrompt.PromptInput[] = []
      const nestedPrompts: SessionPrompt.PromptInput[] = []
      const parentPrompts: SessionPrompt.PromptInput[] = []

      const finishPart = (
        messageID: MessageID,
        sessionID: SessionID,
        reason: string,
        result: string,
      ): SessionV1.ToolPart => {
        const now = Date.now()
        return {
          id: PartID.ascending(),
          messageID,
          sessionID,
          type: "tool",
          tool: "finish",
          callID: PartID.ascending(),
          state: {
            status: "completed",
            input: { reason, result },
            output: result,
            title: result,
            metadata: {},
            time: { start: now, end: now },
          },
        }
      }

      // The grandchild's own run: released by the child's turn, so the report
      // settles before that turn ends.
      const nestedOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          nestedPrompts.push(input)
          return Effect.promise(() => report.promise).pipe(
            Effect.map(() => {
              const replied = reply(input, "grandchild result")
              return {
                ...replied,
                parts: [...replied.parts, finishPart(replied.info.id, input.sessionID, "success", "grandchild result")],
              }
            }),
          )
        },
      }

      const childOps: LooseTaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            parentPrompts.push(input)
            return Effect.sync(() => reply(input, "notified"))
          }
          childPrompts.push(input)
          if (childPrompts.length > 1) {
            const replied = reply(input, "child final result")
            return Effect.sync(() => ({
              ...replied,
              parts: [...replied.parts, finishPart(replied.info.id, input.sessionID, "success", "child final result")],
            }))
          }
          return Effect.gen(function* () {
            // A real dispatch runs inside a real assistant message of the child
            // session; the task tool reads that message for its model.
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              agent: "general",
              model: ref,
              time: { created: Date.now() },
            })
            const dispatch: SessionV1.Assistant = {
              id: MessageID.ascending(),
              role: "assistant",
              parentID: user.id,
              sessionID: input.sessionID,
              mode: "general",
              agent: "general",
              cost: 0,
              path: { cwd: "/tmp", root: "/tmp" },
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ref.modelID,
              providerID: ref.providerID,
              variant: "xhigh",
              time: { created: Date.now() },
            }
            yield* sessions.updateMessage(dispatch)
            const nested = yield* Effect.orDie(
              nestedDef.execute(
                { description: "grandchild work", prompt: "do the nested work", subagent_type: "general" },
                {
                  sessionID: input.sessionID,
                  messageID: dispatch.id,
                  agent: "general",
                  abort: new AbortController().signal,
                  extra: { promptOps: nestedOps, bypassAgentCheck: true },
                  messages: [],
                  metadata: () => Effect.void,
                  ask: () => Effect.void,
                },
              ),
            )
            // The subagent finishes while this turn is still running, then the
            // turn yields for it.
            report.resolve("released")
            yield* jobs.wait({ id: nested.metadata.sessionId, timeout: 5_000 }).pipe(Effect.orDie)
            // A lone settled child cannot satisfy the real finish guard.
            // Another child still runs, so this wait is reachable in production.
            const spare = yield* jobs.start({
              id: `${input.sessionID}_spare`,
              type: "task",
              metadata: { parentSessionId: input.sessionID },
              run: Effect.never,
            })
            expect(spare.status).toBe("running")
            const finish = yield* (yield* FinishTool).init()
            const accepted = yield* Effect.orDie(
              finish.execute(
                { reason: "waiting_for_subagent", result: "waiting" },
                {
                  sessionID: input.sessionID,
                  messageID: dispatch.id,
                  agent: "general",
                  abort: new AbortController().signal,
                  messages: [],
                  metadata: () => Effect.void,
                  ask: () => Effect.void,
                },
              ),
            )
            expect(accepted.metadata.waiting).toBe(true)
            const part = finishPart(dispatch.id, input.sessionID, "waiting_for_subagent", "waiting")
            if (part.state.status === "completed") {
              part.state.output = accepted.output
              part.state.metadata = accepted.metadata
            }
            yield* sessions.updatePart(part)
            return { info: dispatch, parts: [part] }
          })
        },
      }

      const launched = yield* childDef.execute(
        { description: "nested dispatch", prompt: "look into the cache key path", subagent_type: "general" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps: childOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      const child = SessionID.make(launched.metadata.sessionId)

      const settled = yield* jobs.wait({ id: child, timeout: 5_000 })
      expect(settled.info?.status).toBe("completed")
      yield* jobs.cancel(`${child}_spare`, { teardown: true })
      expect(settled.info?.output).toContain("child final result")

      yield* pollWithTimeout(
        Effect.sync(() => (parentPrompts.length === 1 ? true : undefined)),
        "the child's final result was not delivered to the parent",
      )
      const delivered = parentPrompts[0]?.parts[0]?.type === "text" ? parentPrompts[0].parts[0].text : ""
      expect(delivered).toMatch(new RegExp(`<task id="${child}" run="${child}@\\d+" state="completed">`))
      expect(delivered).toContain("child final result")

      // The child was resumed by the parked job with the settled report, and
      // the notification path did not prompt it a second time for that report.
      expect(childPrompts).toHaveLength(2)
      const resumed = childPrompts[1]?.parts[0]?.type === "text" ? childPrompts[1].parts[0].text : ""
      expect(resumed).toContain('state="completed"')
      expect(resumed).toContain("grandchild result")
      expect(nestedPrompts.filter((input) => input.sessionID !== chat.id && input.sessionID !== child)).toHaveLength(1)
      expect(nestedPrompts.filter((input) => input.sessionID === child)).toHaveLength(0)
    }),
  { config: { subagent_depth: 2 } },
)

// A report can settle while the child's turn is still running: the child
// promoted a foreground subagent before its first write. The subagent finished
// and the child's turn then ends in a yield. The parked job delivers that report itself - the
// notification path stands down for a session that is a running task job's
// subject - so the child is resumed exactly once and its final result still
// reaches its own parent.
it.instance(
  "a foreground descendant promoted before writing carries review evidence when its parent resumes",
  () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed("Mid-turn report")
      const childTool = yield* TaskTool
      const childDef = yield* childTool.init()
      const nestedTool = yield* TaskTool
      const nestedDef = yield* nestedTool.init()

      const report = defer<string>()
      const ready = yield* Deferred.make<SessionID>()
      const childPrompts: SessionPrompt.PromptInput[] = []
      const nestedPrompts: SessionPrompt.PromptInput[] = []
      const parentPrompts: SessionPrompt.PromptInput[] = []

      const finishPart = (
        messageID: MessageID,
        sessionID: SessionID,
        reason: string,
        result: string,
      ): SessionV1.ToolPart => {
        const now = Date.now()
        return {
          id: PartID.ascending(),
          messageID,
          sessionID,
          type: "tool",
          tool: "finish",
          callID: PartID.ascending(),
          state: {
            status: "completed",
            input: { reason, result },
            output: result,
            title: result,
            metadata: {},
            time: { start: now, end: now },
          },
        }
      }

      // The grandchild's own run: released by the child's turn, so the report
      // settles before that turn ends.
      const nestedOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          nestedPrompts.push(input)
          return Effect.gen(function* () {
            yield* Deferred.succeed(ready, input.sessionID)
            yield* Effect.promise(() => report.promise)
            const replied = reply(input, "grandchild result")
            yield* sessions.updateMessage(replied.info)
            const write: SessionV1.ToolPart = {
              id: PartID.ascending(),
              messageID: replied.info.id,
              sessionID: input.sessionID,
              type: "tool",
              tool: "write",
              callID: "promoted-nested-write",
              state: {
                status: "completed",
                input: {},
                output: "written",
                title: "write",
                metadata: { reviewLoop: { writesFiles: true } },
                time: { start: Date.now(), end: Date.now() },
              },
            }
            yield* sessions.updatePart(write)
            return {
              ...replied,
              parts: [
                ...replied.parts,
                write,
                finishPart(replied.info.id, input.sessionID, "success", "grandchild result"),
              ],
            }
          })
        },
      }

      const childOps: LooseTaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            parentPrompts.push(input)
            return Effect.sync(() => reply(input, "notified"))
          }
          childPrompts.push(input)
          if (childPrompts.length > 1) {
            return Effect.gen(function* () {
              const incoming = yield* sessions.updateMessage({
                id: input.messageID ?? MessageID.ascending(),
                role: "user",
                sessionID: input.sessionID,
                agent: "general",
                model: ref,
                time: { created: Date.now() },
              })
              for (const part of input.parts)
                if (part.type === "text")
                  yield* sessions.updatePart({
                    ...part,
                    id: PartID.ascending(),
                    messageID: incoming.id,
                    sessionID: input.sessionID,
                  })
              const replied = reply(input, "child final result")
              return {
                ...replied,
                parts: [
                  ...replied.parts,
                  finishPart(replied.info.id, input.sessionID, "success", "child final result"),
                ],
              }
            })
          }
          return Effect.gen(function* () {
            // A real dispatch runs inside a real assistant message of the child
            // session; the task tool reads that message for its model.
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              agent: "general",
              model: ref,
              time: { created: Date.now() },
            })
            const dispatch: SessionV1.Assistant = {
              id: MessageID.ascending(),
              role: "assistant",
              parentID: user.id,
              sessionID: input.sessionID,
              mode: "general",
              agent: "general",
              cost: 0,
              path: { cwd: "/tmp", root: "/tmp" },
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              modelID: ref.modelID,
              providerID: ref.providerID,
              variant: "xhigh",
              time: { created: Date.now() },
            }
            yield* sessions.updateMessage(dispatch)
            const pending = yield* Effect.orDie(
              nestedDef.execute(
                {
                  description: "grandchild work",
                  prompt: "do the nested work",
                  subagent_type: "general",
                  background: false,
                },
                {
                  sessionID: input.sessionID,
                  messageID: dispatch.id,
                  agent: "general",
                  abort: new AbortController().signal,
                  extra: { promptOps: nestedOps, bypassAgentCheck: true },
                  messages: [],
                  metadata: () => Effect.void,
                  ask: () => Effect.void,
                },
              ),
            ).pipe(Effect.forkChild)
            const nestedID = yield* Deferred.await(ready)
            expect((yield* jobs.get(nestedID))?.metadata?.background).toBe(false)
            yield* jobs.promote(nestedID)
            expect((yield* jobs.get(nestedID))?.metadata?.background).toBe(true)
            const nested = yield* Fiber.join(pending)
            // The subagent finishes while this turn is still running, then the
            // turn yields for it.
            report.resolve("released")
            yield* jobs.wait({ id: nested.metadata.sessionId, timeout: 5_000 }).pipe(Effect.orDie)
            // A lone settled child cannot satisfy the real finish guard.
            // Another child still runs, so this wait is reachable in production.
            const spare = yield* jobs.start({
              id: `${input.sessionID}_spare`,
              type: "task",
              metadata: { parentSessionId: input.sessionID },
              run: Effect.never,
            })
            expect(spare.status).toBe("running")
            const finish = yield* (yield* FinishTool).init()
            const accepted = yield* Effect.orDie(
              finish.execute(
                { reason: "waiting_for_subagent", result: "waiting" },
                {
                  sessionID: input.sessionID,
                  messageID: dispatch.id,
                  agent: "general",
                  abort: new AbortController().signal,
                  messages: [],
                  metadata: () => Effect.void,
                  ask: () => Effect.void,
                },
              ),
            )
            expect(accepted.metadata.waiting).toBe(true)
            const part = finishPart(dispatch.id, input.sessionID, "waiting_for_subagent", "waiting")
            if (part.state.status === "completed") {
              part.state.output = accepted.output
              part.state.metadata = accepted.metadata
            }
            yield* sessions.updatePart(part)
            return { info: dispatch, parts: [part] }
          })
        },
      }

      const launched = yield* childDef.execute(
        {
          description: "nested dispatch",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps: childOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      const child = SessionID.make(launched.metadata.sessionId)

      const settled = yield* jobs.wait({ id: child, timeout: 5_000 })
      expect(settled.info?.status).toBe("completed")
      yield* jobs.cancel(`${child}_spare`, { teardown: true })
      expect(settled.info?.output).toContain("child final result")
      const deliveryPart = childPrompts[1]?.parts[0]
      expect(deliveryPart?.type === "text" && deliveryPart.text.includes("UNREVIEWED")).toBe(true)
      expect(deliveryPart?.type === "text" ? deliveryPart.metadata?.reviewLoop : undefined).toMatchObject({
        writesFiles: true,
      })

      yield* pollWithTimeout(
        Effect.sync(() => (parentPrompts.length === 1 ? true : undefined)),
        "the child's final result was not delivered to the parent",
      )
      const delivered = parentPrompts[0]?.parts[0]?.type === "text" ? parentPrompts[0].parts[0].text : ""
      expect(delivered).toMatch(new RegExp(`<task id="${child}" run="${child}@\\d+" state="completed">`))
      expect(delivered).toContain("child final result")
      expect(delivered).toContain("UNREVIEWED")

      // The child was resumed by the parked job with the settled report, and
      // the notification path did not prompt it a second time for that report.
      expect(childPrompts).toHaveLength(2)
      const resumed = childPrompts[1]?.parts[0]?.type === "text" ? childPrompts[1].parts[0].text : ""
      expect(resumed).toContain('state="completed"')
      expect(resumed).toContain("grandchild result")
      expect(nestedPrompts.filter((input) => input.sessionID !== chat.id && input.sessionID !== child)).toHaveLength(1)
      expect(nestedPrompts.filter((input) => input.sessionID === child)).toHaveLength(0)
    }),
  { config: { subagent_depth: 2, agent: { general: { background: false } } } },
)

// A subagent that reports while the child's turn is still running is the same
// wait seen from the other side: the notification path stands down for a
// session that is a running task job's subject, so the report is still in hand
// when the child yields - the park has to deliver it rather than wait for an
// event that already happened.
for (const teardown of [false, true]) {
  it.instance(
    teardown
      ? "a nested teardown records its terminal receipt without waking its live launcher"
      : "a subagent that reported before the child parked is delivered by the parked job",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed("Report before the park")
        const childTool = yield* TaskTool
        const childDef = yield* childTool.init()
        const nestedTool = yield* TaskTool
        const nestedDef = yield* nestedTool.init()

        const report = defer<string>()
        const childPrompts: SessionPrompt.PromptInput[] = []
        const nestedPrompts: SessionPrompt.PromptInput[] = []
        const parentPrompts: SessionPrompt.PromptInput[] = []

        const finishPart = (
          messageID: MessageID,
          sessionID: SessionID,
          reason: string,
          result: string,
        ): SessionV1.ToolPart => {
          const now = Date.now()
          return {
            id: PartID.ascending(),
            messageID,
            sessionID,
            type: "tool",
            tool: "finish",
            callID: PartID.ascending(),
            state: {
              status: "completed",
              input: { reason, result },
              output: result,
              title: result,
              metadata: {},
              time: { start: now, end: now },
            },
          }
        }

        const nestedOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) => {
            nestedPrompts.push(input)
            if (input.noReply) return Effect.succeed(reply(input, "silent receipt"))
            return Effect.promise(() => report.promise).pipe(
              Effect.map(() => {
                const replied = reply(input, "grandchild result BEFORE_PARK")
                return {
                  ...replied,
                  parts: [
                    ...replied.parts,
                    finishPart(replied.info.id, input.sessionID, "success", "grandchild result BEFORE_PARK"),
                  ],
                }
              }),
            )
          },
        }

        const childOps: LooseTaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) => {
            if (input.sessionID === chat.id) {
              parentPrompts.push(input)
              return Effect.sync(() => reply(input, "notified"))
            }
            childPrompts.push(input)
            if (childPrompts.length > 1) {
              const replied = reply(input, "child final result AFTER_PARK")
              return Effect.sync(() => ({
                ...replied,
                parts: [
                  ...replied.parts,
                  finishPart(replied.info.id, input.sessionID, "success", "child final result AFTER_PARK"),
                ],
              }))
            }
            return Effect.gen(function* () {
              // A real dispatch runs inside a real assistant message of the child
              // session; the task tool reads that message for its model.
              const user = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "user",
                sessionID: input.sessionID,
                agent: "general",
                model: ref,
                time: { created: Date.now() },
              })
              const dispatch: SessionV1.Assistant = {
                id: MessageID.ascending(),
                role: "assistant",
                parentID: user.id,
                sessionID: input.sessionID,
                mode: "general",
                agent: "general",
                cost: 0,
                path: { cwd: "/tmp", root: "/tmp" },
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ref.modelID,
                providerID: ref.providerID,
                variant: "xhigh",
                time: { created: Date.now() },
              }
              yield* sessions.updateMessage(dispatch)
              // The child launches its own subagent through the real dispatch, so
              // the report reaches the notification path this test is about.
              const nested = yield* Effect.orDie(
                nestedDef.execute(
                  { description: "grandchild work", prompt: "do the nested work", subagent_type: "general" },
                  {
                    sessionID: input.sessionID,
                    messageID: dispatch.id,
                    agent: "general",
                    abort: new AbortController().signal,
                    extra: { promptOps: nestedOps, bypassAgentCheck: true },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  },
                ),
              )
              // It reports before this turn ends, so by the time the child yields
              // the report has already settled - with nothing left to notify.
              if (teardown) yield* jobs.cancel(nested.metadata.sessionId, { teardown: true })
              report.resolve("released")
              yield* jobs.wait({ id: nested.metadata.sessionId, timeout: 5_000 }).pipe(Effect.orDie)
              if (teardown) {
                yield* pollWithTimeout(
                  Effect.sync(() =>
                    nestedPrompts.find((prompt) => prompt.sessionID === input.sessionID && prompt.noReply),
                  ),
                  "nested teardown did not write its silent terminal receipt",
                )
                const replied = reply(input, "AFTER_PARK")
                return {
                  ...replied,
                  parts: [...replied.parts, finishPart(replied.info.id, input.sessionID, "success", "AFTER_PARK")],
                }
              }
              // A lone settled child cannot satisfy the real finish guard.
              // Another child still runs, so this wait is reachable in production.
              const spare = yield* jobs.start({
                id: `${input.sessionID}_spare`,
                type: "task",
                metadata: { parentSessionId: input.sessionID },
                run: Effect.never,
              })
              expect(spare.status).toBe("running")
              const finish = yield* (yield* FinishTool).init()
              const accepted = yield* Effect.orDie(
                finish.execute(
                  { reason: "waiting_for_subagent", result: "waiting" },
                  {
                    sessionID: input.sessionID,
                    messageID: dispatch.id,
                    agent: "general",
                    abort: new AbortController().signal,
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  },
                ),
              )
              expect(accepted.metadata.waiting).toBe(true)
              const part = finishPart(dispatch.id, input.sessionID, "waiting_for_subagent", "waiting")
              if (part.state.status === "completed") {
                part.state.output = accepted.output
                part.state.metadata = accepted.metadata
              }
              yield* sessions.updatePart(part)
              return { info: dispatch, parts: [part] }
            })
          },
        }

        const launched = yield* childDef.execute(
          { description: "nested dispatch", prompt: "look into the cache key path", subagent_type: "general" },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: { promptOps: childOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        const child = SessionID.make(launched.metadata.sessionId)

        const settled = yield* jobs.wait({ id: child, timeout: 5_000 })
        expect(settled.info?.status).toBe("completed")
        yield* jobs.cancel(`${child}_spare`, { teardown: true })
        expect(settled.info?.output).toContain("AFTER_PARK")

        yield* pollWithTimeout(
          Effect.sync(() => (parentPrompts.length === 1 ? true : undefined)),
          "the child's final result was not delivered to the parent",
        )
        const delivered = parentPrompts[0]?.parts[0]?.type === "text" ? parentPrompts[0].parts[0].text : ""
        expect(delivered).toMatch(new RegExp(`<task id="${child}" run="${child}@\\d+" state="completed">`))
        expect(delivered).toContain("AFTER_PARK")

        // The settled report was delivered by the park, with no second prompt from
        // the notification path: the child's own two turns are all it took.
        expect(childPrompts).toHaveLength(teardown ? 1 : 2)
        const resumed = childPrompts[1]?.parts[0]?.type === "text" ? childPrompts[1].parts[0].text : ""
        if (teardown) {
          const receipts = nestedPrompts.filter((input) => input.sessionID === child)
          expect(receipts).toHaveLength(1)
          expect(receipts[0]?.noReply).toBe(true)
          const part = receipts[0]?.parts[0]
          expect(part?.type === "text" && part.text).toContain('state="cancelled"')
          expect(part?.type === "text" && part.metadata?.backgroundNoReply).toBe(true)
        } else {
          expect(resumed).toContain('state="completed"')
          expect(resumed).toContain("BEFORE_PARK")
          expect(nestedPrompts.filter((input) => input.sessionID === child)).toHaveLength(0)
        }
      }),
    { config: { subagent_depth: 2 } },
  )
}

describe("tool.task delegation enumeration", () => {
  const agentInfo = (over: Partial<Agent.Info>): Agent.Info => ({
    name: "agent-x",
    mode: "subagent",
    permission: Permission.fromConfig({ "*": "allow" }),
    options: {},
    ...over,
  })
  const allow = Permission.fromConfig({ "*": "allow" })

  test("subagent_type falls back to the bare description when nobody is delegatable", () => {
    expect(subagentTypeDescription([])).toBe("The type of specialized agent to use for this task")
    expect(describeAgents([])).toContain("Available agent types and the tools they have access to:")
  })

  test("hidden agents are never advertised", () => {
    const list = delegatableAgents([agentInfo({ name: "ghost", hidden: true })], allow)
    expect(list).toEqual([])
  })

  test("prose and parameter descriptions enumerate the same names, including description-less agents", () => {
    const list = delegatableAgents(
      [agentInfo({ name: "silent" }), agentInfo({ name: "plan", description: "Plans things." })],
      allow,
    )
    const prose = describeAgents(list)
    const param = subagentTypeDescription(list)
    for (const name of ["plan", "silent"]) {
      expect(prose).toContain(name)
      expect(param).toContain(name)
    }
    expect(param).toContain("plan - Plans things.")
    expect(prose).toContain("- silent: This subagent should only be called manually by the user.")
  })

  test("task-denied agents are excluded from the enumeration", () => {
    const list = delegatableAgents(
      [agentInfo({ name: "zebra" }), agentInfo({ name: "alpha" })],
      Permission.fromConfig({ task: { "*": "allow", zebra: "deny" } }),
    )
    expect(list.map((item) => item.name)).toEqual(["alpha"])
  })

  test("makeParameters memoizes on the rendered description", () => {
    expect(makeParameters("same input")).toBe(makeParameters("same input"))
  })
})
