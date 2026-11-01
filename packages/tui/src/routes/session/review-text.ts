import { ReviewReport } from "@opencode-ai/core/review-report"
import { Agent } from "@opencode-ai/schema/agent"
import { Option, Schema } from "effect"
import type { AssistantMessage, Part, TextPart, ToolPart } from "@opencode-ai/sdk/v2"

/** A presentation candidate, not evidence that the review run passed its finish gate. */
export function reviewText(message: AssistantMessage, parts: readonly Part[]) {
  if (Agent.canonicalID(message.agent) !== "review" || message.time.completed === undefined || message.error)
    return undefined
  // A finish in this message can still be declined or declare a non-success;
  // its text must not pre-announce a verdict that the finish did not deliver.
  if (parts.some((part) => {
    if (part.type !== "tool" || part.tool !== "finish") return false
    if (part.state.status !== "completed") return true
    if (part.state.metadata?.waiting === true) return true
    const reason = part.state.input.reason
    return reason !== undefined && reason !== "success"
  })) return undefined
  const text = parts.filter((part): part is TextPart => part.type === "text" && !part.ignored && !part.synthetic)
  if (!text.length) return undefined
  const chunks = text.map((part) => part.text)
  const joined = chunks.join("\n")
  // Examples in fenced code and blockquotes are not protocol deliveries. On
  // ambiguity retain the original Markdown rather than manufacture a verdict.
  if (hasQuotedTag(joined)) return undefined
  const delivery = ReviewReport.extract(chunks)
  if (!delivery.ok) return undefined
  const analysis = reviewPresentationAnalysis(delivery.analysis)
  if (analysis === undefined) return undefined
  return { report: delivery.report, analysis, textPartIDs: text.map((part) => part.id) }
}

function hasQuotedTag(text: string) {
  let fence: { marker: string; length: number } | undefined
  let htmlCode = false
  for (const line of text.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.length) fence = undefined
    }
    if (/<(?:pre|code)(?:\s[^>]*)?>/i.test(line)) htmlCode = true
    for (const tag of ReviewReport.TAGS) {
      let start = line.indexOf(`<${tag}>`)
      while (start >= 0) {
        if (fence || htmlCode || /^\s*>/.test(line) || /^(?: {4}|\t)/.test(line)) return true
        // Be conservative with inline code spans too. Do not turn an example
        // into an approval when a reviewer is discussing the wire format.
        if ((line.slice(0, start).match(/(?<!\\)`+/g) ?? []).length % 2 === 1) return true
        start = line.indexOf(`<${tag}>`, start + tag.length + 2)
      }
    }
    if (/<\/(?:pre|code)\s*>/i.test(line)) htmlCode = false
  }
  return false
}

/** Remove superseded valid envelopes from displayed analysis, retaining the
 * prose around them. If an earlier candidate is ambiguous, keep the ordinary
 * text path rather than hiding it or changing the canonical verdict. */
export function reviewPresentationAnalysis(analysis: string): string | undefined {
  let remaining = analysis
  for (let count = 0; count < 32; count++) {
    if (!ReviewReport.TAGS.some((tag) => remaining.includes(`<${tag}>`))) return remaining
    const previous = ReviewReport.extract([remaining])
    if (!previous.ok || previous.analysis === remaining) return undefined
    remaining = previous.analysis
  }
  return ReviewReport.TAGS.some((tag) => remaining.includes(`<${tag}>`)) ? undefined : remaining
}

/** A foreground task is a Review delivery only when its runtime metadata and
 * complete task output agree on both child identity and canonical report. */
export function subagentReview(part: ToolPart) {
  if (part.tool !== "task" || part.state.status !== "completed") return undefined
  const metadata = part.state.metadata
  const review = metadata?.review
  if (!review || typeof review !== "object" || Array.isArray(review)) return undefined
  const source = review as Record<string, unknown>
  if (source.verdict === "pending" || source.termination === "review-pending") return undefined
  const termination = metadata?.termination
  if (!termination || typeof termination !== "object" || !("reason" in termination) || termination.reason !== "success")
    return undefined
  const session = metadata?.sessionId
  if (typeof session !== "string" || !session || source.sessionId !== session) return undefined
  const inputAgent = part.state.input.subagent_type
  if (typeof inputAgent !== "string" || Agent.canonicalID(inputAgent) !== "review") return undefined
  const output = part.state.output
  const opening = output.match(/^<task id="([^"]+)"(?: run="[^"]+")? state="completed">\n/)
  if (!opening || opening[1] !== session) return undefined
  const body = output.match(/(?:^|\n)<task_result>\n([\s\S]*?)\n<\/task_result>(?:\n|$)/)?.[1]
  if (!body || hasQuotedTag(body)) return undefined
  const delivery = ReviewReport.extract([body])
  if (!delivery.ok) return undefined
  const metadataReport = Option.getOrUndefined(Schema.decodeUnknownOption(ReviewReport.Info)(source.report))
  if (!metadataReport || JSON.stringify(metadataReport) !== JSON.stringify(delivery.report)) return undefined
  if (source.revision !== delivery.report.revision) return undefined
  const analysis = reviewPresentationAnalysis(delivery.analysis)
  if (analysis === undefined) return undefined
  return { report: delivery.report, analysis }
}
