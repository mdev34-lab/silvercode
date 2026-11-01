import { AgentEffort } from "@opencode-ai/schema/agent-effort"
import { RGBA } from "@opentui/core"

export type Level = AgentEffort.Level

/** The session metadata key that stores the persisted per-session selection. */
export const METADATA_KEY = "agentEffort"

// Coupled thinking defaults: effort is its own dial, but an untouched
// thinking selector follows the process level when the model offers it.
const COUPLED_THINKING: Record<Level, string> = {
  fast: "low",
  medium: "medium",
  thorough: "high",
}

/** Narrow for the open metadata/config records read from untrusted input. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isLevel(value: unknown): value is Level {
  return AgentEffort.levels.includes(value as Level)
}

/** Cycles fast → medium → thorough → fast for the local effort dial. */
export function nextLevel(level: Level): Level {
  const index = AgentEffort.levels.indexOf(level)
  // The shared resolver is the agreed fallback contract: a valid level always
  // wraps to the next ordered level, and anything else lands on medium.
  return AgentEffort.resolve(AgentEffort.levels[(index + 1) % AgentEffort.levels.length])
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

// Pass counts are meaningful at zero (a fast delivery really did zero
// review passes), unlike finding counts.
function passCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Reads the persisted selection out of an untrusted session metadata record.
 * Metadata is an open record, so only a closed literal is ever accepted and
 * anything else behaves as "no persisted selection".
 */
export function metadataLevel(metadata: unknown): Level | undefined {
  if (!isRecord(metadata)) return undefined
  const raw = metadata[METADATA_KEY]
  return isLevel(raw) ? raw : undefined
}

/**
 * Reads the reserved scalar `agent.effort` configuration setting. Named agent
 * objects are never enumerated here: a non-scalar `effort` entry (a legacy
 * named agent) or any invalid value is ignored rather than trusted.
 */
export function configLevel(config: unknown): Level | undefined {
  if (!isRecord(config)) return undefined
  const agent = config.agent
  if (!isRecord(agent)) return undefined
  const raw = agent.effort
  return isLevel(raw) ? raw : undefined
}

/**
 * Effective level precedence for the TUI: an explicit persisted session
 * selection, then the configured default, then the schema fallback (medium).
 * Invalid or missing values fall through to the next source instead of being
 * trusted, so an unknown session value never masks the configured default.
 */
export function resolveEffort(input: { metadata?: unknown; config?: unknown; fallback?: Level }): Level {
  return metadataLevel(input.metadata) ?? configLevel(input.config) ?? AgentEffort.resolve(undefined, input.fallback)
}

/**
 * The TUI-level default new sessions start from: the selection persisted on
 * home, then the configured `agent.effort`, then the schema fallback. The
 * caller validates whatever it read from disk, so `selected` is already a
 * level or nothing.
 */
export function defaultLevel(input: { selected?: Level; config?: unknown }): Level {
  return input.selected ?? configLevel(input.config) ?? AgentEffort.resolve(undefined)
}

/**
 * A metadata record carrying exactly one persisted selection, used both for
 * the session metadata write and for the TUI's persisted home default.
 */
export function effortRecord(level: Level): Record<string, unknown> {
  return { [METADATA_KEY]: level }
}

/**
 * `session.update` replaces the metadata record wholesale, so every effort
 * write merges over the current record to preserve unrelated keys. A
 * non-record base (missing/corrupted metadata) collapses to the single key.
 */
export function mergeEffortMetadata(current: unknown, level: Level): Record<string, unknown> {
  const base = isRecord(current) ? current : {}
  return { ...base, ...effortRecord(level) }
}

// Effort hues: fast is green, medium is orange, thorough is red. Each level
// keeps two variants so the hue stays legible on both dark and light surfaces
// (the level names are always rendered next to the color, so the levels never
// depend on color alone).
const TONES: Record<Level, { dark: string; light: string }> = {
  fast: { dark: "#3fb950", light: "#116329" },
  medium: { dark: "#f0883e", light: "#9a3412" },
  thorough: { dark: "#f85149", light: "#b3121f" },
}

function luminance(color: RGBA) {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b
}

/**
 * The effort hue for a level, picked for the surface it is drawn on. A
 * transparent surface means the terminal supplies the background, so the
 * theme's text color stands in for it: readable light text implies a dark
 * surface and therefore the bright hue variant.
 */
export function effortColor(level: Level, theme: { background: RGBA; text: RGBA }): RGBA {
  const lightSurface =
    theme.background.a === 0 ? luminance(theme.text) < 0.5 : luminance(theme.background) > 0.5
  return RGBA.fromHex(TONES[level][lightSurface ? "light" : "dark"])
}

/**
 * The level's hue as a filled indicator plus the ink that stays readable on
 * it, for surfaces (like a highlighted selector row) where the surrounding
 * colors are not ours to choose.
 */
export function effortBadge(level: Level, theme: { background: RGBA; text: RGBA }): { fg: RGBA; bg: RGBA } {
  const bg = effortColor(level, theme)
  return { bg, fg: luminance(bg) > 0.5 ? RGBA.fromInts(0, 0, 0) : RGBA.fromInts(255, 255, 255) }
}

/**
 * Coupled thinking default for an effort change. It is only ever a default:
 * it applies when nothing else has chosen a thinking variant for this model
 * (no explicit selector choice, including explicit default/off, and no
 * configured agent/model variant) and the model actually offers the coupled
 * variant. Unsupported combinations return undefined so the model keeps its
 * normal behavior.
 */
export function coupledThinking(input: {
  effort: Level
  variants?: readonly string[]
  chosen?: string | undefined
  configured?: string | undefined
}): string | undefined {
  if (input.chosen !== undefined) return undefined
  if (input.configured !== undefined && input.configured !== "") return undefined
  const wanted = COUPLED_THINKING[input.effort]
  return input.variants?.includes(wanted) ? wanted : undefined
}

export type FinishTone = "success" | "warning" | "text"

export type FinishStatusLine = {
  label: string
  detail?: string
  tone: FinishTone
}

export type FinishStatus = {
  review?: FinishStatusLine
  validation?: FinishStatusLine
}

const TERMINATION_LABELS: Record<string, FinishStatusLine> = {
  approved: { label: "approved", tone: "success" },
  unreviewed: { label: "unreviewed", tone: "warning" },
  "findings-open": { label: "findings open", tone: "warning" },
  "budget-exhausted": { label: "budget exhausted", tone: "warning" },
  // The unavailable label is retained for historical transcripts. Current
  // policy records a declared failure as blocked and a child handoff as pending.
  "review-unavailable": { label: "review unavailable", tone: "warning" },
  "review-blocked": { label: "review blocked", tone: "warning" },
  "review-pending": { label: "review pending", tone: "warning" },
  "not-required": { label: "not required", tone: "text" },
  waiting: { label: "waiting", tone: "text" },
  // Historical transcript labels stay readable for older finish results.
  "review-cap": { label: "cap", tone: "warning" },
  skipped: { label: "skipped", tone: "warning" },
}

function reviewLine(review: Record<string, unknown>): FinishStatusLine | undefined {
  const termination = typeof review.termination === "string" ? review.termination : undefined
  const mapped = termination ? TERMINATION_LABELS[termination] : undefined
  const disposition =
    review.disposition === "reviewed" || review.disposition === "unreviewed" ? review.disposition : undefined
  const verdict = typeof review.verdict === "string" ? review.verdict : undefined

  const label =
    mapped?.label ??
    termination ??
    (disposition === "unreviewed" ? "unreviewed" : disposition) ??
    (verdict === "approved" ? "approved" : verdict)
  if (!label) return undefined
  const tone: FinishTone =
    mapped?.tone ??
    (disposition === "unreviewed" || verdict === "needs-fixes" || verdict === "cap" ? "warning" : "text")

  const detail: string[] = []
  const effort = review.effort
  if (typeof effort === "string" && effort) detail.push(effort)

  const reviews = passCount(review.reviews)
  const maxIterations =
    typeof review.maxIterations === "number" && Number.isFinite(review.maxIterations) && review.maxIterations > 0
      ? review.maxIterations
      : undefined
  // A pass count is never rendered as an infinite budget: thorough results
  // carry a count without a limit instead of serializing Infinity.
  if (reviews !== undefined) {
    detail.push(
      maxIterations !== undefined
        ? `${reviews}/${maxIterations} passes`
        : `${reviews} ${reviews === 1 ? "pass" : "passes"}`,
    )
  } else if (maxIterations !== undefined) {
    detail.push(`max ${maxIterations} passes`)
  }

  const open = finiteCount(review.openFindings)
  const blocking = finiteCount(review.blockingFindings)
  if (open !== undefined) detail.push(blocking !== undefined ? `${open} open, ${blocking} blocking` : `${open} open`)
  else if (blocking !== undefined) detail.push(`${blocking} blocking`)

  if (review.workSinceReview === true || (typeof review.workSinceReview === "number" && review.workSinceReview > 0)) {
    detail.push("stale")
  }

  const reason = review.unavailableReason
  if (typeof reason === "string" && reason.trim()) detail.push(reason.trim())

  return { label, detail: detail.length ? detail.join(" · ") : undefined, tone }
}

function validationLine(validation: Record<string, unknown>): FinishStatusLine {
  const status =
    validation.status === "passed" || validation.status === "failed" || validation.status === "incomplete"
      ? validation.status
      : undefined
  const label = status ? `validation ${status}` : "validation"

  const detail: string[] = []
  const gate = validation.gate
  if (typeof gate === "string" && gate) detail.push(gate)

  // Missing/failed/not-run/unavailable evidence stays visible: only checks
  // that actually reported passing are left out of the summary line.
  const checks = Array.isArray(validation.checks) ? validation.checks : []
  for (const check of checks) {
    if (!isRecord(check)) continue
    if (check.status === "passed") continue
    const category = typeof check.category === "string" && check.category ? check.category : "check"
    detail.push(typeof check.status === "string" && check.status ? `${category}: ${check.status}` : category)
  }

  const tone: FinishTone = status === "passed" ? "success" : status === "failed" ? "warning" : "text"
  return { label, detail: detail.length ? detail.join(" · ") : undefined, tone }
}

/**
 * Honest finish status for the rendered `finish` tool part. Legacy
 * transcripts keep their historical labels, exhaustive/open/stale/unavailable
 * results are never upgraded to approval, and an absent review/validation
 * record returns undefined so old finish rendering stays untouched.
 */
export function finishStatus(metadata: unknown): FinishStatus | undefined {
  if (!isRecord(metadata)) return undefined
  const review = isRecord(metadata.review) ? reviewLine(metadata.review) : undefined
  const validation = isRecord(metadata.validation) ? validationLine(metadata.validation) : undefined
  if (!review && !validation) return undefined
  return { review, validation }
}

/** Renders the honest status as transcript lines beneath the finish summary. */
export function finishStatusLines(status: FinishStatus): string[] {
  const lines: string[] = []
  if (status.review) {
    lines.push(`review: ${status.review.label}${status.review.detail ? ` · ${status.review.detail}` : ""}`)
  }
  if (status.validation) {
    lines.push(`${status.validation.label}${status.validation.detail ? ` · ${status.validation.detail}` : ""}`)
  }
  return lines
}
