import { Effect } from "effect"
import { WorkFlow } from "@opencode-ai/core/work-flow"
import { Session } from "./session"
import { Question } from "@/question"
import type { SessionID } from "./schema"

export const ownerOf = Effect.fn("WorkFlow.ownerOf")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  let owner = yield* sessions.get(sessionID)
  const seen = new Set<string>()
  while (owner.parentID) {
    if (seen.has(owner.id)) return yield* Effect.die(new Error("Cyclic workflow ancestry"))
    seen.add(owner.id)
    owner = yield* sessions.get(owner.parentID)
  }
  return owner
})

/** Runtime-owned admission cache. Child arguments and model text never set it. */
export const route = Effect.fn("WorkFlow.route")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const owner = yield* ownerOf(sessionID)
  const messages = yield* sessions.messages({ sessionID: owner.id })
  const decision = WorkFlow.admission(messages)
  if (!decision) return { kind: "uncertain" as const, requestID: undefined }
  const previous = owner.metadata?.workFlowRoute as WorkFlow.Route | undefined
  if (previous?.requestID === decision.requestID) return previous
  yield* sessions.setMetadata({ sessionID: owner.id, metadata: { ...owner.metadata, workFlowRoute: decision } })
  return decision
})

/** The options and their meaning are runtime-owned, never supplied by Work. */
export const clarify = Effect.fn("WorkFlow.clarify")(function* (sessionID: SessionID) {
  const current = yield* route(sessionID)
  if (current.kind !== "uncertain") return current
  const question = yield* Question.Service
  const answers = yield* question.ask({
    sessionID,
    questions: [
      {
        header: "Task scope",
        question: "Does this request change or debug software, or produce non-programming work?",
        custom: false,
        options: [
          { label: "Programming", description: "Require Think planning, Code implementation and clean Review" },
          { label: "Non-programming", description: "Work or General may execute; do not use Code" },
        ],
      },
    ],
  })
  const choice = answers[0]?.[0]
  if (choice !== "Programming" && choice !== "Non-programming") return current
  const sessions = yield* Session.Service
  const owner = yield* ownerOf(sessionID)
  const fresh = yield* route(sessionID)
  if (fresh.requestID !== current.requestID) return fresh
  const decision = {
    ...fresh,
    kind: choice === "Programming" ? ("programming" as const) : ("nonprogramming" as const),
    source: "user-answer",
    reason: "user clarified the runtime-owned task-scope question",
  }
  yield* sessions.setMetadata({ sessionID: owner.id, metadata: { ...owner.metadata, workFlowRoute: decision } })
  return decision
})
