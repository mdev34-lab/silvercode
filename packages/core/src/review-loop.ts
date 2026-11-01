import { AgentEffort } from "@opencode-ai/schema/agent-effort"
import { ReviewReport } from "./review-report"

export const REVIEW_LOOP_METADATA = "reviewLoop" as const

export type ReviewVerdict = "approved" | "needs-fixes" | "pending" | "none" | "cap"
export type ReviewPhase = "work" | "review"
/**
 * How a finished turn left the review loop.
 *
 * - `approved`: the work carries an explicit Approved review, or the turn wrote no files.
 * - `budget-exhausted`: the canonical medium pass budget ran without an approval (never approval).
 * - `review-cap`: legacy label, read-only for persisted metadata: the configured number of review attempts, including failed dispatches and
 *   malformed completed reviews, ran without an approval.
 * - `review-unavailable`: legacy label for a delivered turn whose reviewer could not run.
 * - `review-blocked`: review cannot run; only a declared failure may end this way.
 * - `review-pending`: a depth-limited child hands unreviewed writes to its parent.
 * - `skipped`: read from transcripts only; persisted completions keep their recorded outcome.
 */
export type ReviewTermination =
  | "approved"
  | "budget-exhausted"
  | "review-cap"
  | "review-unavailable"
  | "review-blocked"
  | "review-pending"
  | "skipped"

export type ReviewHistoryPart = {
  readonly type?: unknown
  readonly tool?: unknown
  readonly synthetic?: unknown
  readonly metadata?: unknown
  readonly state?: {
    readonly status?: unknown
    readonly input?: unknown
    readonly output?: unknown
    readonly metadata?: unknown
  }
}

/** The small, persisted history projection needed by the review-loop evaluator. */
export type ReviewHistoryMessage = {
  readonly role?: unknown
  readonly info?: { readonly role?: unknown }
  readonly parts: readonly ReviewHistoryPart[]
}

export type ReviewLoopOptions = {
  /**
   * Legacy iteration cap for callers that predate the effort dial. Ignored when
   * `effort` is supplied: the effort policy owns the pass budget, and the
   * configured `review_loop.max_iterations` value does not override it.
   */
  readonly maxIterations?: number
  /** When present, the pass budget is derived from the effort level instead. */
  readonly effort?: AgentEffort.Level
}

export type ReviewLoopState = {
  readonly verdict: ReviewVerdict
  readonly reviews: number
  readonly maxIterations: number
  readonly workSinceReview: boolean
  readonly reviewInProgress: boolean
  /** A `finish` call was already declined with a review nudge for the current work. */
  readonly nudged: boolean
  readonly phase: ReviewPhase
  readonly termination?: ReviewTermination
  /** Any declared file-writing work happened in the current user task. */
  readonly workSeen: boolean
  /** Verdict of the most recent completed valid review; not cleared by later writes. */
  readonly lastReviewVerdict?: "approved" | "needs-fixes"
  /** Findings listed by the most recent completed valid review report. */
  readonly openFindings: number
  /** Critical/important findings in that report (blockers), floored at 1 for a needs-fixes report with no findings. */
  readonly blockingFindings: number
  /** The latest approved review no longer describes the current tree. */
  readonly stale: boolean
}

const ASSESSMENT = /(?:^|\b)(?:assessment|verdict)\s*(?:[:\-–—]\s*)?(approved|needs\s+fix(?:es)?)/gi
const READY_TO_PROCEED = /ready\s+to\s+proceed\??\s*(?:[:\-–—]\s*)?(approved|needs\s+fix(?:es)?)/gi

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function cleanAssessmentLine(line: string) {
  return line
    .replace(/[*_`#>]/g, " ")
    .replace(/[[\]{}()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function verdictFromText(text: string) {
  // Do not treat the review template's `[Approved | Needs fixes]` placeholder as
  // an actual verdict. A report must name one outcome, not list both choices.
  if (
    /\bapproved\b\s*(?:\||\/|or)\s*\bneeds\s+fix(?:es)?\b/i.test(text) ||
    /\bneeds\s+fix(?:es)?\b\s*(?:\||\/|or)\s*\bapproved\b/i.test(text)
  )
    return undefined

  const matches = [...text.matchAll(ASSESSMENT), ...text.matchAll(READY_TO_PROCEED)].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  )
  const verdict = matches.at(-1)?.[1]
  if (!verdict) return undefined
  return /^approved$/i.test(verdict) ? ("approved" as const) : ("needs-fixes" as const)
}

/**
 * Read the last explicit assessment from a review report.
 *
 * Reports delivered through the report envelope carry their assessment in the
 * machine-readable `<silvercode-review>` block, which is canonical. A detected
 * but invalid envelope — malformed content, truncated tags, or an unsupported
 * schema version — is a delivery failure: it never falls through to the prose
 * scan, or a broken report could mint a verdict the delivery layer already
 * rejected. Only output with no envelope at all (legacy transcripts) falls
 * back to a tolerant text scan: headings, emphasis, bullets, and the labels
 * "Assessment", "Verdict", and "Ready to proceed" are all accepted. A
 * positive-sounding paragraph without an explicit assessment is not an
 * approval.
 */
export function parseReviewVerdict(output: string): Exclude<ReviewVerdict, "pending" | "none" | "cap"> | undefined {
  const delivery = ReviewReport.extract([output])
  if (delivery.ok) return delivery.report.assessment
  if (delivery.failure.reason !== "missing") return undefined

  const lines = output.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = cleanAssessmentLine(lines[index] ?? "")
    const verdict = verdictFromText(line) ?? verdictFromText(`${line} ${cleanAssessmentLine(lines[index + 1] ?? "")}`)
    if (verdict) return verdict
  }
  return undefined
}

function messageRole(message: ReviewHistoryMessage) {
  return message.info?.role ?? message.role
}

function isSyntheticUser(message: ReviewHistoryMessage) {
  return (
    messageRole(message) === "user" &&
    message.parts.length > 0 &&
    message.parts.every((part) => part.synthetic === true)
  )
}

function inputRecord(part: ReviewHistoryPart) {
  return isRecord(part.state?.input) ? part.state.input : undefined
}

function isReviewTask(part: ReviewHistoryPart) {
  return part.type === "tool" && part.tool === "task" && inputRecord(part)?.subagent_type === "review"
}

/**
 * Whether this review ran - and so delivers its verdict - in the parent's own
 * turn, as opposed to being handed to the background registry.
 *
 * The mode the tool recorded on its result decides, because the mode the caller
 * *asked for* stopped being a reliable record of it: synchronous execution is a
 * per-agent opt-in, so a `background: false` request can come back as a launch,
 * and a caller who said nothing can get a foreground run. `background: false` in
 * the input and `background: true` on the metadata therefore describe the same
 * call from two sides, and only the second one is the outcome. The flag is also
 * what a promotion leaves behind - `BackgroundJob.promote` sets it when a wait
 * that started in the foreground is detached mid-run - so a lost wait reads as
 * what it is: no verdict here.
 *
 * A transcript from before the field existed carries no recorded mode at all. For
 * those the request is the only record, and it was a faithful one: the tool
 * waited exactly when it was told to, so `background: false` in the input means a
 * delivered review, and anything else means it was never meant to be counted.
 */
function isForegroundReviewTask(part: ReviewHistoryPart) {
  if (!isReviewTask(part)) return false
  const metadata = isRecord(part.state?.metadata) ? part.state.metadata : undefined
  if (typeof metadata?.background === "boolean") return !metadata.background
  return inputRecord(part)?.background === false
}

function taskTerminationReason(part: ReviewHistoryPart) {
  const metadata = isRecord(part.state?.metadata) ? part.state.metadata : undefined
  const termination = isRecord(metadata?.termination) ? metadata.termination : undefined
  return typeof termination?.reason === "string" ? termination.reason : undefined
}

/**
 * A cancelled subagent delivered no review. The tool reports the cancellation as
 * a completed part carrying the typed reason, so without this the evaluator
 * counts a cancellation as a delivered review — and a few of them walk the turn
 * to the iteration cap and disable the review gate entirely.
 */
/**
 * A review task that delivered no verdict for this turn: a cancelled subagent, or a
 * yielded one (`waiting_for_subagent`). Neither counts toward the cap, and a yielded
 * report is provisional, so counting it would let an unfinished review satisfy the gate.
 */
function isUnreportedReviewTask(part: ReviewHistoryPart) {
  if (!isForegroundReviewTask(part)) return false
  if (part.state?.status === "cancelled") return true
  const reason = taskTerminationReason(part)
  return reason === "cancelled" || reason === "waiting_for_subagent"
}

/** The persisted `reviewLoop` declaration on a part, from either metadata slot. */
function reviewLoopDeclaration(part: ReviewHistoryPart) {
  const metadata = {
    ...(isRecord(part.metadata) ? part.metadata : {}),
    ...(isRecord(part.state?.metadata) ? part.state.metadata : {}),
  }
  const reviewLoop = metadata[REVIEW_LOOP_METADATA]
  return isRecord(reviewLoop) ? reviewLoop : undefined
}

/**
 * True when a part declares that it wrote files. Tool parts must have
 * completed; the marker also lives on non-tool parts (a background task
 * notification carrying its child's delegated writes), where any occurrence
 * counts. The declaration lives on the tool definition or is propagated by the
 * task tool, so a new file-writing surface is classified where it is defined.
 */
export function declaresFileWrites(part: ReviewHistoryPart) {
  const declared = reviewLoopDeclaration(part)?.writesFiles === true
  if (!declared) return false
  if (part.type !== "tool") return true
  // Errored and still-running tools count: their writes may already be on disk.
  return part.state?.status === "completed" || part.state?.status === "error" || part.state?.status === "running"
}

/** Name kept for callers that predate the effort policy; same relation as `declaresFileWrites`. */
export function hasFileWrites(part: ReviewHistoryPart) {
  return declaresFileWrites(part)
}

/**
 * Work that invalidates a review: a completed file-writing tool, a delegated
 * non-review child task that wrote files, or a background notification
 * carrying its child's delegated writes. Finish and review dispatches are not
 * work.
 */
function isMutatingPart(part: ReviewHistoryPart) {
  if (part.type !== "tool") return declaresFileWrites(part)
  if (typeof part.tool !== "string") return false
  if (part.tool === "finish" || isReviewTask(part)) return false
  return declaresFileWrites(part)
}

function finishReviewMetadata(part: ReviewHistoryPart) {
  if (part.type !== "tool" || part.tool !== "finish") return undefined
  const metadata = isRecord(part.state?.metadata) ? part.state.metadata : undefined
  return isRecord(metadata?.review) ? metadata.review : undefined
}

/**
 * The task tool attaches the delivered review report to the task result
 * metadata. Prefer it over the output text: a long review's output can be
 * truncated in the parent's history, which could cut the envelope or the
 * prose assessment while the report itself survives in metadata.
 */
function reviewReportFromMetadata(part: ReviewHistoryPart) {
  if (part.type !== "tool" || part.tool !== "task") return undefined
  const metadata = isRecord(part.state?.metadata) ? part.state.metadata : undefined
  const review = isRecord(metadata?.review) ? metadata.review : undefined
  const report = isRecord(review?.report) ? review.report : undefined
  if (report?.version !== 1) return undefined
  if (report.assessment !== "approved" && report.assessment !== "needs-fixes") return undefined
  return report
}

function reviewReportVerdict(part: ReviewHistoryPart): "approved" | "needs-fixes" | undefined {
  const assessment = reviewReportFromMetadata(part)?.assessment
  return assessment === "approved" || assessment === "needs-fixes" ? assessment : undefined
}

/** Findings of the most recent completed valid review, envelope or metadata. */
function reviewFindings(part: ReviewHistoryPart): readonly unknown[] {
  const report = reviewReportFromMetadata(part)
  if (report) return Array.isArray(report.findings) ? report.findings : []
  const output = part.state?.output
  if (typeof output !== "string") return []
  const delivery = ReviewReport.extract([output])
  return delivery.ok ? delivery.report.findings : []
}

function finishTermination(part: ReviewHistoryPart): ReviewTermination | undefined {
  if (part.state?.status !== "completed") return undefined
  const termination = finishReviewMetadata(part)?.termination
  if (
    termination === "approved" ||
    termination === "budget-exhausted" ||
    termination === "review-cap" ||
    termination === "review-unavailable" ||
    termination === "review-blocked" ||
    termination === "review-pending" ||
    termination === "skipped"
  )
    return termination
  return undefined
}

function isFinishNudge(part: ReviewHistoryPart) {
  return part.state?.status === "error" && finishReviewMetadata(part)?.nudged === true
}

/** The pass budget the verdict's `cap` state is derived from. */
function passBudget(options: number | ReviewLoopOptions | undefined) {
  if (typeof options === "number" || options === undefined) {
    const max = options ?? 5
    return Number.isFinite(max) && max > 0 ? max : 1
  }
  if (options.effort === undefined) {
    const max = options.maxIterations ?? 5
    return Number.isFinite(max) && max > 0 ? max : 1
  }
  // fast performs no required passes and thorough is until-clean: neither has a
  // finite cap. Medium is the bounded interactive level: two review passes.
  return options.effort === "medium" ? 2 : Number.POSITIVE_INFINITY
}

/**
 * Evaluate the current user turn. Synthetic continuation messages are deliberately
 * ignored as turn boundaries so a review/fix cycle cannot reset its counter.
 * Only completed parts whose persisted metadata explicitly declares `writesFiles`
 * count as work that requires review — direct file-writing tools and delegated
 * child writes alike.
 *
 * Passing `effort` (or an options object) switches the pass budget to the
 * two-switch policy: medium caps at two passes, fast and thorough are uncapped
 * in this evaluator, and the configured legacy `maxIterations` no longer
 * overrides the dial. The numeric second argument keeps legacy callers
 * (including the TUI footer) on the five-pass default.
 */
export function reviewLoopState(
  messages: readonly ReviewHistoryMessage[],
  options?: number | ReviewLoopOptions,
): ReviewLoopState {
  const max = passBudget(options)
  const start = messages.findLastIndex((message) => messageRole(message) === "user" && !isSyntheticUser(message))
  const current = start < 0 ? messages : messages.slice(start + 1)

  let reviews = 0
  let workSeen = false
  let workSinceReview = false
  let reviewInProgress = false
  let nudged = false
  let latest: Exclude<ReviewVerdict, "pending" | "none" | "cap"> | undefined
  let lastReviewVerdict: "approved" | "needs-fixes" | undefined
  let approvedOnRecord = false
  let openFindings = 0
  let blockingFindings = 0
  let termination: ReviewTermination | undefined

  for (const part of current.flatMap((message) => message.parts)) {
    if (isReviewTask(part)) {
      if (!isForegroundReviewTask(part)) continue
      // A cancelled or yielded review is a non-event: it never delivered a
      // verdict, so it neither counts toward the cap nor disturbs the verdict
      // already on record.
      if (isUnreportedReviewTask(part)) continue

      // A failed dispatch is an attempt toward the cap. It is not a verdict and
      // approves nothing; it clears the work so that reaching the cap can end the
      // requirement honestly (never as an approval).
      if (part.state?.status === "error") {
        reviews++
        // An approval covers only the tree it reviewed. If work landed after it and
        // a review attempt then errored, the errored attempt clears the work flag, so
        // the approval must be dropped here or it would revive as "approved".
        if (workSinceReview && lastReviewVerdict === "approved") lastReviewVerdict = undefined
        latest = undefined
        workSinceReview = false
        reviewInProgress = false
        nudged = false
        termination = undefined
        continue
      }

      if (part.state?.status !== "completed") {
        latest = undefined
        workSinceReview = true
        reviewInProgress = part.state?.status === "pending" || part.state?.status === "running"
        nudged = false
        termination = undefined
        continue
      }

      // Reaching here means the verdict landed in this turn: a part that was
      // routed to the background, or promoted out of a wait mid-run, recorded
      // `background: true` and was excluded above. Counting one of those would
      // advance the review cap and clear `workSinceReview` with no reviewer ever
      // having seen the work - the failure this file already refuses for cancelled
      // reviews.
      const verdict =
        reviewReportVerdict(part) ?? parseReviewVerdict(typeof part.state.output === "string" ? part.state.output : "")
      // A completed run without a readable verdict is a malformed attempt: it counts
      // toward the cap, but it is never a verdict and never an approval.
      reviews++
      // Marker precedence before acceptance: a review run that wrote files hands
      // those writes back unreviewed (`reviewLoop.writesFiles` on its task part).
      // An Approved report cannot count for the child's edits, so they stand as
      // work since this review and the gate stays armed until a review covers them.
      const handedOffWrites = hasFileWrites(part)
      if (handedOffWrites) workSeen = true
      reviewInProgress = false
      nudged = false
      termination = undefined
      if (!verdict) {
        latest = undefined
        workSinceReview = workSinceReview || handedOffWrites
        continue
      }

      latest = verdict
      lastReviewVerdict = verdict
      if (verdict === "approved") approvedOnRecord = true
      const findings = reviewFindings(part)
      openFindings = findings.length
      blockingFindings = findings.filter(
        (finding) => isRecord(finding) && (finding.severity === "critical" || finding.severity === "important"),
      ).length
      if (verdict === "needs-fixes" && openFindings === 0) blockingFindings = Math.max(blockingFindings, 1)
      workSinceReview = handedOffWrites
    }

    if (isFinishNudge(part)) {
      nudged = true
      continue
    }

    const partTermination = finishTermination(part)
    if (partTermination) {
      termination = partTermination
      continue
    }

    if (isMutatingPart(part)) {
      workSeen = true
      workSinceReview = true
      reviewInProgress = false
      nudged = false
      latest = undefined
      termination = undefined
    }
  }

  let verdict: ReviewVerdict
  if (!workSeen) verdict = "none"
  else if (!workSinceReview && latest === "approved") verdict = "approved"
  else if (!workSinceReview && reviews >= max) verdict = "cap"
  else if (latest === "needs-fixes") verdict = "needs-fixes"
  else verdict = "pending"

  const phase: ReviewPhase =
    reviewInProgress || verdict === "approved" || verdict === "cap" || (!workSinceReview && verdict === "pending")
      ? "review"
      : "work"

  return {
    verdict,
    reviews,
    maxIterations: max,
    workSinceReview,
    reviewInProgress,
    nudged,
    phase,
    workSeen,
    openFindings,
    blockingFindings,
    stale: approvedOnRecord && workSinceReview,
    ...(lastReviewVerdict ? { lastReviewVerdict } : {}),
    ...(termination ? { termination } : {}),
  }
}

// The dispatch the model has to make, spelled the way the task tool takes it.
const REVIEW_DISPATCH =
  'call the `task` tool with `subagent_type: "review"` and `background: false`, and give it the request, the changed files, and the diff for this work'

/**
 * Decide whether a `finish` call is declined because the current work is not approved.
 *
 * Every `finish` for unapproved file-writing work is declined, not only the first one: a
 * retry, or any account of the work in the finish result, cannot stand in for a review.
 * This helper is the strict legacy relation; the effort policy (`EffortPolicy.evaluateFinish`)
 * is the production checkpoint and owns the fast/medium/thorough differences.
 */
export function finishGateError(state: ReviewLoopState): Error | undefined {
  if (state.verdict !== "pending" && state.verdict !== "needs-fixes") return undefined
  const declined = state.nudged
    ? "Review required: finish declined again, because retrying finish does not skip review."
    : "Review required: finish declined."
  const status =
    state.verdict === "needs-fixes"
      ? "The latest report from the Review subagent returned Needs fixes, so the current work is not approved. Fix the findings, then run the Review subagent again:"
      : "The current work changed files and has no explicit Approved review from the Review subagent. Run the Review subagent now:"
  return new Error(
    `${declined} ${status} ${REVIEW_DISPATCH}. Call finish after it returns Approved; if it returns Needs fixes, fix the findings and review again. Calling finish again without that review is declined again, and calling the work creative, a prototype, trivial, or not production code does not exempt it.`,
  )
}
