import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import { Session, readAgentEffort } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FinishTool } from "@/tool/finish"
import { Permission } from "@/permission"
import { TaskTool } from "@/tool/task"
import { BackgroundJob } from "@/background/job"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { REVIEW_LOOP_METADATA } from "@opencode-ai/core/review-loop"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import type { TaskPromptOps } from "@/tool/task"
import type { SessionPrompt } from "@/session/prompt"

// Narrows an optional persisted field by type. A missing field fails the test loudly.
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected the persisted field to be present")
  return value
}

afterEach(async () => {
  await disposeAllInstances()
})

const layer = () =>
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      Session.node,
      SessionProjector.node,
      Todo.node,
      Truncate.node,
      Agent.node,
      Config.node,
      EventV2Bridge.node,
      Permission.node,
      CrossSpawnSpawner.node,
      FSUtil.node,
      BackgroundJob.node,
      SessionRunState.node,
      SessionStatus.node,
      ToolRegistry.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
  )

const it = testEffect(layer())

const seedSession = Effect.fn("AgentEffortTest.seedSession")(function* (
  options: {
    title?: string
    agent?: string
    pinnedAgent?: string
    metadata?: Record<string, unknown>
    permission?: PermissionV1.Rule[]
  } = {},
) {
  const session = yield* Session.Service
  const agent = options.agent ?? "work"
  const chat = yield* session.create({
    title: options.title ?? "test",
    ...(options.pinnedAgent !== undefined ? { agent: options.pinnedAgent } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...(options.permission ? { permission: options.permission } : {}),
  })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent,
    model: { providerID: "test" as never, modelID: "test-model" as never },
    time: { created: Date.now() },
  })
  yield* session.updatePart({id:PartID.ascending(),sessionID:chat.id,messageID:user.id,type:"text",text:"Research the requested information"})
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "work",
    agent,
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test-model" as never,
    providerID: "test" as never,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

const addToolPart = Effect.fn("AgentEffortTest.addToolPart")(function* (
  sessionID: SessionID,
  messageID: MessageID,
  tool: string,
  input: Record<string, unknown> = {},
  output = "done",
  metadata: Record<string, unknown> = {},
) {
  const session = yield* Session.Service
  const now = Date.now()
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "tool",
    tool,
    callID: `${tool}-call-${PartID.ascending()}`,
    state: {
      status: "completed",
      input,
      output,
      title: tool,
      // Mirror Tool.define, which stamps file-writing tools with review metadata.
      metadata: tool === "edit" ? { [REVIEW_LOOP_METADATA]: { writesFiles: true }, ...metadata } : { ...metadata },
      time: { start: now, end: now },
    },
  })
})

// Long-turn fixture: every loop iteration appends a fresh assistant row
// (prompt.ts), so assistant rows after the newest user message are how a real
// session grows past task's newest-50 routing window.
const fillAssistantRows = Effect.fn("AgentEffortTest.fillAssistantRows")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  count: number,
) {
  const session = yield* Session.Service
  yield* Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    () =>
      session.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID,
        sessionID,
        mode: "work",
        agent: "work",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "test-model" as never,
        providerID: "test" as never,
        time: { created: Date.now() },
      }),
  )
})

// The medium/thorough block: a successful finish whose reviewer cannot run
// fails the tool call with the typed `Review blocked (<code>)` message.
const blockedMessage = (exit: Exit.Exit<unknown, unknown>) => {
  // A missing or unavailable review delivers UNREVIEWED with the same guidance instead of declining.
  if (Exit.isSuccess(exit)) {
    const output = (exit.value as { output: string }).output
    expect(output).toContain("UNREVIEWED")
    return output
  }
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) return ""
  const failure = Cause.squash(exit.cause)
  expect(failure).toBeInstanceOf(ToolFailure)
  return failure instanceof ToolFailure ? failure.message : ""
}

const finishContext = (sessionID: SessionID, messageID: MessageID) => ({
  sessionID,
  messageID,
  agent: "work",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

function stubOps(): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input: SessionPrompt.PromptInput) => Effect.succeed(reply(input)),
  }
}

function reply(input: SessionPrompt.PromptInput): SessionV1.WithParts {
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
      modelID: input.model?.modelID ?? ("test-model" as never),
      providerID: input.model?.providerID ?? ("test" as never),
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text" as const,
        text: "done",
      },
    ],
  }
}

describe("tool.finish – effort-labelled delivery", () => {
  it.instance(
    "fast delivers unreviewed work as unreviewed with no serialized pass cap",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession()
        yield* addToolPart(chat.id, assistant.id, "edit")
        const tool = yield* FinishTool
        const def = yield* tool.init()

        const result = yield* def.execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))

        expect(result.title).toBe("Task completed")
        const review = present(result.metadata.review)
        expect(review.effort).toBe("fast")
        expect(review.disposition).toBe("unreviewed")
        expect(review.termination).toBe("unreviewed")
        expect(review.reviews).toBe(0)
        expect("maxIterations" in review).toBe(false)
        expect(result.output).toContain("passes 0 (none required)")
        expect(result.output).toContain("review unreviewed/unreviewed")
        expect(result.output).not.toContain("budget")
      }),
    { config: { agent: { effort: "fast" } } },
  )

  it.instance(
    "fast labels an actual approved review as reviewed and approved",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession()
        yield* addToolPart(chat.id, assistant.id, "edit")
        yield* addToolPart(
          chat.id,
          assistant.id,
          "task",
          { subagent_type: "review", background: false },
          [
            "<silvercode-review>",
            JSON.stringify({
              version: 1,
              revision: "uncommitted",
              assessment: "approved",
              summary: "clean",
              findings: [],
            }),
            "</silvercode-review>",
          ].join("\n"),
        )
        const tool = yield* FinishTool
        const def = yield* tool.init()

        const result = yield* def.execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))

        const review = present(result.metadata.review)
        expect(review.effort).toBe("fast")
        expect(review.disposition).toBe("reviewed")
        expect(review.termination).toBe("approved")
      }),
    { config: { agent: { effort: "fast" } } },
  )

  it.instance("finish treats only a missing session row as 'no session' and lets storage defects propagate", () =>
    Effect.gen(function* () {
      const real = yield* Session.Service
      const { chat, assistant } = yield* seedSession()
      yield* addToolPart(chat.id, assistant.id, "edit")

      // A typed NotFound (row vanished after the history read) reads as "no
      // session": reviewer dispatch cannot be verified, so a success with
      // unreviewed writes is declined as session-unreadable (not crashed).
      const missing = yield* (yield* FinishTool.pipe(
        Effect.provideService(Session.Service, {
          ...real,
          get: () => Effect.fail(new NotFoundError({ message: "Session not found" })),
        }),
      )).init()
      const gone = yield* missing
        .execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))
        .pipe(Effect.exit)
      expect(Exit.isSuccess(gone)).toBe(true)
      if (Exit.isSuccess(gone)) {
        expect(gone.value.output).toContain("UNREVIEWED")
        expect(gone.value.output).toContain("session-unreadable")
      }

      // A storage defect is not "no session": it must reach the caller intact.
      const sentinel = new Error("storage-defect-sentinel")
      const broken = yield* (yield* FinishTool.pipe(
        Effect.provideService(Session.Service, { ...real, get: () => Effect.die(sentinel) }),
      )).init()
      const exit = yield* broken
        .execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause) ? Cause.squash(exit.cause) : undefined).toBe(sentinel)
    }),
  )

  it.instance(
    "failure and subagent_wait deliver without an approval ritual; read-only turns are not-required",
    () =>
      Effect.gen(function* () {
        const tool = yield* FinishTool
        const def = yield* tool.init()

        const { chat, assistant } = yield* seedSession()
        yield* addToolPart(chat.id, assistant.id, "edit")
        const failed = yield* def.execute(
          { reason: "failure", result: "gave up" },
          finishContext(chat.id, assistant.id),
        )
        expect(present(failed.metadata.review).termination).toBe("unreviewed")

        const waiting = yield* def.execute(
          { reason: "subagent_wait", result: "waiting on child" },
          finishContext(chat.id, assistant.id),
        )
        expect(present(waiting.metadata.review).termination).toBe("waiting")
        expect(present(waiting.metadata.review).disposition).toBe("unreviewed")

        const quiet = yield* seedSession({ title: "quiet" })
        const exempt = yield* def.execute(
          { reason: "success", result: "read the docs" },
          finishContext(quiet.chat.id, quiet.assistant.id),
        )
        expect(present(exempt.metadata.review).termination).toBe("not-required")
        expect(present(exempt.metadata.review).disposition).toBe("unreviewed")
      }),
    { config: { agent: { effort: "fast" } } },
  )

  it.instance(
    "declared validation evidence is reported as agent-reported, never executed",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession()
        const tool = yield* FinishTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            reason: "success",
            result: "done",
            validation: { checks: [{ category: "syntax", status: "passed", detail: "biome check" }] },
          },
          finishContext(chat.id, assistant.id),
        )

        expect(present(result.metadata.validation)).toEqual({
          gate: "minimal",
          status: "passed",
          checks: [{ category: "syntax", status: "passed", detail: "biome check" }],
          source: "agent-reported",
        })
        expect(result.output).toContain("validation minimal/passed")
      }),
    { config: { agent: { effort: "fast" } } },
  )

  it.instance(
    "missing validation evidence stays visible as incomplete even on a clean delivery",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession()
        const tool = yield* FinishTool
        const def = yield* tool.init()

        const result = yield* def.execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))

        expect(present(result.metadata.validation).gate).toBe("minimal")
        expect(present(result.metadata.validation).status).toBe("incomplete")
        expect(result.output).toContain("validation minimal/incomplete")
      }),
    { config: { agent: { effort: "fast" } } },
  )
})

describe("tool.finish – reviewer availability matches the dispatch context", () => {
  it.instance(
    "a config task deny blocks success at medium on every repeat, and only an honest failure report delivers",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession()
        yield* addToolPart(chat.id, assistant.id, "edit")
        const tool = yield* FinishTool
        const def = yield* tool.init()

        // Medium requires a reviewer: an unavailable one blocks success on
        // every repeat (no decline loop) and never reads as approval.
        const first = yield* def
          .execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))
          .pipe(Effect.exit)
        expect(blockedMessage(first)).toContain("Review blocked (permission-denied)")
        const second = yield* def
          .execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))
          .pipe(Effect.exit)
        expect(blockedMessage(second)).toContain("Review blocked (permission-denied)")

        // Only an honest failure report can complete the turn.
        const reported = yield* def.execute(
          { reason: "failure", result: "Review cannot run" },
          finishContext(chat.id, assistant.id),
        )
        expect(present(reported.metadata.review).termination).toBe("review-blocked")
        expect(present(reported.metadata.review).unavailable).toBe("permission-denied")
      }),
    { config: { permission: { task: { review: "deny" } } } },
  )

  it.instance("a session-scoped task deny also blocks success at medium", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession({
        permission: [{ action: "deny", permission: "task", pattern: "review" }],
      })
      yield* addToolPart(chat.id, assistant.id, "edit")
      const tool = yield* FinishTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))
        .pipe(Effect.exit)
      expect(blockedMessage(exit)).toContain("Review blocked (permission-denied)")
      const reported = yield* def.execute(
        { reason: "failure", result: "Review cannot run" },
        finishContext(chat.id, assistant.id),
      )
      expect(present(reported.metadata.review).termination).toBe("review-blocked")
    }),
  )

  it.instance(
    "the subagent depth limit blocks success at medium, never approval",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession()
        yield* addToolPart(chat.id, assistant.id, "edit")
        const tool = yield* FinishTool
        const def = yield* tool.init()

        const exit = yield* def
          .execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))
          .pipe(Effect.exit)
        expect(blockedMessage(exit)).toContain("Review blocked (subagent-depth)")
        const reported = yield* def.execute(
          { reason: "failure", result: "Review cannot run" },
          finishContext(chat.id, assistant.id),
        )
        expect(present(reported.metadata.review).termination).toBe("review-blocked")
        expect(present(reported.metadata.review).unavailable).toBe("subagent-depth")
      }),
    { config: { subagent_depth: 0 } },
  )
})

describe("tool.finish – availability uses the calling agent's dispatch ruleset", () => {
  // Real dispatch parity: compose exactly the inputs the live path uses —
  // task.ts's requested+resolved pattern pair, evaluated through the
  // ctx.ask ruleset from session/tools.ts (the running agent's permissions
  // merged with the session's) — and run them through the REAL Permission
  // service, so the probe can never bypass evaluation with a stub.
  const dispatchGate = Effect.fn("AgentEffortTest.dispatchGate")(function* (
    chat: Session.Info,
    caller: Agent.Info,
    patterns: string[],
  ) {
    const permission = yield* Permission.Service
    return yield* permission
      .ask({
        permission: "task",
        patterns,
        always: ["*"],
        metadata: { description: "review dispatch parity probe" },
        sessionID: chat.id,
        ruleset: Permission.merge(caller.permission, chat.permission ?? []),
      })
      .pipe(Effect.exit)
  })

  const expectDenied = (exit: Exit.Exit<void, PermissionV1.Error>) => {
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeniedError)
  }

  it.instance(
    "a running-agent-scoped task deny blocks success at medium on every repeat, matching real dispatch denial",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const { chat, assistant } = yield* seedSession()
        yield* addToolPart(chat.id, assistant.id, "edit")
        const tool = yield* FinishTool
        const def = yield* tool.init()

        // The caller is the agent running finish, and its own ruleset is
        // what gates dispatch.
        const caller = yield* agents.get("work")
        expect(Permission.evaluate("task", "review", caller!.permission).action).toBe("deny")

        const first = yield* def
          .execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))
          .pipe(Effect.exit)
        expect(blockedMessage(first)).toContain("Review blocked (permission-denied)")
        const second = yield* def
          .execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))
          .pipe(Effect.exit)
        expect(blockedMessage(second)).toContain("Review blocked (permission-denied)")

        // The real dispatch gate reaches the same verdict: the routed pair
        // is denied under the caller's composition.
        const exit = yield* dispatchGate(chat, caller!, ["review", "work-review"])
        expectDenied(exit)

        const reported = yield* def.execute(
          { reason: "failure", result: "Review cannot run" },
          finishContext(chat.id, assistant.id),
        )
        expect(present(reported.metadata.review).termination).toBe("review-blocked")
        expect(present(reported.metadata.review).unavailable).toBe("permission-denied")
      }),
    { config: { agent: { work: { permission: { task: { review: "deny" } } } } } },
  )

  it.instance(
    "a generic review-agent-scoped task deny does not release a permitted caller's required review",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const { chat, assistant } = yield* seedSession()
        yield* addToolPart(chat.id, assistant.id, "edit")
        const tool = yield* FinishTool
        const def = yield* tool.init()

        // The generic reviewer's OWN ruleset denies task delegation...
        const requested = yield* agents.get("review")
        expect(Permission.evaluate("task", "review", requested!.permission).action).toBe("deny")
        // ...which is not part of the caller's dispatch composition.
        const caller = yield* agents.get("work")
        expect(Permission.evaluate("task", "review", caller!.permission).action).toBe("allow")

        // Real dispatch from the caller completes without a denial (and
        // without ever creating a pending prompt).
        const gate = yield* dispatchGate(chat, caller!, ["review", "work-review"])
        expect(Exit.isSuccess(gate)).toBe(true)

        // finish still demands the required review instead of mislabelling
        // the turn review-unavailable and delivering without one.
        const attempts: Array<{ review?: Record<string, unknown> }> = []
        const declined = yield* def
          .execute(
            { reason: "success", result: "done" },
            {
              ...finishContext(chat.id, assistant.id),
              metadata: (val) => {
                attempts.push(val.metadata as { review?: Record<string, unknown> })
                return Effect.void
              },
            },
          )
          .pipe(Effect.exit)
        // Delivered UNREVIEWED with the review guidance, never as approved.
        expect(Exit.isSuccess(declined)).toBe(true)
        if (!Exit.isSuccess(declined)) return
        expect(declined.value.output).toContain("UNREVIEWED")
        expect(declined.value.metadata.review).toMatchObject({ disposition: "unreviewed" })
        expect(declined.value.metadata.review).not.toMatchObject({ termination: "approved" })
      }),
    { config: { agent: { review: { permission: { task: { "*": "deny" } } } } } },
  )

  it.instance(
    "a deny on the routed reviewer pattern blocks success at medium through the caller's ruleset",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const { chat, assistant } = yield* seedSession()
        yield* addToolPart(chat.id, assistant.id, "edit")
        const tool = yield* FinishTool
        const def = yield* tool.init()

        // work routes a generic review to work-review, so only the routed
        // pattern is denied for this caller; the generic one is untouched.
        const caller = yield* agents.get("work")
        expect(Permission.evaluate("task", "review", caller!.permission).action).toBe("allow")
        expect(Permission.evaluate("task", "work-review", caller!.permission).action).toBe("deny")

        const exit = yield* def
          .execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))
          .pipe(Effect.exit)
        expect(blockedMessage(exit)).toContain("Review blocked (permission-denied)")

        const gate = yield* dispatchGate(chat, caller!, ["review", "work-review"])
        expectDenied(gate)

        const reported = yield* def.execute(
          { reason: "failure", result: "Review cannot run" },
          finishContext(chat.id, assistant.id),
        )
        expect(present(reported.metadata.review).termination).toBe("review-blocked")
        expect(present(reported.metadata.review).unavailable).toBe("permission-denied")
      }),
    { config: { agent: { work: { permission: { task: { "work-review": "deny" } } } } } },
  )

  it.instance(
    "an always-grant masks a later deny: dispatch stays allowed while finish still demands its required review",
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const agents = yield* Agent.Service
        const tool = yield* FinishTool
        const def = yield* tool.init()
        const caller = yield* agents.get("work")

        // The always-allow is granted while no deny rule is in force; the
        // instance-approved state outlives the ruleset it was granted under,
        // exactly as ask() + reply("always") create it.
        const granting = yield* seedSession({ title: "granting" })
        const grant = yield* permission
          .ask({
            permission: "task",
            patterns: ["review"],
            always: ["*"],
            metadata: { description: "review dispatch" },
            sessionID: granting.chat.id,
            ruleset: [],
          })
          .pipe(Effect.forkScoped)
        const pendingRequest = yield* pollWithTimeout(
          Effect.gen(function* () {
            const pending = yield* permission.list()
            return pending[0]
          }),
          "the review permission ask never became pending",
        )
        yield* permission.reply({ requestID: pendingRequest.id, reply: "always" })
        yield* Fiber.join(grant)

        // The deny exists now, on the session finish runs in.
        const { chat, assistant } = yield* seedSession({
          title: "denied",
          permission: [{ action: "deny", permission: "task", pattern: "review" }],
        })
        yield* addToolPart(chat.id, assistant.id, "edit")

        // Actual dispatch remains allowed: Permission.ask evaluates the
        // approved grant last, masking the session deny.
        const gate = yield* dispatchGate(chat, caller!, ["review", "work-review"])
        expect(Exit.isSuccess(gate)).toBe(true)

        // finish must still demand its required review instead of claiming
        // review-unavailable — the mandatory-review escape a masked deny
        // would otherwise create.
        const attempts: Array<{ review?: Record<string, unknown> }> = []
        const declined = yield* def
          .execute(
            { reason: "success", result: "done" },
            {
              ...finishContext(chat.id, assistant.id),
              metadata: (val) => {
                attempts.push(val.metadata as { review?: Record<string, unknown> })
                return Effect.void
              },
            },
          )
          .pipe(Effect.exit)
        // Delivered UNREVIEWED with the review guidance, never as approved.
        expect(Exit.isSuccess(declined)).toBe(true)
        if (!Exit.isSuccess(declined)) return
        expect(declined.value.output).toContain("UNREVIEWED")
        expect(declined.value.metadata.review).toMatchObject({ disposition: "unreviewed" })
        expect(declined.value.metadata.review).not.toMatchObject({ termination: "approved" })
      }),
    30_000,
  )
})

describe("tool.finish – review dispatch permission parity with task dispatch", () => {
  // Reviewer resolution no longer depends on the parent or the message
  // window after the specialist consolidation, so task's dispatch and
  // finish's availability gate must agree on one pattern set: the single
  // reviewer plus its retired specialist aliases.
  const APPROVED = [
    "<silvercode-review>",
    JSON.stringify({
      version: 1,
      revision: "uncommitted",
      assessment: "approved",
      summary: "clean",
      findings: [],
    }),
    "</silvercode-review>",
  ].join("\n")

  it.instance(
    "task's real dispatch asks generic review outside the window while finish still demands its review",
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const agents = yield* Agent.Service
        const sessions = yield* Session.Service
        const caller = yield* agents.get("work")
        expect(caller).toBeDefined()
        if (!caller) return

        const { chat, assistant } = yield* seedSession({ title: "window" })
        yield* addToolPart(chat.id, assistant.id, "edit")
        yield* fillAssistantRows(chat.id, assistant.id, 54)

        const seeded = yield* sessions.get(chat.id)
        expect(seeded.agent ?? null).toBeNull()

        // Actual dispatch: task's real execution. The ctx.ask shim records
        // the real pattern set and forwards to the REAL Permission.ask under
        // the session/tools.ts caller composition (agent + session rules).
        const asked: string[][] = []
        const promptOps: TaskPromptOps = {
          ...stubOps(),
          prompt: (input) =>
            Effect.sync(() => {
              const replied = reply(input)
              const now = Date.now()
              const finishPart: SessionV1.ToolPart = {
                id: PartID.ascending(),
                messageID: replied.info.id,
                sessionID: input.sessionID,
                type: "tool",
                tool: "finish",
                callID: "finish-call",
                state: {
                  status: "completed",
                  input: { result: APPROVED },
                  output: APPROVED,
                  title: "finish",
                  metadata: {},
                  time: { start: now, end: now },
                },
              }
              return { ...replied, parts: [...replied.parts, finishPart] }
            }),
        }
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          { description: "review the change", prompt: "review it", subagent_type: "review", background: false },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.gen(function* () {
                asked.push([...input.patterns])
                yield* permission
                  .ask({
                    ...input,
                    sessionID: chat.id,
                    ruleset: Permission.merge(caller.permission, chat.permission ?? []),
                  })
                  .pipe(Effect.orDie)
              }),
          },
        )

        // task's actual ask: the single reviewer plus the retired specialist
        // aliases that still gate it — and task itself recorded the delivered
        // report for the reviewer.
        expect(asked).toEqual([["review", "work-review", "code-review"]])
        expect(present(result.metadata.review).revision).toBe("uncommitted")
        const child = yield* sessions.get(result.metadata.sessionId as SessionID)
        expect(child.agent).toBe("review")

        // The same real Permission.ask permits the observed dispatch patterns.
        const gate = yield* permission
          .ask({
            permission: "task",
            patterns: asked[0] ?? [],
            always: ["*"],
            metadata: { description: "window parity probe" },
            sessionID: chat.id,
            ruleset: Permission.merge(caller.permission, chat.permission ?? []),
          })
          .pipe(Effect.exit)
        expect(Exit.isSuccess(gate)).toBe(true)

        // finish must demand its required review — not claim the reviewer is
        // unavailable while the actual dispatch, which the same ruleset
        // allows, would run it.
        const attempts: Array<{ review?: Record<string, unknown> }> = []
        const finishTool = yield* FinishTool
        const fdef = yield* finishTool.init()
        const declined = yield* fdef
          .execute(
            { reason: "success", result: "done" },
            {
              ...finishContext(chat.id, assistant.id),
              metadata: (val) => {
                attempts.push(val.metadata as { review?: Record<string, unknown> })
                return Effect.void
              },
            },
          )
          .pipe(Effect.exit)
        // Delivered UNREVIEWED with the review guidance, never as approved.
        expect(Exit.isSuccess(declined)).toBe(true)
        if (!Exit.isSuccess(declined)) return
        expect(declined.value.output).toContain("UNREVIEWED")
        expect(declined.value.metadata.review).toMatchObject({ disposition: "unreviewed" })
        expect(declined.value.metadata.review).not.toMatchObject({ termination: "approved" })
      }),
    {
      config: {
        agent: {
          // An unrelated deny: the review dispatch must stay allowed so the
          // probe measures finish's demand, not a permission block.
          work: { permission: { task: { general: "deny" } } },
          review: { background: false },
        },
      },
    },
  )

  it.instance(
    "a pinned session agent still routes the specialist outside the window and blocks success",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seedSession({ title: "pinned", agent: "code", pinnedAgent: "work" })
        yield* addToolPart(chat.id, assistant.id, "edit")
        yield* fillAssistantRows(chat.id, assistant.id, 54)

        const seeded = yield* sessions.get(chat.id)
        expect(seeded.agent).toBe("work")

        const tool = yield* FinishTool
        const def = yield* tool.init()
        const exit = yield* def
          .execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))
          .pipe(Effect.exit)

        // The window holds no user row, so only the pinned tier can route:
        // the specialist deny blocks honestly instead of degrading to the
        // generic reviewer.
        expect(blockedMessage(exit)).toContain("Review blocked (permission-denied)")
        const reported = yield* def.execute(
          { reason: "failure", result: "Review cannot run" },
          finishContext(chat.id, assistant.id),
        )
        expect(present(reported.metadata.review).termination).toBe("review-blocked")
        expect(present(reported.metadata.review).unavailable).toBe("permission-denied")
      }),
    { config: { agent: { work: { permission: { task: { "work-review": "deny" } } } } } },
  )

  it.instance(
    "the newest user row inside the window still specializes the reviewer and blocks success",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession({ title: "in-window" })
        yield* addToolPart(chat.id, assistant.id, "edit")
        // 49 rows after the user row keeps it as the oldest row of the
        // 50-row window, exactly the boundary task would still see.
        yield* fillAssistantRows(chat.id, assistant.id, 48)

        const tool = yield* FinishTool
        const def = yield* tool.init()
        const exit = yield* def
          .execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))
          .pipe(Effect.exit)
        expect(blockedMessage(exit)).toContain("Review blocked (permission-denied)")
        const reported = yield* def.execute(
          { reason: "failure", result: "Review cannot run" },
          finishContext(chat.id, assistant.id),
        )
        expect(present(reported.metadata.review).termination).toBe("review-blocked")
        expect(present(reported.metadata.review).unavailable).toBe("permission-denied")
      }),
    { config: { agent: { work: { permission: { task: { "work-review": "deny" } } } } } },
  )

  it.instance("review accounting still reads history older than the routing window", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession({ title: "accounting" })
      yield* addToolPart(chat.id, assistant.id, "edit")
      yield* addToolPart(chat.id, assistant.id, "task", { subagent_type: "review", background: false }, APPROVED)
      // The approved review now sits outside the newest-50 window; the
      // full-history read behind reviewLoopState must still count it —
      // the routing window must not truncate accounting.
      yield* fillAssistantRows(chat.id, assistant.id, 54)

      const tool = yield* FinishTool
      const def = yield* tool.init()
      const result = yield* def.execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))

      expect(present(result.metadata.review)).toMatchObject({
        effort: "medium",
        disposition: "reviewed",
        termination: "approved",
        reviews: 1,
      })
    }),
  )
})

describe("tool.finish – background child accounting", () => {
  it.instance(
    "a pending background child exempts the write-free turn; its completed writes are then accounted",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession()
        const sessions = yield* Session.Service
        // The dispatched background task has not reported yet: its part
        // declares no writes, so this turn is write-free and exempt.
        yield* addToolPart(chat.id, assistant.id, "task", { subagent_type: "general", background: true }, "started")
        const tool = yield* FinishTool
        const def = yield* tool.init()

        const pending = yield* def.execute(
          { reason: "success", result: "kicked off" },
          finishContext(chat.id, assistant.id),
        )
        expect(present(pending.metadata.review).termination).toBe("not-required")

        // Once the child's completion notification lands, its delegated
        // writes are real work: the next finish is gated like any other.
        yield* Effect.gen(function* () {
          const now = Date.now()
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: chat.id,
            type: "text",
            synthetic: true,
            text: "Background task completed",
            metadata: { [REVIEW_LOOP_METADATA]: { writesFiles: true } },
            time: { start: now, end: now },
          })
        })

        const exit = yield* def
          .execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))
          .pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (!Exit.isSuccess(exit)) return
        expect(exit.value.output).toContain("UNREVIEWED")
      }),
    { config: { agent: { effort: "medium" } } },
  )
})

describe("tool.task – effort selection lifecycle", () => {
  const taskContext = (chat: SessionID, message: MessageID, ops = stubOps()) => ({
    sessionID: chat,
    messageID: message,
    agent: "work",
    abort: new AbortController().signal,
    extra: { promptOps: ops },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  })

  it.instance(
    "an explicit override persists on the new child and is published in task metadata",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seedSession()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          { description: "do it", prompt: "implement the feature", subagent_type: "general", effort: "thorough" },
          taskContext(chat.id, assistant.id),
        )

        const childID = result.metadata.sessionId as SessionID
        expect(result.metadata.effort).toBe("thorough")
        const child = yield* sessions.get(childID)
        expect(readAgentEffort(child.metadata)).toBe("thorough")
      }),
    30_000,
  )

  it.instance(
    "a new child inherits the parent's persisted level when the override is omitted",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seedSession({ title: "parent", metadata: { agentEffort: "fast" } })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          { description: "do it", prompt: "implement the feature", subagent_type: "general" },
          taskContext(chat.id, assistant.id),
        )

        expect(result.metadata.effort).toBe("fast")
        const child = yield* sessions.get(result.metadata.sessionId as SessionID)
        expect(readAgentEffort(child.metadata)).toBe("fast")
      }),
    30_000,
  )

  it.instance(
    "siblings keep independent selections",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seedSession({ title: "parent", metadata: { agentEffort: "fast" } })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const thorough = yield* def.execute(
          { description: "a", prompt: "work a", subagent_type: "general", effort: "thorough" },
          taskContext(chat.id, assistant.id),
        )
        const inheriting = yield* def.execute(
          { description: "b", prompt: "work b", subagent_type: "general" },
          taskContext(chat.id, assistant.id),
        )

        const thoroughChild = yield* sessions.get(thorough.metadata.sessionId as SessionID)
        const inheritingChild = yield* sessions.get(inheriting.metadata.sessionId as SessionID)
        expect(readAgentEffort(thoroughChild.metadata)).toBe("thorough")
        expect(readAgentEffort(inheritingChild.metadata)).toBe("fast")
      }),
    30_000,
  )

  it.instance(
    "resume keeps an omitted selection and allows an explicit change",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seedSession()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const first = yield* def.execute(
          { description: "a", prompt: "work a", subagent_type: "general", effort: "thorough" },
          taskContext(chat.id, assistant.id),
        )
        const childID = first.metadata.sessionId as SessionID

        const resumed = yield* def.execute(
          { description: "a", prompt: "continue", subagent_type: "general", task_id: childID },
          taskContext(chat.id, assistant.id),
        )
        expect(resumed.metadata.effort).toBe("thorough")
        const kept = yield* sessions.get(childID)
        expect(readAgentEffort(kept.metadata)).toBe("thorough")

        const changed = yield* def.execute(
          { description: "a", prompt: "continue", subagent_type: "general", task_id: childID, effort: "fast" },
          taskContext(chat.id, assistant.id),
        )
        expect(changed.metadata.effort).toBe("fast")
        const updated = yield* sessions.get(childID)
        expect(readAgentEffort(updated.metadata)).toBe("fast")
      }),
    30_000,
  )

  it.instance(
    "a foreign child is neither read nor written and its effort is omitted from metadata",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const other = yield* sessions.create({ title: "Other parent" })
        const child = yield* sessions.create({ parentID: other.id, title: "Foreign child" })
        const { chat, assistant } = yield* seedSession()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "a",
            prompt: "continue foreign work",
            subagent_type: "general",
            task_id: child.id,
            effort: "thorough",
          },
          taskContext(chat.id, assistant.id),
        )

        // The override was not applied, so publishing it would be dishonest.
        expect("effort" in result.metadata).toBe(false)
        const foreign = yield* sessions.get(child.id)
        expect(readAgentEffort(foreign.metadata)).toBeUndefined()
      }),
    30_000,
  )

  it.instance(
    "a background dispatch persists the level before the run starts",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seedSession()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "a",
            prompt: "long running work",
            subagent_type: "general",
            effort: "thorough",
            background: true,
          },
          taskContext(chat.id, assistant.id),
        )

        expect(result.metadata.background).toBe(true)
        expect(result.metadata.effort).toBe("thorough")
        const child = yield* sessions.get(result.metadata.sessionId as SessionID)
        expect(readAgentEffort(child.metadata)).toBe("thorough")
      }),
    30_000,
  )

  it.instance(
    "fork preserves the persisted selection and fork edits stay independent",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat } = yield* seedSession({ title: "original", metadata: { agentEffort: "thorough" } })

        const forked = yield* sessions.fork({ sessionID: chat.id })
        expect(readAgentEffort(forked.metadata)).toBe("thorough")

        yield* sessions.setMetadata({
          sessionID: forked.id,
          metadata: { ...(forked.metadata ?? {}), agentEffort: "fast" },
        })
        const rereadFork = yield* sessions.get(forked.id)
        const rereadOriginal = yield* sessions.get(chat.id)
        expect(readAgentEffort(rereadFork.metadata)).toBe("fast")
        expect(readAgentEffort(rereadOriginal.metadata)).toBe("thorough")
      }),
    30_000,
  )
})

for (const effort of ["medium", "thorough"] as const) {
  it.instance(
    `explicit background reviewer cannot satisfy ${effort} finish even after approval`,
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession({ metadata: { agentEffort: effort } })
        yield* addToolPart(chat.id, assistant.id, "edit")
        const sessions = yield* Session.Service
        const jobs = yield* BackgroundJob.Service
        const task = yield* TaskTool
        const def = yield* task.init()
        const report = `<silvercode-review>\n${JSON.stringify({ version: 1, revision: "uncommitted", assessment: "approved", summary: "No findings.", findings: [] })}\n</silvercode-review>`
        const notified = yield* Deferred.make<SessionPrompt.PromptInput>()
        const result = yield* def.execute(
          { description: "Review file", prompt: "Review file", subagent_type: "review", background: false },
          {
            ...finishContext(chat.id, assistant.id),
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: (input: SessionPrompt.PromptInput) =>
                  input.sessionID === chat.id
                    ? Deferred.succeed(notified, input).pipe(Effect.as(reply(input)))
                    : Effect.sync(() => {
                        const response = reply(input)
                        response.parts = [
                          { ...response.parts[0], type: "text", text: report } as SessionV1.TextPart,
                          {
                            id: PartID.ascending(),
                            messageID: response.info.id,
                            sessionID: input.sessionID,
                            type: "tool",
                            tool: "finish",
                            callID: "review-finish",
                            state: {
                              status: "completed",
                              input: { reason: "success", result: report },
                              output: report,
                              title: "finish",
                              metadata: {},
                              time: { start: 1, end: 2 },
                            },
                          },
                        ]
                        return response
                      }),
              },
            },
          },
        )
        expect(result.metadata.background).toBe(true)
        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.agent).toBe("review")
        // Even a finished, approved background result is not foreground delivery.
        const completed = yield* jobs.wait({ id: result.metadata.sessionId })
        expect(completed?.info?.status).toBe("completed")
        yield* addToolPart(
          chat.id,
          assistant.id,
          "task",
          { subagent_type: "review", background: false },
          result.output,
          result.metadata,
        )
        const notification = yield* Deferred.await(notified)
        expect(notification.parts.some((part) => part.type === "text" && part.text.includes('"approved"'))).toBe(true)
        const finish = yield* FinishTool
        const final = yield* finish.init()
        const exit = yield* final
          .execute({ reason: "success", result: "done" }, finishContext(chat.id, assistant.id))
          .pipe(Effect.exit)
        expect(blockedMessage(exit)).toMatch(/Review required|requires a successful General/)
      }),
    { config: { agent: { effort, "work-review": { background: true } } } },
  )
}
