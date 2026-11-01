import { ReviewReport } from "@opencode-ai/core/review-report"
import { Agent } from "@opencode-ai/schema/agent"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"

/** A presentation candidate, not evidence that the review run passed its finish gate. */
export function reviewText(message: AssistantMessage, parts: readonly Part[]) {
  if (Agent.canonicalID(message.agent) !== "review" || message.time.completed === undefined || message.error)
    return undefined
  const text = parts.filter((part) => part.type === "text" && !part.ignored && !part.synthetic)
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
  const tags = ReviewReport.TAGS.flatMap((tag) => [`<${tag}>`, `</${tag}>`])
  return chunks.reduce((joined, chunk, index) => {
    if (!index) return chunk
    const splitTag = tags.some((tag) =>
      Array.from({ length: tag.length - 1 }, (_, i) => i + 1).some(
        (offset) => joined.endsWith(tag.slice(0, offset)) && chunk.startsWith(tag.slice(offset)),
      ),
    )
    return joined + (splitTag ? "" : "\n") + chunk
  }, "")
}

function hasQuotedTag(text: string) {
  let fence: { marker: string; length: number } | undefined
  for (const line of text.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.length) fence = undefined
    }
    if ((fence || /^\s*>/.test(line)) && ReviewReport.TAGS.some((tag) => line.includes(`<${tag}>`))) return true
  }
  return false
}
