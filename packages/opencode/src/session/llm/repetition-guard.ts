import { LLMEvent } from "@opencode-ai/llm"
import { isRecord } from "@/util/record"
import { Effect, Stream } from "effect"

// SessionRetry.retryable excludes messages with this prefix, so a tripped
// guard is never retried (retrying would replay the same looping stream).
export const REPETITION_MESSAGE = "Repetitive generation detected"

// Issue #94 defaults. Lines shorter than MIN_LINE_CHARS are too generic to
// identify a loop, and fragments shorter than MIN_UNIT_CHARS are almost
// always legitimate prose rhythm.
export const DEFAULT_LINE_REPEATS = 5
export const MIN_LINE_CHARS = 20
export const DEFAULT_UNIT_REPEATS = 3
export const MIN_UNIT_CHARS = 50

// Fragment-rule history: the last TAIL_CHARS characters of the current
// unfenced region, kept as delta segments and joined only at a checkpoint.
// The largest confirmable unit is (TAIL_CHARS - MIN_UNIT_CHARS) /
// (unitRepeats - 1) — about 4 KB at the defaults; longer units are left to
// the generation-length cap (issue #89), which bounds retention.
const TAIL_CHARS = 8192
const CHECK_EVERY_CHARS = 256
// Character comparisons one checkpoint may spend on the periodicity scan:
// a hard bound for adversarial text. Real loops (measured up to the 4 KB
// ceiling) need far fewer; a loop whose confirmation would need more is
// left to the generation-length cap, like units beyond the ceiling.
const MAX_CHECK_COMPARISONS = 16 * TAIL_CHARS
// Error-message preview length for a repeated line.
const PREVIEW_CHARS = 80

// Markdown fence markers open and close code blocks on their own line.
const FENCE = /^\s*(```|~~~)/
// A line prefix that could still become a fence line: leading whitespace
// and at most two marker characters.
const FENCE_PENDING = /^\s*([`~]{0,2})?$/
// Separator art and brace walls repeat without carrying content.
const ALPHANUMERIC = /[a-z0-9]/i
const NON_WHITESPACE = /\S/

export type Thresholds = {
  /** Consecutive identical significant lines that trip the guard. 0 disables. */
  readonly lineRepeats: number
  /** Consecutive repetitions of one MIN_UNIT_CHARS+ fragment that trip the guard. 0 disables. */
  readonly unitRepeats: number
}

export function resolveThresholds(input: { lineRepeats?: number; unitRepeats?: number }): Thresholds {
  return {
    lineRepeats: input.lineRepeats === undefined ? DEFAULT_LINE_REPEATS : input.lineRepeats,
    unitRepeats: input.unitRepeats === undefined ? DEFAULT_UNIT_REPEATS : input.unitRepeats,
  }
}

export class RepetitionDetectedError extends Error {
  override readonly name = "RepetitionDetectedError"
  constructor(readonly detail: string) {
    super(`${REPETITION_MESSAGE}: ${detail}`)
  }
}

// Stable identity for a tripped guard on the persisted assistant message.
// MessageV2.fromError records this marker in UnknownError.data.ref; the error
// keeps its name and message text, so every existing renderer and the retry
// exclusion see exactly what they saw before. Recovery reads the marker instead
// of matching REPETITION_MESSAGE, because a provider HTTP error can quote the
// guard text while being a different failure entirely (issue #738).
export const ERROR_REF = "repetition-guard"

/** True when a persisted `Assistant["error"]` is the harness's own guard abort. */
export function isStoredError(error: unknown): boolean {
  return isRecord(error) && error.name === "UnknownError" && isRecord(error.data) && error.data.ref === ERROR_REF
}

type GuardOptions = {
  readonly thresholds: Thresholds
}

function preview(text: string) {
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}…`
}

// Length of the unit whose verbatim repetition ends `tail` — `repeats -
// 1` complete consecutive copies visible plus MIN_UNIT_CHARS of the
// repeats-th — or undefined. Lengths are tried shortest first with one
// backward early-exit comparison each: the evidence is len-periodicity
// over the tail's final (repeats - 1) * len + MIN_UNIT_CHARS characters,
// and a wrong length almost always mismatches immediately. The shortest
// confirming length is the minimal period, so a unit containing its own
// text again cannot be confirmed at a shorter cut; if it carries no
// alphanumeric the loop is contentless art and the scan stops for this
// checkpoint (longer confirmations are multiples of the same period).
// Each checkpoint spends at most MAX_CHECK_COMPARISONS comparisons, so
// adversarial text cannot make the scan unbounded.
function repeatedUnitLength(tail: string, repeats: number): number | undefined {
  const maxUnit = Math.floor((tail.length - MIN_UNIT_CHARS) / (repeats - 1))
  let budget = MAX_CHECK_COMPARISONS
  for (let len = MIN_UNIT_CHARS; len <= maxUnit; len++) {
    const span = Math.min((repeats - 1) * len + MIN_UNIT_CHARS, tail.length - len)
    let i = 0
    while (i < span && tail.charCodeAt(tail.length - 1 - i) === tail.charCodeAt(tail.length - 1 - i - len)) i++
    budget -= i + 1
    // Out of budget: this checkpoint gives up. A persistent loop is
    // re-examined at the next checkpoint as more of it streams.
    if (budget < 0) return undefined
    if (i < span) continue
    if (ALPHANUMERIC.test(tail.slice(-len))) return len
    return undefined
  }
  return undefined
}

// Detects a model stuck regenerating the same text without reaching a
// tool call (issue #94): identical lines, or one fragment verbatim, while
// the harness pays for every token. Both rules are scoped to a single
// text part and suppressed inside fenced code blocks (fenced rows are
// legitimate; the generation-length cap bounds them). Fences are decided
// by one machine over the line under construction: a line's leading
// characters are held back from the fragment tail until they settle
// whether it is a fence line — so an opener never reaches the tail even
// before its newline arrives — and every fence boundary resets the tail.
export function guard<E, R>(
  self: Stream.Stream<LLMEvent, E, R>,
  options: GuardOptions,
): Stream.Stream<LLMEvent, E | RepetitionDetectedError, R> {
  return Stream.suspend(() => {
    // A single occurrence is not repetition: values below 2 disable a
    // rule instead of tripping on the first significant line.
    const lineRule = options.thresholds.lineRepeats >= 2 ? options.thresholds.lineRepeats : undefined
    const unitRule = options.thresholds.unitRepeats >= 2 ? options.thresholds.unitRepeats : undefined

    let previousLine: string | undefined
    let runCount = 0
    let fenced = false
    let lineParts: string[] = []
    let tail: string[] = []
    let sinceCheck = 0
    // Fence state of the line under construction: "pending" can still
    // become a fence line (its prefix is held back), "fence" feeds
    // nothing, "plain" feeds everything.
    let lineFence: "pending" | "fence" | "plain" = "pending"
    let held = ""

    const resetRun = () => {
      previousLine = undefined
      runCount = 0
    }
    const resetUnit = () => {
      tail = []
      sinceCheck = 0
    }
    const resetLine = () => {
      lineParts = []
      lineFence = "pending"
      held = ""
    }

    // Retains one unfenced segment; checks the tail every CHECK_EVERY_CHARS.
    const feed = (segment: string): string | undefined => {
      if (unitRule === undefined) return undefined
      tail.push(segment)
      sinceCheck += segment.length
      if (sinceCheck < CHECK_EVERY_CHARS) return undefined
      sinceCheck = 0
      const text = tail.join("").slice(-TAIL_CHARS)
      tail = [text]
      const len = repeatedUnitLength(text, unitRule)
      if (len === undefined) return undefined
      return (
        `the model streamed the same ${len}-character fragment ${unitRule} times in a row without making progress. ` +
        `Aborted the stream instead of paying for more of the same; retry or rephrase the prompt. ` +
        `(Override with OPENCODE_EXPERIMENTAL_REPETITION_UNITS.)`
      )
    }

    // Consumes the completed line: toggles fences, feeds the separator
    // (plus anything held back while the fence question was open) to the
    // fragment tail, and walks the identical-line run. Blank lines are
    // transparent: paragraph breaks do not reset a run.
    const onLineComplete = (): string | undefined => {
      const isFence = lineFence === "fence"
      const late = lineFence === "pending" ? held : ""
      const line = lineParts.join("")
      resetLine()
      if (isFence) {
        // A fence boundary starts a fresh tail in both directions.
        fenced = !fenced
        resetRun()
        resetUnit()
        return undefined
      }
      // Fenced content breaks the run: repetition that resumes after a
      // code block is not consecutive.
      if (fenced) {
        resetRun()
        return undefined
      }
      if (lineRule !== undefined && NON_WHITESPACE.test(line)) {
        // Identity is exact: the whole previous significant line.
        if (line === previousLine) runCount += 1
        else {
          previousLine = line
          runCount = 1
        }
        if (runCount >= lineRule && line.length >= MIN_LINE_CHARS && ALPHANUMERIC.test(line))
          return (
            `the model streamed the same line ("${preview(line)}") ${runCount} times in a row without reaching a tool call. ` +
            `Aborted the stream instead of paying for more of the same; retry or rephrase the prompt. ` +
            `(Override with OPENCODE_EXPERIMENTAL_REPETITION_LINES.)`
          )
      }
      return feed(late + "\n")
    }

    // Streams one text delta through both rules. Fence state settles as
    // the line's opening characters arrive — inside a fenced block too,
    // where it recognizes the closer — and a segment is fed only if it
    // belongs to the unfenced region.
    const onText = (text: string): string | undefined => {
      const pieces = text.split("\n")
      for (let i = 0; i < pieces.length; i++) {
        if (i > 0) {
          const detail = onLineComplete()
          if (detail) return detail
        }
        const piece = pieces[i]
        lineParts.push(piece)
        if (lineFence === "pending") {
          const candidate = held + piece
          if (FENCE.test(candidate)) {
            // A fence line's bytes (info string included) never reach the
            // fragment tail, newline or not.
            held = ""
            lineFence = "fence"
          } else if (FENCE_PENDING.test(candidate)) {
            held = candidate
          } else {
            held = ""
            lineFence = "plain"
            if (!fenced) {
              const detail = feed(candidate)
              if (detail) return detail
            }
          }
          continue
        }
        if (lineFence === "plain" && !fenced) {
          const detail = feed(piece)
          if (detail) return detail
        }
      }
      return undefined
    }

    const inspect = (event: LLMEvent): string | undefined => {
      if (LLMEvent.is.textStart(event)) {
        resetRun()
        resetUnit()
        resetLine()
        fenced = false
        return undefined
      }
      if (!LLMEvent.is.textDelta(event)) return undefined
      return onText(event.text)
    }

    return self.pipe(
      Stream.mapEffect((event) => {
        const detail = inspect(event)
        if (detail === undefined) return Effect.succeed(event)
        return Effect.fail(new RepetitionDetectedError(detail))
      }),
    )
  })
}

export * as RepetitionGuard from "./repetition-guard"
