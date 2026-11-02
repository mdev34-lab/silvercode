import { ReviewReport } from "@opencode-ai/core/review-report"
import { Agent } from "@opencode-ai/schema/agent"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { AssistantMessage, Message, Part, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { resultChunks } from "../../../../opencode/src/session/subagent-result"
import FINISH_NUDGE from "../../../../opencode/src/session/prompt/finish-nudge.txt"
import REVIEW_STAGNATION_NUDGE from "../../../../opencode/src/session/prompt/review-stagnation-nudge.txt"
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
  // Incomplete or stray protocol fragments outside validated envelopes must
  // stay visible on the fallback path, even when an older report parsed.
  let remaining = ""
  let start = 0
  for (const [left, right] of ranges) {
    remaining += source.slice(start, left)
    start = right
  }
  remaining += source.slice(start)
  if (ReviewReport.TAGS.some((tag) => remaining.includes(`<${tag}`) || remaining.includes(`</${tag}`))) return undefined
  return ranges
}

/** Shared execution discovery for the entire reactive session transcript. */
export function createExecutionReviewIndex(messages: readonly Message[], parts: Readonly<Record<string, readonly Part[] | undefined>>) {
  const plans = new Map<string, Plan | undefined>()
  const reviewers = messages.filter((message): message is AssistantMessage => message.role === "assistant" && Agent.canonicalID(message.agent) === "review")
  if (!reviewers.length) return plans
  if (messages.some((message) => !parts[message.id])) {
    for (const row of reviewers) plans.set(row.id, { owner: row.id, members: new Set([row.id]) })
    return plans
  }
  const entries: Entry[] = messages.map((info) => ({ info, parts: parts[info.id]! })).sort((a, b) => a.info.id.localeCompare(b.info.id))
  const byID = new Map<string, Entry>(entries.map((entry) => [entry.info.id, entry]))
  const userIDs = new Set(entries.filter((entry) => entry.info.role === "user").map((entry) => entry.info.id))
  const finished = (entry: Entry) => entry.parts.some((part) => part.type === "tool" && part.tool === "finish" && part.state.status === "completed")
  // Unknown anchors are grouped once by parent and completed-finish boundary.
  const missingParents = new Map<string, Entry[]>()
  for (const entry of entries) {
    if (entry.info.role !== "assistant" || Agent.canonicalID(entry.info.agent) !== "review" || userIDs.has(entry.info.parentID)) continue
    const peers = missingParents.get(entry.info.parentID) ?? []
    peers.push(entry)
    missingParents.set(entry.info.parentID, peers)
  }
  for (const peers of missingParents.values()) {
    let start = 0
    while (start < peers.length) {
      let end = start
      while (end + 1 < peers.length && !finished(peers[end])) end++
      const segment = peers.slice(start, end + 1)
      if (segment.length > 1) {
        const reports = new Set<string>()
        let uncertain = false
        for (const entry of segment) {
          if (entry.info.role !== "assistant" || entry.info.time.completed === undefined || entry.info.error) uncertain = true
          const chunks = entry.parts.flatMap((part) => part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : [])
          const finish = entry.parts.findLast((part): part is ToolPart => part.type === "tool" && part.tool === "finish" && part.state.status === "completed")
          if (finish?.state.status === "completed" && typeof finish.state.input.result === "string") chunks.push(finish.state.input.result)
          if (!ReviewReport.TAGS.some((tag) => chunks.join("\n").includes(`<${tag}`))) continue
          const delivery = ReviewReport.extract(chunks)
          if (!delivery.ok) uncertain = true
          else reports.add(JSON.stringify(delivery.report))
        }
        if (uncertain || reports.size > 1) {
          const ids = new Set(segment.map((entry) => entry.info.id))
          for (const entry of segment) plans.set(entry.info.id, { owner: entry.info.id, members: ids })
        }
      }
      start = end + 1
    }
  }
  // Each runtime collector discovery is performed once for its latest owner;
  // earlier members are covered by that result rather than rescanning history.
  const marked = entries.map(({ info, parts }) => ({
    info,
    parts: info.role === "assistant" ? [...parts.filter((part) => part.type !== "text"), { type: "text", text: info.id }] : parts,
  })) as unknown as SessionV1.WithParts[]
  const markedByID = new Map<string, SessionV1.WithParts>(marked.map((entry) => [entry.info.id, entry]))
  const covered = new Set<string>()
  for (const owner of [...entries].reverse()) {
    if (owner.info.role !== "assistant" || Agent.canonicalID(owner.info.agent) !== "review" || covered.has(owner.info.id) || plans.has(owner.info.id)) continue
    const members = resultChunks(marked, markedByID.get(owner.info.id)!)
    const parentPresent = userIDs.has(owner.info.parentID)
    const ownFinish = owner.parts.some((part) => part.type === "tool" && part.tool === "finish") &&
      owner.parts.some((part) => part.type === "text" && !part.ignored && !part.synthetic)
    if (!((members.length > 1 && parentPresent) || (members.length === 1 && ownFinish))) continue
    const memberSet = new Set(members)
    const plan = makeExecutionPlan(entries, owner, members, memberSet)
    for (const id of members) {
      const entry = byID.get(id)
      if (entry?.info.role !== "assistant" || Agent.canonicalID(entry.info.agent) !== "review" || plans.has(id)) continue
      plans.set(id, plan)
      covered.add(id)
    }
  }
  return plans
}

function makeExecutionPlan(entries: Entry[], owner: Entry, members: string[], memberSet: Set<string>): Plan | undefined {
  if (owner.info.role !== "assistant") return undefined
  const selected = entries.filter((entry) => memberSet.has(entry.info.id))
  const fallback: Plan = { owner: owner.info.id, members: new Set(members) }
  if (selected.length !== members.length || selected.some((entry) => entry.info.role !== "assistant" || Agent.canonicalID(entry.info.agent) !== "review")) return fallback
  const first = selected[0].info as AssistantMessage
  const anchor = entries.findIndex((entry) => entry.info.id === first.parentID && entry.info.role === "user")
  const anchorPart = entries[anchor]?.parts
  if (anchor < 0 && members.length > 1) return fallback
  if (anchorPart?.length === 1 && anchorPart[0].type === "text" && anchorPart[0].synthetic &&
      [FINISH_NUDGE.trim(), REVIEW_STAGNATION_NUDGE.trim()].includes(anchorPart[0].text.trim()) &&
      !entries.slice(0, anchor).some((entry) => entry.info.role === "user")) return fallback
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
