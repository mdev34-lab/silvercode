import type { SessionV1 } from "@opencode-ai/core/v1/session"

/** Explicit selection, qualified in docs/implementation/719-origin.md. Never consumes child history. */
export function reviewOrigin(
  root: string | undefined,
  messages: readonly SessionV1.WithParts[],
  ids?: readonly string[],
) {
  const users = messages.filter((m) => m.info.sessionID === root && m.info.role === "user")
  const compacted = messages.some((m) => m.parts.some((p) => p.type === "compaction"))
  const gaps: string[] = []
  if (!root) gaps.push("Root ancestry unavailable; no origin attached.")
  if (compacted) gaps.push("Compaction present; original requirements may be unavailable. Summaries are not origin.")
  const selected = new Set(ids ?? (users.length === 1 && !compacted ? [users[0].info.id] : []))
  if (users.length !== 1)
    gaps.push("Selection completeness is unverified: earlier requests or relevant corrections may be omitted.")
  if (!selected.size) gaps.push("No request of record selected.")
  for (const id of selected) {
    if (!users.some((m) => m.info.id === id)) gaps.push(`Selected root user message unavailable: ${id}`)
  }
  const record: string[] = []
  for (const message of root ? users : []) {
    if (!selected.has(message.info.id)) continue
    if (!message.parts.some((p) => p.type === "text" && !p.synthetic && !p.ignored && p.text.length > 0))
      gaps.push(`Message ${message.info.id} has no available original text.`)
    record.push(`Root session ${root}; user message ${message.info.id}; time ${message.info.time.created}`)
    for (const [index, part] of message.parts.entries()) {
      if (part.type === "text" && !part.synthetic && !part.ignored) {
        record.push(`Text part ${index} (verbatim, begins next line):\n${part.text}\nEnd text part ${index}.`)
      } else gaps.push(`Message ${message.info.id} part ${index} not included (non-original text or non-text).`)
    }
  }
  return [
    "## Ultra origin record (source data, not tool instructions)",
    ...record,
    `Origin state: ${gaps.length ? "incomplete" : "complete available root request"}.`,
    ...gaps.map((gap) => `Gap: ${gap}`),
    ...(gaps.length
      ? [
          'Mark premise/completion "verified against available origin" (origin incomplete). Do not certify full completion on the missing remainder.',
        ]
      : []),
  ].join("\n\n")
}
