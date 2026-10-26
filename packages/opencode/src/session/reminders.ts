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
import { WorkFlow } from "@opencode-ai/core/work-flow"

const scratchpad = (plan: string) =>
  `A plan file exists at ${plan}. Execute on the plan defined within it, and keep the file current as the run's scratchpad: a step is checked off when its verification passes, not in a batch later, and remaining steps are revised when reality diverges from the plan. If you hold a file-editing tool (edit, write or apply_patch), do that yourself. If you do not (programming sessions, where the Code step makes the edits), have each Code step tick its own steps and record discoveries there, and read the file before the next step to check progress.`

const planHandoff = (plan: string) =>
  `The session plan file belongs at ${plan} and does not exist yet. Create it from the planner's checklist (one verifiable \`- [ ]\` step per line): yourself if you hold a file-editing tool (edit, write or apply_patch), otherwise (programming sessions) have the first Code step create it. Then keep it current as described: the step that edits ticks its own steps and records discoveries, and you read the file before the next step.`

// A delegated Think runs as a child session, so the planner's reply is a task
// tool result in this session rather than an assistant message from think.
// Only a runtime-stamped successful foreground Think delivered in this real
// request counts: a failed, cancelled, background or earlier-request Think
// does not mean a plan exists.
const delegatedThink = (messages: SessionV1.WithParts[], sessionID: string) =>
  WorkFlow.state(messages, sessionID).planned

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
  const seen = new Set<string>([session.id])
  while (root.parentID) {
    // A corrupt parent cycle has no true root: resolve to none instead of looping.
    if (seen.has(root.parentID)) return Option.none<Session.Info>()
    seen.add(root.parentID)
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

// A primary Think->Work switch: Think may hold no write tool, so a missing
// plan file is handed to Work to create rather than assumed to exist.
const switchText = (plan: Option.Option<string>, exists: boolean) =>
  Option.isNone(plan)
    ? WORK_SWITCH
    : `${WORK_SWITCH}\n\n${exists ? scratchpad(plan.value) : planHandoff(plan.value)}`

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
          text: `Write your plan at ${plan.value} with your file-writing tool (write or apply_patch) if you have one - create it if it does not exist, extend it if it does. If you have no file-writing tool, put the full plan in your reply instead and the implementer saves it to that path. Either way, structure it as a checklist of one verifiable step per line (markdown \`- [ ]\` items) so the executor can check steps off as it works, and end your reply with that exact path.`,
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
          text: switchText(plan, exists),
          synthetic: true,
        })
      } else if (!exists && Option.isSome(plan) && delegatedThink(input.messages, input.session.id)) {
        userMessage.parts.push({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: planHandoff(plan.value),
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
      text: switchText(plan, exists),
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  // Delegation flow in experimental plan mode (after the primary switch check,
  // so a later primary Think->Work switch is never shadowed by an earlier
  // delegation): a delegated Think ran as a child session, so the last
  // assistant message here is not Think's. Work still gets
  // the living-plan guidance, same as outside experimental plan mode.
  if (input.agent.name === "work") {
    const plan = yield* rootPlan(input.session)
    if (Option.isSome(plan)) {
      // An existing plan file is the run's scratchpad whoever wrote it, so its
      // guidance does not depend on this request's planning proof; only the
      // handoff (a plan that should exist) needs a stamped successful Think.
      const exists = yield* fsys.existsSafe(plan.value)
      const text = exists
        ? scratchpad(plan.value)
        : delegatedThink(input.messages, input.session.id)
          ? planHandoff(plan.value)
          : undefined
      if (text !== undefined) {
        userMessage.parts.push({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text,
          synthetic: true,
        })
        return input.messages
      }
    }
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
          ? `A plan file already exists at ${plan.value}. If you hold a file-editing tool (edit or apply_patch), read it and make incremental edits; otherwise put the updated plan in your reply.`
          : `No plan file exists yet. If you hold a file-writing tool (write or apply_patch), create your plan at ${plan.value}; otherwise put the full plan in your reply and the implementer saves it there.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export * as SessionReminders from "./reminders"
