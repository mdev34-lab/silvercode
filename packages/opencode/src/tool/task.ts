import { ownerOf as workflowOwner, route as workRoute } from "@/session/work-flow"
import { WorkFlow } from "@opencode-ai/core/work-flow"
import { sessionAgent } from "../session/session-agent"
import * as Tool from "./tool"
import { resultChunks, textResult, renderTextResult } from "@/session/subagent-result"
import { FinishTool, deliveredReason, readTermination, type Reason, type TerminationReason } from "@/tool/finish"
import DESCRIPTION from "./task.txt"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ReviewReport } from "@opencode-ai/core/review-report"
import { declaresFileWrites, hasFileWrites, REVIEW_LOOP_METADATA } from "@opencode-ai/core/review-loop"
import { EventV2Bridge } from "@/event-v2-bridge"
import { BackgroundJob } from "@/background/job"
import { Session, readAgentEffort, withAgentEffort } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { isReviewAgent, LEGACY_REVIEW_AGENTS, resolveReviewer } from "../agent/review-agents"
import { deriveSubagentSessionPermission, deriveSubagentToolDenies } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Cause, Effect, Exit, Option, Ref, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Database } from "@opencode-ai/core/database/database"
import { AgentEffort } from "@opencode-ai/schema/agent-effort"
import { NotFoundError } from "@/storage/storage"
import { Permission } from "@/permission"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

// Delivery receipts share the lifetime of the process-local job registry. A
// notifier that handed its report to a park must remain alive until that owner
// settles, then deliver itself if the park never consumed it (e.g. success).
// Weak keys isolate registries/instances and do not keep disposed ones alive.
const receipts = new WeakMap<BackgroundJob.Interface, Set<string>>()

// A resumed subagent (task_id) reuses its session ID, so receipts are keyed per
// run: the ID plus the job's start time. A stale notifier of an earlier run must
// not claim or consume the receipt of a later run on the same session.
const runKey = (job: { id: string; started_at: number }) => `${job.id}@${job.started_at}`

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Subagents run asynchronously by default: the tool launches the subagent and returns immediately.",
  "You will be notified automatically when it finishes; do not sleep, poll, or ask it for status.",
  "Set background=false when you need the result before continuing; the tool then waits only for subagents whose agent sets background=false in opencode.json, and launches a background task for every other agent.",
].join(" ")
// The yield instruction is scoped to a parent that has not finished: delivering
// a completed result while a task keeps running is still the normal ending, and
// this task's notification wakes the session when its run ends. It is also
// limited to the main session, because the wait is refused for a session that is
// itself a subagent: a child's run ends at its yield, so a yield from a child
// would deliver a provisional result and nothing else.
const BACKGROUND_STARTED = [
  "The task is running in the background. You will be notified automatically when its run ends.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  'Work on non-overlapping tasks. If your own task is complete, call finish with reason "success" as usual: a task still running in the background does not hold your result back.',
  'If it is not finished and you have no independent work left, the main session can call finish with reason "waiting_for_subagent" to yield — this task\'s notification wakes it. A subagent may yield the same way only for background subagents it launched itself: its job stays running until they report. With nothing of its own in flight it must deliver with "success" or "failure" instead.',
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when its run ends.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  'Work on non-overlapping tasks. If your own task is complete, call finish with reason "success" as usual: a task still running in the background does not hold your result back.',
  'If it is not finished and you have no independent work left, the main session can call finish with reason "waiting_for_subagent" to yield — this task\'s notification wakes it. A subagent may yield the same way only for background subagents it launched itself: its job stays running until they report. With nothing of its own in flight it must deliver with "success" or "failure" instead.',
].join("\n")

const SUBAGENT_TYPE_FALLBACK = "The type of specialized agent to use for this task"

/**
 * The single source for who a caller may delegate to: non-primary, non-hidden
 * agents the caller's (merged) ruleset does not deny the task tool for. Both
 * the tool description prose and the `subagent_type` parameter description
 * render from this list, so they can never diverge.
 */
export function delegatableAgents(agents: Agent.Info[], permission: PermissionV1.Ruleset): Agent.Info[] {
  return agents
    .filter(
      (item) =>
        item.mode !== "primary" &&
        item.hidden !== true &&
        Permission.evaluate("task", item.name, permission).action !== "deny",
    )
    .toSorted((a, b) => a.name.localeCompare(b.name, "en"))
}

/** The tool-description prose listing the delegatable agents. */
export function describeAgents(agents: Agent.Info[]): string {
  const description = agents
    .map((item) => `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`)
    .join("\n")
  return ["Available agent types and the tools they have access to:", description].join("\n")
}

/**
 * Render the delegation-eligible agents into the `subagent_type` parameter
 * description, so specialists are visible at the point the model picks a value
 * instead of only in the tool description prose. A nudge, not a restriction -
 * any resolvable name stays valid.
 */
export function subagentTypeDescription(agents: Agent.Info[]): string {
  const available = agents.map((agent) => (agent.description ? `${agent.name} - ${agent.description}` : agent.name))
  return available.length ? `${SUBAGENT_TYPE_FALLBACK}. Available: ${available.join("; ")}` : SUBAGENT_TYPE_FALLBACK
}

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: SUBAGENT_TYPE_FALLBACK }),
  task_id: Schema.optional(Schema.String).annotate({
    description: "Resume a previous subagent session by its task_id",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "Triggering command" }),
}

// Memoized: tools() runs per request and schema identity feeds downstream
// caches, so the same enumeration must return the same Schema instance.
const parametersCache = new Map<string, ReturnType<typeof makeParametersUncached>>()

const makeParametersUncached = (subagentType: string) =>
  Schema.Struct({
    ...BaseParameterFields,
    subagent_type: Schema.String.annotate({ description: subagentType }),
    effort: Schema.optional(AgentEffort.Level).annotate({
      description: "Override the child's effort policy; omit to inherit.",
    }),
    background: Schema.optional(Schema.Boolean).annotate({
      description:
        "Run asynchronously and get notified on completion (default). Agents configured with `background: false` in opencode.json run in the foreground and wait for the result; true forces a background launch; false on any other agent still launches it in the background.",
    }),
  })

export const makeParameters = (subagentType: string) => {
  const cached = parametersCache.get(subagentType)
  if (cached) return cached
  const parameters = makeParametersUncached(subagentType)
  parametersCache.set(subagentType, parameters)
  return parameters
}

// Module-scope fallback so imports that cannot run the tool's Effect init (the
// JSON-Schema snapshot test) still see a stable wire shape; the constructed
// tool replaces this with the enumerated description.
export const Parameters = makeParameters(SUBAGENT_TYPE_FALLBACK)

/**
 * Wording for the termination element the parent reads out of the envelope.
 *
 * A subagent that ends on `subagent_wait` is parked on a dependency, not slow
 * and not in flight. Say so in the parent envelope so the parent never reads a
 * waiting run as a fire-and-forget task it should wait on. `success` carries no
 * note: the reason is the signal, and the result text already says the work is
 * done.
 *
 * `TERMINATION_NOTE` is keyed by the delivered reasons, and a declared
 * `waiting_for_subagent` is not one of them: it is dropped by
 * {@link deliveredReason} before it reaches an envelope. A nested yield keeps
 * this dispatch's job alive until the child terminates (#222), so there is no
 * provisional delivery to describe: when the wait has nothing behind it, the
 * child's last result is delivered as its last word, with no termination.
 */
const TERMINATION_NOTE: Record<TerminationReason, string> = {
  success: "",
  subagent_wait: "Subagent stopped on a dependency and is not in flight; it will not report back on its own.",
  failure: "Subagent stopped because the task could not be completed.",
  cancelled: "Subagent was cancelled before completion; its result was not delivered.",
}

/**
 * Stand-in result for a cancelled run. A cancelled child never reaches a finish
 * call, so there is usually no output at all; the envelope must still say what
 * became of the task instead of delivering an empty result.
 */
const CANCELLED_TEXT = "The subagent was cancelled before it delivered a result."

/**
 * Renders the parent-facing `<task>` envelope. The termination reason is part of
 * the envelope, not of the injected text, so a background notification and a
 * foreground tool result carry byte-identical termination for the same run.
 */
function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error" | "cancelled"
  summary?: string
  text: string
  termination?: TerminationReason
  // The run key (sessionID@started_at) of the job this envelope reports, so a
  // resumed session's deliveries settle their own run and no other (#400).
  run?: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}"${input.run ? ` run="${input.run}"` : ""} state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    ...(input.termination
      ? [`<termination reason="${input.termination}">${TERMINATION_NOTE[input.termination]}</termination>`]
      : []),
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const receipted = receipts.get(background) ?? new Set<string>()
    receipts.set(background, receipted)
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const database = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const status = yield* SessionStatus.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()

      // The finish tool waives its review requirement only when this tool would
      // refuse a `review` dispatch: the depth limit here, an unresolvable
      // reviewer, or a permission deny below. Keep `reviewUnavailable` in
      // finish.ts in step with these refusals.
      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      // The agent that owns this session, read from the session itself.
      //
      // A session row's `agent` is null for the default session, so the newest
      // user message is the fallback that actually names the running agent.
      // `MessageV2.page` returns messages oldest-first, hence `findLast`: the
      // agent currently driving the session is the last one to name itself, and
      // `find` would return a session's first-ever user message instead - which
      // inverts the routing in exactly the mid-session agent switch it exists to
      // handle. `ctx.agent` is deliberately not a tier here: on the subtask path
      // it is the CHILD's agent, so it would select a reviewer by the child's
      // identity. Hydration is deferred into the fallback so a pinned session
      // never pays for it.
      //
      // A parent that cannot be read fails the dispatch instead of resolving to
      // nothing. Swallowing the read made an unreadable parent degrade to the
      // generic reviewer, which then ran the wrong prompt under the wrong
      // permissions with nothing to indicate the routing had never happened -
      // and `ctx.agent` is no fallback, because it names the child. Only
      // `NotFound` is narrowed here; any other cause stays a defect rather than
      // being reinterpreted as "no parent agent", which is the only reading
      // this function can act on.

      // One resolution, two consumers: routing the review request, and
      // addressing the background notification back to the parent. Resolving
      // twice could disagree - the pinned row and the newest user message are
      // read at two different moments, and a parent that switched agent
      // mid-thread is exactly the case this routing exists to handle - and a
      // notification delivered under an agent other than the one that
      // Cached
      // rather than hoisted so a task that never delivers a background result
      // still never pays for the message read.
      // `Effect.cached` yields the memoized effect rather than its value, so nothing runs here.
      // Only the background delivery below yields it.
      const parentAgentOf = yield* Effect.cached(sessionAgent(sessions, parent))

      // A retired specialist reviewer (`work-review`, `code-review`) is an
      // alias for the single `review` agent: the rewrite keeps the report
      // gate, the permission prompt and the delivered envelope agreed on one
      // resolved name. The requested name still keys the permission prompt
      // below, so rules and grants written against a specialist keep applying.
      const subagentType = resolveReviewer(params.subagent_type)

      const next = yield* agent.get(subagentType)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${subagentType} is not a valid agent type`))
      }
      // Primary agents are session entry points, never delegation targets.
      // Reject them before permission prompts so an impossible delegation
      // cannot block on user interaction.
      if (next.mode === "primary") {
        return yield* Effect.fail(new Error(`Agent type ${subagentType} is a primary agent and cannot be delegated to`))
      }

      // Background execution is the default and waiting for a subagent's result
      // is opt-in per agent, not per call: only an agent configured with
      // `background: false` may run in its parent's foreground. Honoring a bare
      // `background: false` request would hand the parent's execution path to a
      // child that never finishes, which is the coupling the background path and
      // this configuration exist to make explicit.
      //
      // A retired specialist reviewer request is rewritten to the single
      // reviewer, and config - like the permission rules keyed on both names
      // below - is usually written against the name that was asked for, so the
      // requested name counts as a fallback. Precedence: the agent that
      // actually runs decides, the requested name decides only when the runner
      // says nothing, and background decides when neither does. Both names are
      // read through `Agent.get` rather than off the raw config so a name
      // resolves exactly the way the delegation itself resolves it, legacy
      // aliases included; the fallback is skipped entirely when resolution
      // left the name alone, which is every other dispatch.
      const requested = subagentType === params.subagent_type ? undefined : yield* agent.get(params.subagent_type)
      const callerName = yield* parentAgentOf
      const workIdentity = yield* agent.get("work")
      const thinkIdentity = yield* agent.get("think")
      const codeIdentity = yield* agent.get("code")
      const allRoles = yield* agent.list()
      const coordinator = WorkFlow.ownsRole(allRoles, workIdentity, callerName)
      const session = params.task_id
        ? yield* sessions
            .get(SessionID.make(params.task_id))
            .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
        : undefined
      const admission = yield* workRoute(ctx.sessionID).pipe(Effect.provideService(Session.Service, sessions))
      const rootOwner = yield* workflowOwner(ctx.sessionID).pipe(Effect.provideService(Session.Service, sessions))
      const rootRole = yield* sessionAgent(sessions, rootOwner)
      const inheritedWorkflow = WorkFlow.ownsRole(allRoles, workIdentity, rootRole)
      const programming = coordinator && admission.kind === "programming"
      if (inheritedWorkflow && admission.kind === "programming" && !coordinator)
        return yield* Effect.fail(
          new Error(
            "Programming stage children cannot delegate implementation or substitute workflow stages. Return the result to Work.",
          ),
        )
      if (inheritedWorkflow && admission.kind === "uncertain")
        return yield* Effect.fail(
          new Error(
            "Clarify programming or non-programming intent with the user before dispatching any child. Inspection may use the native read-only tools.",
          ),
        )
      const planner = WorkFlow.ownsRole(allRoles, thinkIdentity, callerName) && admission.kind === "programming"
      if (planner)
        return yield* Effect.fail(
          new Error("Programming Think must return a read-only plan, not delegate implementation."),
        )
      if (
        coordinator &&
        admission.kind !== "nonprogramming" &&
        ![thinkIdentity, codeIdentity, yield* agent.get("review")].some(
          (item) => item?.native === true && item === next,
        )
      )
        return yield* Effect.fail(
          new Error(
            "Programming or uncertain Work cannot bypass routing through an alternate child. Use Think/Code for programming or ask the user to clarify non-programming intent.",
          ),
        )
      if (admission.kind !== "programming" && next === codeIdentity)
        return yield* Effect.fail(
          new Error(
            "Code is only for a programming request. Non-programming work stays manual or with General; clarify uncertain intent first.",
          ),
        )
      const workflow = coordinator
        ? WorkFlow.state(yield* sessions.messages({ sessionID: ctx.sessionID }), ctx.sessionID)
        : undefined
      const reviewIdentity = yield* agent.get("review")
      if (programming && next === reviewIdentity && !workflow?.implemented)
        return yield* Effect.fail(
          new Error("Programming Review follows successful Code implementation; it cannot replace Think or Code."),
        )
      if (programming && codeIdentity?.native === true && next === codeIdentity && !workflow?.planned)
        return yield* Effect.fail(
          new Error(
            "Work must complete a successful Think planning task in this request before dispatching Code. Delegate Think first; a pending, cancelled or failed plan is not sufficient.",
          ),
        )
      const generalIdentity = yield* agent.get("general")
      const requiredGeneral =
        admission.kind === "nonprogramming" &&
        (AgentEffort.resolve(
          readAgentEffort(parent.metadata),
          AgentEffort.resolve(typeof cfg.agent?.effort === "string" ? cfg.agent.effort : undefined),
        ) === "thorough" ||
          WorkFlow.complex(
            WorkFlow.request(yield* sessions.messages({ sessionID: ctx.sessionID }))
              ?.parts.flatMap((part) => (part.type === "text" ? [(part as { text: string }).text] : []))
              .join("\n") ?? "",
          ))
      const noncodingGeneral =
        coordinator && admission.kind === "nonprogramming" && next.native === true && next === generalIdentity
      const requiredStage = programming && next.native === true && (next === thinkIdentity || next === codeIdentity)
      const runInBackground =
        requiredStage || (noncodingGeneral && requiredGeneral)
          ? false
          : (next.background ?? requested?.background ?? true) || params.background === true

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          // Keyed on both names when routing rewrote the request. The requested
          // name is the user-facing contract - stored always-allow grants and
          // user config rules (`permission.task.review`) are written against it,
          // so re-keying on the routing decision alone would silently re-prompt
          // returning users and silently drop their `deny` rule. The resolved
          // name is added because a rule written against `work-review` or
          // `code-review` is just as legitimate, and because the metadata below
          // records the resolved name: a prompt gated on one name while its
          // stored input and every audit log report the other is a rule that
          // cannot be seen to have applied. Asking under both names is the
          // union, so no rule that could reasonably have gated this call is
          // skipped, and the common case - a request routing did not rewrite -
          // still prompts under exactly one name.
          patterns: [
            ...(subagentType === params.subagent_type ? [params.subagent_type] : [params.subagent_type, subagentType]),
            // The retired specialist names stay valid rule targets: a deny or
            // grant written against `work-review`/`code-review` gated the
            // reviewer before the consolidation, and there is exactly one
            // reviewer to gate now, so it must keep matching.
            ...(subagentType === "review"
              ? [...LEGACY_REVIEW_AGENTS].filter((name) => name !== params.subagent_type)
              : []),
          ],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: subagentType,
          },
        })
      }

      if (
        (requiredStage || (noncodingGeneral && requiredGeneral)) &&
        session &&
        (session.parentID !== ctx.sessionID || session.agent !== next.name)
      )
        return yield* Effect.fail(new Error("Workflow stages cannot reuse a child owned by another session."))
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = deriveSubagentToolDenies({
        subagent: next,
        primaryTools: cfg.experimental?.primary_tools,
      })
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        }))

      // Effective effort for the child: explicit override, then this child's
      // persisted selection (resume of an owned child only), then the parent's
      // persisted level, then the root's, then configuration, then medium. A
      // child owned by another parent is neither read nor written here — its
      // selection belongs to the parent that created it.
      const owned = session === undefined || session.parentID === ctx.sessionID
      const persisted = owned ? readAgentEffort(nextSession.metadata) : undefined
      const configEffort = typeof cfg.agent?.effort === "string" ? cfg.agent.effort : undefined
      const effort = AgentEffort.resolve(
        params.effort ?? persisted ?? readAgentEffort(parent.metadata) ?? readAgentEffort(current.metadata),
        AgentEffort.resolve(configEffort),
      )
      // Persist the resolved level before execution so both foreground and
      // background runs (and every resume) observe the same selection.
      if (owned && persisted !== effort) {
        yield* sessions.setMetadata({
          sessionID: nextSession.id,
          metadata: withAgentEffort(nextSession.metadata ?? {}, effort),
        })
      }

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata: Record<string, any> = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        // A foreign child's selection belongs to the parent that created it:
        // it is neither read nor written here, so publishing a level would
        // claim a governance this dispatch does not have. Owned children
        // persisted the level above, so theirs is honest to record.
        ...(owned ? { effort } : {}),
        // The mode this call actually ran in, recorded on every outcome rather
        // than only the background ones. `params.background` is the request, and
        // since the per-agent opt-in a request no longer predicts the outcome in
        // either direction; anything downstream that needs to know whether a result
        // landed here - the review loop's finish gate, the run CLI's pending-task
        // bookkeeping - reads this field instead of re-deriving the rule. The
        // launch and promotion paths below overwrite it, because those change the
        // answer after this point.
        background: runInBackground,
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      // The child declares why it stopped on the finish tool input. Capture it
      // once, where the reply is already in hand, so the background and the
      // foreground delivery paths below report the same value without either
      // one re-reading the child transcript. The declared reason is mapped to
      // the delivered one here, in one place, so a declared yield can never
      // reach an envelope. A cancelled run never made a finish call; that path
      // records `cancelled` itself, so this ref holds the whole delivered
      // contract rather than the declared subset.
      const termination = yield* Ref.make<TerminationReason | undefined>(undefined)
      // The reason the child *declared*, kept apart from the delivered one: a
      // nested yield is never delivered, but it is what decides whether this
      // dispatch keeps the child's job alive and resumes it (#222).
      const declaredReason = yield* Ref.make<Reason | undefined>(undefined)
      const explicitSuccess = yield* Ref.make(false)
      const projectWrites = Effect.fn("TaskTool.projectChildWrites")(function* (parts: readonly SessionV1.Part[]) {
        if (!parts.some(hasFileWrites)) return
        const evidence = { writesFiles: true, handoff: "pending", sessionId: nextSession.id }
        metadata[REVIEW_LOOP_METADATA] = evidence
        // Snapshot this projection before yielding; the locked callback must
        // not depend on the shared delivery metadata object.
        const projected = { ...metadata, [REVIEW_LOOP_METADATA]: evidence }
        const parentMessages = yield* sessions.messages({ sessionID: ctx.sessionID })
        const taskPart = parentMessages
          .flatMap((message) => message.parts)
          .find((part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === ctx.callID)
        if (taskPart && taskPart.state.status !== "pending") {
          // The history lookup identifies the row only. Completion may land
          // after that lookup, so read the state again under the part lock.
          yield* sessions.modifyPart(
            { partID: taskPart.id, messageID: taskPart.messageID, sessionID: taskPart.sessionID },
            (current) => {
              if (current?.type !== "tool" || current.state.status === "pending") return
              return {
                ...current,
                state: {
                  ...current.state,
                  metadata: {
                    ...current.state.metadata,
                    ...projected,
                    [REVIEW_LOOP_METADATA]: {
                      ...current.state.metadata?.[REVIEW_LOOP_METADATA],
                      ...evidence,
                    },
                  },
                },
              }
            },
          )
        } else {
          yield* ctx.metadata({ title: params.description, metadata: projected })
        }
      })
      // Observe writes while the child is running, not only after successful
      // delivery. A crash or promotion must not erase its parent's evidence.
      //
      // A subscriber is infallible by contract (`Subscriber` returns
      // `Effect<void>`), and this one projects through `sessions.messages`,
      // which can report the parent session as gone. Dropping the error channel
      // is safe: the live projection is an optimization over the transcript
      // projection `runWithEvidence` performs when the child ends, so a failure
      // here costs nothing that the run's end does not recover. It is logged
      // because a parent that cannot be read mid-run is worth knowing about.
      //
      // The projection has to stay awaited by the publish that triggered it, or
      // the parent's task part is not carrying the child's evidence by the time
      // the child's own run reads it back. It is awaited because `EventV2` runs
      // listeners inline, inside `publish`, with `Effect.forEach` (sequential by
      // default): the publisher waits for whatever a listener returns. That is
      // true of this pipe and of every other failure handler available in
      // effect@4 - `Effect.catch`, `Effect.catchIf`, `Effect.catchCause` all
      // await the effect they wrap, as does a listener that handles nothing.
      // None of them starts a fiber, so none of them can detach this body; only
      // an explicit fork does (`Effect.forkDetach`, `Effect.forkChild`), and
      // that is what would cost the ordering "projects child writes before
      // completed delivery" asserts. See the pinned ordering test at
      // `EventV2 listener awaiting` in packages/core/test/event.test.ts.
      //
      // What the combinator does decide is the failure channel, and how a
      // projection that cannot read its parent is reported. Durable events are
      // already isolated by `EventV2` - a throwing listener is logged, not
      // propagated - so this site is not protecting the publish; it is naming
      // the failure once, with the child's session, instead of letting it fall
      // through to that generic log.
      // Whether this child wrote files, from its history. Declared writes count
      // whether the child is a review run or not: #233 hands a review run's writes
      // back to the parent as unreviewed work, so they are never dropped here.
      const wroteFiles = yield* Ref.make(false)
      const unsubscribeWrites = yield* events.listen((event) => {
        if (event.type !== SessionV1.Event.PartUpdated.type) return Effect.void
        const data = event.data as { sessionID?: unknown; part?: SessionV1.Part }
        if (data.sessionID !== nextSession.id || !data.part) return Effect.void
        return projectWrites([data.part]).pipe(
          Effect.option,
          Effect.flatMap((projected) =>
            Option.isNone(projected)
              ? Effect.logError("Child write evidence live projection failed; the run's end recovers it", {
                  sessionID: nextSession.id,
                })
              : Effect.void,
          ),
        )
      })

      // One child turn, whatever prompted it: the dispatch's own prompt and a
      // resumed turn after a nested wait (#222) deliver the same contract, so
      // they read the reply with the same extraction and record the same refs.
      const promptChild = Effect.fn("TaskTool.promptChild")(function* (parts: SessionPrompt.PromptInput["parts"]) {
        const promptID = MessageID.ascending()
        const result = yield* ops.prompt({
          messageID: promptID,
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: next.model ? undefined : variant,
          agent: next.name,
          parts: [
            ...parts,
            {
              type: "text",
              text: isReviewAgent(next.name)
                ? "Deliver your final review in the required <silvercode-review> envelope before finish, in this execution."
                : "Before every finish call, deliver a non-empty <silvercode-result>final result text</silvercode-result> envelope. It may be in the same assistant turn, an earlier assistant turn of this execution, or finish.result. Do not put progress in the result envelope.",
            },
          ],
        })

        const transcript = yield* sessions.messages({ sessionID: nextSession.id })
        const chunks = resultChunks(transcript, result)
        yield* projectWrites(result.parts)
        yield* Ref.update(wroteFiles, (prev) => prev || result.parts.some((part) => declaresFileWrites(part)))
        if (result.info.role === "assistant" && result.info.error) {
          const error = result.info.error
          const message = error.data && "message" in error.data ? error.data.message : error.name
          return yield* Effect.fail(new Error(`Subagent failed: ${message}`))
        }

        const finish = result.parts.findLast(
          (item): item is SessionV1.ToolPart =>
            item.type === "tool" && item.tool === FinishTool.id && item.state.status === "completed",
        )
        yield* Ref.set(
          explicitSuccess,
          finish?.state.status === "completed" &&
            finish.state.input.reason === "success" &&
            result.info.role === "assistant" &&
            result.info.parentID === promptID &&
            result.info.agent === next.name &&
            result.info.sessionID === nextSession.id,
        )
        yield* Ref.set(declaredReason, finish ? readTermination(finish) : undefined)
        yield* Ref.set(termination, finish ? deliveredReason(readTermination(finish)) : undefined)

        // The review subagent delivers its canonical result through a tagged
        // report envelope. Extract it from the complete child output — every
        // text part plus the finish summary — because the last text part alone
        // is not a reliable delivery boundary: a trailing empty text part can
        // erase an earlier report, and a missing or malformed envelope must
        // surface as an explicit delivery failure, never as an empty result.
        if (isReviewAgent(next.name)) {
          // A review run only completes through a successful finish call: the
          // finish tool itself rejects results without a parseable report, so
          // reaching this point without a completed finish means the run
          // terminated another way and must not silently become a verdict.
          if (!finish) {
            const analysis = result.parts
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n")
              .trim()
            return yield* Effect.fail(
              new Error(
                ReviewReport.failureMessage({
                  sessionID: nextSession.id,
                  failure: { reason: "missing", message: "the review run ended without a completed finish call" },
                  analysis: analysis.length > 0 ? analysis : undefined,
                }),
              ),
            )
          }
          const summary = finish.state.input.result
          const delivery = ReviewReport.extract([...chunks, typeof summary === "string" ? summary : undefined])
          if (!delivery.ok)
            return yield* Effect.fail(
              new Error(
                ReviewReport.failureMessage({
                  sessionID: nextSession.id,
                  failure: delivery.failure,
                  analysis: delivery.analysis,
                }),
              ),
            )
          return ReviewReport.render(delivery)
        }

        const summary = finish?.state.status === "completed" ? finish.state.input.result : undefined
        const delivery = textResult([...chunks, typeof summary === "string" ? summary : undefined])
        if (!delivery.ok)
          return yield* Effect.fail(
            new Error(
              "Subagent result delivery failed: missing non-empty <silvercode-result> envelope in this execution.",
            ),
          )
        return renderTextResult(delivery.text)
      })

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        return yield* promptChild(yield* ops.resolvePromptParts(params.prompt))
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error" | "cancelled",
        text: string,
        termination: TerminationReason | undefined,
        silent = false,
        receiptKey = nextSession.id,
      ) {
        // Notifications must run in the parent session, under the parent agent -
        // the same one the routing above read, not a second opinion taken when
        // the child finishes. `ctx.agent` is not a candidate: on the subtask path
        // it is the child's agent.
        const parentAgent = yield* parentAgentOf
        // A running dispatch owns its session's continuation, but it may end
        // with success/failure instead of parking. Deferral is a handoff, never
        // a drop: keep this watcher alive and check its receipt after the owner
        // settles. The park claims the same receipt before resuming the child.
        const owner = (yield* background.list()).find(
          (job) => job.type === id && job.status === "running" && BackgroundJob.runsSession(job, ctx.sessionID),
        )
        if (owner && !silent) {
          const ended = yield* background.wait({ id: owner.id })
          // An ancestor may be stopping this recipient too. Record the terminal
          // envelope without starting a turn; its own delivery does NOT resolve
          // descendant rows in the headless tracker.
          silent = ended.info?.cancelledByTeardown === true
        }
        if (receipted.has(receiptKey)) return
        receipted.add(receiptKey)
        const wrote = yield* Ref.get(wroteFiles)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            noReply: silent,
            agent: parentAgent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  run: receiptKey,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : state === "cancelled"
                        ? `Background task cancelled: ${params.description}`
                        : `Background task failed: ${params.description}`,
                  text: metadata[REVIEW_LOOP_METADATA]
                    ? `UNREVIEWED: This child changed files. Parent must run Review before reporting success.\n${text}`
                    : text,
                  termination,
                }),
                // The notification itself carries the child's delegated writes
                // so the parent's review accounting cannot approve a tree the
                // child changed.
                ...(wrote || silent
                  ? {
                      metadata: {
                        ...(wrote ? { [REVIEW_LOOP_METADATA]: { writesFiles: true } } : {}),
                        ...(silent ? { backgroundNoReply: true } : {}),
                      },
                    }
                  : {}),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              const reason = yield* Ref.get(termination)
              if (result.info?.status === "completed")
                return yield* inject("completed", result.info.output ?? "", reason, false, runKey(result.info))
              // A subagent can declare a reason and still fail afterwards, for
              // example when review envelope extraction fails after finish. The
              // reason was captured before that failure, so deliver it rather
              // than reporting a bare <task_error> with no signal.
              if (result.info?.status === "error")
                return yield* inject("error", result.info.error ?? "", reason, false, runKey(result.info))
              // A cancelled run produced no finish call and no declared reason.
              // The job outcome is the termination: deliver it so the parent
              // resumes orchestration knowing the user stopped the child,
              // instead of never hearing about a subagent that vanished.
              //
              // A cancel that cascaded from an ancestor's teardown is the
              // exception: cancelling a session (Ctrl+C, or its own double-Esc)
              // sweeps up every job beneath it. Those envelopes are recorded
              // silently so they resolve their own rows without prompting the
              // session that is stopping and undoing the interrupt.
              if (result.info?.status === "cancelled") {
                // Totality invariant: every launched job has a terminal
                // envelope, including teardown. Teardown suppresses the wake,
                // not the receipt: ancestor delivery does not cover this row.
                return yield* inject(
                  "cancelled",
                  result.info.output ?? CANCELLED_TEXT,
                  "cancelled",
                  result.info.cancelledByTeardown === true,
                  runKey(result.info),
                )
              }
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      /**
       * The child's own task jobs: the background subagents it launched. A
       * nested yield waits on these, and their report is what wakes the child.
       */
      const childJobs = Effect.fn("TaskTool.childJobs")(function* () {
        const jobs = yield* background.list()
        return jobs.filter(
          (job) =>
            job.type === id && BackgroundJob.isSubagentOf(job, nextSession.id) && job.metadata?.background !== false,
        )
      })

      /**
       * What a settled child of the child declared when it ended, read from its
       * transcript - the same evidence its own dispatch delivered upward. The
       * job record does not carry the typed reason, and an unreadable session is
       * not evidence of success: a missing row reads as no termination while any
       * other storage cause propagates, exactly as the run-end recovery does.
       */
      const descendantTermination = (descendant: SessionID) =>
        sessions.messages({ sessionID: descendant }).pipe(
          Effect.map((messages) =>
            messages
              .flatMap((message) => message.parts)
              .findLast(
                (part): part is SessionV1.ToolPart =>
                  part.type === "tool" && part.tool === FinishTool.id && part.state.status === "completed",
              ),
          ),
          Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)),
          Effect.map((finish) => (finish ? deliveredReason(readTermination(finish)) : undefined)),
        )

      /**
       * The child's next turn after one of its subagents reported. This is the
       * notification the child would have received, rendered from the settled
       * job and delivered by this dispatch because the parked job owns the
       * child's continuation (#222): same envelope, same UNREVIEWED marker for
       * delegated writes, same agent the child session runs under.
       */
      const resumeChild = Effect.fn("TaskTool.resumeChild")(function* (job: BackgroundJob.Info) {
        const state = job.status === "completed" ? "completed" : job.status === "cancelled" ? "cancelled" : "error"
        const body =
          state === "completed"
            ? (job.output ?? "")
            : state === "cancelled"
              ? (job.output ?? CANCELLED_TEXT)
              : (job.error ?? "")
        const wrote = job.metadata?.[REVIEW_LOOP_METADATA] !== undefined
        // A descendant's writes make this child's own result unreviewed too.
        if (wrote) yield* Ref.set(wroteFiles, true)
        const descendant = SessionID.make(job.id)
        const termination = state === "cancelled" ? ("cancelled" as const) : yield* descendantTermination(descendant)
        // Claim only after the transcript read succeeds. If it fails, this
        // dispatch errors and the still-live notifier must deliver the report.
        receipted.add(runKey(job))
        return yield* promptChild([
          {
            type: "text" as const,
            synthetic: true,
            text: renderOutput({
              sessionID: descendant,
              state,
              run: runKey(job),
              summary:
                state === "completed"
                  ? `Background task completed: ${job.title ?? "subagent"}`
                  : state === "cancelled"
                    ? `Background task cancelled: ${job.title ?? "subagent"}`
                    : `Background task failed: ${job.title ?? "subagent"}`,
              text: wrote
                ? `UNREVIEWED: This child changed files. Parent must run Review before reporting success.\n${body}`
                : body,
              termination,
            }),
            ...(wrote ? { metadata: { [REVIEW_LOOP_METADATA]: { writesFiles: true } } } : {}),
          },
        ])
      })

      // Jobs this dispatch has already reported to the child. It lives across
      // parks: a child that waits twice must not be told about the same
      // finished subagent twice.
      const reported = yield* Ref.make(new Set<string>())

      /**
       * Keeps this dispatch's job alive while the child waits on its own
       * subagents (#222). The child's run ended at its yield but its work did
       * not: the job stays `running`, so a parent can wait on it again and the
       * session's status stays truthful; no provisional envelope is delivered;
       * and the parent receives exactly one delivery - the child's terminal
       * result - once its subagents have reported and the child has finished
       * the turns it resumed for.
       *
       * `parked: false` means the declared wait has nothing behind it: nothing
       * of the child's own is running and no report is outstanding, so its last
       * result is delivered as the run's last word, as it was before.
       */
      const park = Effect.fn("TaskTool.parkChild")(function* (last: string) {
        const delivered = yield* Ref.get(reported)
        const behind = (yield* childJobs()).filter((job) => job.status === "running" || !delivered.has(runKey(job)))
        if (behind.length === 0) return { text: last, parked: false }
        // The child's run has ended, and this is what keeps that from reading
        // as "the child is finished" to anything watching the session.
        yield* status.set(nextSession.id, { type: "busy" })
        const text = yield* Effect.gen(function* () {
          let text = last
          while (true) {
            const kids = yield* childJobs()
            const seen = yield* Ref.get(reported)
            const settled = kids.filter((job) => job.status !== "running" && !seen.has(runKey(job)))
            if (settled.length > 0) {
              for (const job of settled) {
                yield* Ref.update(reported, (ids) => new Set(ids).add(runKey(job)))
                // Teardown notifications still write a silent terminal envelope
                // themselves. Do not claim their receipt or resurrect the child.
                if (job.cancelledByTeardown) continue
                if (receipted.has(runKey(job))) continue
                text = yield* resumeChild(job)
                if ((yield* Ref.get(declaredReason)) !== "waiting_for_subagent") return text
              }
              continue
            }
            const running = kids.filter((job) => job.status === "running")
            if (running.length === 0) return text
            yield* running.map((job) => background.wait({ id: job.id })).reduce((a, b) => Effect.raceFirst(a, b))
          }
        }).pipe(Effect.ensuring(status.set(nextSession.id, { type: "idle" })))
        return { text, parked: true }
      })

      // Each continuation owns its listener until that continuation ends.
      // Extending an existing background job must clean up too.
      const runWithEvidence = () =>
        runTask().pipe(
          Effect.flatMap((text) =>
            Effect.gen(function* () {
              while ((yield* Ref.get(declaredReason)) === "waiting_for_subagent") {
                const next = yield* park(text)
                text = next.text
                if (!next.parked) break
              }
              return text
            }),
          ),
          Effect.onInterrupt(() => ops.cancel(nextSession.id)),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const history = yield* sessions.messages({ sessionID: nextSession.id })
              yield* projectWrites(history.flatMap((message) => message.parts))
            }).pipe(
              // Effect v4 finalizer failures replace the original cause unless
              // it is combined explicitly. Neither failure is recoverable here.
              Effect.catchCause((cause) =>
                Effect.failCause(Exit.isFailure(exit) ? Cause.combine(exit.cause, cause) : cause),
              ),
              Effect.ensuring(unsubscribeWrites),
            ),
          ),
        )

      if (yield* background.extend({ id: nextSession.id, run: runWithEvidence() })) {
        const extended = yield* background.get(nextSession.id)
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
            ...(extended ? { runId: runKey(extended) } : {}),
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      // A reused session ID starts a new job, hence a new delivery obligation:
      // receipts are keyed per run (runKey), so nothing to reset here.
      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          Effect.gen(function* () {
            const promoted = yield* background.get(nextSession.id)
            yield* ctx.metadata({
              title: params.description,
              metadata: {
                ...metadata,
                background: true,
                jobId: nextSession.id,
                ...(promoted ? { runId: runKey(promoted) } : {}),
              },
            })
          }),
          notify(nextSession.id),
        ]),
        run: runWithEvidence(),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
            runId: runKey(info),
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            const wrote = yield* Ref.get(wroteFiles)
            // Cancellation is a delivery, not a tool failure: the parent is
            // blocked on this call, and a free-form failure would leave it
            // re-deriving what happened from prose. The same envelope the
            // background path injects carries the typed reason here.
            if (result?.status === "cancelled")
              return {
                title: params.description,
                metadata: {
                  ...metadata,
                  ...(wrote ? { [REVIEW_LOOP_METADATA]: { writesFiles: true } } : {}),
                  termination: { reason: "cancelled" },
                },
                output: renderOutput({
                  sessionID: nextSession.id,
                  state: "cancelled",
                  text: result.output ?? CANCELLED_TEXT,
                  termination: "cancelled",
                }),
              } satisfies Tool.ExecuteResult
            // Re-associate the delivered review report with the result metadata
            // so consumers know which revision was reviewed without re-parsing
            // the output. The output already carries the canonical envelope.
            const review = isReviewAgent(next.name) ? ReviewReport.extract([result?.output ?? ""]) : undefined
            const reviewed = review?.ok
              ? { report: review.report, sessionId: nextSession.id, revision: review.report.revision }
              : undefined
            const reason = yield* Ref.get(termination)
            const completed: Tool.ExecuteResult = {
              title: params.description,
              metadata: {
                ...metadata,
                ...((requiredStage || noncodingGeneral) &&
                reason === "success" &&
                result?.status === "completed" &&
                result.metadata?.background !== true &&
                result.metadata?.truncated !== true &&
                (yield* Ref.get(explicitSuccess))
                  ? {
                      [WorkFlow.METADATA]: {
                        agent: noncodingGeneral ? "general" : next === thinkIdentity ? "think" : "code",
                        terminal: "success",
                        planned: workflow?.planned === true,
                        requestID: workflow?.requestID,
                        parentID: ctx.sessionID,
                      },
                    }
                  : {}),
                ...(reviewed ? { review: reviewed } : {}),
                ...(reason !== undefined ? { termination: { reason } } : {}),
                // A handoff reports the child's writes as unreviewed. It keeps
                // the delivered report and what that report was about: the
                // parent still paid for the review, and dropping the
                // association would leave it re-parsing the output to learn
                // which revision was reviewed.
                ...(metadata[REVIEW_LOOP_METADATA]
                  ? { review: { ...reviewed, verdict: "pending", termination: "review-pending" } }
                  : {}),
              },
              output: renderOutput({
                sessionID: nextSession.id,
                state: "completed",
                text: metadata[REVIEW_LOOP_METADATA]
                  ? `UNREVIEWED: This child changed files. Parent must run Review before reporting success.\n${result?.output ?? ""}`
                  : (result?.output ?? ""),
                termination: reason,
              }),
            }
            return completed
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n"),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
