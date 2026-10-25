import { SessionProjector } from "@opencode-ai/core/session/projector"
import { afterEach, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { Question } from "@/question"
import { route, clarify } from "@/session/work-flow"
import { MessageID, PartID } from "@/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, Question.node])))
afterEach(async () => {
  await disposeAllInstances()
})

it.instance("only a user answer binds uncertain admission and a new root request invalidates it", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const questions = yield* Question.Service
    const root = yield* sessions.create({ title: "scope" })
    const add = Effect.fnUntraced(function* (text: string) {
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: root.id,
        role: "user",
        agent: "work",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({ id: PartID.ascending(), sessionID: root.id, messageID: user.id, type: "text", text })
      return user.id
    })
    const requestID = yield* add("Fix this")
    expect((yield* route(root.id)).kind).toBe("uncertain")
    const fiber = yield* clarify(root.id).pipe(Effect.forkChild)
    let pending = yield* questions.list()
    while (!pending.length) {
      yield* Effect.sleep("5 millis")
      pending = yield* questions.list()
    }
    expect(pending[0].questions[0].options.map((item) => item.label)).toEqual(["Programming", "Non-programming"])
    yield* questions.reply({ requestID: pending[0].id, answers: [["Programming"]] })
    const decision = yield* Fiber.join(fiber)
    expect(decision.kind).toBe("programming")
    expect(decision.requestID).toBe(requestID)
    expect((yield* route(root.id)).kind).toBe("programming")
    yield* add("Research hotels")
    expect((yield* route(root.id)).kind).toBe("nonprogramming")
  }),
)

it.instance("an answer to a stale clarification cannot overwrite a newer root request", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const questions = yield* Question.Service
    const root = yield* sessions.create({ title: "race" })
    const add = Effect.fnUntraced(function* (text: string) {
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: root.id,
        role: "user",
        agent: "work",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({ id: PartID.ascending(), sessionID: root.id, messageID: user.id, type: "text", text })
    })
    yield* add("Fix this")
    const fiber = yield* clarify(root.id).pipe(Effect.forkChild)
    let pending = yield* questions.list()
    while (!pending.length) {
      yield* Effect.sleep("5 millis")
      pending = yield* questions.list()
    }
    yield* add("Implement API endpoint")
    yield* questions.reply({ requestID: pending[0].id, answers: [["Non-programming"]] })
    expect((yield* Fiber.join(fiber)).kind).toBe("programming")
    expect((yield* route(root.id)).kind).toBe("programming")
  }),
)
