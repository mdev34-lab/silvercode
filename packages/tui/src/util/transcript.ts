import type { AssistantMessage, Part, Provider, UserMessage } from "@opencode-ai/sdk/v2"
import { formatGenerationMetrics } from "./generation-metrics"
import { Locale } from "./locale"
import * as Model from "./model"

export type TranscriptOptions = {
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
  providers?: Provider[]
}

export type SessionInfo = {
  id: string
  title: string
  time: {
    created: number
    updated: number
  }
}

export type MessageWithParts = {
  info: UserMessage | AssistantMessage
  parts: Part[]
}

export function transcriptHeader(session: SessionInfo): string {
  let header = `# ${session.title}\n\n`
  header += `**Session ID:** ${session.id}\n`
  header += `**Created:** ${new Date(session.time.created).toLocaleString()}\n`
  header += `**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n`
  header += `---\n\n`
  return header
}

function formatMessages(
  messages: MessageWithParts[],
  options: TranscriptOptions,
  providers: ReadonlyMap<string, Provider>,
): string {
  return messages
    .toSorted((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))
    .map((msg) => `${formatMessage(msg.info, msg.parts, options, providers)}---\n\n`)
    .join("")
}

export function formatTranscript(
  session: SessionInfo,
  messages: MessageWithParts[],
  options: TranscriptOptions,
): string {
  return transcriptHeader(session) + formatMessages(messages, options, Model.index(options.providers))
}

export type TranscriptPage = {
  rows: MessageWithParts[]
  cursor?: string
}

// The complete transcript without holding it all in memory at once: pages are
// read newest-first (`before` walks older) and only their formatted text is
// kept, so an export of a very long session does not materialize every message
// and part in the store or in memory (#815 review).
export async function formatTranscriptPaged(
  session: SessionInfo,
  options: TranscriptOptions,
  page: (before?: string) => Promise<TranscriptPage>,
): Promise<string> {
  const providers = Model.index(options.providers)
  const chunks: string[] = []
  let before: string | undefined
  for (;;) {
    const next = await page(before)
    chunks.push(formatMessages(next.rows, options, providers))
    if (!next.cursor) break
    before = next.cursor
  }
  return transcriptHeader(session) + chunks.toReversed().join("")
}

export function formatMessage(
  msg: UserMessage | AssistantMessage,
  parts: Part[],
  options: TranscriptOptions,
  providers?: Provider[] | ReadonlyMap<string, Provider>,
): string {
  let result = ""

  if (msg.role === "user") {
    result += `## User\n\n`
  } else {
    result += formatAssistantHeader(msg, options.assistantMetadata, providers ?? options.providers)
  }

  for (const part of parts) {
    result += formatPart(part, options)
  }

  return result
}

export function formatAssistantHeader(
  msg: AssistantMessage,
  includeMetadata: boolean,
  providers?: Provider[] | ReadonlyMap<string, Provider>,
): string {
  if (!includeMetadata) {
    return `## Assistant\n\n`
  }

  const duration =
    msg.time.completed && msg.time.created ? ((msg.time.completed - msg.time.created) / 1000).toFixed(1) + "s" : ""

  const modelName = Model.name(providers, msg.providerID, msg.modelID)
  const metrics = formatGenerationMetrics(msg)

  return `## Assistant (${Locale.titlecase(msg.agent)} · ${modelName}${duration ? ` · ${duration}` : ""}${metrics ? ` · ${metrics}` : ""})\n\n`
}

export function formatPart(part: Part, options: TranscriptOptions): string {
  if (part.type === "text" && !part.synthetic) {
    return `${part.text}\n\n`
  }

  if (part.type === "reasoning") {
    if (options.thinking) {
      return `_Thinking:_\n\n${part.text}\n\n`
    }
    return ""
  }

  if (part.type === "tool") {
    let result = `**Tool: ${part.tool}**\n`
    if (options.toolDetails && part.state.input) {
      result += `\n**Input:**\n\`\`\`json\n${JSON.stringify(part.state.input, null, 2)}\n\`\`\`\n`
    }
    if (options.toolDetails && part.state.status === "completed" && part.state.output) {
      result += `\n**Output:**\n\`\`\`\n${part.state.output}\n\`\`\`\n`
    }
    if (options.toolDetails && part.state.status === "error" && part.state.error) {
      result += `\n**Error:**\n\`\`\`\n${part.state.error}\n\`\`\`\n`
    }
    result += `\n`
    return result
  }

  return ""
}
