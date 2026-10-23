import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Option } from "effect"
import { Agent } from "@/agent/agent"
import { Agent as AgentSchema } from "@opencode-ai/schema/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import WORK_SWITCH from "./prompt/work-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"
import { NotFoundError } from "@/storage/storage"

const scratchpad = (plan: string) =>
  `A plan file exists at ${plan}. Execute on the plan defined within it, and keep the file current as your scratchpad: check off steps as you finish them and revise the remaining steps when reality diverges from the plan.`

// Plan files belong to the root session: a Think running as a delegated
// subagent writes the same plan file its caller's session later reads.
// A missing ancestor row means the true root is unknown: resolve to none
// rather than inventing the deepest resolved session as the root, which
// would name the wrong plan file.
// Pure form for callers that already hold the service (tool execute contexts
// cannot require the Session tag).
export const walkToRoot = Effect.fn("SessionReminders.walkToRoot")(function* (
  sessions: Session.Interface,
  session: Session.Info,
) {
  let root = session
  while (root.parentID) {
    const parent = yield* sessions
      .get(root.parentID)
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
    if (!parent) return Option.none<Session.Info>()
    root = parent
  }
  return Option.some(root)
})

export const rootSession = Effect.fn("SessionReminders.rootSession")(function* (session: Session.Info) {
  const sessions = yield* Session.Service
  return yield* walkToRoot(sessions, session)
})

const rootPlan = Effect.fn("SessionReminders.rootPlan")(function* (session: Session.Info) {
  const ctx = yield* InstanceState.context
  const root = yield* rootSession(session)
  return Option.map(root, (root) => Session.plan(root, ctx))
})

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  if (!flags.experimentalPlanMode) {
    if (input.agent.name === "think") {
      const plan = yield* rootPlan(input.session)
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: PROMPT_PLAN,
        synthetic: true,
      })
      if (Option.isSome(plan))
        userMessage.parts.push({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: `Write your plan at ${plan.value} with the write tool - create it if it does not exist, extend it if it does. End your reply with that exact path so the executor can find the file.`,
          synthetic: true,
        })
    }
    if (input.agent.name === "work") {
      const plan = yield* rootPlan(input.session)
      const exists = Option.isSome(plan) && (yield* fsys.existsSafe(plan.value))
      const wasPlan = input.messages.some(
        (msg) => msg.info.role === "assistant" && AgentSchema.canonicalID(msg.info.agent ?? "") === "think",
      )
      if (wasPlan) {
        userMessage.parts.push({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: exists && Option.isSome(plan) ? `${WORK_SWITCH}\n\n${scratchpad(plan.value)}` : WORK_SWITCH,
          synthetic: true,
        })
      } else if (exists && Option.isSome(plan)) {
        // Delegation flow: no plan->work switch happened in this session, but a
        // planner (usually a delegated Think) already wrote the plan file.
        userMessage.parts.push({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: scratchpad(plan.value),
          synthetic: true,
        })
      }
    }
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "think" && AgentSchema.canonicalID(assistantMessage?.info.agent ?? "") === "think") {
    const plan = yield* rootPlan(input.session)
    const exists = Option.isSome(plan) && (yield* fsys.existsSafe(plan.value))
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists && Option.isSome(plan) ? `${WORK_SWITCH}\n\n${scratchpad(plan.value)}` : WORK_SWITCH,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (input.agent.name !== "think" || AgentSchema.canonicalID(assistantMessage?.info.agent ?? "") === "think") return input.messages

  const plan = yield* rootPlan(input.session)
  const exists = Option.isSome(plan) && (yield* fsys.existsSafe(plan.value))
  if (Option.isSome(plan) && !exists)
    yield* fsys.ensureDir(path.dirname(plan.value)).pipe(Effect.catch(Effect.die))
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: PLAN_MODE.replace("${planInfo}", () =>
      Option.isNone(plan)
        ? "A plan file path could not be resolved because an ancestor session is missing from storage. Do not create or edit any plan file."
        : exists
          ? `A plan file already exists at ${plan.value}. You can read it and make incremental edits using the edit tool.`
          : `No plan file exists yet. You should create your plan at ${plan.value} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export * as SessionReminders from "./reminders"
