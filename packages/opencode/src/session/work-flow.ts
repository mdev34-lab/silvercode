import { Effect, Option } from "effect"
import { NotFoundError } from "@/storage/storage"
import { WorkFlow } from "@opencode-ai/core/work-flow"
import { Session } from "./session"
import { Question } from "@/question"
import type { SessionID } from "./schema"

/**
 * The root session that owns the workflow. A missing ancestor row means the
 * true root is unknown: resolve to none (callers fail closed) instead of
 * dying, which would turn a storage gap into a ToolRegistry.tools defect.
 * A parent cycle is still a defect.
 */
export const ancestry = Effect.fn("WorkFlow.ancestry")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const load = (id: SessionID) =>
    sessions.get(id).pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
  let owner = yield* load(sessionID)
  let depth = 0
  const seen = new Set<string>()
  while (owner?.parentID) {
    if (seen.has(owner.id)) return yield* Effect.die(new Error("Cyclic workflow ancestry"))
    seen.add(owner.id)
    depth++
    owner = yield* load(owner.parentID)
  }
  return owner ? Option.some({ owner, depth }) : Option.none()
})

/**
 * Depth of the reachable part of a session chain. A missing ancestor ends the walk, so
 * the result is a lower bound; the depth limit still applies to it.
 */
export const knownDepth = Effect.fn("WorkFlow.knownDepth")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const load = (id: SessionID) =>
    sessions.get(id).pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
  let owner = yield* load(sessionID)
  let depth = 0
  const seen = new Set<string>()
  while (owner?.parentID) {
    if (seen.has(owner.id)) return yield* Effect.die(new Error("Cyclic workflow ancestry"))
    seen.add(owner.id)
    depth++
    owner = yield* load(owner.parentID)
  }
  return depth
})

export const ownerOrNone = Effect.fn("WorkFlow.ownerOrNone")(function* (sessionID: SessionID) {
  return Option.map(yield* ancestry(sessionID), (found) => found.owner)
})

/** Runtime-owned admission cache. Child arguments and model text never set it. */
export const route = Effect.fn("WorkFlow.route")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const found = yield* ownerOrNone(sessionID)
  // Unknown root: stay uncertain (restricted, inspection only) and persist nothing.
  if (Option.isNone(found)) return { kind: "uncertain" as const, requestID: undefined }
  const owner = found.value
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
  // Nothing can bind an answer when the root session is unknown: do not ask.
  if (Option.isNone(yield* ownerOrNone(sessionID))) return current
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
  const found = yield* ownerOrNone(sessionID)
  if (Option.isNone(found)) return current
  const owner = found.value
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
