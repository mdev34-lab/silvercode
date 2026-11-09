import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { REVIEW_LOOP_METADATA } from "@opencode-ai/core/review-loop"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Cause, Effect, Exit } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session, withAgentEffort } from "@/session/session"
import { Todo } from "@/session/todo"
import { FinishTool } from "@/tool/finish"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
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
  ),
)

const seed = Effect.fn("FinishMinorPolicy.seed")(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "minor policy", metadata: withAgentEffort(undefined, "thorough") })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "work",
    model: { providerID: "test" as never, modelID: "test-model" as never },
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: chat.id,
    messageID: user.id,
    type: "text",
    text: "Implement the requested change",
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
    modelID: "test-model" as never,
    providerID: "test" as never,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  return { chat, assistant }
})

const add = Effect.fn("FinishMinorPolicy.add")(function* (
  chat: SessionID,
  message: MessageID,
  tool: "edit" | "task",
  output = "done",
) {
  const sessions = yield* Session.Service
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: chat,
    messageID: message,
    type: "tool",
    tool,
    callID: PartID.ascending(),
    state: {
      status: "completed",
      input: tool === "task" ? { subagent_type: "review", background: false } : {},
      output,
      title: tool,
      time: { start: Date.now(), end: Date.now() },
      metadata: tool === "edit" ? { [REVIEW_LOOP_METADATA]: { writesFiles: true } } : { background: false },
    },
  })
})

function review(findings: readonly Record<string, unknown>[] = []) {
  return `<silvercode-review>${JSON.stringify({
    version: 1,
    revision: "uncommitted",
    assessment: "approved",
    summary: "Reviewed current work",
    findings,
  })}</silvercode-review>`
}

const minor = { severity: "minor", title: "Correct the documented name", file: "README.md", line: 1 }

function context(chat: SessionID, message: MessageID, recorded: Record<string, unknown>[]): Tool.Context {
  return {
    sessionID: chat,
    messageID: message,
    agent: "work",
    abort: new AbortController().signal,
    messages: [],
    ask: () => Effect.void,
    metadata: (input) =>
      Effect.sync(() => {
        recorded.push(input.metadata ?? {})
      }),
  }
}

const call = Effect.fn("FinishMinorPolicy.call")(function* (
  chat: SessionID,
  message: MessageID,
  recorded: Record<string, unknown>[],
) {
  const tool = yield* FinishTool
  const def = yield* tool.init()
  const exit = yield* def
    .execute({ reason: "success", result: "done" }, context(chat, message, recorded))
    .pipe(Effect.exit)
  if (Exit.isSuccess(exit)) recorded.push(exit.value.metadata)
  return exit
})

function decline(exit: Exit.Exit<unknown, unknown>) {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error("expected a recoverable finish decline")
  const failure = Cause.squash(exit.cause)
  expect(failure).toBeInstanceOf(ToolFailure)
  if (!(failure instanceof ToolFailure)) throw failure
  return failure.message
}

describe("finish: known minor findings at thorough", () => {
  it.instance("persists Approved+minor evidence and requires correction followed by a fresh clean review", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const recorded: Record<string, unknown>[] = []
      yield* add(chat.id, assistant.id, "edit")
      yield* add(chat.id, assistant.id, "task", review([minor]))
      const sessions = yield* Session.Service
      const stored = yield* sessions.messages({ sessionID: chat.id })
      const report = stored.flatMap((entry) => entry.parts).find((part) => part.type === "tool" && part.tool === "task")
      expect(report?.type === "tool" && report.state.status === "completed" ? report.state.output : "").toBe(
        review([minor]),
      )

      const message = decline(yield* call(chat.id, assistant.id, recorded))
      expect(message).toContain("minor")
      expect(message).toContain("fresh")
      expect(recorded.at(-1)?.review).toMatchObject({
        nudged: true,
        effort: "thorough",
        verdict: "approved",
        disposition: "reviewed",
        openFindings: 1,
        blockingFindings: 0,
        workSinceReview: false,
      })
      expect(decline(yield* call(chat.id, assistant.id, recorded))).toBe(message)

      yield* add(chat.id, assistant.id, "edit", "minor finding corrected")
      expect(decline(yield* call(chat.id, assistant.id, recorded))).toContain("fresh")
      expect(recorded.at(-1)?.review).toMatchObject({
        effort: "thorough",
        openFindings: 1,
        blockingFindings: 0,
        workSinceReview: true,
        stale: true,
      })
      yield* add(chat.id, assistant.id, "task", review([minor]))
      expect(decline(yield* call(chat.id, assistant.id, recorded))).toContain("minor")
      expect(recorded.at(-1)?.review).toMatchObject({ openFindings: 1, blockingFindings: 0, workSinceReview: false })

      yield* add(chat.id, assistant.id, "task", review())
      const clean = yield* call(chat.id, assistant.id, recorded)
      expect(Exit.isSuccess(clean)).toBe(true)
      if (!Exit.isSuccess(clean)) return
      expect(clean.value.metadata.review).toMatchObject({
        effort: "thorough",
        termination: "approved",
        disposition: "reviewed",
        reviews: 3,
        openFindings: 0,
        blockingFindings: 0,
        workSinceReview: false,
      })
      expect(clean.value.output).not.toContain("UNREVIEWED")
    }),
  )

  it.instance("switching the current session effort changes enforcement without rewriting the review", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      yield* add(chat.id, assistant.id, "edit")
      yield* add(chat.id, assistant.id, "task", review([minor]))
      const sessions = yield* Session.Service
      const recorded: Record<string, unknown>[] = []
      for (const effort of ["thorough", "medium", "thorough", "fast", "thorough"] as const) {
        yield* sessions.setMetadata({ sessionID: chat.id, metadata: withAgentEffort(chat.metadata, effort) })
        const result = yield* call(chat.id, assistant.id, recorded)
        if (effort === "thorough") {
          expect(decline(result)).toContain("minor")
          expect(recorded.at(-1)?.review).toMatchObject({ effort, openFindings: 1, blockingFindings: 0 })
          continue
        }
        expect(Exit.isSuccess(result)).toBe(true)
        if (!Exit.isSuccess(result)) continue
        expect(result.value.metadata.review).toMatchObject({
          effort,
          termination: "approved",
          openFindings: 1,
          blockingFindings: 0,
        })
      }
    }),
  )

  it.instance("stale work with no findings and a missing review keep the existing warning delivery", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const recorded: Record<string, unknown>[] = []
      yield* add(chat.id, assistant.id, "edit")
      const missing = yield* call(chat.id, assistant.id, recorded)
      expect(Exit.isSuccess(missing)).toBe(true)
      if (!Exit.isSuccess(missing)) return
      expect(missing.value.output).toContain("UNREVIEWED")
      expect(missing.value.metadata.review).toMatchObject({
        effort: "thorough",
        termination: "unreviewed",
        openFindings: 0,
        blockingFindings: 0,
      })

      yield* add(chat.id, assistant.id, "task", review())
      yield* add(chat.id, assistant.id, "edit", "later clean-tree work")
      const stale = yield* call(chat.id, assistant.id, recorded)
      expect(Exit.isSuccess(stale)).toBe(true)
      if (!Exit.isSuccess(stale)) return
      expect(stale.value.output).toContain("UNREVIEWED")
      expect(stale.value.metadata.review).toMatchObject({
        effort: "thorough",
        termination: "unreviewed",
        disposition: "reviewed",
        openFindings: 0,
        blockingFindings: 0,
        workSinceReview: true,
        stale: true,
      })
    }),
  )
})
