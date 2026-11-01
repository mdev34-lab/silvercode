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
  // These parts still have an ordinary transcript rendering path. Do not put a
  // structured verdict next to excluded protocol-looking text, including a
  // truncated candidate; retain all of it on the existing Markdown path.
  if (parts.some((part) =>
    part.type === "text" && (part.ignored || part.synthetic) &&
    ReviewReport.TAGS.some((tag) => part.text.includes(`<${tag}`) || part.text.includes(`</${tag}`)),
  )) return undefined
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
  // Match the entire shape emitted by task.renderOutput. A matching prefix or
  // first result is not enough: extra results, inconsistent termination, a
  // missing closing task, and trailing content must never become a verdict.
  const envelope = output.match(/^<task id="([^"\n]+)"(?: run="[^"\n]+")? state="completed">\n(?:<summary>([^\n]*)<\/summary>\n)?<task_result>\n([\s\S]*?)\n<\/task_result>\n<termination reason="success"><\/termination>\n<\/task>$/)
  if (!envelope || envelope[1] !== session) return undefined
  const body = envelope[3]
  // Runtime task bodies are free text, so ambiguous embedded wrapper tags are
  // not safely distinguishable from a second envelope. Keep the fallback.
  if (!body || /<\/?(?:task|task_result|task_error|summary|termination)(?:\s|>)/.test(body) || hasQuotedTag(body)) return undefined
  const delivery = ReviewReport.extract([body])
  if (!delivery.ok) return undefined
  const metadataReport = Option.getOrUndefined(Schema.decodeUnknownOption(ReviewReport.Info)(source.report))
  if (!metadataReport || JSON.stringify(metadataReport) !== JSON.stringify(delivery.report)) return undefined
  if (source.revision !== delivery.report.revision) return undefined
  const analysis = reviewPresentationAnalysis(delivery.analysis)
  if (analysis === undefined) return undefined
  return { report: delivery.report, analysis }
}

/**
 * A background receipt is not reviewer identity. A caller may use this only
 * after it has established that the supplied transcript is complete; otherwise
 * an unseen launch or receipt could make an apparent match ambiguous.
 */
export function backgroundReview(input: {
  receipt: TextPart
  messages: readonly import("@opencode-ai/sdk/v2").Message[]
  parts: Readonly<Record<string, readonly Part[] | undefined>>
  sessions: readonly import("@opencode-ai/sdk/v2").Session[]
  complete: boolean
}) {
  if (!input.complete || !input.receipt.synthetic) return undefined
  const { receipt, messages, parts, sessions } = input
  if (messages.some((message) => !parts[message.id])) return undefined
  const owner = messages.find((message) => message.id === receipt.messageID)
  if (!owner || owner.role !== "user" || owner.sessionID !== receipt.sessionID) return undefined
  const envelope = receipt.text.match(/^<task id="([^"\n]+)" run="([^"\n]+)" state="completed">\n(?:<summary>([^\n]*)<\/summary>\n)?<task_result>\n([\s\S]*?)\n<\/task_result>\n<termination reason="success"><\/termination>\n<\/task>$/)
  if (!envelope) return undefined
  const [, childID, run, , body] = envelope
  if (!run.startsWith(`${childID}@`) || !/^\d+$/.test(run.slice(childID.length + 1))) return undefined
  const child = sessions.filter((session) => session.id === childID)
  if (child.length !== 1 || child[0].parentID !== receipt.sessionID || !child[0].agent || Agent.canonicalID(child[0].agent) !== "review") return undefined
  const launches = messages.flatMap((message) => (parts[message.id] ?? []).flatMap((part) => {
    if (part.type !== "tool" || part.tool !== "task" || part.state.status !== "completed") return []
    return part.state.metadata?.runId === run ? [{ message, part }] : []
  }))
  if (launches.length !== 1) return undefined
  const { message, part } = launches[0]
  if (message.role !== "assistant" || message.sessionID !== receipt.sessionID || message.id >= owner.id || part.state.status !== "completed") return undefined
  const metadata = part.state.metadata
  if (metadata?.background !== true || metadata.parentSessionId !== receipt.sessionID || metadata.sessionId !== childID ||
      typeof part.state.input.subagent_type !== "string" || Agent.canonicalID(part.state.input.subagent_type) !== "review") return undefined
  const receipts = messages.flatMap((message) => (parts[message.id] ?? []).filter((candidate) => {
    if (message.role !== "user" || candidate.type !== "text" || !candidate.synthetic) return false
    const open = candidate.text.match(/^<task id="([^"\n]+)" run="([^"\n]+)"(?:\s|>)/)
    return open?.[1] === childID && open[2] === run
  }))
  if (receipts.length !== 1 || receipts[0].id !== receipt.id || receipts[0].type !== "text" || receipts[0].text !== receipt.text) return undefined
  if (!body || /<\/?(?:task|task_result|task_error|summary|termination)(?:\s|>)/.test(body) || hasQuotedTag(body)) return undefined
  const delivery = ReviewReport.extract([body])
  if (!delivery.ok) return undefined
  const analysis = reviewPresentationAnalysis(delivery.analysis)
  return analysis === undefined ? undefined : { report: delivery.report, analysis }
}
