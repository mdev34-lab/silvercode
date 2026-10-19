import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import { ReviewReport } from "@opencode-ai/core/review-report"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FinishTool } from "@/tool/finish"
import type { Tool } from "@/tool/tool"
import { BackgroundJob } from "@/background/job"
import { Permission } from "@/permission"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { REVIEW_LOOP_METADATA } from "@opencode-ai/core/review-loop"

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
      BackgroundJob.node,
    ]),
  )

const it = testEffect(layer())

const seedSession = Effect.fn("FinishTest.seedSession")(function* (
  title = "test",
  agent = "work",
  parentID?: SessionID,
  permission?: PermissionV1.Ruleset,
) {
  const session = yield* Session.Service
  const chat = yield* session.create({
    title,
    ...(parentID ? { parentID } : {}),
    ...(permission ? { permission } : {}),
  })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent,
    model: { providerID: "test" as any, modelID: "test-model" as any },
    time: { created: Date.now() },
  })
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
    modelID: "test-model" as any,
    providerID: "test" as any,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

const FILE_WRITING_TOOLS = new Set(["edit", "write", "apply_patch"])

const addToolPart = Effect.fn("FinishTest.addToolPart")(function* (
  sessionID: SessionID,
  messageID: MessageID,
  tool: string,
  input: Record<string, unknown> = {},
  output = "done",
) {
  const session = yield* Session.Service
  const now = Date.now()
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "tool",
    tool,
    callID: `${tool}-call`,
    state: {
      status: "completed",
      input,
      output,
      title: tool,
      // Mirror Tool.define, which stamps file-writing tools with review metadata.
      metadata: FILE_WRITING_TOOLS.has(tool) ? { [REVIEW_LOOP_METADATA]: { writesFiles: true } } : {},
      time: { start: now, end: now },
    },
  })
})

const workCtx = (
  sessionID: SessionID,
  messageID: MessageID,
  metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => Effect.Effect<void> = () => Effect.void,
  agent = "work",
  extra?: Tool.Context["extra"],
): Tool.Context => ({
  sessionID,
  messageID,
  agent,
  abort: new AbortController().signal,
  messages: [],
  metadata,
  ask: () => Effect.void,
  ...(extra ? { extra } : {}),
})

// Runs finish once and returns the decline along with the metadata the tool
// reported for the failed part, which is what the runtime persists.
const declineOf = Effect.fn("FinishTest.declineOf")(function* (
  input: { reason: "success" | "failure"; result: string },
  sessionID: SessionID,
  messageID: MessageID,
) {
  const tool = yield* FinishTool
  const def = yield* tool.init()
  const recorded: Record<string, unknown>[] = []
  const failure = reviewFailure(
    yield* def
      .execute(
        input,
        workCtx(sessionID, messageID, (value) => {
          recorded.push(value.metadata ?? {})
          return Effect.void
        }),
      )
      .pipe(Effect.exit),
  )
  return { message: failure?.message ?? "", metadata: recorded.at(-1) ?? {}, recorded }
})

// The Review subagent's delivered verdict as the parent's task part carries it.
const addReview = (sessionID: SessionID, messageID: MessageID, assessment: "Approved" | "Needs fixes") =>
  addToolPart(sessionID, messageID, "task", { subagent_type: "review", background: false }, `Assessment: ${assessment}`)

// Finish requires an explicit Approved review of file-writing work (#231). The
// decline names the Review subagent and how to dispatch it, and it is not a
// waiver: a retried finish - whatever its result says about the work - is
// declined again until a review approves the current work.
describe("tool.finish – review requirement", () => {
  it.instance("declines a finish for unreviewed file writes and names the Review subagent", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      yield* addToolPart(chat.id, assistant.id, "edit")
      const tool = yield* FinishTool
      const def = yield* tool.init()
      const recorded: Record<string, unknown>[] = []

      const exit = yield* def
          .execute(
            { reason: "success", result: "done" },
            workCtx(chat.id, assistant.id, (input) => {
              recorded.push(input.metadata ?? {})
              return Effect.void
            }),
          )
          .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const failure = exit.cause.reasons.find(Cause.isFailReason)?.error
      expect(failure).toBeInstanceOf(ToolFailure)
      if (!(failure instanceof ToolFailure)) return
      expect(failure.message).toContain("requires at least one independent review")
      expect(failure.message).toContain('subagent_type: "review"')
      // The old skip-on-repeat hint is gone: repeating finish is never the way out.
      expect(failure.message).not.toContain("skip")
      expect(recorded).toEqual([
        {
          review: {
            nudged: true,
            effort: "medium",
            disposition: "unreviewed",
            verdict: "pending",
            reviews: 0,
            maxIterations: 2,
            openFindings: 0,
            blockingFindings: 0,
            workSinceReview: true,
          },
        },
      ])
    }),
  )

  it.instance("declines a repeated finish call too: the persisted nudge is not a skip path", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      yield* addToolPart(chat.id, assistant.id, "edit")
      const session = yield* Session.Service
      const now = Date.now()
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "tool",
        tool: "finish",
        callID: "finish-call-1",
        state: {
          status: "error",
          input: { reason: "success", result: "done" },
          error: "Review required",
          metadata: {
            review: {
              nudged: true,
              effort: "medium",
              disposition: "unreviewed",
              verdict: "pending",
              reviews: 0,
              maxIterations: 2,
              openFindings: 0,
              blockingFindings: 0,
              workSinceReview: true,
            },
          },
          time: { start: now, end: now },
        },
      })
      const tool = yield* FinishTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          { reason: "success", result: "done" },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const failure = exit.cause.reasons.find(Cause.isFailReason)?.error
      expect(failure).toBeInstanceOf(ToolFailure)
      if (!(failure instanceof ToolFailure)) return
      expect(failure.message).toContain("requires at least one independent review")
      expect(failure.message).not.toContain("skip")
    }),
  )

  it.instance("records approval only after a completed synchronous review", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      yield* addToolPart(chat.id, assistant.id, "edit")
      yield* addReview(chat.id, assistant.id, "Approved")
      const tool = yield* FinishTool
      const def = yield* tool.init()
      const result = yield* def.execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id))

      expect(result.metadata.review?.termination).toBe("approved")
      expect(result.metadata.review?.verdict).toBe("approved")
      expect(result.metadata.review).not.toHaveProperty("unavailable")
    }),
  )

  it.instance("declines a finish after a Needs fixes review until the fixes are reviewed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      yield* addToolPart(chat.id, assistant.id, "edit")
      yield* addReview(chat.id, assistant.id, "Needs fixes")
      const tool = yield* FinishTool
      const def = yield* tool.init()

      const failure = reviewFailure(
        yield* def.execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id)).pipe(Effect.exit),
      )
      expect(failure?.message).toContain("returned Needs fixes")
      expect(failure?.message).toContain("run the Review subagent again")

      yield* addToolPart(chat.id, assistant.id, "edit")
      yield* addReview(chat.id, assistant.id, "Approved")
      const result = yield* def.execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id))
      expect(result.metadata.review?.termination).toBe("approved")
      expect(result.metadata.review?.reviews).toBe(2)
    }),
  )

  // Every reason except a yield is a delivery, and a failed attempt still
  // leaves its writes behind, so a failure cannot be used to step around review.
  it.instance("declines a failure finish for unreviewed file writes too", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      yield* addToolPart(chat.id, assistant.id, "edit")
      const tool = yield* FinishTool
      const def = yield* tool.init()

      const failure = reviewFailure(
        yield* def
          .execute({ reason: "failure", result: "Could not finish the scene." }, workCtx(chat.id, assistant.id))
          .pipe(Effect.exit),
      )
      expect(failure?.message).toContain("no explicit Approved review")
    }),
  )
})

// The requirement ends only on facts the runtime can check - never on the
// finish result. Each exemption records its own outcome; none reads as an
// approval.
describe("tool.finish – review requirement exemptions", () => {
  it.instance("a turn without file writes completes without a review", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      yield* addToolPart(chat.id, assistant.id, "read", { filePath: "scene.html" })
      yield* addToolPart(chat.id, assistant.id, "bash", { command: "ls" })
      const tool = yield* FinishTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        { reason: "success", result: "Listed the files." },
        workCtx(chat.id, assistant.id),
      )

      expect(result.title).toBe("Task completed")
      expect(result.metadata.review?.verdict).toBe("none")
      expect(result.metadata.review).not.toHaveProperty("unavailable")
    }),
  )

  it.instance(
    "the review cap completes as budget-exhausted, not as an approval",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession()
        yield* addToolPart(chat.id, assistant.id, "edit")
        yield* addReview(chat.id, assistant.id, "Needs fixes")
        // Medium's canonical budget is two completed passes: the second
        // non-approving pass reaches the cap.
        yield* addReview(chat.id, assistant.id, "Needs fixes")
        const tool = yield* FinishTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          { reason: "success", result: "Stopped at the review cap with one open finding." },
          workCtx(chat.id, assistant.id),
        )

        expect(result.metadata.review).toMatchObject({
          verdict: "cap",
          reviews: 2,
          maxIterations: 2,
          termination: "budget-exhausted",
        })
      }),
  )

  // The task tool refuses any delegation from a session at the subagent depth
  // limit (see "prevents subagents from launching subagents by default" in
  // task.test.ts), so a task child cannot obtain a review of its own. Without
  // the waiver every child that writes files would be declined forever.
  it.instance("a subagent at the depth limit delivers an unreviewed handoff", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const { chat, assistant } = yield* seedSession("child", "general", parent.id)
      yield* addToolPart(chat.id, assistant.id, "edit")
      const tool = yield* FinishTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        { reason: "success", result: "Implemented the unit." },
        workCtx(chat.id, assistant.id, undefined, "general"),
      )

      expect(result.title).toBe("Task completed")
      expect(result.metadata.review).toMatchObject({
        verdict: "pending",
        reviews: 0,
        maxIterations: 2, // medium's canonical pass budget
        termination: "review-pending",
        unavailable: "subagent-depth",
      })
    }),
  )

  it.instance(
    "a subagent that can dispatch the Review subagent still needs its approval",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "parent" })
        const { chat, assistant } = yield* seedSession("child", "code", parent.id)
        yield* addToolPart(chat.id, assistant.id, "edit")
        const tool = yield* FinishTool
        const def = yield* tool.init()

        const failure = reviewFailure(
          yield* def
            .execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id, undefined, "code"))
            .pipe(Effect.exit),
        )
        expect(failure?.message).toContain("no explicit Approved review")
      }),
    { config: { subagent_depth: 2 } },
  )

  // The deny the task tool writes into a child session whose agent declares no
  // task rule. It hides the task tool, so the child has no way to dispatch.
  it.instance(
    "a session whose permissions hide task blocks success but can report failure",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "parent" })
        const { chat, assistant } = yield* seedSession("child", "general", parent.id, [
          { permission: "task", pattern: "*", action: "deny" },
        ])
        yield* addToolPart(chat.id, assistant.id, "edit")
        const tool = yield* FinishTool
        const def = yield* tool.init()

        const failure = reviewFailure(
          yield* def
            .execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id, undefined, "general"))
            .pipe(Effect.exit),
        )
        expect(failure?.message).toContain("Review blocked")
        const result = yield* def.execute(
          { reason: "failure", result: "Review cannot run" },
          workCtx(chat.id, assistant.id, undefined, "general"),
        )
        expect(result.metadata.review?.termination).toBe("review-blocked")
        expect(result.metadata.review?.unavailable).toBe("permission-denied")
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "an agent denied Review blocks success but can report failure",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession()
        yield* addToolPart(chat.id, assistant.id, "edit")
        const tool = yield* FinishTool
        const def = yield* tool.init()

        const failure = reviewFailure(
          yield* def.execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id)).pipe(Effect.exit),
        )
        expect(failure?.message).toContain("Review blocked")
        const result = yield* def.execute(
          { reason: "failure", result: "Review cannot run" },
          workCtx(chat.id, assistant.id),
        )
        expect(result.metadata.review?.termination).toBe("review-blocked")
        expect(result.metadata.review?.unavailable).toBe("permission-denied")
      }),
    { config: { agent: { work: { permission: { task: { review: "deny" } } } } } },
  )

  // An explicit agent invocation lets the task tool skip its permission
  // prompt, so the same deny no longer stops a dispatch and the waiver must not
  // apply either.
  it.instance(
    "a permission deny the task tool would bypass does not waive the review",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession()
        yield* addToolPart(chat.id, assistant.id, "edit")
        const tool = yield* FinishTool
        const def = yield* tool.init()

        const failure = reviewFailure(
          yield* def
            .execute(
              { reason: "success", result: "done" },
              workCtx(chat.id, assistant.id, undefined, "work", { bypassAgentCheck: true }),
            )
            .pipe(Effect.exit),
        )
        expect(failure?.message).toContain("no explicit Approved review")
      }),
    { config: { agent: { work: { permission: { task: { review: "deny" } } } } } },
  )

  it.instance(
    "a disabled generic review agent does not block a usable specialist reviewer",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession("owner", "work")
        yield* addToolPart(chat.id, assistant.id, "edit")
        const def = yield* (yield* FinishTool).init()

        const failure = reviewFailure(
          yield* def.execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id)).pipe(Effect.exit),
        )
        // Declines for the missing verdict, exactly as dispatch would allow a
        // review: never the false reviewer-missing block.
        expect(failure?.message).toContain("no explicit Approved review")
        expect(failure?.message).not.toContain("Review blocked")
      }),
    { config: { agent: { review: { disable: true } } } },
  )

  it.instance(
    "a disabled reviewer blocks success but can report failure",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession()
        yield* addToolPart(chat.id, assistant.id, "edit")
        const tool = yield* FinishTool
        const def = yield* tool.init()

        const failure = reviewFailure(
          yield* def.execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id)).pipe(Effect.exit),
        )
        expect(failure?.message).toContain("Review blocked")
        const result = yield* def.execute(
          { reason: "failure", result: "Review cannot run" },
          workCtx(chat.id, assistant.id),
        )
        expect(result.metadata.review?.termination).toBe("review-blocked")
        expect(result.metadata.review?.unavailable).toBe("reviewer-missing")
      }),
    { config: { agent: { "work-review": { disable: true } } } },
  )
})

describe("tool.finish – todo closure safety net", () => {
  it.instance("closes pending todos", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const todos = yield* Todo.Service
      const tool = yield* FinishTool
      const def = yield* tool.init()

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "pending task", status: "pending", priority: "high" },
          { content: "another pending", status: "pending", priority: "low" },
        ],
      })

      const result = yield* def.execute(
        { reason: "success", result: "done" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.title).toBe("Task completed")
      const after = yield* todos.get(chat.id)
      expect(after).toHaveLength(2)
      expect(after.every((t) => t.status !== "pending")).toBe(true)
      expect(after.every((t) => t.status !== "in_progress")).toBe(true)
      expect(after.every((t) => t.status === "cancelled")).toBe(true)
    }),
  )

  it.instance("closes in_progress todos", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const todos = yield* Todo.Service
      const tool = yield* FinishTool
      const def = yield* tool.init()

      yield* todos.update({
        sessionID: chat.id,
        todos: [{ content: "active task", status: "in_progress", priority: "high" }],
      })

      yield* def.execute(
        { reason: "success", result: "done" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const after = yield* todos.get(chat.id)
      expect(after).toHaveLength(1)
      expect(after[0].status).toBe("cancelled")
    }),
  )

  it.instance("leaves no open todos after finish", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const todos = yield* Todo.Service
      const tool = yield* FinishTool
      const def = yield* tool.init()

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "pending", status: "pending", priority: "high" },
          { content: "active", status: "in_progress", priority: "high" },
          { content: "done", status: "completed", priority: "low" },
        ],
      })

      yield* def.execute(
        { reason: "success", result: "done" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const after = yield* todos.get(chat.id)
      const open = after.filter((t) => t.status === "pending" || t.status === "in_progress")
      expect(open).toHaveLength(0)
    }),
  )

  it.instance("already-completed todos remain completed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const todos = yield* Todo.Service
      const tool = yield* FinishTool
      const def = yield* tool.init()

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "done 1", status: "completed", priority: "high" },
          { content: "pending", status: "pending", priority: "medium" },
        ],
      })

      yield* def.execute(
        { reason: "success", result: "done" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const after = yield* todos.get(chat.id)
      expect(after.find((t) => t.content === "done 1")?.status).toBe("completed")
      expect(after.find((t) => t.content === "pending")?.status).toBe("cancelled")
    }),
  )

  it.instance("does not modify unrelated sessions' todos", () =>
    Effect.gen(function* () {
      const { chat: chatA, assistant: assistantA } = yield* seedSession("session A")
      const { chat: chatB } = yield* seedSession("session B")
      const todos = yield* Todo.Service
      const tool = yield* FinishTool
      const def = yield* tool.init()

      yield* todos.update({
        sessionID: chatA.id,
        todos: [{ content: "A pending", status: "pending", priority: "high" }],
      })
      yield* todos.update({
        sessionID: chatB.id,
        todos: [{ content: "B pending", status: "pending", priority: "high" }],
      })

      yield* def.execute(
        { reason: "success", result: "done A" },
        {
          sessionID: chatA.id,
          messageID: assistantA.id,
          agent: "work",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const afterA = yield* todos.get(chatA.id)
      const afterB = yield* todos.get(chatB.id)

      expect(afterA[0].status).toBe("cancelled")
      expect(afterB[0].status).toBe("pending")
    }),
  )

  it.instance("handles empty todo list gracefully", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const todos = yield* Todo.Service
      const tool = yield* FinishTool
      const def = yield* tool.init()

      const before = yield* todos.get(chat.id)
      expect(before).toHaveLength(0)

      const result = yield* def.execute(
        { reason: "success", result: "nothing to do" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.title).toBe("Task completed")
      const after = yield* todos.get(chat.id)
      expect(after).toHaveLength(0)
    }),
  )
})

// A wait yields the turn while the subagents this session launched keep
// running. Everything the eventual real finish needs - the review requirement,
// the plan, the terminal metadata - must survive it, and a wait that has
// nothing to wait on must be refused rather than recorded as a termination.
describe("tool.finish – waiting for a background subagent", () => {
  const startRunningChild = Effect.fn("FinishTest.startRunningChild")(function* (parent: SessionID) {
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const child = yield* sessions.create({ parentID: parent, title: "child" })
    yield* background.start({
      id: child.id,
      type: "task",
      metadata: { parentSessionId: parent, sessionId: child.id },
      run: Effect.never,
    })
    return child.id
  })

  const recordFinishPart = Effect.fn("FinishTest.recordFinishPart")(function* (
    sessionID: SessionID,
    messageID: MessageID,
    input: Record<string, unknown>,
    result: { title: string; output: string; metadata: Record<string, unknown> },
  ) {
    const sessions = yield* Session.Service
    const now = Date.now()
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "tool",
      tool: "finish",
      callID: "finish-call-wait",
      state: {
        status: "completed",
        input,
        output: result.output,
        title: result.title,
        metadata: result.metadata,
        time: { start: now, end: now },
      },
    })
  })

  it.instance("refuses a wait when no background subagent of this session is running", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const tool = yield* FinishTool
      const def = yield* tool.init()
      const recorded: Record<string, unknown>[] = []

      const failure = reviewFailure(
        yield* def
          .execute(
            { reason: "waiting_for_subagent", result: "waiting" },
            workCtx(chat.id, assistant.id, (input) => {
              recorded.push(input.metadata ?? {})
              return Effect.void
            }),
          )
          .pipe(Effect.exit),
      )

      expect(failure?.message).toContain("no running background subagents found for this session")
      // The refusal is model feedback, not a review decline: nothing is
      // persisted on the part for the review gate to read.
      expect(recorded).toEqual([])
    }),
  )

  it.instance("refuses a wait for a subagent owned by another session", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const sessions = yield* Session.Service
      const sibling = yield* sessions.create({ title: "sibling" })
      yield* startRunningChild(sibling.id)
      const tool = yield* FinishTool
      const def = yield* tool.init()

      const failure = reviewFailure(
        yield* def
          .execute({ reason: "waiting_for_subagent", result: "waiting" }, workCtx(chat.id, assistant.id))
          .pipe(Effect.exit),
      )

      expect(failure?.message).toContain("no running background subagents found for this session")
    }),
  )

  // The wait follows the parent link on a task job only. A job this session
  // merely owns - its own run, or something that is not a delegated task - is
  // not work that notifies a parent, so it cannot hold a wait.
  it.instance("refuses a wait on a job of this session that is not a task", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const background = yield* BackgroundJob.Service
      yield* background.start({
        id: `${chat.id}-own-run`,
        type: "server",
        metadata: { sessionId: chat.id },
        run: Effect.never,
      })
      const tool = yield* FinishTool
      const def = yield* tool.init()

      const failure = reviewFailure(
        yield* def
          .execute({ reason: "waiting_for_subagent", result: "waiting" }, workCtx(chat.id, assistant.id))
          .pipe(Effect.exit),
      )

      expect(failure?.message).toContain("no running background subagents found for this session")
    }),
  )

  it.instance("refuses a wait after the subagent stopped", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const background = yield* BackgroundJob.Service
      const child = yield* startRunningChild(chat.id)
      yield* background.cancel(child)
      const tool = yield* FinishTool
      const def = yield* tool.init()

      const failure = reviewFailure(
        yield* def
          .execute({ reason: "waiting_for_subagent", result: "waiting" }, workCtx(chat.id, assistant.id))
          .pipe(Effect.exit),
      )

      expect(failure?.message).toContain("no running background subagents found for this session")
    }),
  )

  // A subagent may yield for background subagents it launched itself: `task`
  // keeps its job running through the wait and resumes it as they report, so
  // the wait is woken by work that belongs to the session (#222). Yielding for
  // anything else - its parent's work, or nothing at all - would end its run
  // here and deliver a provisional result as the run's only delivery.
  it.instance("accepts a wait from a child session with a running subagent of its own", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const { chat, assistant } = yield* seedSession("child", "work", parent.id)
      yield* startRunningChild(chat.id)
      const tool = yield* FinishTool
      const def = yield* tool.init()
      const recorded: Record<string, unknown>[] = []

      const result = yield* def.execute(
        { reason: "waiting_for_subagent", result: "waiting" },
        workCtx(chat.id, assistant.id, (input) => {
          recorded.push(input.metadata ?? {})
          return Effect.void
        }),
      )

      expect(result.title).toBe("Waiting for 1 background subagent(s)")
      expect(result.output).toBe("waiting")
      expect(result.metadata.waiting).toBe(true)
      expect(result.metadata).not.toHaveProperty("review")
      // Non-terminal: the wait persists nothing for the eventual finish to read.
      expect(recorded).toEqual([])
    }),
  )

  it.instance("refuses a wait from a child session with nothing of its own running", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const { chat, assistant } = yield* seedSession("child", "work", parent.id)
      // A wait would otherwise be accepted: the parent itself has a child
      // running, but that child is not work this session launched.
      yield* startRunningChild(parent.id)
      const tool = yield* FinishTool
      const def = yield* tool.init()
      const recorded: Record<string, unknown>[] = []

      const failure = reviewFailure(
        yield* def
          .execute(
            { reason: "waiting_for_subagent", result: "waiting" },
            workCtx(chat.id, assistant.id, (input) => {
              recorded.push(input.metadata ?? {})
              return Effect.void
            }),
          )
          .pipe(Effect.exit),
      )

      expect(failure?.message).toContain("this session is itself a subagent")
      expect(failure?.message).toContain("has no background subagents of its own running")
      expect(failure?.message).toContain('Deliver your own result with reason: "success"')
      // Model feedback, not a nudge persisted for the eventual finish.
      expect(recorded).toEqual([])
    }),
  )

  // A resumed task (`task_id`) can run a session that never had a parentID, so
  // the task job running the session is the signal that it is a subagent. With
  // nothing of its own running, the wait is refused for that reason.
  it.instance("refuses a wait from a session running as a task job with nothing of its own running", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const background = yield* BackgroundJob.Service
      yield* background.start({
        id: `${chat.id}-task-run`,
        type: "task",
        metadata: { sessionId: chat.id, parentSessionId: SessionID.make("ses_other_parent") },
        run: Effect.never,
      })
      const tool = yield* FinishTool
      const def = yield* tool.init()

      const failure = reviewFailure(
        yield* def
          .execute({ reason: "waiting_for_subagent", result: "waiting" }, workCtx(chat.id, assistant.id))
          .pipe(Effect.exit),
      )

      expect(failure?.message).toContain("this session is itself a subagent")
    }),
  )

  it.instance("yields the turn without consuming the review requirement or the plan", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const todos = yield* Todo.Service
      const tool = yield* FinishTool
      const def = yield* tool.init()
      const recorded: Record<string, unknown>[] = []

      yield* addToolPart(chat.id, assistant.id, "edit")
      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "wire the parser", status: "in_progress", priority: "high" },
          { content: "cover the edge case", status: "pending", priority: "medium" },
        ],
      })
      yield* startRunningChild(chat.id)
      yield* startRunningChild(chat.id)

      const result = yield* def.execute(
        { reason: "waiting_for_subagent", result: "Waiting on the two children." },
        workCtx(chat.id, assistant.id, (input) => {
          recorded.push(input.metadata ?? {})
          return Effect.void
        }),
      )

      expect(result.title).toBe("Waiting for 2 background subagent(s)")
      expect(result.output).toBe("Waiting on the two children.")
      // Non-terminal: no review verdict, so nothing marks the run complete, and
      // no decline was persisted for the gate to read later.
      expect(result.metadata.waiting).toBe(true)
      expect(result.metadata).not.toHaveProperty("review")
      expect(recorded).toEqual([])
      const plan = yield* todos.get(chat.id)
      expect(plan.map((todo) => todo.status)).toEqual(["in_progress", "pending"])

      // The gate is still armed for the eventual finish: persisting the wait the
      // way the runtime does must not let a later finish skip review.
      yield* recordFinishPart(
        chat.id,
        assistant.id,
        { reason: "waiting_for_subagent", result: "Waiting on the two children." },
        result,
      )
      const failure = reviewFailure(
        yield* def.execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id)).pipe(Effect.exit),
      )
      expect(failure?.message).toContain("no explicit Approved review")
      expect(failure?.message).toContain('`subagent_type: "review"`')
      expect(failure?.message).not.toContain("retrying finish does not skip review")
    }),
  )
})

describe("todo state – granular planning and sequential execution", () => {
  it.instance("todo items can represent granular sequential work", () =>
    Effect.gen(function* () {
      const { chat } = yield* seedSession()
      const todos = yield* Todo.Service

      const granularPlan = [
        { content: "Trace current model-selection state flow", status: "pending" as const, priority: "high" as const },
        { content: "Trace agent-turn configuration resolution", status: "pending" as const, priority: "high" as const },
        {
          content: "Identify where pending configuration is deferred",
          status: "pending" as const,
          priority: "high" as const,
        },
        {
          content: "Define next-turn configuration semantics",
          status: "pending" as const,
          priority: "medium" as const,
        },
        { content: "Implement pending model state", status: "pending" as const, priority: "high" as const },
        { content: "Add model-switch test", status: "pending" as const, priority: "medium" as const },
        { content: "Run targeted tests", status: "pending" as const, priority: "medium" as const },
        { content: "Review final diff", status: "pending" as const, priority: "low" as const },
      ]

      yield* todos.update({ sessionID: chat.id, todos: granularPlan })
      const stored = yield* todos.get(chat.id)
      expect(stored).toHaveLength(8)
      expect(stored[0].content).toBe("Trace current model-selection state flow")
    }),
  )

  it.instance("one item can remain active while agent performs operations", () =>
    Effect.gen(function* () {
      const { chat } = yield* seedSession()
      const todos = yield* Todo.Service

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "Trace how model configuration reaches the agent turn", status: "in_progress", priority: "high" },
          { content: "Implement feature", status: "pending", priority: "high" },
        ],
      })

      const current = yield* todos.get(chat.id)
      const active = current.filter((t) => t.status === "in_progress")
      expect(active).toHaveLength(1)
      expect(active[0].content).toBe("Trace how model configuration reaches the agent turn")

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "Trace how model configuration reaches the agent turn", status: "completed", priority: "high" },
          { content: "Implement feature", status: "in_progress", priority: "high" },
        ],
      })

      const after = yield* todos.get(chat.id)
      expect(after[0].status).toBe("completed")
      expect(after[1].status).toBe("in_progress")
    }),
  )

  it.instance("completed items transition correctly", () =>
    Effect.gen(function* () {
      const { chat } = yield* seedSession()
      const todos = yield* Todo.Service

      yield* todos.update({
        sessionID: chat.id,
        todos: [{ content: "task", status: "pending", priority: "high" }],
      })
      yield* todos.update({
        sessionID: chat.id,
        todos: [{ content: "task", status: "in_progress", priority: "high" }],
      })
      let stored = yield* todos.get(chat.id)
      expect(stored[0].status).toBe("in_progress")

      yield* todos.update({
        sessionID: chat.id,
        todos: [{ content: "task", status: "completed", priority: "high" }],
      })
      stored = yield* todos.get(chat.id)
      expect(stored[0].status).toBe("completed")
    }),
  )

  it.instance("newly discovered work can be added without corrupting existing state", () =>
    Effect.gen(function* () {
      const { chat } = yield* seedSession()
      const todos = yield* Todo.Service

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "Implement feature", status: "completed", priority: "high" },
          { content: "Run tests", status: "in_progress", priority: "medium" },
        ],
      })

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "Implement feature", status: "completed", priority: "high" },
          { content: "Run tests", status: "in_progress", priority: "medium" },
          { content: "Fix edge case discovered during testing", status: "pending", priority: "high" },
        ],
      })

      const after = yield* todos.get(chat.id)
      expect(after).toHaveLength(3)
      expect(after[0].status).toBe("completed")
      expect(after[1].status).toBe("in_progress")
      expect(after[2].content).toBe("Fix edge case discovered during testing")
    }),
  )

  it.instance("creating, updating, completing, removing items works", () =>
    Effect.gen(function* () {
      const { chat } = yield* seedSession()
      const todos = yield* Todo.Service

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "task 1", status: "pending", priority: "high" },
          { content: "task 2", status: "pending", priority: "medium" },
        ],
      })
      expect(yield* todos.get(chat.id)).toHaveLength(2)

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "task 1", status: "in_progress", priority: "high" },
          { content: "task 2", status: "pending", priority: "medium" },
        ],
      })
      expect((yield* todos.get(chat.id))[0].status).toBe("in_progress")

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "task 1", status: "completed", priority: "high" },
          { content: "task 2", status: "pending", priority: "medium" },
        ],
      })
      expect((yield* todos.get(chat.id))[0].status).toBe("completed")

      yield* todos.update({
        sessionID: chat.id,
        todos: [{ content: "task 1 revised", status: "completed", priority: "high" }],
      })
      const after = yield* todos.get(chat.id)
      expect(after).toHaveLength(1)
      expect(after[0].content).toBe("task 1 revised")

      yield* todos.update({ sessionID: chat.id, todos: [] })
      expect(yield* todos.get(chat.id)).toHaveLength(0)
    }),
  )
})

const REVIEW_NEEDS_FIXES = {
  version: 1,
  revision: "uncommitted",
  assessment: "needs-fixes",
  summary: "One important finding.",
  findings: [{ severity: "important", title: "Off-by-one" }],
}

const REVIEW_APPROVED = {
  version: 1,
  revision: "uncommitted",
  assessment: "approved",
  summary: "Nothing to report.",
  findings: [],
}

const reviewEnvelope = (report: Record<string, unknown>) =>
  ["<silvercode-review>", JSON.stringify(report, null, 2), "</silvercode-review>"].join("\n")

const reviewCtx = (sessionID: SessionID, messageID: MessageID) => ({
  sessionID,
  messageID,
  agent: "review",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const reviewFailure = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) return undefined
  const failure = exit.cause.reasons.find(Cause.isFailReason)?.error
  expect(failure).toBeInstanceOf(ToolFailure)
  if (!(failure instanceof ToolFailure)) return undefined
  return failure
}

describe("tool.finish – review result gate", () => {
  it.instance("rejects a review finish with an empty result and no envelope", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession("review", "review")
      const tool = yield* FinishTool
      const def = yield* tool.init()

      const failure = reviewFailure(
        yield* def.execute({ reason: "success", result: "" }, reviewCtx(chat.id, assistant.id)).pipe(Effect.exit),
      )
      expect(failure?.message).toContain("Review finish rejected")
      expect(failure?.message).toContain("<silvercode-review>")
    }),
  )

  it.instance("rejects a review finish with prose and no envelope", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession("review", "review")
      const tool = yield* FinishTool
      const def = yield* tool.init()

      const failure = reviewFailure(
        yield* def
          .execute({ reason: "success", result: "Looks good to me, ship it." }, reviewCtx(chat.id, assistant.id))
          .pipe(Effect.exit),
      )
      expect(failure?.message).toContain("Review finish rejected")
      expect(failure?.message).toContain("no <silvercode-review> report envelope was found")
    }),
  )

  it.instance("accepts a valid needs-fixes envelope and keeps the canonical result", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession("review", "review")
      const tool = yield* FinishTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        { reason: "success", result: `Assessment\n\n${reviewEnvelope(REVIEW_NEEDS_FIXES)}` },
        reviewCtx(chat.id, assistant.id),
      )

      expect(result.title).toBe("Task completed")
      const delivery = ReviewReport.extract([result.output])
      expect(delivery.ok).toBe(true)
      if (!delivery.ok) return
      expect(delivery.report.assessment).toBe("needs-fixes")
      expect(delivery.report.findings).toHaveLength(1)
    }),
  )

  it.instance("accepts a valid approved envelope and keeps the canonical result", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession("review", "review")
      const tool = yield* FinishTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        { reason: "success", result: `Assessment\n\n${reviewEnvelope(REVIEW_APPROVED)}` },
        reviewCtx(chat.id, assistant.id),
      )

      expect(result.title).toBe("Task completed")
      const delivery = ReviewReport.extract([result.output])
      expect(delivery.ok).toBe(true)
      if (!delivery.ok) return
      expect(delivery.report.assessment).toBe("approved")
    }),
  )

  it.instance("accepts the envelope from an earlier text part with a short summary", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession("review", "review")
      const session = yield* Session.Service
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "text",
        text: `Assessment\n\n${reviewEnvelope(REVIEW_NEEDS_FIXES)}`,
      })
      const tool = yield* FinishTool
      const def = yield* tool.init()

      const result = yield* def.execute({ reason: "success", result: "done" }, reviewCtx(chat.id, assistant.id))

      expect(result.title).toBe("Task completed")
      // The orchestrator assembles the canonical result from the persisted
      // text parts plus the finish summary, so assert through that same shape.
      const text = `Assessment\n\n${reviewEnvelope(REVIEW_NEEDS_FIXES)}`
      expect(ReviewReport.extract([text, result.output]).ok).toBe(true)
    }),
  )
})

describe("tool.finish - per-message review blocker", () => {
  it.instance("hiding task never waives success", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const sessions = yield* Session.Service
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const user = messages.find((m) => m.info.role === "user")!.info
      if (user.role !== "user") throw new Error("Expected user")
      yield* sessions.updateMessage({ ...user, tools: { task: false } })
      yield* addToolPart(chat.id, assistant.id, "edit")
      const def = yield* (yield* FinishTool).init()
      const failure = reviewFailure(
        yield* def.execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id)).pipe(Effect.exit),
      )
      expect(failure?.message).toContain("task-hidden")
      const result = yield* def.execute({ reason: "failure", result: "Cannot review" }, workCtx(chat.id, assistant.id))
      expect(result.metadata.review?.termination).toBe("review-blocked")
    }),
  )
})

// ---------------------------------------------------------------------------
// Which agent owns the review dispatch (#233).
//
// `reviewUnavailable` decides whether this session can dispatch the Review
// subagent at all, and it now reads the session's own owner through the shared
// `sessionAgent` helper: the pinned session agent, else the newest USER
// message. It never reads `ctx.agent`, the agent running the tool. The resolver
// it replaces used `session.agent ?? ctx.agent`, so each case below is arranged
// to route to a *different* reviewer under the two rules and therefore reach
// the opposite outcome. Every one of them fails on the old resolver and passes
// on this one, except the pinned-owner precedence case, which both resolvers
// answer identically and which is here to pin precedence against the newest
// USER rule rather than against the old code.
// ---------------------------------------------------------------------------
describe("tool.finish – review dispatch owner", () => {
  // A session whose owner is pinned, with messages owned by a different agent.
  const seedPinned = Effect.fn("FinishTest.seedPinned")(function* (pinned: string, messageAgent: string) {
    const session = yield* Session.Service
    const chat = yield* session.create({ title: "pinned", agent: pinned })
    const user = yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: chat.id,
      agent: messageAgent,
      model: { providerID: "test" as any, modelID: "test-model" as any },
      time: { created: Date.now() },
    })
    yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: user.id,
      sessionID: chat.id,
      mode: "work",
      agent: messageAgent,
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as any,
      providerID: "test" as any,
      time: { created: Date.now() },
    } as SessionV1.Assistant)
    const messages = yield* session.messages({ sessionID: chat.id })
    const assistant = messages.find((message) => message.info.role === "assistant")!.info as SessionV1.Assistant
    return { chat, assistant }
  })

  // Newer than the seeded user message, and owned by a different agent: the
  // message a "newest message of any role" rule would read.
  const addNewerAssistant = Effect.fn("FinishTest.addNewerAssistant")(function* (
    sessionID: SessionID,
    parentID: MessageID,
    agent: string,
  ) {
    const session = yield* Session.Service
    yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID,
      sessionID,
      mode: "work",
      agent,
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as any,
      providerID: "test" as any,
      time: { created: Date.now() },
    } as SessionV1.Assistant)
  })

  // The session is unpinned, so its owner is the newest USER message ("work",
  // which routes to work-review). The tool runs as "code", which routes to
  // code-review - the agent disabled here. The old resolver fell back to
  // `ctx.agent`, resolved the disabled reviewer, and reported the session
  // blocked; this one resolves the owner's reviewer and declines normally.
  it.instance(
    "the newest user message owns the reviewer, not the agent running finish",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession("owner", "work")
        yield* addToolPart(chat.id, assistant.id, "edit")
        const def = yield* (yield* FinishTool).init()

        const failure = reviewFailure(
          yield* def
            .execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id, undefined, "code"))
            .pipe(Effect.exit),
        )
        expect(failure?.message).toContain("no explicit Approved review")
        expect(failure?.message).not.toContain("Review blocked")
      }),
    { config: { agent: { "code-review": { disable: true } } } },
  )

  // Same discrimination, with a newer assistant message owned by the agent
  // whose reviewer is disabled. A resolver that read the newest message of any
  // role - or the agent running the tool - would resolve code-review here.
  it.instance(
    "a newer assistant message does not own the reviewer",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession("owner", "work")
        yield* addNewerAssistant(chat.id, assistant.parentID!, "code")
        yield* addToolPart(chat.id, assistant.id, "edit")
        const def = yield* (yield* FinishTool).init()

        const failure = reviewFailure(
          yield* def
            .execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id, undefined, "code"))
            .pipe(Effect.exit),
        )
        expect(failure?.message).toContain("no explicit Approved review")
        expect(failure?.message).not.toContain("Review blocked")
      }),
    { config: { agent: { "code-review": { disable: true } } } },
  )

  // The pinned owner outranks the newest USER message. Pinned "code" routes to
  // the disabled code-review, so this session is blocked even though its newest
  // user message would route to an available reviewer.
  it.instance(
    "a pinned session owner outranks the newest user message",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedPinned("code", "work")
        yield* addToolPart(chat.id, assistant.id, "edit")
        const def = yield* (yield* FinishTool).init()

        const failure = reviewFailure(
          yield* def
            .execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id, undefined, "code"))
            .pipe(Effect.exit),
        )
        expect(failure?.message).toContain("Review blocked (reviewer-missing)")
      }),
    { config: { agent: { "code-review": { disable: true } } } },
  )

  // Permission, both directions. The ruleset is read from the agent running the
  // tool, but the *pattern* it is matched against is the resolved reviewer - so
  // a deny only bites when it names the reviewer this session actually routes
  // to. Owner "work" routes to work-review while the tool runs as "code".
  it.instance(
    "a deny aimed at the resolved reviewer blocks success",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession("owner", "work")
        yield* addToolPart(chat.id, assistant.id, "edit")
        const def = yield* (yield* FinishTool).init()

        const failure = reviewFailure(
          yield* def
            .execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id, undefined, "code"))
            .pipe(Effect.exit),
        )
        expect(failure?.message).toContain("Review blocked (permission-denied)")
        // A block is not a waiver: the honest failure still completes, and it
        // records why review could not run.
        const result = yield* def.execute(
          { reason: "failure", result: "Review cannot run" },
          workCtx(chat.id, assistant.id, undefined, "code"),
        )
        expect(result.metadata.review?.termination).toBe("review-blocked")
        expect(result.metadata.review?.unavailable).toBe("permission-denied")
      }),
    { config: { agent: { code: { permission: { task: { "work-review": "deny" } } } } } },
  )

  it.instance(
    "a deny aimed at a reviewer this session does not route to does not block",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession("owner", "work")
        yield* addToolPart(chat.id, assistant.id, "edit")
        const def = yield* (yield* FinishTool).init()

        const failure = reviewFailure(
          yield* def
            .execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id, undefined, "code"))
            .pipe(Effect.exit),
        )
        expect(failure?.message).toContain("no explicit Approved review")
        expect(failure?.message).not.toContain("Review blocked")
      }),
    { config: { agent: { code: { permission: { task: { "code-review": "deny" } } } } } },
  )
})

// A depth block at the root has nowhere to hand its writes to, so it is a block
// and not a handoff: success is refused, and only a declared failure completes.
describe("tool.finish – review blocked at the root", () => {
  it.instance(
    "a root session at depth 0 cannot report success but can report failure",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession()
        yield* addToolPart(chat.id, assistant.id, "edit")
        const def = yield* (yield* FinishTool).init()

        const failure = reviewFailure(
          yield* def.execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id)).pipe(Effect.exit),
        )
        expect(failure?.message).toContain("Review blocked (subagent-depth)")

        const result = yield* def.execute(
          { reason: "failure", result: "Review cannot run at this depth." },
          workCtx(chat.id, assistant.id),
        )
        expect(result.metadata.review).toMatchObject({
          verdict: "pending",
          reviews: 0,
          maxIterations: 2, // medium's canonical pass budget
          termination: "review-blocked",
          unavailable: "subagent-depth",
        })
        // No parent, so nothing is handed off and no write evidence is projected.
        expect(result.metadata).not.toHaveProperty(REVIEW_LOOP_METADATA)
      }),
    { config: { subagent_depth: 0 } },
  )
})

// The task tool projects a child's writes onto its own part while the child is
// still running, so the parent's gate sees them before any delivery. That
// projection has to gate the parent - and the parent's own Review has to be
// what clears it, since the child could not review its own work.
describe("tool.finish – a parent reviews its child's writes", () => {
  // The part the task tool leaves on the parent while a writing child runs.
  const addChildTaskPart = Effect.fn("FinishTest.addChildTaskPart")(function* (
    sessionID: SessionID,
    messageID: MessageID,
    status: "running" | "error",
  ) {
    const session = yield* Session.Service
    const now = Date.now()
    const base = {
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "tool" as const,
      tool: "task",
      callID: "child-write-task",
    }
    const metadata = {
      [REVIEW_LOOP_METADATA]: { writesFiles: true, handoff: "pending", sessionId: "ses_child" },
    }
    yield* session.updatePart(
      status === "running"
        ? {
            ...base,
            state: {
              status,
              input: { subagent_type: "general", background: false },
              title: "task",
              metadata,
              time: { start: now },
            },
          }
        : {
            ...base,
            state: {
              status,
              input: { subagent_type: "general", background: false },
              error: "child crashed after writing",
              title: "task",
              metadata,
              time: { start: now, end: now },
            },
          },
    )
  })

  for (const status of ["running", "error"] as const) {
    it.instance(`projected child writes gate the parent while the child is ${status}`, () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession()
        yield* addChildTaskPart(chat.id, assistant.id, status)
        const def = yield* (yield* FinishTool).init()

        const failure = reviewFailure(
          yield* def.execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id)).pipe(Effect.exit),
        )
        expect(failure?.message).toContain("no explicit Approved review")

        // The parent's own Review covers the child's projected writes: the gate
        // is a requirement the parent can discharge, not a permanent block.
        yield* addReview(chat.id, assistant.id, "Approved")
        const result = yield* def.execute(
          { reason: "success", result: "Reviewed the child's changes." },
          workCtx(chat.id, assistant.id),
        )
        expect(result.metadata.review?.termination).toBe("approved")
        expect(result.metadata.review?.verdict).toBe("approved")
        expect(result.metadata.review).not.toHaveProperty("unavailable")
      }),
    )
  }

  // The report side of the same handoff: a review child that wrote files hands
  // those writes back unreviewed even when its report is Approved. The task
  // tool keeps the report association on the part and declares the handoff
  // `review-pending`, so the marker - not the approval - decides the gate. The
  // Needs-fixes fixture could not catch this hole: a Needs-fixes handoff
  // already reads as unapproved.
  const addWritingReview = Effect.fn("FinishTest.addWritingReview")(function* (
    sessionID: SessionID,
    messageID: MessageID,
  ) {
    const session = yield* Session.Service
    const now = Date.now()
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "tool",
      tool: "task",
      callID: "review-write-task",
      state: {
        status: "completed",
        input: { subagent_type: "review", background: false },
        output:
          "UNREVIEWED: This child changed files. Parent must run Review before reporting success.\nAssessment: Approved",
        title: "task",
        metadata: {
          [REVIEW_LOOP_METADATA]: { writesFiles: true, handoff: "pending", sessionId: "ses_review_child" },
          review: {
            report: REVIEW_APPROVED,
            sessionId: "ses_review_child",
            revision: "uncommitted",
            verdict: "pending",
            termination: "review-pending",
          },
          termination: { reason: "success" },
        },
        time: { start: now, end: now },
      },
    })
  })

  it.instance("an Approved report from a writing review child does not approve the child's edits", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      yield* addToolPart(chat.id, assistant.id, "edit")
      yield* addWritingReview(chat.id, assistant.id)
      const def = yield* (yield* FinishTool).init()

      const failure = reviewFailure(
        yield* def.execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id)).pipe(Effect.exit),
      )
      expect(failure?.message).toContain("no explicit Approved review")

      // The parent's own Review covers the child's projected writes: the gate
      // is a requirement the parent can discharge, not a permanent block.
      yield* addReview(chat.id, assistant.id, "Approved")
      const result = yield* def.execute(
        { reason: "success", result: "Reviewed the child's changes." },
        workCtx(chat.id, assistant.id),
      )
      expect(result.metadata.review?.termination).toBe("approved")
      expect(result.metadata.review?.verdict).toBe("approved")
    }),
  )
})

// An errored synchronous review is an honest attempt: it consumed one of the
// configured iterations without delivering a verdict. Counting it is what keeps
// a reviewer that keeps failing from holding the turn open forever.
describe("tool.finish – errored review attempts reach the cap", () => {
  const addErroredReview = Effect.fn("FinishTest.addErroredReview")(function* (
    sessionID: SessionID,
    messageID: MessageID,
  ) {
    const session = yield* Session.Service
    const now = Date.now()
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "tool",
      tool: "task",
      callID: "review-errored",
      state: {
        status: "error",
        input: { subagent_type: "review", background: false },
        error: "the review dispatch failed",
        title: "task",
        metadata: {},
        time: { start: now, end: now },
      },
    })
  })

  it.instance(
    "an errored review attempt counts toward the cap and ends the requirement",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession()
        yield* addToolPart(chat.id, assistant.id, "edit")
        yield* addErroredReview(chat.id, assistant.id)
        yield* addErroredReview(chat.id, assistant.id)
        const def = yield* (yield* FinishTool).init()

        // Two failed dispatches spend medium's two-pass budget: the cap ends the
        // requirement honestly, never as a verdict.
        const result = yield* def.execute(
          { reason: "success", result: "Stopped at the cap after the review dispatch failed." },
          workCtx(chat.id, assistant.id),
        )
        expect(result.metadata.review).toMatchObject({
          verdict: "cap",
          reviews: 2,
          maxIterations: 2,
          termination: "budget-exhausted",
        })
      }),
  )

  // Below the cap the same errored attempt leaves the work unapproved: counting
  // it must not read as a verdict.
  it.instance("an errored review attempt below the cap still blocks success", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      yield* addToolPart(chat.id, assistant.id, "edit")
      yield* addErroredReview(chat.id, assistant.id)
      const def = yield* (yield* FinishTool).init()

      const failure = reviewFailure(
        yield* def.execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id)).pipe(Effect.exit),
      )
      expect(failure?.message).toContain("no explicit Approved review")
    }),
  )
})

// An approval covers only the tree it reviewed. Approved review, then more
// file writes, then a review attempt that errored: the errored attempt clears
// the work flag, so the earlier approval must not revive as a delivered verdict.
describe("tool.finish – stale approval after later work and an errored attempt", () => {
  const addErroredTask = Effect.fn("FinishTest.addErroredTask")(function* (
    sessionID: SessionID,
    messageID: MessageID,
  ) {
    const session = yield* Session.Service
    const now = Date.now()
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "tool",
      tool: "task",
      callID: "review-errored-stale",
      state: {
        status: "error",
        input: { subagent_type: "review", background: false },
        error: "the review dispatch failed",
        title: "task",
        metadata: {},
        time: { start: now, end: now },
      },
    })
  })

  const staleSetup = Effect.fn("FinishTest.staleSetup")(function* (chatID: SessionID, assistantID: MessageID) {
    yield* addToolPart(chatID, assistantID, "edit")
    yield* addReview(chatID, assistantID, "Approved")
    yield* addToolPart(chatID, assistantID, "edit")
    yield* addErroredTask(chatID, assistantID)
  })

  it.instance("medium: delivers budget-exhausted, never approved", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      yield* staleSetup(chat.id, assistant.id)
      const def = yield* (yield* FinishTool).init()
      const result = yield* def.execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id))
      expect(result.metadata.review).toMatchObject({
        termination: "budget-exhausted",
        disposition: "unreviewed",
        reviews: 2,
        maxIterations: 2,
      })
      expect(result.metadata.review).not.toMatchObject({ termination: "approved" })
    }),
  )

  it.instance(
    "thorough: declines again, never delivered as approved",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession()
        yield* staleSetup(chat.id, assistant.id)
        const declined = yield* declineOf({ reason: "success", result: "done" }, chat.id, assistant.id)
        expect(declined.message).toContain('effort is "thorough"')
        expect(declined.metadata.review).not.toMatchObject({ termination: "approved" })
        expect(declined.metadata.review).not.toMatchObject({ disposition: "reviewed" })
      }),
    { config: { agent: { effort: "thorough" } } },
  )

  it.instance(
    "fast: delivers unreviewed, never approved",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSession()
        yield* staleSetup(chat.id, assistant.id)
        const def = yield* (yield* FinishTool).init()
        const result = yield* def.execute({ reason: "success", result: "done" }, workCtx(chat.id, assistant.id))
        expect(result.metadata.review).toMatchObject({ termination: "unreviewed", disposition: "unreviewed" })
      }),
    { config: { agent: { effort: "fast" } } },
  )
})
