export * as ReviewReport from "./review-report"

import { Option, Schema } from "effect"

/**
 * The Review subagent delivers its canonical result through a tagged,
 * machine-readable report envelope appended after its human-readable analysis:
 *
 * <silvercode-review>
 * { "version": 1, ... }
 * </silvercode-review>
 *
 * Delivery extracts this envelope from the complete child output instead of
 * trusting the last text part, which a trailing empty text part can erase.
 * When several complete envelopes appear, the last one is canonical by
 * protocol: duplicated structured output is tolerated rather than turned into
 * another delivery failure, and render() normalizes the persisted result back
 * to a single canonical envelope.
 *
 * Envelopes written before the product rename are still recognized, so reports
 * persisted by older sessions — and integrations that still build the old
 * literal — keep parsing instead of failing as missing. Only the canonical tag
 * is ever emitted or advertised.
 */

export const TAG = "silvercode-review"

/** Envelope tags written before the rename that are still accepted; never emitted. */
export const LEGACY_TAGS = ["alphacode-review"] as const

/** Every accepted envelope tag, canonical first. `extract` matches all of them. */
export const TAGS: readonly string[] = [TAG, ...LEGACY_TAGS]

/** Bumped only for breaking envelope changes; older versions are rejected clearly. */
export const VERSION = 1

export const Finding = Schema.Struct({
  severity: Schema.Literals(["critical", "important", "minor"]),
  title: Schema.String,
  file: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Number),
  detail: Schema.optional(Schema.String),
}).annotate({ identifier: "ReviewFinding" })

export const Info = Schema.Struct({
  version: Schema.Literal(VERSION),
  /** The unit boundary that was reviewed: "uncommitted" or "<base>..<head>". */
  revision: Schema.String,
  assessment: Schema.Literals(["approved", "needs-fixes"]),
  summary: Schema.String,
  findings: Schema.Array(Finding),
}).annotate({ identifier: "ReviewReport" })

export type Finding = Schema.Schema.Type<typeof Finding>
export type Info = Schema.Schema.Type<typeof Info>

/** Why a completed review could not be delivered as a parseable report. */
export type Failure =
  | { reason: "missing"; message: string }
  | { reason: "malformed"; message: string }
  | { reason: "schema"; message: string }

export type Delivery = { ok: true; report: Info; analysis: string } | { ok: false; failure: Failure; analysis: string }

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString, { onExcessProperty: "ignore" })
const decodeReport = Schema.decodeUnknownOption(Info, {
  errors: "all",
  onExcessProperty: "ignore",
  propertyOrder: "original",
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const SCHEMA_HINT =
  'expected {"version": 1, "revision": string, "assessment": "approved" | "needs-fixes", "summary": string, "findings": [{"severity": "critical" | "important" | "minor", "title": string, "file"?: string, "line"?: number, "detail"?: string}]}'

/**
 * Extract the canonical review report from the complete child output.
 *
 * Chunks are every text part plus the finish summary, in order, so a trailing
 * empty text part cannot erase a report delivered earlier. When several
 * complete envelopes are present, the last one wins by protocol — models
 * occasionally duplicate a structured block, and accepting the final complete
 * copy is more robust than failing the delivery. The remaining text, including
 * any superseded envelope copies, is returned as the human-readable analysis.
 * A review that completes without a parseable version-1 envelope is a delivery
 * failure, never an empty successful result. A pre-rename envelope is delivered
 * exactly like a canonical one: the last complete envelope wins across tag
 * spellings, so mixed text cannot resolve to a different report than the one
 * the reviewer wrote last.
 */
export function extract(chunks: readonly (string | undefined)[]): Delivery {
  const text = chunks.filter((chunk): chunk is string => typeof chunk === "string").join("\n")
  // Pair only matching tag spellings while allowing an unmatched prose opening
  // before the real report. A tag inside a JSON string is ordinary report data.
  const tokens = new RegExp(`<(/?)(${TAGS.join("|")})>`, "g")
  let pending: { tag: string; start: number; body: number } | undefined
  let last: { index: number; end: number; inner: string } | undefined
  let quotedClose: { index: number; end: number; inner: string } | undefined
  let quoted = false
  let escaped = false
  let json: boolean | undefined
  let cursor = 0
  for (const token of text.matchAll(tokens)) {
    const start = token.index
    if (pending) {
      // Tags inside JSON strings are data, not envelope boundaries.
      for (; cursor < start; cursor++) {
        const char = text[cursor]
        if (json === undefined && !/\s/.test(char)) json = char === "{"
        if (!json) continue
        if (escaped) {
          escaped = false
          continue
        }
        if (quoted && char === "\\") {
          escaped = true
          continue
        }
        if (char === '"') quoted = !quoted
      }
      if (quoted) {
        if (token[1] && pending.tag === token[2])
          quotedClose = { index: pending.start, end: start + token[0].length, inner: text.slice(pending.body, start) }
        continue
      }
    }
    if (!token[1]) {
      // An unmatched prose opening must not consume a later real envelope.
      pending = { tag: token[2], start, body: start + token[0].length }
      quotedClose = undefined
      quoted = false
      escaped = false
      json = undefined
    } else if (pending?.tag === token[2]) {
      last = { index: pending.start, end: start + token[0].length, inner: text.slice(pending.body, start) }
      pending = undefined
      quotedClose = undefined
    }
    cursor = start + token[0].length
  }
  // A closing tag under an unterminated JSON quote still marks a malformed
  // latest report. Never silently revive an older approval in that case.
  if (pending && quotedClose) last = quotedClose
  if (!last) {
    const analysis = text.trim()
    const opened = TAGS.find((tag) => text.includes(`<${tag}>`))
    if (opened !== undefined)
      return {
        ok: false,
        analysis,
        failure: { reason: "malformed", message: `the <${opened}> envelope has an opening tag but no closing tag` },
      }
    return { ok: false, analysis, failure: { reason: "missing", message: `no <${TAG}> report envelope was found` } }
  }

  const start = last.index ?? 0
  const analysis = [text.slice(0, start).trimEnd(), text.slice(last.end).trimStart()]
    .filter((part) => part.length > 0)
    .join("\n\n")

  const inner = last.inner.trim()
  const parsed = Option.getOrUndefined(decodeJson(inner))
  if (!isRecord(parsed))
    return {
      ok: false,
      analysis,
      failure: { reason: "malformed", message: "the envelope content is not a JSON object" },
    }
  if (parsed.version === undefined)
    return {
      ok: false,
      analysis,
      failure: { reason: "malformed", message: 'the report is missing the required "version" field' },
    }
  if (parsed.version !== VERSION)
    return {
      ok: false,
      analysis,
      failure: {
        reason: "schema",
        message: `unknown report schema version ${JSON.stringify(parsed.version)}; this runtime supports version ${VERSION} only`,
      },
    }
  const report = Option.getOrUndefined(decodeReport(parsed))
  if (!report)
    return {
      ok: false,
      analysis,
      failure: {
        reason: "malformed",
        message: `the report does not match the version ${VERSION} review report schema: ${SCHEMA_HINT}`,
      },
    }
  return { ok: true, report, analysis }
}

/** The canonical envelope text for a report, as the reviewer is told to emit it. */
export function envelope(report: Info): string {
  return `<${TAG}>\n${JSON.stringify(report, null, 2)}\n</${TAG}>`
}

/**
 * Render a delivered review as the parent-facing output: the human-readable
 * analysis followed by the re-serialized canonical envelope, so the persisted
 * result always carries exactly one valid report.
 */
export function render(delivery: Extract<Delivery, { ok: true }>): string {
  return [delivery.analysis, envelope(delivery.report)].filter((part) => part.length > 0).join("\n\n")
}

const ANALYSIS_EXCERPT_LIMIT = 1200

/** The explicit parent-facing failure for a review that delivered no report. */
export function failureMessage(input: { sessionID: string; failure: Failure; analysis?: string }): string {
  const preview = input.analysis ? boundedExcerpt(input.analysis) : undefined
  return [
    `Review delivery failed: ${input.failure.message}.`,
    `The review session ${input.sessionID} completed without a parseable <${TAG}> report, so this is not a verdict and carries no approval.`,
    preview ? `Its analysis, preserved here in truncated form: ${preview}` : undefined,
    `Re-dispatch the review to obtain a parseable report.`,
  ]
    .filter((part) => part !== undefined)
    .join(" ")
}

function boundedExcerpt(analysis: string): string {
  const text = analysis.trim()
  return text.length <= ANALYSIS_EXCERPT_LIMIT ? text : `${text.slice(0, ANALYSIS_EXCERPT_LIMIT)}… [truncated]`
}
