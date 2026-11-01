import { ReviewReport } from "@opencode-ai/core/review-report"
import { Agent } from "@opencode-ai/schema/agent"
import type { AssistantMessage, Part, TextPart } from "@opencode-ai/sdk/v2"

/** A presentation candidate, not evidence that the review run passed its finish gate. */
export function reviewText(message: AssistantMessage, parts: readonly Part[]) {
  if (Agent.canonicalID(message.agent) !== "review" || message.time.completed === undefined || message.error)
    return undefined
  const text = parts.filter((part): part is TextPart => part.type === "text" && !part.ignored && !part.synthetic)
  if (!text.length) return undefined
  const chunks = text.map((part) => part.text)
  const joined = joinSplitTags(chunks)
  // Examples in fenced code and blockquotes are not protocol deliveries. On
  // ambiguity retain the original Markdown rather than manufacture a verdict.
  if (hasQuotedTag(joined)) return undefined
  const delivery = ReviewReport.extract([joined])
  if (!delivery.ok) return undefined
  return { report: delivery.report, analysis: delivery.analysis, textPartIDs: text.map((part) => part.id) }
}

// The canonical extractor separates independent parts with newlines. A tag can
// itself be split by streaming/part boundaries; only remove that separator when
// the two sides together spell a complete protocol tag.
function joinSplitTags(chunks: string[]) {
  // Pick a delimiter absent from the source so no user text is lost.
  let separator = "\u0000"
  while (chunks.some((chunk) => chunk.includes(separator))) separator += "\u0000"
  const tags = ReviewReport.TAGS.flatMap((tag) => [`<${tag}>`, `</${tag}>`])
  let joined = chunks.join(separator)
  for (const tag of tags) {
    const pattern = tag.split("").map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(`(?:${separator})*`)
    joined = joined.replace(new RegExp(pattern, "g"), tag)
  }
  return joined.split(separator).join("\n")
}

function hasQuotedTag(text: string) {
  let fence: { marker: string; length: number } | undefined
  for (const line of text.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.length) fence = undefined
    }
    for (const tag of ReviewReport.TAGS) {
      let start = line.indexOf(`<${tag}>`)
      while (start >= 0) {
        if (fence || /^\s*>/.test(line)) return true
        // Be conservative with inline code spans too. Do not turn an example
        // into an approval when a reviewer is discussing the wire format.
        if ((line.slice(0, start).match(/(?<!\\)`+/g) ?? []).length % 2 === 1) return true
        start = line.indexOf(`<${tag}>`, start + tag.length + 2)
      }
    }
  }
  return false
}
