import { SessionProjector } from "@opencode-ai/core/session/projector"
import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Session } from "@/session/session"
import { Question } from "@/question"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { MessageID } from "@/session/schema"
import { PlanExitTool } from "@/tool/plan"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionProjector.node, Question.node, Provider.node, EventV2Bridge.node, Truncate.node, Agent.node]),
  ),
)
const ctxFor = (sessionID: Session.Info["id"]) => ({
  sessionID,
  messageID: MessageID.make("msg_plan_exit"),
  agent: "think",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})
const seedUser = Effect.fnUntraced(function* (id: Session.Info["id"]) {
  const sessions = yield* Session.Service
  yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: id,
    role: "user",
    agent: "think",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    time: { created: Date.now() },
  })
})

describe("tool.plan_exit", () => {
  it.instance("a delegated child is refused: no question and no switch message on any session (#637)", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const question = yield* Question.Service
      const root = yield* sessions.create({ title: "root" })
      const child = yield* sessions.create({ parentID: root.id })
      yield* seedUser(root.id)
      yield* seedUser(child.id)
      const rootBefore = (yield* sessions.messages({ sessionID: root.id })).length
      const childBefore = (yield* sessions.messages({ sessionID: child.id })).length
      const tool = yield* (yield* PlanExitTool).init()
      const exit = yield* tool.execute({}, ctxFor(child.id)).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String((exit as Exit.Failure<unknown, unknown>).cause)).toContain("owns the plan")
      expect(yield* question.list()).toEqual([])
      expect((yield* sessions.messages({ sessionID: root.id })).length).toBe(rootBefore)
      expect((yield* sessions.messages({ sessionID: child.id })).length).toBe(childBefore)
    }),
  )

  it.instance("the root session still asks and switches itself to Work", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const question = yield* Question.Service
      const root = yield* sessions.create({ title: "root" })
      yield* seedUser(root.id)
      const tool = yield* (yield* PlanExitTool).init()
      const fiber = yield* tool.execute({}, ctxFor(root.id)).pipe(Effect.forkChild)
      let pending = yield* question.list()
      while (!pending.length) {
        yield* Effect.sleep("5 millis")
        pending = yield* question.list()
      }
      expect(pending[0].sessionID).toBe(root.id)
      yield* question.reply({ requestID: pending[0].id, answers: [["Yes"]] })
      yield* Fiber.join(fiber)
      const last = (yield* sessions.messages({ sessionID: root.id })).at(-1)
      expect(last?.info.role === "user" && last.info.agent).toBe("work")
    }),
  )
})
