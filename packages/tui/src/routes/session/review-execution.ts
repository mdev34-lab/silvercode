import { ReviewReport } from "@opencode-ai/core/review-report"
import { Agent } from "@opencode-ai/schema/agent"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { AssistantMessage, Message, Part, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { resultChunks } from "../../../../opencode/src/session/subagent-result"
import { hasQuotedTag } from "./review-text"

type Entry = { info: Message; parts: readonly Part[] }
type Plan = {
  owner: string
  members: Set<string>
  prose?: Map<string, string>
  report?: ReviewReport.Info
  raw?: string
  finishID?: string
  finishProse?: string
}

// Locate only complete, individually canonical envelopes. Any ambiguity uses
// the ordinary transcript path rather than hiding or upgrading a candidate.
function envelopeRanges(source: string): [number, number][] | undefined {
  const ranges: [number, number][] = []
  const token = new RegExp(`<(/?)(${ReviewReport.TAGS.join("|")})>`, "g")
  for (;;) {
    const match = token.exec(source)
    if (!match) break
    if (match[1]) return undefined
    let cursor = token.lastIndex
    while (/\s/.test(source[cursor] ?? "") && cursor < source.length) cursor++
    if (source[cursor] !== "{") return undefined
    let depth = 0, quoted = false, escaped = false
    for (; cursor < source.length; cursor++) {
      const char = source[cursor]
      if (escaped) { escaped = false; continue }
      if (quoted && char === "\\") { escaped = true; continue }
      if (char === '"') { quoted = !quoted; continue }
      if (quoted) continue
      if (char === "{" || char === "[") depth++
      if (char === "}" || char === "]") depth--
      if (depth === 0) { cursor++; break }
    }
    if (depth !== 0 || quoted) return undefined
    while (cursor < source.length && /\s/.test(source[cursor])) cursor++
    const close = `</${match[2]}>`
    if (!source.startsWith(close, cursor)) return undefined
    const end = cursor + close.length
    const candidate = ReviewReport.extract([source.slice(match.index, end)])
    if (!candidate.ok || candidate.analysis.trim()) return undefined
    ranges.push([match.index, end])
    token.lastIndex = end
  }
  return ranges
}

/** Uses the runtime collector for identity, ordering, nudges, and finish boundaries. */
export function executionReviewPlan(messages: readonly Message[], parts: Readonly<Record<string, readonly Part[] | undefined>>, current: AssistantMessage): Plan | undefined {
  if (Agent.canonicalID(current.agent) !== "review") return undefined
  if (!messages.some((message) => message.id === current.id) || messages.some((message) => !parts[message.id])) return undefined
  const entries: Entry[] = messages.map((info) => ({ info, parts: parts[info.id]! })).sort((a, b) => a.info.id.localeCompare(b.info.id))
  // Mark assistant messages in a copy, keeping all finish parts intact, so the
  // actual runtime collector tells us which rows belong to the same execution.
  const marked = entries.map(({ info, parts }) => ({
    info,
    parts: info.role === "assistant" ? [...parts.filter((part) => part.type !== "text"), { type: "text", text: info.id }] : parts,
  })) as unknown as SessionV1.WithParts[]
  let owner: Entry | undefined
  let members: string[] = []
  for (const entry of [...entries].reverse()) {
    if (entry.info.role !== "assistant" || Agent.canonicalID(entry.info.agent) !== "review") continue
    const parentID = entry.info.parentID
    if (!entries.some((row) => row.info.role === "user" && row.info.id === parentID)) continue
    const target = marked.find((row) => row.info.id === entry.info.id)!
    const ids = resultChunks(marked, target)
    if (ids.length > 1 && ids.includes(current.id)) { owner = entry; members = ids; break }
  }
  if (!owner || owner.info.role !== "assistant") return undefined
  const selected = entries.filter((entry) => members.includes(entry.info.id))
  if (selected.length !== members.length || selected.some((entry) => entry.info.role !== "assistant" || Agent.canonicalID(entry.info.agent) !== "review")) return undefined
  const fallback: Plan = { owner: owner.info.id, members: new Set(members) }
  const textParts = selected.flatMap((entry) => entry.parts.filter((part): part is TextPart => part.type === "text" && !part.synthetic && !part.ignored))
  const chunks = textParts.map((part) => part.text)
  const finishes = owner.parts.filter((part): part is ToolPart => part.type === "tool" && part.tool === "finish")
  const finish = finishes.at(-1)
  if (selected.some((entry) => entry.info.role !== "assistant" || entry.info.time.completed === undefined || entry.info.error) ||
      finishes.some((part) => part.state.status !== "completed" || part.state.metadata?.waiting === true || (part.state.input.reason !== undefined && part.state.input.reason !== "success"))) return fallback
  if (selected.some((entry) => entry.parts.some((part) => part.type === "text" && (part.ignored || part.synthetic) && ReviewReport.TAGS.some((tag) => part.text.includes(`<${tag}`) || part.text.includes(`</${tag}`))))) return fallback
  const finishText = finish?.state.status === "completed" && typeof finish.state.input.result === "string" ? finish.state.input.result : undefined
  const allChunks = finishText === undefined ? chunks : [...chunks, finishText]
  const joined = allChunks.join("\n")
  if (!ReviewReport.TAGS.some((tag) => joined.includes(`<${tag}`))) return undefined
  if (hasQuotedTag(joined)) return fallback
  // Selection is performed by the same collector and canonical extractor as
  // finish and task delivery, not by the span locator below.
  const runtime = entries as unknown as SessionV1.WithParts[]
  const target = runtime.find((entry) => entry.info.id === owner!.info.id)!
  const canonical = ReviewReport.extract([...resultChunks(runtime, target), finishText])
  if (!canonical.ok) return fallback
  const ranges = envelopeRanges(joined)
  if (!ranges?.length) return fallback
  const prose = new Map<string, string>()
  let offset = 0
  for (const part of textParts) {
    const end = offset + part.text.length
    let at = offset, value = ""
    for (const [start, stop] of ranges) {
      if (stop <= offset || start >= end) continue
      const left = Math.max(offset, start), right = Math.min(end, stop)
      value += joined.slice(at, left)
      at = right
    }
    value += joined.slice(at, end)
    prose.set(part.id, value)
    offset = end + 1
  }
  let finishProse: string | undefined
  if (finishText !== undefined) {
    const end = offset + finishText.length
    let at = offset
    finishProse = ""
    for (const [start, stop] of ranges) {
      if (stop <= offset || start >= end) continue
      const left = Math.max(offset, start), right = Math.min(end, stop)
      finishProse += joined.slice(at, left)
      at = right
    }
    finishProse += joined.slice(at, end)
  }
  return { ...fallback, prose, report: canonical.report, raw: joined, finishID: finish?.id, finishProse }
}
