export * as EffortPolicy from "./effort-policy"

import { AgentEffort } from "@opencode-ai/schema/agent-effort"
import type { ReviewLoopState } from "./review-loop"

/** Validation gate derived from the effort level — the second of the two switches. */
export type ValidationGate = "minimal" | "standard" | "full"

export type ValidationCategory = "syntax" | "smoke" | "tests" | "typecheck" | "parity"

export type ValidationStatus = "passed" | "failed" | "not-run" | "not-applicable"

export type ValidationCheck = {
  readonly category: ValidationCategory
  readonly status: ValidationStatus
  readonly detail: string
}

export type ValidationDeclaration = {
  readonly checks: readonly ValidationCheck[]
}

export type ValidationReport = {
  readonly gate: ValidationGate
  readonly status: "passed" | "failed" | "incomplete"
  readonly checks: readonly ValidationCheck[]
  readonly source: "agent-reported"
}

/**
 * Honest delivery status written to `metadata.review.termination`.
 * Never an approval unless a valid independent review actually approved the
 * delivered work.
 */
export type Termination =
  | "unreviewed"
  | "approved"
  | "findings-open"
  | "budget-exhausted"
  | "review-unavailable"
  | "review-blocked"
  | "review-pending"
  | "not-required"
  | "waiting"

export type Disposition = "reviewed" | "unreviewed"

export type FinishReason = "success" | "failure" | "subagent_wait"

export type FinishInput = {
  readonly effort: AgentEffort.Level
  readonly reason: FinishReason
  readonly state: ReviewLoopState
  /** Dispatch capability of the routed reviewer in this session's context. */
  readonly reviewerAvailable: boolean
  /** Why the reviewer is unavailable, when it is. */
  readonly unavailableReason?: string
  /** Typed reason code for an unavailable reviewer (for example `subagent-depth`), when known. */
  readonly unavailableCode?: string
  /**
   * A depth-limited child with a parent cannot dispatch review: its writes are handed
   * back to the parent as unreviewed (`review-pending`), never approved.
   */
  readonly handoff?: boolean
}

export type FinishOutcome = {
  readonly deliver: boolean
  readonly disposition: Disposition
  readonly termination: Termination
  /** Finite pass limit to serialize, when one applies to this level. */
  readonly maxIterations?: number
  /** Recoverable feedback for the model when the finish call is declined. */
  readonly feedback?: string
  readonly unavailableReason?: string
}

/**
 * The first of the two switches: how many independent review passes a level
 * requires. `0` means none are required; `undefined` means until-clean with no
 * finite cap (thorough and ultra). Ultra differs in delegation depth and origin
 * anchoring, not pass count.
 */
export function passLimit(level: AgentEffort.Level): number | undefined {
  if (level === "fast") return 0
  if (level === "medium") return 2
  return undefined
}

/** The second of the two switches: which validation evidence a level expects. */
export function validationGate(level: AgentEffort.Level): ValidationGate {
  if (level === "fast") return "minimal"
  if (level === "medium") return "standard"
  return "full"
}

const GATE_CATEGORIES: Record<ValidationGate, readonly ValidationCategory[]> = {
  minimal: ["syntax", "smoke"],
  standard: ["tests"],
  full: ["tests", "typecheck", "parity"],
}

/**
 * Categories a gate expects evidence for. A category the agent declares
 * `not-applicable` is satisfied by that declaration; a category with no
 * declared check at all leaves the report incomplete. Nothing here executes:
 * the declaration is agent-reported evidence only, never verified commands.
 */
export function requiredCategories(gate: ValidationGate): readonly ValidationCategory[] {
  return GATE_CATEGORIES[gate]
}

/** Derive the validation report from the effective level and the optional declaration. */
export function deriveValidation(input: {
  effort: AgentEffort.Level
  declaration?: ValidationDeclaration
}): ValidationReport {
  const gate = validationGate(input.effort)
  const checks = input.declaration?.checks ?? []
  const status = ((): ValidationReport["status"] => {
    if (checks.some((check) => check.status === "failed")) return "failed"
    const statusByCategory = new Map(checks.map((check) => [check.category, check.status]))
    // Minimal is satisfied by ONE actually-passed applicable check: syntax OR
    // smoke. When neither can apply, both categories declared explicitly
    // not-applicable satisfy it honestly; empty, all-not-run, or missing
    // evidence stays incomplete. Nothing here executes: a declaration is
    // agent-reported evidence only.
    if (gate === "minimal") {
      const applicable = requiredCategories(gate)
      if (applicable.some((category) => statusByCategory.get(category) === "passed")) return "passed"
      if (applicable.every((category) => statusByCategory.get(category) === "not-applicable")) return "passed"
      return "incomplete"
    }
    const covered = new Set(checks.filter((check) => check.status !== "not-run").map((check) => check.category))
    const missing = requiredCategories(gate).some((category) => !covered.has(category))
    return missing ? "incomplete" : "passed"
  })()
  return { gate, status, checks, source: "agent-reported" }
}

/**
 * Decide whether this `finish` call delivers, and with which honest labels.
 *
 * Enforcement lives here, at the finish checkpoint, and depends only on the persisted review
 * state, never on how often finish was attempted.
 *
 * - `fast`: no mandatory review. Delivers with an honest unreviewed/findings label.
 * - `medium`: at least one independent review, then at most two completed attempts. Blocking
 *   findings or stale work force another pass until the cap; after the cap delivery is labelled
 *   budget-exhausted, never approved.
 * - `thorough`: until-clean with no pass cap.
 *
 * For medium and thorough (#233): an unavailable reviewer BLOCKS a successful finish. Only a
 * declared failure may deliver with `review-blocked`, and a depth-limited child hands its writes
 * to its parent as `review-pending`. A declared failure with a dispatchable reviewer is still
 * reviewed. `subagent_wait` is a provisional yield, never approval. Read-only turns are exempt and
 * labelled `not-required`, distinct from approval.
 */
export function evaluateFinish(input: FinishInput): FinishOutcome {
  const { effort, reason, state, reviewerAvailable } = input
  // A delivered verdict is what makes a review "happened"; an errored or malformed attempt only
  // spends budget.
  const reviewed = state.lastReviewVerdict !== undefined
  const disposition: Disposition = reviewed ? "reviewed" : "unreviewed"
  const limit = passLimit(effort)
  const maxIterations = limit !== undefined && limit > 0 && Number.isFinite(limit) ? limit : undefined
  const common: { disposition: Disposition; maxIterations?: number } = {
    disposition,
    ...(maxIterations !== undefined ? { maxIterations } : {}),
  }

  if (reason === "subagent_wait") return { deliver: true, termination: "waiting", ...common }

  if (!state.workSeen) {
    // No code changes this task: exempt from the review ritual, labelled distinctly from approval.
    if (reason === "failure") return { deliver: true, termination: "unreviewed", ...common }
    return { deliver: true, termination: "not-required", ...common }
  }

  const converged =
    reviewed && !state.workSinceReview && state.lastReviewVerdict === "approved" && state.blockingFindings === 0
  const blocking = state.blockingFindings > 0

  const deliverableTermination = ((): Termination => {
    if (state.workSinceReview) return reviewed ? "findings-open" : "unreviewed"
    if (converged) return "approved"
    if (state.lastReviewVerdict === "needs-fixes") return "findings-open"
    if (reviewed) return "findings-open"
    return "unreviewed"
  })()

  if (effort === "fast") {
    // Fast requires no review. With no verdict on record the honest label is unreviewed.
    return { deliver: true, termination: deliverableTermination, ...common }
  }

  if (state.reviewInProgress) {
    return decline(common, "A synchronous review is already in progress. Wait for its report before finishing.")
  }

  const exhausted = limit !== undefined && state.reviews >= limit

  // Blocked, handed off, or declared failure: never a silent approval.
  const unavailable = (): FinishOutcome => {
    const unavailableReason = input.unavailableReason ?? "no reviewer is dispatchable in this session's context"
    if (input.handoff) return { deliver: true, termination: "review-pending", ...common, unavailableReason }
    if (reason === "failure") return { deliver: true, termination: "review-blocked", ...common, unavailableReason }
    return decline(
      common,
      `Review blocked (${input.unavailableCode ?? unavailableReason}): success cannot be reported without review. Restore Review dispatch or report failure honestly.`,
      unavailableReason,
    )
  }

  if (effort === "medium") {
    if (exhausted && !converged) {
      // At the cap: a blocking or unapproved last verdict is budget-exhausted; stale work after an
      // approval is findings-open. Neither is ever labelled approved.
      const approvedStale = reviewed && state.lastReviewVerdict === "approved" && !blocking
      return { deliver: true, termination: approvedStale ? "findings-open" : "budget-exhausted", ...common }
    }
    if (!reviewed) return reviewerAvailable ? decline(common, reviewRequired(effort)) : unavailable()
    if (blocking || state.workSinceReview || state.lastReviewVerdict !== "approved") {
      if (!reviewerAvailable) return unavailable()
      return decline(
        common,
        state.workSinceReview
          ? "Review required: work changed after the last review, so the current tree has no explicit Approved review. Run the Review subagent again before finishing."
          : `Review required: the latest report from the Review subagent returned Needs fixes, with ${state.blockingFindings} blocking finding(s) (critical/important) or no findings listed, so the current work is not approved. Fix the findings, then run the Review subagent again (\`subagent_type: "review"\`, \`background: false\`) before finishing.`,
      )
    }
    return { deliver: true, termination: deliverableTermination, ...common }
  }

  // thorough and ultra: until-clean, no finite cap.
  if (!reviewed || blocking || state.lastReviewVerdict !== "approved" || state.workSinceReview) {
    if (!reviewerAvailable) return unavailable()
    return decline(
      common,
      state.workSinceReview && state.lastReviewVerdict === "approved"
        ? "Work changed after the approved review, so the current tree is no longer covered. Run another synchronous review before finishing."
        : `Review required: effort is "${effort}", so delivery requires a clean, current independent review from the Review subagent (\`subagent_type: "review"\`, \`background: false\`). Address the outstanding findings and run it again before finishing.`,
    )
  }
  return { deliver: true, termination: "approved", ...common }
}

function reviewRequired(effort: AgentEffort.Level) {
  return `Review required: this task changed files and effort is "${effort}", which requires at least one independent review before delivery. The current work has no explicit Approved review from the Review subagent. Run the Review subagent now: call the \`task\` tool with \`subagent_type: "review"\` and \`background: false\`, then call finish after it returns Approved.`
}

function decline(
  common: { disposition: Disposition; maxIterations?: number },
  feedback: string,
  unavailableReason?: string,
): FinishOutcome {
  return {
    deliver: false,
    termination: "unreviewed",
    ...common,
    feedback,
    ...(unavailableReason ? { unavailableReason } : {}),
  }
}
