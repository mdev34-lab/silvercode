/**
 * Dynamic context reduction for the opencode (v1) session loop.
 *
 * The reduction itself lives in core and works on v2 session messages. This module is the
 * boundary: it views the v1 history as v2 messages, runs the core reduction, and maps the
 * result back onto copies of the v1 messages. Canonical history is never modified; only the copy
 * handed to the model-message lowering changes.
 */
import type { Model } from "@opencode-ai/llm"
import { SessionContextReduction } from "@opencode-ai/core/session/context-reduction"
import type { SessionContext } from "@opencode-ai/schema/session-context"
import type { SessionMessage } from "@opencode-ai/core/session/message"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { WithParts } from "@opencode-ai/core/v1/session"

type Entry = WithParts

const textOf = (parts: readonly { type: string; text?: string }[]) =>
  parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")

/** View one v1 tool state as the v2 state the reduction rungs understand. */
const toolState = (part: Extract<Entry["parts"][number], { type: "tool" }>): SessionMessage.ToolState => {
  const state = part.state
  if (state.status === "completed") {
    const files = (state.attachments ?? []).map(() => ({ type: "file" }))
    return {
      status: "completed",
      input: state.input,
      structured: {},
      content: [{ type: "text", text: state.output }, ...files],
    } as unknown as SessionMessage.ToolState
  }
  if (state.status === "error") {
    return {
      status: "error",
      input: state.input,
      structured: {},
      content: [{ type: "text", text: state.error }],
      error: { type: "unknown", message: state.error },
    } as unknown as SessionMessage.ToolState
  }
  if (state.status === "running")
    return { status: "running", input: state.input, structured: {}, content: [] } as unknown as SessionMessage.ToolState
  return { status: "pending", input: state.raw } as unknown as SessionMessage.ToolState
}

const view = (entry: Entry): SessionMessage.Message => {
  if (entry.info.role === "user") {
    return {
      type: "user",
      id: entry.info.id,
      text: textOf(entry.parts as never),
      files: [],
      agents: [],
      time: { created: entry.info.time.created },
    } as unknown as SessionMessage.Message
  }
  return {
    type: "assistant",
    id: entry.info.id,
    content: entry.parts.flatMap((part) => {
      if (part.type === "text") return [{ type: "text", id: part.id, text: part.text }]
      if (part.type === "reasoning") return [{ type: "reasoning", id: part.id, text: part.text }]
      if (part.type === "tool")
        return [{ type: "tool", id: part.callID, name: part.tool, state: toolState(part), time: { created: 0 } }]
      return []
    }),
    time: { created: entry.info.time.created },
  } as unknown as SessionMessage.Message
}

const contentText = (content: readonly { type: string; text?: string }[]) =>
  content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")

export interface Input {
  readonly messages: readonly Entry[]
  readonly envelope: SessionContextReduction.Envelope
  readonly model: { readonly limit: { readonly context: number; readonly output: number } }
  readonly config: ConfigV1.Info["context"] | undefined
}

export interface Result {
  readonly messages: readonly Entry[]
  readonly report: SessionContext.Report
}

/** Project the v1 history this request sends. Returns the input array untouched when nothing is reduced. */
export function reduce(input: Input): Result {
  const views = input.messages.map(view)
  const model = {
    route: { defaults: { limits: { context: input.model.limit.context, output: input.model.limit.output } } },
  } as unknown as Model
  const policy = SessionContextReduction.policy(
    input.config ? ([{ type: "document", info: { context: input.config } }] as never) : [],
  )
  const reduction = SessionContextReduction.reduce({ messages: views, envelope: input.envelope, model, policy })
  if (reduction.messages.length === views.length && reduction.messages.every((message, i) => message === views[i]))
    return { messages: input.messages, report: reduction.report }

  const reduced = new Map(reduction.messages.map((message) => [String(message.id), message]))
  const original = new Map(views.map((message) => [String(message.id), message]))
  const messages = input.messages.flatMap((entry): Entry[] => {
    const next = reduced.get(entry.info.id)
    if (!next) return []
    if (next === original.get(entry.info.id) || next.type !== "assistant" || entry.info.role !== "assistant")
      return [entry]
    const tools = new Map(
      next.content.flatMap((part) => (part.type === "tool" ? [[part.id, part.state] as const] : [])),
    )
    const before = new Map(
      (original.get(entry.info.id) as SessionMessage.Assistant).content.flatMap((part) =>
        part.type === "tool" ? [[part.id, part.state] as const] : [],
      ),
    )
    return [
      {
        ...entry,
        parts: entry.parts.map((part) => {
          if (part.type !== "tool") return part
          const state = tools.get(part.callID)
          if (state === undefined || state === before.get(part.callID)) return part
          if (part.state.status === "completed" && state.status === "completed")
            return { ...part, state: { ...part.state, output: contentText(state.content as never) } }
          if (part.state.status === "error" && state.status === "error")
            return { ...part, state: { ...part.state, input: state.input as never } }
          return part
        }),
      } as Entry,
    ]
  })
  return { messages, report: reduction.report }
}

export * as ContextReduction from "./context-reduction"
