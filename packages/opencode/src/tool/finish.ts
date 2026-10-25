import { route as workRoute } from "@/session/work-flow"
import { WorkFlow } from "@opencode-ai/core/work-flow"
import * as Tool from "./tool"
import { ToolFailure } from "@opencode-ai/llm"
import { ReviewReport } from "@opencode-ai/core/review-report"
import { EffortPolicy } from "@opencode-ai/core/effort-policy"
import { AgentEffort } from "@opencode-ai/schema/agent-effort"
import DESCRIPTION from "./finish.txt"
import { Effect, Option, Schema } from "effect"
import { Todo } from "../session/todo"
import { Session, readAgentEffort } from "../session/session"
import { NotFoundError } from "@/storage/storage"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Config } from "@/config/config"
import { reviewLoopState } from "../session/review-loop"
import { BackgroundJob } from "@/background/job"
import { isReviewAgent, LEGACY_REVIEW_AGENTS, resolveReviewer } from "../agent/review-agents"
import { Agent } from "../agent/agent"
import { Permission } from "@/permission"
import { resultChunks, textResult, TEXT_RESULT_TAG } from "@/session/subagent-result"

const DeclaredReasons = ["success", "waiting_for_subagent", "subagent_wait", "failure"] as const

export const Reason = Schema.Literals(DeclaredReasons)

export type Reason = Schema.Schema.Type<typeof Reason>

/**
 * The full termination contract for a finished run, as delivered to a parent
 * through a `<termination reason="...">` element.
 *
 * The model only ever declares {@link Reason} on the finish tool; `cancelled`
 * cannot be declared there. A cancelled subagent never reaches a finish call —
 * the user stops it mid-run — so the runtime records the cancellation itself
 * instead of forcing the reason through a tool input the model never supplied.
 *
 * The delivered set is deliberately narrower than the declared one:
 * `waiting_for_subagent` is not in it. A yield ends the child's turn, so an
 * envelope naming that reason would present a provisional result as a terminal
 * one; {@link deliveredReason} drops it. A nested yield (#222) delivers nothing
 * at all: the child's job stays running and its terminal result is the only
 * delivery.
 */
export const TerminationReason = Schema.Literals(["success", "subagent_wait", "failure", "cancelled"])

export type TerminationReason = Schema.Schema.Type<typeof TerminationReason>

export const Parameters = Schema.Struct({
  reason: Reason.annotate({
    description:
      "Why the turn ends: success, waiting_for_subagent (yield while your own background subagents run, including from a subagent session), subagent_wait, or failure.",
  }),
  result: Schema.String.annotate({
    description: "Concise summary of the outcome, shown to the user.",
  }),
  validation: Schema.optional(
    Schema.Struct({
      checks: Schema.Array(
        Schema.Struct({
          category: Schema.Literals(["syntax", "smoke", "tests", "typecheck", "parity"]),
          status: Schema.Literals(["passed", "failed", "not-run", "not-applicable"]),
          detail: Schema.String,
        }),
      ),
    }),
  ).annotate({
    description: "Optional validation evidence, one entry per check.",
  }),
})

/**
 * Reads the termination reason the model declared on a completed finish call.
 *
 * Three cases, deliberately not collapsed into one default:
 *
 * - A record with no `reason` is a transcript written before the field existed.
 *   Those turns were successes, so absence reads as `success` and the loop
 *   still exits with a verdict.
 * - A record carrying a reason this build does not recognise is not a legacy
 *   transcript. It resolves to `undefined` rather than to `success`, so a
 *   future build's value is never silently upgraded into a delivered verdict by
 *   an older one.
 * - Anything that is not a record cannot be read at all and yields `undefined`.
 */
export function readTermination(part: SessionV1.ToolPart): Reason | undefined {
  if (part.tool !== FinishTool.id) return undefined
  if (part.state.status !== "completed") return undefined
  const input = part.state.input
  if (typeof input !== "object" || input === null) return undefined
  const declared = (input as { reason?: unknown }).reason
  if (declared === undefined) return "success"
  return Option.getOrUndefined(Schema.decodeUnknownOption(Reason)(declared))
}

/**
 * The declared reason as it is delivered to a parent.
 *
 * A declared `waiting_for_subagent` has no delivered counterpart. The finish
 * tool accepts the wait only while a background subagent of that session is
 * running - for a task child, one it launched itself, which keeps its job alive
 * (#222) - so a transcript carrying the reason without one behind it must not
 * put a provisional envelope on the wire as a terminal one: it delivers like a
 * legacy record with no declared reason — a plain result with no
 * `<termination>` element.
 */
export function deliveredReason(reason: Reason | undefined): TerminationReason | undefined {
  if (reason === "waiting_for_subagent") return undefined
  return reason
}

/**
 * Why a session cannot dispatch the Review subagent.
 *
 * This is dispatch evidence, never a waiver. It is persisted on the finish part
 * so the review loop and the TUI can tell a blocked turn from an approved one,
 * and the set is the contract both read: every reason `reviewUnavailable` below
 * can report must be declared here, or the metadata assignment fails to type.
 */
export type ReviewUnavailable =
  | "subagent-depth"
  | "task-hidden"
  | "reviewer-missing"
  | "permission-denied"
  | "session-unreadable"
  | "caller-unreadable"

/**
 * Persisted `metadata` of a finish result. The waiting branch sets only `waiting`;
 * the delivered and declined branches set `review` (and `termination`/`validation`
 * on delivery). Declared here so the execute result is typed, not inferred from
 * the two branches, which would collapse the optional fields to `undefined`.
 */
type FinishMetadata = {
  waiting?: boolean
  termination?: { reason: Reason }
  review?: {
    nudged?: boolean
    effort: AgentEffort.Level
    disposition: EffortPolicy.Disposition
    verdict: string
    reviews: number
    maxIterations?: number
    termination?: EffortPolicy.Termination
    unavailable?: ReviewUnavailable
    unavailableReason?: string
    openFindings: number
    blockingFindings: number
    workSinceReview: boolean
    stale?: boolean
  }
  validation?: EffortPolicy.ValidationReport
}

export const FinishTool = Tool.define(
  "finish",
  Effect.gen(function* () {
    const todo = yield* Todo.Service
    const sessions = yield* Session.Service
    const config = yield* Config.Service
    const background = yield* BackgroundJob.Service
    const agents = yield* Agent.Service
    const permission = yield* Permission.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<FinishMetadata>, ToolFailure> =>
        Effect.gen(function* () {
          yield* ctx.waitForOtherTools ?? Effect.void
          const messages = yield* sessions
            .messages({ sessionID: ctx.sessionID })
            .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
          const currentMessage = messages.find((message) => message.info.id === ctx.messageID)
          const chunks = currentMessage ? resultChunks(messages, currentMessage) : []
          const ownerSession = yield* sessions
            .get(ctx.sessionID)
            .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
          const isChild =
            ownerSession?.parentID !== undefined ||
            (yield* background.list()).some(
              (job) => job.type === "task" && BackgroundJob.runsSession(job, ctx.sessionID),
            )
          if (isChild && !isReviewAgent(ctx.agent) && !textResult([...chunks, params.result]).ok) {
            return yield* Effect.fail(
              new ToolFailure({
                message: `Subagent finish rejected: emit a non-empty <${TEXT_RESULT_TAG}>final text result</${TEXT_RESULT_TAG}> envelope in this execution, or include it in finish.result, then call finish again. Progress text and tool output are not a delivered result.`,
              }),
            )
          }
          // The Review subagent completes its run through this same finish
          // tool, so the structured review result is gated here, at the
          // control-flow boundary: without a parseable report envelope the
          // call fails as recoverable model feedback and the run continues
          // instead of completing without a verdict. Reviewer sessions are
          // never recursively reviewed by the effort policy below — their
          // own report contract is the whole gate.
          if (isReviewAgent(ctx.agent)) {
            const delivery = ReviewReport.extract([...chunks, params.result])
            if (!delivery.ok) {
              yield* Effect.logWarning("finish declined: review result missing or unparseable", {
                sessionID: ctx.sessionID,
                reason: delivery.failure.reason,
              })
              return yield* Effect.fail(
                new ToolFailure({
                  message: [
                    `Review finish rejected: ${delivery.failure.message}.`,
                    `The review run cannot complete until finish is called with a result containing a valid <${ReviewReport.TAG}> report envelope: {"version": 1, "revision": string, "assessment": "approved" | "needs-fixes", "summary": string, "findings": [{"severity": "critical" | "important" | "minor", "title": string}]}.`,
                    `Emit the envelope and call finish again; the review continues.`,
                  ].join(" "),
                }),
              )
            }
          }

          // Yielding for background work is not a termination. The turn ends so
          // the model stops polling for the subagents it launched, but the
          // session is woken by their notification, so a wait must leave
          // everything the real finish depends on untouched: the review
          // requirement, the plan, and the terminal metadata the review loop
          // reads as a delivered outcome.
          //
          if (params.reason === "waiting_for_subagent") {
            const jobs = yield* background.list()
            const session = yield* sessions
              .get(ctx.sessionID)
              .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
            const isSubagentRun =
              session.parentID !== undefined ||
              jobs.some(
                (job) =>
                  job.type === "task" && job.status === "running" && BackgroundJob.runsSession(job, ctx.sessionID),
              )
            // The filter below is a snapshot, not a reservation (#222): a job
            // whose cancellation is already in flight still reads `running`
            // here, so a wait can be accepted whose child never notifies.
            // The same ownership relation the cancellation walks use, narrowed
            // to the jobs a wait can actually be woken by: a task this session
            // launched. A session's own run job is not work it can wait for.
            const running = jobs.filter(
              (job) =>
                job.type === "task" && job.status === "running" && BackgroundJob.isSubagentOf(job, ctx.sessionID),
            )
            if (running.length === 0) {
              // A subagent that launched its own background subagents may yield
              // for them: `task` keeps its job running through the wait and
              // resumes it when they report, so the session is woken by exactly
              // the work it declared (#222). What it must not do is yield with
              // nothing of its own in flight - its run ends at the yield, so the
              // parent would receive this provisional result as the run's only
              // delivery and whatever it waits on would never reach it.
              if (isSubagentRun) {
                yield* Effect.logWarning("finish declined: a subagent yielded with no subagents of its own running", {
                  sessionID: ctx.sessionID,
                })
                return yield* Effect.fail(
                  new ToolFailure({
                    message:
                      "Cannot wait: this session is itself a subagent and has no background subagents of its own " +
                      "running. A subagent may yield only for a task it launched itself, because that is the work " +
                      "that can wake it; a yield with nothing of its own in flight would end its run here and " +
                      'deliver this provisional result as the run\'s only delivery. Deliver your own result with reason: "success", ' +
                      'or "failure" if the task could not be completed.',
                  }),
                )
              }
              return yield* Effect.fail(
                new ToolFailure({
                  message:
                    "Cannot wait: no running background subagents found for this session. " +
                    "Wait only for a task you launched that is still running — a subagent whose run " +
                    "already ended will not report again. " +
                    'If your work is complete, call finish with reason: "success".',
                }),
              )
            }
            // Accepted for a subagent too, when the running jobs are its own:
            // `task` keeps its job running through the wait and resumes it as
            // they report, so the wait is woken by work that belongs to it.
            yield* Effect.logInfo("finish yielded while background subagents run", {
              sessionID: ctx.sessionID,
              subagents: running.length,
            })
            return {
              title: `Waiting for ${running.length} background subagent(s)`,
              output: params.result,
              metadata: { waiting: true },
            }
          }

          const cfg = yield* config.get()
          // Only a missing row reads as "no session". Storage failures reach
          // here as defects and must propagate instead of silently resolving the
          // effort and reviewer availability against no session.
          const session = yield* sessions
            .get(ctx.sessionID)
            .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
          // Effective level: session-persisted selection, then configured
          // default, then medium. The model never supplies a level here —
          // finish must not accept a model-selected effort or pass budget.
          const configEffort = typeof cfg.agent?.effort === "string" ? cfg.agent.effort : undefined
          const effort = AgentEffort.resolve(readAgentEffort(session?.metadata), AgentEffort.resolve(configEffort))
          const reviewState = reviewLoopState(messages, { effort })
          const workIdentity = yield* agents.get("work")
          if (
            session !== undefined &&
            WorkFlow.ownsRole(yield* agents.list(), workIdentity, ctx.agent) &&
            params.reason === "success"
          ) {
            const workflow = WorkFlow.state(messages, ctx.sessionID)
            const admission = yield* workRoute(ctx.sessionID).pipe(
              Effect.provideService(Session.Service, sessions),
              Effect.mapError((error) => new ToolFailure({ message: error.message })),
            )
            const original = WorkFlow.request(messages)
            const requestText =
              original?.parts
                .flatMap((part) => (part.type === "text" ? [(part as { text: string }).text] : []))
                .join("\n") ?? ""
            if (
              admission.kind === "nonprogramming" &&
              (effort === "thorough" || WorkFlow.complex(requestText)) &&
              !workflow.delegated
            )
              return yield* Effect.fail(
                new ToolFailure({
                  message:
                    "Complex or thorough non-programming work requires a successful General delivery before success. Do not send it to Code.",
                }),
              )
            if (admission.kind === "programming" && !workflow.implemented)
              return yield* Effect.fail(
                new ToolFailure({
                  message:
                    "Programming success requires deep-think planning (or a successful Think task) followed by successful Code implementation in this request.",
                }),
              )
            if (
              (admission.kind === "programming" || reviewState.blockingFindings > 0) &&
              (reviewState.blockingFindings > 0 ||
                reviewState.workSinceReview ||
                reviewState.lastReviewVerdict !== "approved")
            )
              return yield* Effect.fail(
                new ToolFailure({
                  message:
                    "Work cannot report implementation success while Review is missing, stale or has blocking findings. Fix through the appropriate executor and obtain a clean Review; a review budget is not approval. Report failure honestly if blocked.",
                }),
              )
          }

          // Reviewer availability is dispatch evidence taken from the same
          // context a real `task` dispatch would use: the reviewer's
          // existence/primary status, the CALLING
          // agent's permission ruleset exactly as `ctx.ask` composes it, the
          // session's rules, and the subagent depth limit. It is only
          // consulted when the policy could actually need a review.
          const availability =
            effort === "fast" || !reviewState.workSeen
              ? ({ available: true } as const)
              : yield* Effect.gen(function* () {
                  if (!session)
                    return {
                      available: false as const,
                      code: "session-unreadable" as const,
                      reason: "the session could not be read to verify reviewer dispatch context",
                    }
                  // One reviewer exists after the specialist consolidation:
                  // resolution is the identity for a `review` dispatch, so the
                  // availability check reads the reviewer directly.
                  const resolved = resolveReviewer("review")
                  const reviewer = yield* agents.get(resolved)
                  if (!reviewer)
                    return {
                      available: false as const,
                      code: "reviewer-missing" as const,
                      reason: `reviewer agent "${resolved}" is not available`,
                    }
                  if (reviewer.mode === "primary")
                    return {
                      available: false as const,
                      code: "reviewer-missing" as const,
                      reason: `reviewer agent "${resolved}" is a primary agent and cannot be delegated to`,
                    }
                  // The dispatch permission gate asks through `ctx.ask`,
                  // whose ruleset is the RUNNING agent's permissions merged
                  // with the session's (session/tools.ts), and finish runs
                  // inside that same running agent — `ctx.agent` is the
                  // caller. The requested reviewer's own permissions are not
                  // part of that composition: a deny on the generic `review`
                  // agent gates nothing at dispatch, and a caller-scoped
                  // deny must not be hidden behind it.
                  const caller = yield* agents.get(ctx.agent)
                  if (!caller)
                    return {
                      available: false as const,
                      code: "caller-unreadable" as const,
                      reason: `running agent "${ctx.agent}" could not be read to verify its dispatch permissions`,
                    }
                  const ruleset = Permission.merge(caller.permission, session.permission ?? [])
                  // The retired specialist names stay valid deny targets: a
                  // rule written against `work-review`/`code-review` gated the
                  // reviewer before the consolidation, and there is exactly one
                  // reviewer to gate now, so it must keep gating.
                  const patterns = ["review", ...LEGACY_REVIEW_AGENTS]
                  // Same deny verdict as the real dispatch: `Permission.denies`
                  // evaluates this ruleset against the instance-approved grants
                  // exactly as `Permission.ask` does, so an always-grant that
                  // would mask a deny at dispatch cannot make finish claim
                  // review-unavailable while dispatch stays allowed — and an
                  // ungranted deny still reports unavailable honestly.
                  // An explicit agent invocation (bypassAgentCheck) lets task skip its
                  // permission prompt, so the same deny does not stop that dispatch and
                  // must not read as unavailable here either.
                  const bypassAgentCheck = ctx.extra?.bypassAgentCheck === true
                  if (!bypassAgentCheck && (yield* permission.denies({ permission: "task", patterns, ruleset })))
                    return {
                      available: false as const,
                      code: "permission-denied" as const,
                      reason: `permission config denies task "${resolved}"`,
                    }
                  let depth = 0
                  let current: Session.Info | undefined = session
                  while (current?.parentID) {
                    depth++
                    const parent: Session.Info | undefined = yield* sessions
                      .get(current.parentID)
                      .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
                    if (!parent)
                      return {
                        available: false as const,
                        code: "session-unreadable" as const,
                        reason: "session ancestry could not be read to verify the subagent depth limit",
                      }
                    current = parent
                  }
                  // 233: the newest user message hides the task tool for this turn.
                  // A per-message decision, so it blocks a dispatch the ruleset would allow.
                  const latestUser = messages.findLast((message) => message.info.role === "user")
                  if (latestUser?.info.role === "user" && latestUser.info.tools?.task === false)
                    return {
                      available: false as const,
                      code: "task-hidden" as const,
                      reason: "the newest user message hides the task tool for this turn",
                    }
                  const depthLimit = cfg.subagent_depth ?? 1
                  if (depth >= depthLimit)
                    return {
                      available: false as const,
                      code: "subagent-depth" as const,
                      reason: `subagent depth limit reached (${depthLimit})`,
                    }
                  return { available: true as const }
                })

          const outcome = EffortPolicy.evaluateFinish({
            effort,
            reason: params.reason,
            state: reviewState,
            reviewerAvailable: availability.available,
            ...(availability.available ? {} : { unavailableReason: availability.reason }),
            ...(availability.available ? {} : { unavailableCode: availability.code }),
            // #233 handoff: a child that cannot dispatch review because of the depth limit hands
            // its unreviewed writes to its parent (review-pending), never claims approval.
            handoff:
              !availability.available && session?.parentID !== undefined && availability.code === "subagent-depth",
          })

          if (!outcome.deliver) {
            yield* Effect.logWarning("finish declined by effort policy", {
              sessionID: ctx.sessionID,
              effort,
              reason: params.reason,
              verdict: reviewState.verdict,
              reviews: reviewState.reviews,
              feedback: outcome.feedback,
            })
            // Persist the attempt on the failed part so the transcript shows
            // the review demand. Declining depends only on the persisted review
            // state, so repeating this call never becomes a review bypass.
            yield* ctx.metadata({
              title: "Review required",
              metadata: {
                review: {
                  nudged: true,
                  ...(availability.available ? {} : { unavailable: availability.code }),
                  effort,
                  disposition: outcome.disposition,
                  verdict: reviewState.verdict,
                  reviews: reviewState.reviews,
                  ...(outcome.maxIterations !== undefined ? { maxIterations: outcome.maxIterations } : {}),
                  openFindings: reviewState.openFindings,
                  blockingFindings: reviewState.blockingFindings,
                  workSinceReview: reviewState.workSinceReview,
                  ...(reviewState.stale ? { stale: true } : {}),
                },
              },
            })
            return yield* Effect.fail(new ToolFailure({ message: outcome.feedback ?? "Review required." }))
          }

          if (outcome.termination === "budget-exhausted" || outcome.termination === "review-unavailable") {
            yield* Effect.logWarning("finish delivered without a clean review", {
              sessionID: ctx.sessionID,
              effort,
              termination: outcome.termination,
              reviews: reviewState.reviews,
              ...(outcome.unavailableReason ? { unavailableReason: outcome.unavailableReason } : {}),
            })
          }

          yield* Effect.gen(function* () {
            const existing = yield* todo.get(ctx.sessionID)
            const hasOpen = existing.some((t) => t.status === "pending" || t.status === "in_progress")
            if (!hasOpen) return
            const closed = existing.map((t) =>
              t.status === "pending" || t.status === "in_progress" ? { ...t, status: "cancelled" as const } : t,
            )
            yield* todo.update({ sessionID: ctx.sessionID, todos: closed })
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("finish todo cleanup failed, but finish still succeeds", {
                sessionID: ctx.sessionID,
                cause,
              }),
            ),
          )

          // Agent-reported evidence only: finish never executes validation and
          // never claims a check ran because a gate was selected. Missing or
          // failed evidence stays visible in both output and metadata.
          const validation = EffortPolicy.deriveValidation({ effort, declaration: params.validation })
          // Fast requires no passes: render its zero as the honest "none
          // required" rather than an until-clean or N-cap budget it does not have.
          const passes = `passes ${reviewState.reviews}${
            effort === "fast"
              ? " (none required)"
              : outcome.maxIterations !== undefined
                ? `/${outcome.maxIterations}`
                : " until-clean"
          }`
          const status = [
            `effort ${effort}`,
            [
              `review ${outcome.disposition}/${outcome.termination}, ${passes}${reviewState.openFindings > 0 ? `, open findings ${reviewState.openFindings}` : ""}${
                reviewState.blockingFindings > 0 ? `, blocking ${reviewState.blockingFindings}` : ""
              }${reviewState.stale ? ", stale work after review" : ""}${
                outcome.unavailableReason ? `, reviewer unavailable: ${outcome.unavailableReason}` : ""
              }`,
            ].join(""),
            `validation ${validation.gate}/${validation.status}`,
          ].join(" | ")

          return {
            title: "Task completed",
            output: `${params.result}\n\n[${status}]`,
            metadata: {
              termination: { reason: params.reason },
              review: {
                effort,
                disposition: outcome.disposition,
                ...(availability.available ? {} : { unavailable: availability.code }),
                verdict: reviewState.verdict,
                reviews: reviewState.reviews,
                ...(outcome.maxIterations !== undefined ? { maxIterations: outcome.maxIterations } : {}),
                termination: outcome.termination,
                openFindings: reviewState.openFindings,
                blockingFindings: reviewState.blockingFindings,
                workSinceReview: reviewState.workSinceReview,
                ...(reviewState.stale ? { stale: true } : {}),
                ...(outcome.unavailableReason ? { unavailableReason: outcome.unavailableReason } : {}),
              },
              validation,
            },
          }
        }),
    }
  }),
)
