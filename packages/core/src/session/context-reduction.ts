export * as SessionContextReduction from "./context-reduction"

import type { Model } from "@opencode-ai/llm"
import type { SessionContext } from "@opencode-ai/schema/session-context"
import type { Config } from "../config"
import { Glob } from "../util/glob"
import { Token } from "../util/token"
import type { SessionMessage } from "./message"

/**
 * Dynamic context reduction: the derivation of the context one provider request carries from the
 * session's canonical history.
 *
 * ## Contract
 *
 * Canonical history is authoritative and is never modified. Reduction is a pure function of the
 * history and of the request being prepared for — the model's usable window, the prompt envelope
 * the request carries besides history, and the resolved policy — and it returns a *projection* of
 * that history: some of its messages, in their original order, where a few recorded tool payloads
 * have been replaced by smaller equivalents. It never invents a message, never rewrites model text,
 * and never reorders anything.
 *
 * Nothing is remembered between calls, so the session runner is the single owner of reduction state
 * and lifecycle: it loads history, declares the envelope it is about to send, calls `reduce`, lowers
 * the result and builds the request. A turn cannot inherit a stale projection, a restart cannot lose
 * one, and no consumer can disagree with the runtime about what was sent — the runner publishes the
 * returned report and clients render it instead of deriving their own.
 *
 * ## Determinism
 *
 * Every rung is a function of the messages alone, and each one is monotonic: a call that is
 * superseded, an input that has gone stale, a message that was dropped, stays that way as the
 * session grows. The request prefix therefore only changes where something genuinely new happened,
 * which keeps provider prompt caching useful.
 */

export interface Policy {
  readonly enabled: boolean
  /**
   * Fraction of the usable window at which reduction starts, and the target it reduces back to.
   *
   * Reduction aims at the threshold rather than at the window itself so the response keeps its
   * headroom. Compaction — not a deeper reduction — is the escalation when the threshold cannot be
   * reached, because everything left is protected.
   */
  readonly threshold: number
  /** Assistant turns a failed call keeps its original input for. */
  readonly errorTurns: number
  readonly protection: {
    readonly recentTurns: number
    readonly tools: readonly string[]
    readonly files: readonly string[]
  }
}

/**
 * Tools whose recorded calls are never reduced. Losing any of these changes how the agent reasons
 * about the current task rather than merely making it re-read stale information.
 */
const PROTECTED_TOOLS: readonly string[] = ["apply_patch", "edit", "question", "skill", "todowrite", "write"]

/**
 * Tools whose result depends on external state or changes it. Two identical calls are two different
 * observations, so they are never deduplicated even when their arguments match.
 */
const STATE_CHANGING_TOOLS: readonly string[] = [
  "apply_patch",
  "attachment",
  "bash",
  "edit",
  "question",
  "todowrite",
  "webfetch",
  "websearch",
  "write",
]

const defaultPolicy: Policy = {
  enabled: true,
  threshold: 0.8,
  errorTurns: 4,
  protection: { recentTurns: 4, tools: PROTECTED_TOOLS, files: [] },
}

/**
 * Fold every configuration document into one reduction policy.
 *
 * Scalars are last-wins, so the most specific document decides. The protection arrays accumulate
 * instead: protection is a safety rule, and a project file that protects one more tool must not
 * silently discard what a broader file protected. A narrower document can therefore only *add*
 * protection; widening reduction stays an explicit choice (`enabled`, `threshold`, `recent_turns`).
 */
export const policy = (documents: readonly Config.Entry[]): Policy =>
  documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.context ? [entry.info.context] : []))
    .reduce(
      (result, current) => ({
        enabled: current.reduction?.enabled ?? result.enabled,
        threshold: current.reduction?.threshold ?? result.threshold,
        errorTurns: current.reduction?.error_turns ?? result.errorTurns,
        protection: {
          recentTurns: current.protection?.recent_turns ?? result.protection.recentTurns,
          tools: current.protection?.tools
            ? [...new Set([...result.protection.tools, ...current.protection.tools])]
            : result.protection.tools,
          files: current.protection?.files
            ? [...new Set([...result.protection.files, ...current.protection.files])]
            : result.protection.files,
        },
      }),
      defaultPolicy,
    )

/**
 * Everything one provider request carries besides the conversation.
 *
 * Utilization measured from history alone understates the request: the system prompt and the tool
 * definitions are resent on every turn and are frequently larger than the recent conversation. The
 * runner — which owns the request — declares them here so the budget describes the real prompt.
 */
export interface Envelope {
  readonly system?: unknown
  readonly tools?: unknown
  readonly extra?: unknown
}

export interface Input {
  /** Canonical session history, exactly as the runner loaded it. */
  readonly messages: readonly SessionMessage.Message[]
  readonly envelope: Envelope
  readonly model: Model
  readonly policy: Policy
}

export interface Reduction {
  /** The projection to lower and send; the canonical input when nothing needed reducing. */
  readonly messages: readonly SessionMessage.Message[]
  /** The authoritative measurement of that projection, published once per provider request. */
  readonly report: SessionContext.Report
}

export const DUPLICATE_MARKER =
  "[duplicate tool output pruned: an identical call is repeated later in this conversation]"
export const PURGED_INPUT_MARKER = "[input purged: this call failed and its input is no longer part of the request]"
export const TRUNCATED_MARKER = "[stale tool output truncated]"

/** A recorded payload smaller than this is left alone: pruning it saves less than it churns. */
const MINIMUM_SAVING = 256
/** Characters kept from each end of a truncated stale output. */
const TRUNCATE_KEEP = 400

/**
 * Derive the context one provider request carries.
 *
 * One budget, one direction: the request is measured against the model's usable window, and when it
 * is over the configured threshold the rungs run in a fixed order — cheapest and least destructive
 * first — until it is back under. Below the threshold the canonical history is sent untouched.
 */
export const reduce = (input: Input): Reduction => {
  const limit = usableWindow(input.model)
  const overhead = size([input.envelope.system ?? [], input.envelope.tools ?? [], input.envelope.extra ?? []])
  const canonical = measure(input.messages)
  const report = (characters: number, outcome: SessionContext.Outcome): SessionContext.Report => {
    const tokens = Token.fromLength(characters + overhead)
    return {
      tokens,
      overheadTokens: Token.fromLength(overhead),
      reclaimedTokens: Math.max(Token.fromLength(canonical + overhead) - tokens, 0),
      ...(limit === undefined ? {} : { limit }),
      utilization: limit === undefined ? 0 : tokens / limit,
      outcome,
    }
  }
  const untouched = report(canonical, "untouched")
  // No measurable window means no measurable pressure: send the history and report it as sent.
  if (limit === undefined || !input.policy.enabled) return { messages: input.messages, report: untouched }
  const fits = (characters: number) => Token.fromLength(characters + overhead) <= limit * input.policy.threshold
  if (fits(canonical)) return { messages: input.messages, report: untouched }

  const protection = protect(input.messages, input.policy)
  // Content rungs, least destructive first. Each one runs to completion — it replaces every payload
  // it can prove is redundant — and the fold stops calling them once the request fits.
  const content = [
    (messages: readonly SessionMessage.Message[]) => duplicateOutputs(messages, protection),
    (messages: readonly SessionMessage.Message[]) => staleErrorInputs(messages, protection, input.policy),
    (messages: readonly SessionMessage.Message[]) => staleOutputs(messages, protection),
  ].reduce(
    (state, rung) => {
      if (fits(state.characters)) return state
      const result = rung(state.messages)
      if (result.count === 0) return state
      return { messages: result.messages, characters: state.characters - result.saved }
    },
    { messages: input.messages, characters: canonical },
  )
  // Dropping whole messages is genuinely last, and the only rung that stops as soon as it can.
  const state = fits(content.characters) ? content : dropOldest(content, protection, fits)
  return {
    messages: state.messages,
    report: report(state.characters, fits(state.characters) ? "reduced" : "exhausted"),
  }
}

/**
 * The window a request may occupy: the model's context limit minus the output it reserves.
 *
 * Undefined when the model declares no context limit — there is then nothing to be under pressure
 * against, and reduction stays out of the way.
 */
const usableWindow = (model: Model) => {
  const context = model.route.defaults.limits?.context
  if (context === undefined || context <= 0) return undefined
  // A declared output reserve at or above the context limit must not collapse the window to one
  // token (every request would then be reduced to exhaustion): keep a quarter of the context.
  return Math.max(context - (model.route.defaults.limits?.output ?? 0), Math.ceil(context / 4))
}

/** Serialized length of one value as the request carries it. */
const size = (value: unknown) => (JSON.stringify(value) ?? "").length

/**
 * Serialized length of a message list as the request carries it.
 *
 * JSON is compositional — a subtree appears verbatim inside its parent's serialization — so a rung
 * accounts for what it removed by differencing two subtree lengths instead of re-serializing the
 * whole history. Reduction runs precisely on the histories that are too large to serialize twice.
 */
const measure = (messages: readonly SessionMessage.Message[]) => size(messages.map(transmitted))

/** A canonical message as the request carries it. */
const transmitted = (message: SessionMessage.Message): SessionMessage.Message => {
  if (message.type !== "assistant") return message
  return {
    ...message,
    content: message.content.map((part) => (part.type === "tool" ? transmittedPart(part) : part)),
  }
}

/**
 * A recorded tool call as the request carries it.
 *
 * Measurement has to price the transmission, not the storage: the lowering re-derives a locally
 * executed call's provider value from `structured` and `content`, so the `result` stored beside
 * them never reaches a provider. Pricing it would roughly double every tool output and start
 * reduction at half the real utilization.
 */
const transmittedPart = (part: SessionMessage.AssistantTool): SessionMessage.AssistantTool => {
  if (part.provider?.executed === true) return part
  if (part.state.status !== "completed" && part.state.status !== "error") return part
  if (part.state.result === undefined) return part
  return { ...part, state: { ...part.state, result: undefined } }
}

interface Protection {
  /** Index of the first message inside the protected recent window. */
  readonly recentFrom: number
  /** Messages the drop rung may never remove. */
  readonly messages: ReadonlySet<SessionMessage.ID>
  /** Tool calls whose recorded state no rung may rewrite. */
  readonly calls: ReadonlySet<string>
}

/**
 * Resolve every protection rule once for one canonical message list.
 *
 * Each rung consults the result instead of re-deriving protection from scratch, so the rungs cannot
 * disagree about what is untouchable — and a provider-executed call, whose result AlphaCode did not
 * record, is untouchable everywhere.
 */
const protect = (messages: readonly SessionMessage.Message[], policy: Policy): Protection => {
  const recentFrom = recentWindow(messages, policy.protection.recentTurns)
  const kept = new Set<SessionMessage.ID>()
  const calls = new Set<string>()
  messages.forEach((message, index) => {
    const recent = index >= recentFrom
    if (recent || message.type === "user" || message.type === "synthetic") kept.add(message.id)
    if (message.type !== "assistant") return
    for (const part of message.content) {
      if (part.type !== "tool") continue
      if (recent || part.provider?.executed === true) calls.add(part.id)
      if (!protectedTool(part, policy)) continue
      calls.add(part.id)
      // A protected call protects the message carrying it: dropping that message would drop the
      // call, which no rung is allowed to do.
      kept.add(message.id)
    }
  })
  // The newest user input and the newest assistant turn always survive, whatever the window says:
  // a request that cannot see the question it is answering is worse than an oversized one.
  const latestUser = messages.findLast((message) => message.type === "user" || message.type === "synthetic")
  if (latestUser) kept.add(latestUser.id)
  const latestAssistant = messages.findLast((message) => message.type === "assistant")
  if (latestAssistant) kept.add(latestAssistant.id)
  return { recentFrom, messages: kept, calls }
}

/** Input keys a file protection pattern is matched against. */
const PATH_KEYS = ["file", "filePath", "filename", "path", "source", "target"]

const protectedTool = (tool: SessionMessage.AssistantTool, policy: Policy) => {
  if (policy.protection.tools.includes(tool.name)) return true
  if (policy.protection.files.length === 0) return false
  const input = tool.state.status === "pending" ? undefined : tool.state.input
  if (typeof input !== "object" || input === null) return false
  return PATH_KEYS.some((key) => {
    const value = (input as Record<string, unknown>)[key]
    return typeof value === "string" && policy.protection.files.some((pattern) => Glob.match(pattern, value))
  })
}

const deduplicable = (name: string) => !STATE_CHANGING_TOOLS.includes(name)

/**
 * Index of the first message belonging to the last `turns` assistant turns.
 *
 * A turn starts at the user message that provoked it, so the window protects the request as well as
 * its response.
 */
const recentWindow = (messages: readonly SessionMessage.Message[], turns: number) => {
  if (turns <= 0) return messages.length
  let seen = 0
  let boundary = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    boundary = index
    if (messages[index].type !== "assistant") continue
    seen++
    if (seen < turns) continue
    while (boundary > 0 && messages[boundary - 1].type !== "assistant") boundary--
    return boundary
  }
  return boundary
}

/**
 * Rewrite the recorded state of whichever tool calls `select` returns a replacement for.
 *
 * One shape for every content rung, so the rungs differ only in what they consider redundant and
 * the accounting stays in one place: the characters a rung removed are the difference between the
 * two serializations of the state it replaced, which is exact because JSON is compositional.
 */
const rewrite = (
  messages: readonly SessionMessage.Message[],
  select: (tool: SessionMessage.AssistantTool, index: number) => SessionMessage.ToolState | undefined,
) => {
  let saved = 0
  let count = 0
  const result = messages.map((message, index) => {
    if (message.type !== "assistant") return message
    let touched = false
    const content = message.content.map((part) => {
      if (part.type !== "tool") return part
      const state = select(part, index)
      if (state === undefined) return part
      saved += size(transmittedPart(part)) - size(transmittedPart({ ...part, state }))
      count++
      touched = true
      return { ...part, state }
    })
    return touched ? { ...message, content } : message
  })
  return count === 0 ? { messages, saved: 0, count: 0 } : { messages: result, saved, count }
}

/**
 * Superseded duplicate tool output.
 *
 * Only the newest result of a repeated `name(arguments)` pair stays verbatim; earlier identical
 * calls keep their call record and lose their output. Reading the same file five times is one fact,
 * not five.
 */
const duplicateOutputs = (messages: readonly SessionMessage.Message[], protection: Protection) => {
  const seen = new Map<string, string[]>()
  const sizes = new Map<string, number>()
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || part.state.status !== "completed") continue
      if (!deduplicable(part.name)) continue
      const signature = `${part.name}:${stable(part.state.input)}`
      seen.set(signature, [...(seen.get(signature) ?? []), part.id])
      sizes.set(part.id, size(part.state.content))
    }
  }
  // The newest occurrence always survives, including inside the protected window: protection means
  // a call never loses its own output, and that rule has no override. When nothing unprotected is
  // left the request stays large and the runtime escalates instead of pruning anyway.
  const superseded = new Set(
    Array.from(seen.values())
      .flatMap((ids) => ids.slice(0, -1))
      .filter((id) => !protection.calls.has(id))
      // Replacing a small output with the marker would grow the request instead of shrinking it.
      .filter((id) => (sizes.get(id) ?? 0) - DUPLICATE_MARKER.length > MINIMUM_SAVING),
  )
  return rewrite(messages, (tool) => {
    if (!superseded.has(tool.id) || tool.state.status !== "completed") return undefined
    return {
      status: "completed",
      input: tool.state.input,
      structured: {},
      content: [{ type: "text", text: DUPLICATE_MARKER }],
    }
  })
}

/**
 * The input of a failed call, once it is stale.
 *
 * A failure stays useful long after its input does: the model needs the tool name, the error and
 * the diagnostic, not the 500 KB script that produced it.
 */
const staleErrorInputs = (messages: readonly SessionMessage.Message[], protection: Protection, policy: Policy) => {
  // The tighter of the retention window and the protected recent window: pressure never reaches
  // into content the policy calls untouchable.
  const boundary = Math.min(recentWindow(messages, policy.errorTurns), protection.recentFrom)
  return rewrite(messages, (tool, index) => {
    if (index >= boundary || tool.state.status !== "error") return undefined
    if (protection.calls.has(tool.id) || size(tool.state.input) < MINIMUM_SAVING) return undefined
    return { ...tool.state, input: { purged: PURGED_INPUT_MARKER } }
  })
}

/**
 * An oversized output of a stale, unprotected call keeps its head and tail.
 *
 * The most a rung may take from a result that is merely old: the model can still see what the call
 * returned, and can re-read the source when it needs the middle.
 */
const staleOutputs = (messages: readonly SessionMessage.Message[], protection: Protection) =>
  rewrite(messages, (tool, index) => {
    if (index >= protection.recentFrom || tool.state.status !== "completed") return undefined
    if (protection.calls.has(tool.id)) return undefined
    // Truncation rebuilds the result as plain text; a result carrying files or other non-text parts would lose them.
    if (tool.state.content.some((item) => item.type !== "text")) return undefined
    const text = tool.state.content.map((item) => (item.type === "text" ? item.text : "")).join("\n")
    if (text.length <= TRUNCATE_KEEP * 2) return undefined
    return {
      status: "completed",
      input: tool.state.input,
      structured: {},
      content: [
        {
          type: "text",
          text: `${text.slice(0, TRUNCATE_KEEP)}\n${TRUNCATED_MARKER}\n${text.slice(-TRUNCATE_KEEP)}`,
        },
      ],
    }
  })

/**
 * Drop unprotected messages, oldest first, until the request fits.
 *
 * Only the prefix *before* the protected recent window is ever eligible: dropping a recent turn is
 * worse than sending an oversized request, because the model would answer a question it can no
 * longer see. So "until it fits" is a best effort — when the eligible prefix runs out the report
 * says `exhausted` and the runtime does not prune protected content. Compaction is a separate, config-driven step (`compaction.auto`) that runs on its own measurement of the request.
 */
const dropOldest = (
  state: { readonly messages: readonly SessionMessage.Message[]; readonly characters: number },
  protection: Protection,
  fits: (characters: number) => boolean,
) => {
  // Eligibility is decided against the original positions: removing a message shifts every later
  // index left and would otherwise walk the boundary into the protected window. Each candidate is
  // measured once, because re-serializing the whole history per candidate is quadratic on exactly
  // the input this rung exists for.
  const droppable = state.messages
    .slice(0, protection.recentFrom)
    .flatMap((message, index) => (protection.messages.has(message.id) ? [] : [index]))
  const dropped = new Set<number>()
  let characters = state.characters
  let remaining = state.messages.length
  for (const index of droppable) {
    if (fits(characters)) break
    dropped.add(index)
    // Dropping an element removes its serialization plus one separating comma, except when it
    // leaves the list empty and only the brackets survive.
    characters -= size(transmitted(state.messages[index])) + (remaining > 1 ? 1 : 0)
    remaining--
  }
  if (dropped.size === 0) return state
  return {
    messages: state.messages.filter((_, index) => !dropped.has(index)),
    characters,
  }
}

/** Order-independent JSON, so `{a,b}` and `{b,a}` count as the same call. */
const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`
}
