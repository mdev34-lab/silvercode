/**
 * AI SDK `LanguageModelV3` implementation for the Qwen Web provider.
 *
 * This is the only module SilverCode's LLM layer talks to: it converts AI SDK
 * calls into incremental turns on the provider's persistent thread and maps
 * the canonical webchat events (text / thinking / tool-call / usage / finish)
 * onto AI SDK stream parts. All browser and streaming details stay behind the
 * session/transport layers.
 */
import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FinishReason,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3Prompt,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
  type LanguageModelV3ToolResultOutput,
  type LanguageModelV3Usage,
  type SharedV3Warning,
} from "@ai-sdk/provider"
import { QWEN_WEB_PROVIDER_ID, type QwenWebReasoningMode } from "@opencode-ai/webchat/adapters/qwen/constants"
import {
  QwenWebError,
  abortedError,
  isAbortLike,
  isQwenWebErrorPhase,
  sanitizeQwenErrorText,
  withQwenWebErrorPhase,
  type QwenWebErrorPhase,
} from "@opencode-ai/webchat/adapters/qwen/errors"
import { debug } from "@opencode-ai/webchat/adapters/qwen/log"
import { toUpstreamModelId } from "@opencode-ai/webchat/adapters/qwen/protocol"
import { randomId } from "@opencode-ai/webchat/adapters/qwen/protocol"
import { Hash } from "@opencode-ai/core/util/hash"
import { buildToolInstructions, buildToolReminder, functionTools, renderPrompt, type QwenWebToolDefinition } from "./prompt"
import { QwenWebSession } from "@opencode-ai/webchat/adapters/qwen/session"
import { lastAnchored } from "@opencode-ai/webchat/thread"
import { QwenWebUpload } from "@opencode-ai/webchat/adapters/qwen/upload"
import { refreshModelsInBackground, resolveUpstreamModelId } from "./catalog"
import { sharedBrowser } from "@opencode-ai/webchat/adapters/qwen/browser"
import type { RenderedPrompt } from "./prompt"
import type { WebChatEvent, WebChatThread, WebChatUsage } from "@opencode-ai/webchat/types"

export interface QwenWebModelOptions {
  reasoningMode?: QwenWebReasoningMode
  thinking?: boolean
  /** Test seams. */
  session?: QwenWebSession
  upload?: QwenWebUpload
}

// Follow-ups on a thread that already has a committed assistant response
// re-send only the tail after that response (the transcript before it lives
// in the upstream chat, chained via `parent_id`). Lite streams (session
// titles/subtitles) keep the full prompt: their thread is a scratchpad for
// the current conversation and carries no reusable upstream context.
// The trim's mirror assumption — the upstream thread reflects the prompt's
// pre-tail transcript — is VERIFIED, not trusted: every committed turn
// records a context fingerprint (`thread.contextCursor`) of the transcript
// it sent, and a follow-up only trims when its prompt prefix still matches
// that fingerprint. A provider switch (foreign turns spliced into the
// history), an in-place message edit, a compaction rewrite — or a legacy
// thread with no cursor at all — fails the check; the binding and chain
// anchors are then dropped so the full prompt rides a fresh chat instead of
// silently stranding context the upstream never saw.
// The trim also requires a LIVE chat binding (`thread.providerId`): when a
// dead upstream chat was discarded after a failed turn, the anchors no
// longer point at anything the next request can chain onto, and trimming
// would silently drop the whole transcript.
function incrementalPrompt(
  prompt: LanguageModelV3Prompt,
  thread: WebChatThread,
  lite: boolean,
): RenderedPrompt | undefined {
  if (lite) return undefined
  if (!thread.providerId) return undefined
  if (!lastAnchored(thread)?.providerState?.responseId) return undefined
  let lastAssistant = -1
  for (let index = prompt.length - 1; index >= 0; index--) {
    if (prompt[index]!.role === "assistant") {
      lastAssistant = index
      break
    }
  }
  // Provenance check before the binding is reused at all — including the
  // no-assistant shapes (an edit may have dropped the committed response):
  // the prefix the upstream chat is believed to mirror is everything before
  // the last assistant message, or the whole prompt when there is none.
  const prefix = lastAssistant >= 0 ? prompt.slice(0, lastAssistant) : prompt
  if (!matchesContextCursor(prefix, thread)) {
    debug("sdk", "local transcript diverged from the upstream mirror; rebinding on a fresh chat", {
      thread: thread.id,
      chatId: thread.providerId?.slice(0, 12),
      prefixMessages: prefix.length,
      cursorMessages: thread.contextCursor?.messages ?? null,
    })
    clearUpstreamBinding(thread)
    return undefined
  }
  if (lastAssistant < 0 || lastAssistant >= prompt.length - 1) return undefined
  const tail = renderPrompt(prompt.slice(lastAssistant + 1))
  if (tail.text.trim().length === 0) return undefined
  return tail
}

/**
 * Fingerprint of the conversation transcript a prompt renders to.
 *
 * System messages are excluded on purpose: SilverCode rebuilds the system
 * block on every call (environment date, tool overview, file-write policy
 * flip once a session writes a file), so it drifts even while the
 * conversation itself is unchanged — folding it in would churn fresh chats
 * without evidence of divergence. Conversation text and media descriptors
 * (type/filename/source, so a swapped attachment counts as an edit) are the
 * transcript the upstream mirror assumption is actually about.
 */
function transcriptFingerprint(prompt: LanguageModelV3Prompt): string {
  const rendered = renderPrompt(prompt.filter((message) => message.role !== "system"))
  const parts = [rendered.text]
  for (const item of rendered.media) {
    parts.push(`${item.mediaType ?? ""}\u0001${item.filename ?? ""}\u0001${item.source}`)
  }
  return Hash.sha256(parts.join("\u0000"))
}

/**
 * True when the thread's provenance cursor still describes `prefix` — the
 * transcript the bound upstream chat is believed to mirror. A thread with no
 * cursor (legacy `threads.json` entry persisted before cursors existed, or a
 * binding that outlived a crash between commit and persist) cannot be
 * verified, and an unverifiable binding is not trusted.
 */
function matchesContextCursor(prefix: LanguageModelV3Prompt, thread: WebChatThread): boolean {
  const cursor = thread.contextCursor
  if (!cursor || typeof cursor.fingerprint !== "string") return false
  if (cursor.messages !== prefix.length) return false
  return cursor.fingerprint === transcriptFingerprint(prefix)
}

/**
 * Drop every local binding to a live-but-divergent upstream chat: the chat
 * id, the chain anchors (`providerState.responseId`), and the stale cursor.
 * Only the upstream linkage is cleared — the local message mirror stays, and
 * the turn that triggered this re-send rides a fresh chat with the FULL
 * rendered prompt and media.
 *
 * Persistence: the session re-persists the shared thread object with its
 * first `store.put` of the next delivery (synchronously, before any await),
 * so the cleared state reaches disk as soon as the re-run starts. If the
 * process dies before that put, the on-disk copy still holds the stale
 * cursor, verification fails again after the restart, and the binding is
 * cleared again — self-healing.
 */
function clearUpstreamBinding(thread: WebChatThread): void {
  thread.providerId = undefined
  thread.contextCursor = undefined
  for (const message of thread.messages) {
    if (message.providerState?.["responseId"] === undefined) continue
    const rest = { ...message.providerState }
    delete rest["responseId"]
    message.providerState = Object.keys(rest).length > 0 ? rest : undefined
  }
  thread.updatedAt = Date.now()
}

export class QwenWebLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider = QWEN_WEB_PROVIDER_ID
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}
  private readonly options: QwenWebModelOptions
  private readonly session: QwenWebSession
  private readonly upload: QwenWebUpload
  private readonly instanceId: string

  constructor(modelId: string, options?: QwenWebModelOptions) {
    this.modelId = modelId
    this.options = options ?? {}
    this.session = options?.session ?? new QwenWebSession()
    this.upload = options?.upload ?? new QwenWebUpload()
    this.instanceId = randomId()
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const collected: LanguageModelV3Content[] = []
    let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: "stop" }
    let usage: LanguageModelV3Usage = emptyUsage()
    let textBuffer = ""
    let reasoningBuffer = ""
    const warnings = this.warnings(options)

    const flushText = () => {
      if (textBuffer) {
        collected.push({ type: "text", text: textBuffer })
        textBuffer = ""
      }
    }
    const flushReasoning = () => {
      if (reasoningBuffer) {
        collected.push({ type: "reasoning", text: reasoningBuffer })
        reasoningBuffer = ""
      }
    }

    const { stream } = await this.doStream(options)
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        switch (value.type) {
          case "text-start":
            flushReasoning()
            break
          case "text-delta":
            textBuffer += value.delta
            break
          case "text-end":
            flushText()
            break
          case "reasoning-start":
            flushText()
            break
          case "reasoning-delta":
            reasoningBuffer += value.delta
            break
          case "reasoning-end":
            flushReasoning()
            break
          case "tool-call":
            flushText()
            flushReasoning()
            collected.push(value)
            break
          case "error":
            throw value.error
          case "finish":
            finishReason = value.finishReason
            usage = value.usage
            break
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    flushText()
    flushReasoning()
    return { content: collected, finishReason, usage, warnings }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const signal = options.abortSignal
    if (signal?.aborted) throw toApiError(abortedError("stop"), this.modelId, "stop")
    const warnings = this.warnings(options)
    const tools = functionTools(options.tools as QwenWebToolDefinition[] | undefined)
    const useTools = tools.length > 0 && options.toolChoice?.type !== "none"

    const fullRendered = renderPrompt(options.prompt)
    const redactValues = promptSensitiveValues(options.prompt)
    let rendered = fullRendered
    const wrap = (p: string, full: boolean): string => {
      let out = p
      if (useTools) {
        // Incremental follow-ups ride on an upstream thread that already
        // carries the full manifest + contract: a short reminder suffices.
        // Forced tool choices keep the full instructions (the MUST-call rule).
        const instructions =
          full || options.toolChoice?.type === "tool" || options.toolChoice?.type === "required"
            ? buildToolInstructions(tools, options.toolChoice)
            : buildToolReminder(tools)
        out = `${instructions}\n\n${out}`
      }
      if (options.responseFormat?.type === "json") {
        const schema = options.responseFormat.schema
          ? `\n\nRespond with JSON matching this schema:\n${JSON.stringify(options.responseFormat.schema)}`
          : "\n\nRespond with valid JSON only."
        out = `${out}${schema}`
      }
      if (options.stopSequences && options.stopSequences.length > 0) {
        out = `${out}\n\n(Stop generating when you would emit any of: ${options.stopSequences.map((s) => JSON.stringify(s)).join(", ")})`
      }
      return out
    }
    let prompt = wrap(rendered.text, true)

    // Strip reasoning variants first, then translate any legacy catalog id
    // (e.g. `qwen3-max`) onto the live upstream catalog so requests never
    // carry an id the server has retired (`Not_Found: Model not found`).
    const upstreamModel = resolveUpstreamModelId(toUpstreamModelId(this.modelId))
    const reasoningMode = this.reasoningMode(options)

    debug("sdk", "starting generation", {
      model: upstreamModel,
      reasoningMode,
      promptChars: prompt.length,
      media: rendered.media.length,
      tools: useTools ? tools.length : 0,
    })

    refreshModelsInBackground(() => sharedBrowser().isRunning())

    // One persistent thread per model (+optional per-agent scope). The turn
    // is incremental: only this turn's prompt is sent, chained upstream.
    const thread = await this.session.ensureThread({ model: upstreamModel, scope: this.threadScope(options) })
    // The full rendered prompt: if a dead upstream chat forces the session's
    // one fresh-chat recovery, the fresh chat carries no server-side
    // transcript, so the re-run must ride on this — never on the trimmed tail.
    const fullPrompt = prompt
    const trim = incrementalPrompt(options.prompt, thread, this.isLite(options))
    if (trim) {
      rendered = trim
      prompt = wrap(trim.text, false)
    }
    const files = rendered.media.length > 0 ? await this.uploadFiles(rendered.media, signal, redactValues) : undefined
    // Incremental calls omit earlier media too; upload the full set only if recovery needs a fresh chat.
    const recoveryFiles =
      trim && fullRendered.media.length > 0
        ? (recoverySignal?: AbortSignal) => this.uploadFiles(fullRendered.media, recoverySignal, redactValues)
        : undefined
    const toolDeclarations = useTools
      ? tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? tool.name,
          inputSchema: tool.inputSchema,
        }))
      : undefined

    // Cancelling the mapped stream (or the caller aborting) must stop the
    // upstream generation: an internal signal fans the abort into the turn.
    const internalAbort = new AbortController()
    let externalListener: (() => void) | undefined
    let externalCleanup: (() => void) | undefined
    if (signal) {
      if (signal.aborted) {
        throw toApiError(abortedError("stop"), this.modelId, "stop")
      }
      externalListener = () => internalAbort.abort()
      signal.addEventListener("abort", externalListener, { once: true })
      externalCleanup = () => {
        try { signal.removeEventListener("abort", externalListener!) } catch {}
      }
    }
    try {
      const generator = this.session.runTurn({
        thread,
        content: prompt,
        recoveryContent: fullPrompt,
        recoveryFiles,
        tools: toolDeclarations,
        files,
        reasoningMode,
        signal: internalAbort.signal,
      })
      const stream = this.buildStream({
        generator,
        warnings,
        signal: internalAbort.signal,
        onCancel: () => internalAbort.abort(),
        redactValues,
        onCleanup: externalCleanup,
        onTurnCommitted: () => {
          // Record the provenance cursor for the transcript this turn commits.
          // Fires on the session's `finish` event, which the session yields
          // right before it appends the assistant node and re-persists the
          // thread — so this mutation rides that same `store.put` and survives
          // a restart. (A turn that fails or is cancelled never yields
          // `finish`, so a failed turn cannot vouch for the upstream mirror.)
          thread.contextCursor = {
            fingerprint: transcriptFingerprint(options.prompt),
            messages: options.prompt.length,
            recordedAt: Date.now(),
          }
        },
      })
      return { stream }
    } catch (e) {
      externalCleanup?.()
      throw e
    }
  }

  private threadScope(options: LanguageModelV3CallOptions): string {
    const providerOptions = (options.providerOptions?.[QWEN_WEB_PROVIDER_ID] ?? {}) as Record<string, unknown>
    const threadId = providerOptions["threadId"]
    if (typeof threadId === "string" && threadId) return threadId
    return this.instanceId
  }

  private isLite(options: LanguageModelV3CallOptions): boolean {
    const providerOptions = (options.providerOptions?.[QWEN_WEB_PROVIDER_ID] ?? {}) as Record<string, unknown>
    return providerOptions["small"] === true
  }

  private async uploadFiles(
    media: { source: string; mediaType?: string; filename?: string }[],
    signal?: AbortSignal,
    redactValues?: readonly string[],
  ) {
    try {
      return await this.upload.uploadAll(media, signal)
    } catch (error) {
      throw toApiError(error, this.modelId, "setup", redactValues)
    }
  }

  private reasoningMode(options: LanguageModelV3CallOptions): QwenWebReasoningMode {
    const providerOptions = (options.providerOptions?.[QWEN_WEB_PROVIDER_ID] ?? {}) as Record<string, unknown>
    const fromProviderOptions = providerOptions["reasoningMode"]
    if (fromProviderOptions === "auto" || fromProviderOptions === "thinking" || fromProviderOptions === "fast") {
      return fromProviderOptions
    }
    const thinking = providerOptions["thinking"] ?? this.options.thinking
    if (typeof thinking === "boolean") return thinking ? "thinking" : "fast"
    return this.options.reasoningMode ?? "auto"
  }

  private warnings(options: LanguageModelV3CallOptions): SharedV3Warning[] {
    const warnings: SharedV3Warning[] = []
    if (options.temperature !== undefined) {
      warnings.push({
        type: "unsupported",
        feature: "temperature",
        details: "Qwen Web does not accept a temperature parameter.",
      })
    }
    if (options.topP !== undefined || options.topK !== undefined) {
      warnings.push({
        type: "unsupported",
        feature: "sampling",
        details: "Qwen Web does not accept topP/topK parameters.",
      })
    }
    const tools = (options.tools ?? []) as QwenWebToolDefinition[]
    if (tools.some((tool) => tool.type !== "function")) {
      warnings.push({
        type: "unsupported",
        feature: "provider tools",
        details: "Only function tools are supported; provider tools were ignored.",
      })
    }
    return warnings
  }

  /** Map canonical webchat events onto `LanguageModelV3StreamPart`s. */
  private buildStream(input: {
    generator: AsyncGenerator<WebChatEvent>
    warnings: SharedV3Warning[]
    signal?: AbortSignal
    onCancel?: () => void
    redactValues?: readonly string[]
    onCleanup?: () => void
    /** Invoked on the session's `finish` event: the turn is committing, and
     * the session persists the thread (with any mutation made here) right
     * after. Used to record the transcript provenance cursor. */
    onTurnCommitted?: () => void
  }): ReadableStream<LanguageModelV3StreamPart> {
    const { generator, warnings, signal, onCancel, onCleanup, onTurnCommitted, redactValues } = input
    const modelId = this.modelId
    let finished = false
    let toolCallCount = 0
    let blockCounter = 0
    let currentTextId: string | undefined
    let currentReasoningId: string | undefined
    let usage: LanguageModelV3Usage = emptyUsage()
    let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: "stop" }
    let metadataEmitted = false
    const safeId = modelId.replace(/[^a-zA-Z0-9_-]/g, "_")

    const endTextBlock = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) => {
      if (currentTextId !== undefined) {
        controller.enqueue({ type: "text-end", id: currentTextId })
        currentTextId = undefined
      }
    }
    const endReasoningBlock = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) => {
      if (currentReasoningId !== undefined) {
        controller.enqueue({ type: "reasoning-end", id: currentReasoningId })
        currentReasoningId = undefined
      }
    }
    const ensureText = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) => {
      if (currentTextId === undefined) {
        currentTextId = `text-${safeId}-${++blockCounter}`
        controller.enqueue({ type: "text-start", id: currentTextId })
      }
    }
    const ensureReasoning = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) => {
      if (currentReasoningId === undefined) {
        currentReasoningId = `reasoning-${safeId}-${++blockCounter}`
        controller.enqueue({ type: "reasoning-start", id: currentReasoningId })
      }
    }

    const finishStream = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) => {
      if (finished) return
      finished = true
      endTextBlock(controller)
      endReasoningBlock(controller)
      const unified: "stop" | "tool-calls" = toolCallCount > 0 ? "tool-calls" : "stop"
      controller.enqueue({ type: "finish", finishReason: { unified, raw: unified }, usage })
      controller.close()
      onCleanup?.()
      debug("sdk", "generation finished", { model: modelId, toolCalls: toolCallCount })
    }

    const failStream = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>, error: unknown) => {
      if (finished) return
      finished = true
      onCleanup?.()
      controller.error(toApiError(error, modelId, "stream", redactValues))
    }

    return new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings })
        void (async () => {
          try {
            for (;;) {
              if (finished) return
              const { done, value } = await generator.next()
              if (finished) return
              if (done) {
                finishStream(controller)
                return
              }
              handleEvent(controller, value)
            }
          } catch (error) {
            if (finished) return
            if (isAbortLike(error) || signal?.aborted) {
              failStream(
                controller,
                QwenWebError.isInstance(error) && error.code === "aborted" ? error : abortedError("stop"),
              )
            } else failStream(controller, error)
          } finally {
            // Never orphan a suspended generator: throwing on an `error`
            // event would otherwise leave the turn's cleanup (the session's
            // per-thread busy flag, abort listeners) pending forever.
            void generator.return(undefined).catch(() => {})
          }
        })()
      },
      pull() {},
      cancel: () => {
        if (!finished) {
          finished = true
          onCancel?.()
          void generator.return(undefined).catch(() => {})
        }
        onCleanup?.()
      },
    })

    function handleEvent(
      controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
      event: WebChatEvent,
    ): void {
      switch (event.type) {
        case "thinking-start":
          endTextBlock(controller)
          ensureReasoning(controller)
          return
        case "thinking-delta":
          ensureReasoning(controller)
          controller.enqueue({ type: "reasoning-delta", id: currentReasoningId as string, delta: event.delta })
          return
        case "thinking-end":
          endReasoningBlock(controller)
          return
        case "text-start":
          endReasoningBlock(controller)
          ensureText(controller)
          return
        case "text-delta":
          ensureText(controller)
          controller.enqueue({ type: "text-delta", id: currentTextId as string, delta: event.delta })
          return
        case "text-end":
          endTextBlock(controller)
          return
        case "tool-call":
          endTextBlock(controller)
          endReasoningBlock(controller)
          toolCallCount++
          controller.enqueue({
            type: "tool-call",
            toolCallId: event.id,
            toolName: event.name,
            input: JSON.stringify(event.args),
          })
          return
        case "usage":
          usage = mapCanonicalUsage(event.usage)
          return
        case "response-metadata":
          if (!metadataEmitted && event.responseId) {
            metadataEmitted = true
            controller.enqueue({ type: "response-metadata", id: event.responseId })
          }
          return
        case "finish":
          finishReason = { unified: event.finishReason, raw: event.finishReason }
          // The session yields `finish` only on a committing turn, right
          // before it appends the assistant node and re-persists the thread;
          // record the provenance cursor while the generator is suspended so
          // that same `store.put` carries it to disk.
          onTurnCommitted?.()
          return
        case "done":
          return
        case "error":
          throw event.error
      }
    }
  }
}

function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }
}

function mapCanonicalUsage(usage: WebChatUsage): LanguageModelV3Usage {
  return {
    inputTokens: { total: usage.inputTokens, noCache: undefined, cacheRead: usage.cacheRead, cacheWrite: undefined },
    outputTokens: { total: usage.outputTokens, text: usage.textTokens, reasoning: usage.reasoningTokens },
    raw: { totalTokens: usage.totalTokens },
  }
}

function promptSensitiveValues(prompt: LanguageModelV3Prompt): string[] {
  const values: string[] = []
  for (const message of prompt) {
    if (message.role === "system") values.push(message.content)
    if (message.role === "user")
      values.push(...message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text" || part.type === "reasoning") values.push(part.text)
        if (part.type === "tool-call")
          values.push(typeof part.input === "string" ? part.input : (JSON.stringify(part.input) ?? ""))
        if (part.type === "tool-result") values.push(...toolOutputTextValues(part.output))
      }
    }
    if (message.role === "tool") {
      for (const part of message.content)
        if (part.type === "tool-result") values.push(...toolOutputTextValues(part.output))
    }
  }
  return [...new Set(values.filter((value) => value.trim().length >= 8))]
}

function toolOutputTextValues(output: LanguageModelV3ToolResultOutput): string[] {
  switch (output.type) {
    case "text":
    case "error-text":
      return [output.value]
    case "json":
    case "error-json":
      return [typeof output.value === "string" ? output.value : (JSON.stringify(output.value) ?? "")]
    case "execution-denied":
      return output.reason ? [output.reason] : []
    case "content":
      return output.value.flatMap((item) => (item.type === "text" ? [item.text] : []))
  }
}

/** Map provider errors onto `APICallError` for SilverCode's error pipeline. */
export function toApiError(
  error: unknown,
  modelId: string,
  phase?: QwenWebErrorPhase,
  redactValues?: readonly string[],
): APICallError {
  if (error instanceof APICallError) return error
  const fallbackPhase = isQwenWebErrorPhase(phase) ? phase : isAbortLike(error) ? "stop" : "setup"
  const failure = withQwenWebErrorPhase(error, fallbackPhase)
  const safePhase = isQwenWebErrorPhase(failure.phase) ? failure.phase : fallbackPhase
  const status = failure.code === "aborted" ? (failure.status ?? 499) : failure.status
  const responseBody = JSON.stringify({
    provider: "qwen-web",
    phase: safePhase,
    code: failure.code,
    status: status ?? null,
    upstreamCode: failure.upstreamCode ?? null,
    retryable: failure.retryable,
    detail: sanitizeQwenErrorText(failure.detail, 240, redactValues) ?? null,
  })
  return new APICallError({
    message: sanitizeQwenErrorText(failure.message, 600, redactValues) ?? "Qwen Web request failed.",
    url: "https://chat.qwen.ai/api/v2/chat/completions",
    requestBodyValues: { model: modelId },
    statusCode: status,
    responseBody,
    isRetryable: failure.retryable,
  })
}

/** Create a language model (used by the provider's custom model loader). */
export function createQwenWebModel(modelId: string, options?: Record<string, unknown>): QwenWebLanguageModel {
  return new QwenWebLanguageModel(modelId, {
    reasoningMode: asReasoningMode(options?.["reasoningMode"]) ?? asReasoningMode(options?.["reasoning_mode"]),
    thinking: typeof options?.["thinking"] === "boolean" ? (options["thinking"] as boolean) : undefined,
  })
}

/** Bundled SDK factory shape (`BUNDLED_PROVIDERS`). */
export function createQwenWeb(options?: Record<string, unknown>): {
  languageModel: (modelId: string) => QwenWebLanguageModel
} {
  return {
    languageModel: (modelId: string) => createQwenWebModel(modelId, options),
  }
}

function asReasoningMode(value: unknown): QwenWebReasoningMode | undefined {
  return value === "auto" || value === "thinking" || value === "fast" ? value : undefined
}