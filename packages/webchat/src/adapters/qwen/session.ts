/**
 * Qwen chat-session management.
 *
 * SilverCode owns one persistent Qwen chat per thread (`ThreadStore`), and
 * every generation is an incremental turn on that chat: it chains the new
 * user message to the previous assistant response via `parent_id`, so the
 * model sees the conversation in its server-side memory instead of a
 * re-sent transcript. Tools are offered on each turn and parsed out of the
 * stream (`QWEN_WEB_TOOL_MODE=block`, the default) or surfaced as native
 * `local_mcp` `tool_calls` events (`QwenWebToolMode.native`, experimental).
 *
 * The thread is the source of truth for continuation anchors (`providerId`
 * = upstream chat, `providerState.responseId` = chain parent). Each turn
 * mutates the stored thread and re-persists it, so a restart reuses the
 * same upstream chat instead of creating a new one.
 *
 * Dead upstream chats (deleted/expired `providerId`, reported as
 * `CHAT_NOT_FOUND`-class errors) are handled instead of poisoning the
 * thread: at most once per turn, the failed delivery is rolled back (user
 * node, unconsumed seed, chain anchors), the dead chat binding is cleared,
 * and the turn re-runs on a fresh chat with the caller's FULL prompt — a
 * fresh chat carries no upstream transcript, so a trimmed tail must never
 * be sent to it.
 */
import {
  QWEN_WEB_ENV,
  QWEN_WEB_PATHS,
  type QwenWebChatMode,
  type QwenWebReasoningMode,
  type QwenWebToolMode,
} from "./constants"
import {
  CHALLENGE_NO_WINDOW_DETAIL,
  CHALLENGE_WINDOW_OPEN_DETAIL,
  QwenWebError,
  chatInProgressExhaustedError,
  abortedError,
  challengeError,
  classifyHttpResponse,
  classifyJsonError,
  classifyStatus,
  classifyStreamError,
  classifyTruncatedJson,
  emptyResponseError,
  isAbortLike,
  isChatInProgressError,
  isHtmlBody,
  isStaleAnchorError,
  isStaleBindingError,
  isStaleChatError,
  isStallTimeout,
  isChallengeMessage,
  loginRequiredError,
  nonStreamResponseError,
  sessionExpiredError,
  withQwenWebErrorPhase,
} from "./errors"
import { debug, summarizePayload } from "./log"
import {
  buildChatNewBody,
  buildCompletionPayload,
  buildStopBody,
  formatThinkingSummary,
  incrementalDelta,
  parseChatNewOutcome,
  QwenWebSSEParser,
  randomId,
  type QwenNativeTool,
  type QwenWebFileEntry,
  type QwenWebStreamEvent,
} from "./protocol"
import { ThreadStore } from "../../store"
import { append, lastAnchored, removeById, byId } from "../../thread"
import { StreamingToolParser } from "./tool-parser"
import { QwenWebTransport, sharedTransport } from "./transport"
import type {
  WebChatEditInput,
  WebChatEvent,
  WebChatForkInput,
  WebChatMessage,
  WebChatPart,
  WebChatProvider,
  WebChatThread,
  WebChatTool,
  WebChatTurnInput,
  WebChatUsage,
} from "../../types"

export interface QwenWebSessionOptions {
  transport?: QwenWebTransport
  chatMode?: QwenWebChatMode
  /** Tool protocol selection; `block` (default) uses marker-tag tool blocks. */
  toolMode?: QwenWebToolMode
  /** Persistence for threads; defaults to the data dir. Tests inject a temp store. */
  store?: ThreadStore
  /** Waits (ms) between re-sends while Qwen reports the chat is still generating. Tests inject short ones. */
  inProgressBackoffMs?: readonly number[]
}

/**
 * Challenge errors already passed through reveal+enrich. The same error
 * object can surface at several sites (pre-stream throw, setup-loop
 * rethrow), and the headed relaunch must run only once per error.
 */
const enrichedChallenges = new WeakSet<QwenWebError>()

export interface StartGenerationInput {
  prompt: string
  model: string
  files?: QwenWebFileEntry[]
  reasoningMode?: QwenWebReasoningMode
  signal?: AbortSignal
  referrerChatId?: string | null
}

export interface ActiveGeneration {
  chatId: string
  response: { status: number; contentType: string; stream: ReadableStream<Uint8Array>; abort: () => void }
}

/** One incremental turn on an existing thread. */
export interface QwenWebTurnInput extends WebChatTurnInput {
  files?: QwenWebFileEntry[]
  reasoningMode?: QwenWebReasoningMode
  /**
   * The caller's full, untrimmed prompt for this turn. Consumed at most once
   * when a dead upstream chat forces a fresh-chat recovery: the fresh chat
   * has no server-side transcript to ride on, so the recovery must never
   * re-send a trimmed tail. Defaults to `content`.
   */
  recoveryContent?: string
  /** Lazily re-upload the full prompt's media when a fresh-chat retry is needed. */
  recoveryFiles?: (signal?: AbortSignal) => Promise<QwenWebFileEntry[] | undefined>
}

/**
 * Bounded waits (ms) between re-sends of a request Qwen rejected because the
 * chat is still generating. A rejected request never started upstream, so
 * re-sending it cannot duplicate a turn. Total wait is capped at 14 seconds.
 */
const DEFAULT_IN_PROGRESS_BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000]

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError("stop"))
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortedError("stop"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(abortedError("stop"))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError("stop"))
    signal.addEventListener("abort", onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

export class QwenWebSession implements WebChatProvider {
  readonly id = "qwen-web"
  private readonly transport: QwenWebTransport
  private readonly chatMode: QwenWebChatMode
  private readonly toolMode: QwenWebToolMode
  private readonly store: ThreadStore
  private readonly running = new Set<string>()
  private readonly inProgressBackoffMs: readonly number[]
  /** Latest upstream response id seen per chat; lets a stuck chat be stopped once. */
  private readonly lastResponseByChat = new Map<string, string>()

  constructor(options?: QwenWebSessionOptions) {
    this.inProgressBackoffMs = options?.inProgressBackoffMs ?? DEFAULT_IN_PROGRESS_BACKOFF_MS
    this.transport = options?.transport ?? sharedTransport()
    this.chatMode = options?.chatMode ?? readChatModeDefault()
    this.toolMode = options?.toolMode ?? readToolModeDefault()
    this.store = options?.store ?? ThreadStore.inDataDir()
  }

  /** Create a fresh Qwen chat for one generation. */
  async createChat(model: string, signal?: AbortSignal): Promise<string> {
    try {
      const response = await this.transport.rawRequestJson("POST", QWEN_WEB_PATHS.chatsNew, {
        body: JSON.stringify(buildChatNewBody(model, this.chatMode)),
        signal,
      })
      if (response.status < 200 || response.status >= 300) {
        const error =
          classifyHttpResponse(response.body, response.status, response.statusText, "chat-create") ??
          loginRequiredError()
        if (error.code === "challenge") throw await this.enrichChallenge(error, signal)
        throw error
      }
      const outcome = parseChatNewOutcome(safeJsonParse(response.body))
      if (outcome.kind === "ok") {
        debug("session", "chat created", {
          ...summarizePayload(JSON.stringify({ model })),
        })
        return outcome.chatId
      }
      // The invalid_response fallback below is never stale-chat evidence: a
      // chat that was never created proves nothing about an existing binding,
      // so report it and leave the thread unbound rather than inventing a
      // recovery the error cannot support. (A classified stale-chat/anchor
      // error from the same body still propagates as binding evidence, and
      // deliverTurn's single-recovery cap bounds that path.)
      const classified = classifyJsonError(response.body, response.status, "chat-create")
      if (classified?.code === "challenge") throw await this.enrichChallenge(classified, signal)
      if (classified) throw classified
      throw new QwenWebError({
        code: "invalid_response",
        phase: "chat-create",
        retryable: false,
        status: response.status,
        detail: "The response did not contain a usable chat identifier.",
        message: `Qwen returned an unexpected chat-creation payload (HTTP ${response.status}, ${
          outcome.reason === "empty" ? "empty body" : outcome.reason === "blank" ? "blank chat id" : "no chat id"
        }): nothing to bind to. The thread stays unbound and the next turn creates a new chat.`,
      })
    } catch (error) {
      throw withQwenWebErrorPhase(error, "chat-create")
    }
  }

  /** Start a streaming generation on a fresh chat (legacy single-turn path). */
  async startGeneration(input: StartGenerationInput): Promise<ActiveGeneration> {
    const signal = input.signal
    if (signal?.aborted) throw abortedError("stop")
    const chatId = await this.createChat(input.model, signal)
    const payload = buildCompletionPayload({
      prompt: input.prompt,
      model: input.model,
      chatId,
      parentId: null,
      files: input.files,
      reasoningMode: input.reasoningMode,
      chatMode: this.chatMode,
    })
    const path = `${QWEN_WEB_PATHS.completions}?chat_id=${encodeURIComponent(chatId)}`
    // Completions run over the raw-node path: page-context fetches to this
    // endpoint are held by the WAF unless driven by the site's own client.
    try {
      const response = await this.transport.rawRequestStream("POST", path, {
        body: JSON.stringify(payload),
        signal,
        reasoning: input.reasoningMode !== "fast",
        referrer: chatReferrer(chatId),
      })
      await this.ensureStreamable(response, chatId, signal)
      return { chatId, response }
    } catch (error) {
      throw withQwenWebErrorPhase(error, "setup")
    }
  }

  /**
   * Ask the upstream to stop an in-flight generation, then abort locally.
   * Best effort: cancelling the local stream always proceeds.
   */
  async stopGeneration(chatId: string, responseId: string | undefined, abortLocal: () => void): Promise<void> {
    try {
      abortLocal()
    } catch {
      // Best-effort local cancel; do not block remote stop on cleanup errors.
    }
    if (!chatId || !responseId) return
    try {
      const path = `${QWEN_WEB_PATHS.completionsStop}?chat_id=${encodeURIComponent(chatId)}`
      const response = await this.transport
        .requestJson("POST", path, {
          body: JSON.stringify(buildStopBody(chatId, responseId)),
          referrer: chatReferrer(chatId),
          timeoutMs: 15_000,
        })
        .catch((error: unknown) => {
          const failure = withQwenWebErrorPhase(error, "stop")
          debug("session", "upstream stop request failed", {
            phase: failure.phase,
            code: failure.code,
            status: failure.status,
            upstreamCode: failure.upstreamCode,
            retryable: failure.retryable,
          })
          return undefined
        })
      if (response) {
        const failure =
          classifyJsonError(response.body, response.status, "stop") ??
          classifyStatus(response.status, response.statusText, "stop")
        if (failure) {
          debug("session", "upstream stop request failed", {
            phase: failure.phase,
            code: failure.code,
            status: failure.status,
            upstreamCode: failure.upstreamCode,
            retryable: failure.retryable,
          })
        }
      }
    } catch {
      // best-effort remote stop ignored
    }
  }

  // -------------------------------------------------------------------------
  // Persistent-thread API (`WebChatProvider`)
  // -------------------------------------------------------------------------

  /** Create a new (empty) thread. The upstream chat is created on first turn. */
  async createThread(input: { model: string; title?: string; scope?: string }): Promise<WebChatThread> {
    const now = Date.now()
    const thread: WebChatThread = {
      id: `qwen-web:${input.model}${input.scope ? `:${input.scope}` : ""}:${randomId()}`,
      model: input.model,
      title: input.title,
      messages: [],
      createdAt: now,
      updatedAt: now,
    }
    this.store.put(thread)
    return thread
  }

  /**
   * Return the persistent thread for a model (+optional scope, e.g. a per-agent
   * `threadId`). Multiple parallel agents on the same model share one thread,
   * so concurrent turns on the same thread are rejected (`busy`).
   */
  async ensureThread(input: { model: string; scope?: string }): Promise<WebChatThread> {
    const key = `qwen-web:${input.model}${input.scope ? `:${input.scope}` : ""}`
    const existing = this.store.get(key)
    if (existing) return existing
    const now = Date.now()
    const thread: WebChatThread = { id: key, model: input.model, messages: [], createdAt: now, updatedAt: now }
    this.store.put(thread)
    return thread
  }

  /**
   * Run one incremental turn on a thread. Yields canonical events; the last
   * one is `done` with the persisted thread. The turn chains onto the last
   * assistant response (`parent_id`) so upstream memory is the transcript.
   *
   * A broken binding triggers at most ONE recovery per turn, and the kind of
   * recovery follows the evidence:
   * - dead upstream chat (`CHAT_NOT_FOUND`-class): the delivery is fully
   *   rolled back (user node, unconsumed seed, anchors, chat binding) and the
   *   turn re-runs on a fresh chat.
   * - dead anchor only (`parent_id`/response gone, chat still live): the
   *   anchors are dropped but the chat is kept, and the turn re-runs
   *   unanchored on the same chat.
   * Either way the re-run rides on `recoveryContent` — the caller's full
   * prompt — because neither a fresh chat nor a re-anchored branch carries
   * the upstream transcript the trimmed tail assumes.
   */
  async *runTurn(input: QwenWebTurnInput): AsyncGenerator<WebChatEvent> {
    const thread = input.thread
    if (input.signal?.aborted) throw abortedError("stop")
    if (this.running.has(thread.id)) {
      throw new QwenWebError({
        code: "upstream_error",
        phase: "setup",
        retryable: true,
        message: `Qwen thread "${thread.id}" already has a turn in progress.`,
      })
    }
    this.running.add(thread.id)

    const traceStart = Date.now()
    const trace = (label: string, extra?: Record<string, unknown>) =>
      debug("session", `turn timing: ${label}`, { ms: Date.now() - traceStart, ...extra })

    try {
      // One binding recovery per turn, of either kind: a recovery re-sends the
      // turn, so allowing a second one would risk a silent replay loop.
      let recoveryUsed = false
      let content = input.content
      let files = input.files
      for (;;) {
        if (input.signal?.aborted) throw abortedError("stop")
        const outcome = yield* this.deliverTurn({
          input,
          content,
          files,
          allowRecovery: !recoveryUsed,
          trace,
        })
        if (outcome === "finished") return
        recoveryUsed = true
        // Both recoveries break the upstream chain: the fresh chat has no
        // server-side transcript and the re-anchored branch starts a new one,
        // so the retry must never ride on a trimmed tail.
        content = input.recoveryContent ?? input.content
        files = (await input.recoveryFiles?.(input.signal)) ?? input.files
        trace(outcome === "recover-anchor" ? "stale anchor recovery" : "fresh chat recovery")
      }
    } finally {
      this.running.delete(thread.id)
    }
  }

  /**
   * One delivery attempt of a turn: user-node bookkeeping, pre-stream setup
   * (retried once), stream consumption, and thread commit. Returns
   * `"recover-fresh-chat"` when a dead upstream chat was rolled back and the
   * caller should re-run the turn on a fresh chat with the full prompt,
   * `"recover-anchor"` when only the continuation anchor was confirmed dead
   * and the same chat can be re-anchored, and `"finished"` when the turn
   * reached its terminal `done` event (gracefully or with an error event).
   */
  private async *deliverTurn(state: {
    input: QwenWebTurnInput
    content: string
    files?: QwenWebFileEntry[]
    allowRecovery: boolean
    trace: (label: string, extra?: Record<string, unknown>) => void
  }): AsyncGenerator<WebChatEvent, "recover-fresh-chat" | "recover-anchor" | "finished"> {
    const input = state.input
    const trace = state.trace
    const thread = input.thread
    const signal = input.signal
    const model = thread.model

    const toolMode = this.toolMode
    const lastResponseByChat = this.lastResponseByChat
    const tools = input.tools ?? []
    const declaredTools = new Set(tools.map((tool) => tool.name))
    const nativeTools = toolMode === "native" ? toNativeTools(tools) : undefined

    // Validate the persisted binding pair before it is used. A thread file
    // written by another process (or an older build) can carry a blank chat id
    // or a blank anchor; either would be sent upstream as-is and read as a
    // live binding. Drop them here instead.
    if (sanitizeBinding(thread)) {
      debug("session", "sanitized persisted binding state", { thread: thread.id })
      this.store.put(thread)
    }

    // A fork/compaction seed becomes part of the first turn on the new chat.
    // Track it so a failed delivery can restore it instead of losing it.
    let content = state.content
    let seedUsed: string | undefined
    if (thread.seedText && !lastAnchored(thread)) {
      seedUsed = thread.seedText
      content = `${seedUsed}\n\n${content}`
      thread.seedText = undefined
    }

    // The local mirror records the user node now; its id is the upstream fid.
    const fid = randomId()
    append(thread, {
      id: fid,
      role: "user",
      content,
      parts: [{ type: "text", text: content }],
    })
    this.store.put(thread)

    let chatId = thread.providerId
    let response:
      | { status: number; contentType: string; stream: ReadableStream<Uint8Array>; abort: () => void }
      | undefined
    let listener: (() => void) | undefined

    // Drop every continuation anchor to the upstream chat. The chat itself
    // stays bound: only the response/parent ids we tried to chain onto are
    // confirmed unusable. Stop bookkeeping follows suit — a response id
    // recorded for a dropped anchor must never be sent to stop anything.
    const clearAnchors = () => {
      if (chatId) lastResponseByChat.delete(chatId)
      if (thread.providerId) lastResponseByChat.delete(thread.providerId)
      for (const message of thread.messages) {
        if (message.providerState?.["responseId"] === undefined) continue
        const rest = { ...message.providerState }
        delete rest["responseId"]
        message.providerState = Object.keys(rest).length > 0 ? rest : undefined
      }
    }

    // Drop the whole binding to a confirmed-dead upstream chat: future turns
    // must neither address it (chat id) nor chain onto it (parent ids).
    const clearChatBinding = () => {
      clearAnchors()
      thread.providerId = undefined
      chatId = undefined
    }

    // Full rollback of this delivery (user node, seed, chat binding) so a
    // fresh-chat recovery re-runs the turn from a clean slate.
    const discardDelivery = () => {
      removeById(thread, fid)
      if (seedUsed !== undefined) thread.seedText = seedUsed
      clearChatBinding()
      this.store.put(thread)
      debug("session", "dead upstream chat discarded; recovering on a fresh chat", { thread: thread.id })
    }

    // Rollback for a dead anchor: the user node and seed come back, the
    // anchors go, and the chat stays bound for the unanchored re-run.
    const discardAnchoredDelivery = () => {
      removeById(thread, fid)
      if (seedUsed !== undefined) thread.seedText = seedUsed
      clearAnchors()
      this.store.put(thread)
      debug("session", "stale upstream anchor discarded; re-anchoring on the same chat", { thread: thread.id })
    }

    // Evidence-based recovery only. A stale anchor can be re-anchored on the
    // same chat; without a full prompt that re-run would silently drop every
    // earlier turn the trim had left to upstream memory, so it is not
    // attempted then — the error surfaces instead.
    const canRecoverAnchor = Boolean(input.recoveryContent)

    try {
      // Pre-stream setup is retried once for transient failures; a confirmed
      // dead chat is handled below without a blind retry.
      let setupError: unknown
      let staleChat = false
      let staleAnchor = false
      let inProgressWaits = 0
      let stopRequested = false
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const chatCreatedNow = !chatId
          if (!chatId) {
            chatId = thread.providerId ?? (await this.createChat(model, signal))
            thread.providerId = chatId
            this.store.put(thread)
          }
          trace("chat ready", { created: chatCreatedNow })
          const parentId = (lastAnchored(thread)?.providerState?.responseId as string | undefined) ?? null
          const payload = buildCompletionPayload({
            prompt: content,
            model,
            chatId,
            parentId,
            files: state.files,
            reasoningMode: input.reasoningMode,
            chatMode: this.chatMode,
            toolMode,
            nativeTools,
          })
          const path = `${QWEN_WEB_PATHS.completions}?chat_id=${encodeURIComponent(chatId)}`
          const streamResponse = await this.transport.rawRequestStream("POST", path, {
            body: JSON.stringify(payload),
            signal,
            reasoning: (input.reasoningMode ?? "auto") !== "fast",
            referrer: chatReferrer(chatId),
          })
          trace("request sent")
          await this.ensureStreamable(streamResponse, chatId, signal)
          trace("response usable")
          response = streamResponse
          break
        } catch (error) {
          const failure = withQwenWebErrorPhase(error, "setup")
          setupError = failure
          // A confirmed-dead chat never succeeds on a blind retry, even after
          // the one fresh-chat recovery has already been consumed.
          if (isStaleChatError(failure)) {
            staleChat = true
            break
          }
          // Same for a confirmed-dead anchor: re-sending the identical
          // `parent_id` cannot work. Only the one anchor recovery may retry.
          if (isStaleAnchorError(failure)) {
            staleAnchor = true
            break
          }
          // Chat still generating: wait a bounded number of times (without
          // consuming the setup-retry counter), ask the upstream once to stop
          // the earlier generation when its id is known, then end terminally.
          if (isChatInProgressError(failure)) {
            const wait = this.inProgressBackoffMs[inProgressWaits]
            if (wait === undefined) {
              setupError = chatInProgressExhaustedError({
                status: failure.status,
                attempts: inProgressWaits,
              })
              break
            }
            const earlier = chatId ? this.lastResponseByChat.get(chatId) : undefined
            if (!stopRequested && chatId && earlier) {
              stopRequested = true
              // The stop request can take up to its own 15s timeout; the caller's
              // abort must not wait for it.
              try {
                await raceAbort(this.stopGeneration(chatId, earlier, () => {}), signal)
              } catch (abort) {
                setupError = abort
                break
              }
            }
            inProgressWaits++
            debug("session", "chat still generating; waiting before re-sending", { wait, n: inProgressWaits })
            try {
              await sleepAbortable(wait, signal)
            } catch (abort) {
              setupError = abort
              break
            }
            attempt--
            continue
          }
          if (attempt === 2 || !isPreStreamRetryable(failure)) break
          debug("session", "turn setup failed; retrying once", {
            phase: failure.phase,
            code: failure.code,
            status: failure.status,
            upstreamCode: failure.upstreamCode,
            retryable: failure.retryable,
          })
        }
      }
      // Pre-stream recovery: nothing was delivered, so the rollback is clean.
      if (staleChat && state.allowRecovery) {
        discardDelivery()
        return "recover-fresh-chat"
      }
      if (staleAnchor && state.allowRecovery && canRecoverAnchor) {
        discardAnchoredDelivery()
        return "recover-anchor"
      }
      if (!response) {
        // The user node was never delivered upstream: roll it back, and put
        // an unconsumed seed back so the next turn can still carry it.
        removeById(thread, fid)
        if (seedUsed !== undefined) thread.seedText = seedUsed
        // A binding confirmed dead here must not stay bound to the thread; a
        // dead anchor is dropped while the chat itself stays bound.
        if (isStaleChatError(setupError)) clearChatBinding()
        else if (isStaleAnchorError(setupError)) clearAnchors()
        this.store.put(thread)
        if (QwenWebError.isInstance(setupError) && setupError.code === "challenge") {
          // A challenge is a manual pause, not evidence of an expired chat.
          // Preserve its binding/anchor for a user-directed retry, and never
          // resubmit a prompt that may already have been accepted upstream.
          throw await this.enrichChallenge(setupError, signal)
        }
        throw setupError
      }

      const parser = new StreamingToolParser({ declared: declaredTools })
      const sse = new QwenWebSSEParser()
      const decoder = new TextDecoder()
      const reader = response.stream.getReader()
      let responseId: string | undefined
      let textAccumulated = ""
      let reasoningAccumulated = ""
      let stopping = false
      let upstreamDone = false
      let toolCallCount = 0
      let usage: WebChatUsage | undefined
      let thinkingOpen = false
      let textOpen = false
      let firstChunkSeen = false
      let firstEventSeen = false
      let deltaLogged = false
      // True once any output or metadata event reached the caller (response-metadata,
      // usage, thinking, text, or tool-call). A fresh-chat recovery is only seamless
      // while this is false (pre-stream setup errors or immediate stream error before
      // any event): once an event like response-metadata is yielded, the caller
      // (such as LanguageModelV3StreamPart) has already observed stream identity that
      // a silent re-run would duplicate or contradict (issue 238).
      let emitted = false
      const traceFirstDelta = (kind: string): void => {
        if (deltaLogged) return
        deltaLogged = true
        trace(`first delta (${kind})`)
      }
      const textParts: string[] = []
      const toolCalls: Array<{ id: string; name: string; args: unknown }> = []

      const teardownUpstream = () => {
        try { reader.cancel().catch(() => {}) } catch {}
        try { response?.abort() } catch {}
      }
      const stopUpstream = () => {
        if (stopping) return
        stopping = true
        teardownUpstream()
        if (chatId && responseId) {
          // Remote stop independent; local cleanup already done above.
          // Passing no-op abortLocal avoids double-cancel; stopGeneration calls its own.
          void this.stopGeneration(chatId, responseId, () => {}).catch(() => {})
        }
      }
      const onAbort = () => stopUpstream()
      if (signal) {
        if (signal.aborted) {
          stopUpstream()
        } else {
          signal.addEventListener("abort", onAbort, { once: true })
          listener = onAbort
        }
      }

      const endThinking = function* (): Generator<WebChatEvent> {
        if (thinkingOpen) {
          thinkingOpen = false
          yield { type: "thinking-end" }
        }
      }
      const endText = function* (): Generator<WebChatEvent> {
        if (textOpen) {
          textOpen = false
          yield { type: "text-end" }
        }
      }

      const emitToolCall = function* (id: string, name: string, args: unknown): Generator<WebChatEvent> {
        yield* endThinking()
        yield* endText()
        toolCallCount++
        emitted = true
        toolCalls.push({ id, name, args })
        yield { type: "tool-call", id, name, args }
      }

      // Adopt an authoritative upstream chat id the moment upstream reports
      // it. When it differs from the id we addressed, the local binding was
      // stale or the chat was rotated, and every later turn must use what
      // upstream said. Persisted immediately: a crash mid-turn must not leave
      // the stale id behind for the next process to pick up.
      const adoptChatId = (candidate: string | undefined) => {
        if (!candidate || candidate === thread.providerId) return
        debug("session", "adopting upstream chat id", {
          thread: thread.id,
          from: thread.providerId?.slice(0, 12),
          to: candidate.slice(0, 12),
        })
        // Re-key the stop bookkeeping too: this response belongs to the chat
        // future turns will address, not to the stale id.
        if (chatId) lastResponseByChat.delete(chatId)
        chatId = candidate
        thread.providerId = candidate
        // Carry any response id already seen over to the adopted chat, so a
        // stop request can still reach this generation.
        if (responseId) lastResponseByChat.set(candidate, responseId)
        this.store.put(thread)
      }

      const handleEvent = function* (event: QwenWebStreamEvent): Generator<WebChatEvent> {
        // A rotated chat id can arrive on any event (chunk-level `chat_id`),
        // not only on `response.created`.
        if ("chatId" in event) adoptChatId(event.chatId)
        switch (event.kind) {
          case "done":
          case "answer-finished":
            upstreamDone = true
            return
          case "response-created":
            if (!responseId) {
              responseId = event.responseId
              // Bookkept against the (possibly just adopted) live chat id.
              if (chatId) lastResponseByChat.set(chatId, event.responseId)
              emitted = true
              yield { type: "response-metadata", responseId: event.responseId }
            }
            return
          case "error":
            throw classifyStreamError(event.code, event.message, response?.status)
          case "usage":
            usage = {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              totalTokens: event.totalTokens,
              cacheRead: event.cachedTokens,
              reasoningTokens: event.reasoningTokens,
              textTokens: event.textTokens,
            }
            emitted = true
            yield { type: "usage", usage }
            return
          case "tool-calls": {
            // Experimental native path: delta `tool_calls` arrivals, one call
            // per event. Partial-argument accumulation is not attempted.
            if (responseId && event.responseId && event.responseId !== responseId) return
            for (const call of event.calls) {
              yield* emitToolCall(call.id ?? `call_${randomId()}`, call.name ?? "unknown", parseToolArgs(call.arguments))
            }
            return
          }
          case "thinking": {
            if (responseId && event.responseId && event.responseId !== responseId) return
            const formatted = formatThinkingSummary(event.delta)
            if (!formatted) return
            const result = incrementalDelta(reasoningAccumulated, formatted)
            if (result.delta === "FINISHED") return
            reasoningAccumulated = result.matched
            if (!result.delta) return
            if (!thinkingOpen) {
              thinkingOpen = true
              yield* endText()
              traceFirstDelta("thinking")
              emitted = true
              yield { type: "thinking-start" }
            }
            emitted = true
            yield { type: "thinking-delta", delta: result.delta }
            return
          }
          case "text": {
            if (responseId && event.responseId && event.responseId !== responseId) return
            if (event.responseId && !responseId) responseId = event.responseId
            const result = incrementalDelta(textAccumulated, event.content)
            if (result.delta === "FINISHED") return
            textAccumulated = result.matched
            if (!result.delta) return
            const parsed = parser.push(result.delta)
            if (parsed.text) {
              if (!textOpen) {
                textOpen = true
                yield* endThinking()
                emitted = true
                yield { type: "text-start" }
              }
              textParts.push(parsed.text)
              traceFirstDelta("text")
              emitted = true
              yield { type: "text-delta", delta: parsed.text }
            }
            for (const call of parsed.toolCalls) {
              yield* emitToolCall(call.id, call.name, parseToolArgs(call.input))
            }
            return
          }
          case "unknown":
            return
        }
      }

      let failure: unknown
      try {
        for (;;) {
          if (signal?.aborted) {
            teardownUpstream()
            throw abortedError("stop")
          }
          const { done, value } = await reader.read()
          if (done || !value) break
          if (!firstChunkSeen) {
            firstChunkSeen = true
            trace("first chunk")
          }
          const events = sse.feed(decoder.decode(value, { stream: true }))
          for (const event of events) {
            if (upstreamDone) break
            if (!firstEventSeen) {
              firstEventSeen = true
              trace("first event", { kind: event.kind })
            }
            yield* handleEvent(event)
          }
          if (upstreamDone) break
        }
        if (!upstreamDone) {
          const tail = decoder.decode()
          const events = [...(tail ? sse.feed(tail) : []), ...sse.flush()]
          for (const event of events) {
            if (upstreamDone) break
            yield* handleEvent(event)
          }
        }
      } catch (error) {
        if (QwenWebError.isInstance(error) && error.code === "challenge") {
          // Mid-stream challenge: open a visible window when possible, and
          // say exactly what happened instead of promising a window. Keep the
          // anchor: a challenge does not prove the chat is dead, and this path
          // never silently replays the possibly accepted prompt.
          failure = await this.enrichChallenge(error, signal)
        } else if (isAbortLike(error) || signal?.aborted) {
          failure = abortedError("stop")
        } else if (isStallTimeout(error)) {
          // The upstream went quiet without a terminating event. Recover the
          // unclosed tail and end gracefully so tool calls already emitted are
          // still usable instead of the turn wedging forever.
          stopUpstream()
        } else {
          failure = withQwenWebErrorPhase(error, "stream")
        }
      }

      if (failure && isStaleBindingError(failure)) {
        // The upstream binding broke mid-turn: release the local stream. With
        // no output emitted yet, roll the delivery back and recover — a fresh
        // chat for a dead chat, an unanchored re-run for a dead anchor.
        // Otherwise surface the error, but still drop what was confirmed
        // dead so the next turn starts from a valid binding.
        await reader.cancel().catch(() => {})
        response?.abort()
        if (!emitted && state.allowRecovery) {
          if (isStaleChatError(failure)) {
            discardDelivery()
            return "recover-fresh-chat"
          }
          if (canRecoverAnchor) {
            discardAnchoredDelivery()
            return "recover-anchor"
          }
        }
        if (isStaleChatError(failure)) clearChatBinding()
        else clearAnchors()
        this.store.put(thread)
      }

      const graceful = !failure || isStallTimeout(failure)
      if (graceful) {
        const flushed = parser.flush()
        if (flushed.text) {
          if (!textOpen) {
            textOpen = true
            yield* endThinking()
            yield { type: "text-start" }
          }
          textParts.push(flushed.text)
          yield { type: "text-delta", delta: flushed.text }
        }
        for (const call of flushed.toolCalls) {
          yield* emitToolCall(call.id, call.name, parseToolArgs(call.input))
        }
        yield* endThinking()
        yield* endText()
        // An empty turn is a failure, not a stop: committing it would hand
        // the caller a silent "finished" with an empty assistant message.
        if (textParts.length === 0 && toolCalls.length === 0 && !textAccumulated && !reasoningAccumulated) {
          removeById(thread, fid)
          if (seedUsed !== undefined) thread.seedText = seedUsed
          this.store.put(thread)
          yield { type: "error", error: failure ?? emptyResponseError() }
          trace("turn done", { failure: true, empty: true })
          yield { type: "done", thread }
          return "finished"
        }
        const finishReason: "stop" | "tool-calls" = toolCallCount > 0 ? "tool-calls" : "stop"
        yield { type: "finish", finishReason }
        append(
          thread,
          buildAssistantMessage({
            responseId,
            text: textAccumulated,
            textParts,
            toolCalls,
            usage,
            createdAt: Date.now(),
          }),
        )
      } else {
        if (isAbortLike(failure) || signal?.aborted) {
          teardownUpstream()
        }
        yield* endThinking()
        yield* endText()
        // Abort-like errors should be filtered by caller/ UI; never emit undefined.
        yield { type: "error", error: failure ?? new Error("session turn failed") }
      }
      this.store.put(thread)
      trace("turn done", { failure: Boolean(failure) })
      yield { type: "done", thread }
      return "finished"
    } finally {
      if (listener && signal) signal.removeEventListener("abort", listener)
    }
  }

  /**
   * Rewrite a message's content in place. Editing a user node keeps its id, so
   * future forks/anchors stay stable; the server-side rewrite is best-effort
   * (wire validation is a separate spike), so this is marked on the node.
   */
  async editMessage(input: WebChatEditInput): Promise<WebChatThread> {
    const { thread, messageId, content } = input
    const message = byId(thread, messageId)
    if (!message) {
      throw new QwenWebError({
        code: "invalid_response",
        retryable: false,
        message: `Cannot edit message "${messageId}": not part of the thread.`,
      })
    }
    message.content = content
    message.parts = [{ type: "text", text: content }, ...message.parts.filter((part) => part.type !== "text")]
    message.providerState = { ...message.providerState, editedLocally: true }
    thread.updatedAt = Date.now()
    this.store.put(thread)
    debug("session", "edited message (local mirror; server-side write pending wire validation)", {
      thread: thread.id,
      messageId,
    })
    return thread
  }

  /** Fork a thread into a new empty chat; `seed` seeds the first turn. */
  async forkThread(input: WebChatForkInput): Promise<WebChatThread> {
    const now = Date.now()
    const thread: WebChatThread = {
      id: `qwen-web:${input.thread.model}:fork:${randomId()}`,
      model: input.thread.model,
      title: input.thread.title ? `${input.thread.title} (fork)` : undefined,
      seedText: input.seed,
      messages: [],
      createdAt: now,
      updatedAt: now,
    }
    this.store.put(thread)
    debug("session", "forked thread", { from: input.thread.id, to: thread.id, seed: Boolean(input.seed) })
    return thread
  }

  /** Local threads are authoritative for SilverCode's own turns; the upstream
   * reconcile (`GET chat`) is a separate wire spike. */
  async readThread(input: { thread: WebChatThread }): Promise<WebChatThread> {
    return this.store.get(input.thread.id) ?? input.thread
  }

  /** Drop the local thread. The upstream chat delete is a separate spike. */
  async deleteThread(input: { thread: WebChatThread }): Promise<void> {
    debug("session", "deleted thread (local); upstream chat delete is a separate spike", { thread: input.thread.id })
    this.store.remove(input.thread.id)
  }

  /** The shared browser/transport own their lifecycle; nothing to release. */
  async stop(): Promise<void> {
    debug("session", "stop() called; shared transport lifecycle owned elsewhere", {})
  }

  /** Reveal a headed window for a challenge; returns the detail naming what happened. */
  private async challengeDetail(signal?: AbortSignal): Promise<string> {
    const revealed = await this.transport.revealChallengeWindow(signal).catch(() => false)
    return revealed ? CHALLENGE_WINDOW_OPEN_DETAIL : CHALLENGE_NO_WINDOW_DETAIL
  }

  /**
   * Attach the reveal detail to a challenge error exactly once. The same
   * error object can pass several sites (pre-stream throw -> setup-loop
   * rethrow), and the reveal (headed relaunch) must run only once.
   */
  private async enrichChallenge(error: QwenWebError, signal?: AbortSignal): Promise<QwenWebError> {
    if (enrichedChallenges.has(error)) return error
    enrichedChallenges.add(error)
    error.message += ` ${await this.challengeDetail(signal)}`
    return error
  }

  private async ensureStreamable(
    response: { status: number; contentType: string; stream: ReadableStream<Uint8Array>; abort: () => void },
    chatId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const contentType = response.contentType.toLowerCase()
    if (
      response.status >= 200 &&
      response.status < 300 &&
      (contentType.includes("text/event-stream") || contentType === "")
    )
      return
    // Non-streaming response: drain a bounded preview to classify the failure.
    const preview = await readPreview(response.stream, 8192).catch(() => "")
    response.abort()
    debug("session", "non-SSE completion response", {
      status: response.status,
      contentType,
    })
    if (isChallengeMessage(preview))
      throw await this.enrichChallenge(
        challengeError(undefined, response.status, { upstreamCode: "waf_challenge" }),
        signal,
      )
    if (isHtmlBody(preview) || contentType.includes("text/html")) {
      throw sessionExpiredError("Qwen returned a login page instead of a stream.", response.status === 403 ? 403 : 401)
    }
    if (contentType.includes("application/json") || preview.trimStart().startsWith("{")) {
      const classified = classifyJsonError(preview, response.status, "setup")
      if (classified) throw classified
      // The preview is bounded: oversized JSON error bodies arrive truncated
      // and fail to parse. Salvage only a safe, bounded diagnostic — the raw
      // body may contain request context and is never copied to the error.
      throw classifyTruncatedJson(preview, response.status, "setup")
    }
    throw classifyStatus(response.status, undefined, "setup") ?? nonStreamResponseError(preview, response.status, "setup")
  }
}

function chatReferrer(chatId: string): string {
  return `/c/${encodeURIComponent(chatId)}`
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

async function readPreview(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || !value) break
      chunks.push(value)
      bytes += value.byteLength
      if (bytes >= maxBytes) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const merged = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

function readChatModeDefault(): QwenWebChatMode {
  const raw = process.env[QWEN_WEB_ENV.chatMode]?.toLowerCase()
  if (raw === "thread" || raw === "thread-explicit") {
    debug("session", "THREAD MODE ENABLED — shares upstream Qwen conversation across turns. This can leak context between unrelated SilverCode sessions using the same Qwen account. Use QWEN_WEB_CHAT_MODE=thread-explicit to acknowledge.")
  }
  return raw === "thread-explicit" ? "thread" : "temp"
}

function readToolModeDefault(): QwenWebToolMode {
  return process.env[QWEN_WEB_ENV.toolMode]?.toLowerCase() === "native" ? "native" : "block"
}

function isPreStreamRetryable(error: unknown): boolean {
  if (isAbortLike(error)) return false
  if (!QwenWebError.isInstance(error)) return false
  if (error.code === "login_required" || error.code === "session_expired" || error.code === "challenge") return false
  return error.retryable
}

/**
 * Repair a persisted thread's binding pair before the turn uses it.
 *
 * Returns `true` when anything changed. A thread file can be written by
 * another process or an older build, and may carry a blank chat id or a blank
 * continuation anchor: left alone both look like a live binding and would be
 * sent upstream as one.
 */
function sanitizeBinding(thread: WebChatThread): boolean {
  let changed = false
  if (typeof thread.providerId === "string") {
    const trimmed = thread.providerId.trim()
    if (!trimmed) {
      thread.providerId = undefined
      changed = true
    } else if (trimmed !== thread.providerId) {
      thread.providerId = trimmed
      changed = true
    }
  } else if (thread.providerId !== undefined) {
    thread.providerId = undefined
    changed = true
  }
  for (const message of thread.messages) {
    const state = message.providerState
    if (!state) continue
    const responseId = state["responseId"]
    if (responseId === undefined) continue
    if (typeof responseId !== "string" || !responseId.trim()) {
      const rest = { ...state }
      delete rest["responseId"]
      message.providerState = Object.keys(rest).length > 0 ? rest : undefined
      changed = true
    } else if (responseId !== responseId.trim()) {
      // A padded anchor is the same class of junk binding as a blank one:
      // store the trimmed id rather than sending it upstream verbatim.
      message.providerState = { ...state, responseId: responseId.trim() }
      changed = true
    }
  }
  return changed
}

function parseToolArgs(raw: string | undefined): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { _raw: raw }
  }
}

function toNativeTools(tools: WebChatTool[]): QwenNativeTool[] | undefined {
  if (tools.length === 0) return undefined
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? { type: "object", properties: {} },
  }))
}

function buildAssistantMessage(input: {
  responseId?: string
  text: string
  textParts: string[]
  toolCalls: Array<{ id: string; name: string; args: unknown }>
  usage?: WebChatUsage
  createdAt: number
}): WebChatMessage {
  const parts: WebChatPart[] = []
  if (input.textParts.length > 0) parts.push({ type: "text", text: input.textParts.join("") })
  for (const call of input.toolCalls) parts.push({ type: "tool-call", id: call.id, name: call.name, args: call.args })
  const message: WebChatMessage = {
    id: `assistant-${randomId()}`,
    role: "assistant",
    content: input.text,
    parts,
    createdAt: input.createdAt,
  }
  if (input.responseId) message.providerState = { responseId: input.responseId }
  else message.providerState = { usage: input.usage }
  return message
}

// ---------------------------------------------------------------------------
// Stream consumption: SSE events -> ordered text / reasoning / usage deltas.
// ---------------------------------------------------------------------------

export interface ConsumedStream {
  text: string
  reasoning: string
  responseId?: string
  chatId?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cachedTokens?: number
    reasoningTokens?: number
    textTokens?: number
  }
  finishReason: "stop" | "length" | "error"
  error?: QwenWebError
}

export interface StreamConsumerEvents {
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
  onResponseCreated?: (responseId: string, chatId?: string) => void
  onUsage?: (usage: NonNullable<ConsumedStream["usage"]>) => void
}

/**
 * Consume a raw upstream byte stream into ordered deltas.
 *
 * Cumulative `content` updates are prefix-diffed; a `FINISHED` sentinel and
 * empty deltas are swallowed; only events for the first observed response id
 * are honored (the upstream may interleave auxiliary streams).
 */
export async function consumeQwenStream(
  stream: ReadableStream<Uint8Array>,
  events?: StreamConsumerEvents,
  signal?: AbortSignal,
): Promise<ConsumedStream> {
  const parser = new QwenWebSSEParser()
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let text = ""
  let reasoning = ""
  let responseId: string | undefined
  let chatId: string | undefined
  let usage: ConsumedStream["usage"]
  let streamError: QwenWebError | undefined
  let terminated = false

  const handle = (event: QwenWebStreamEvent): void => {
    switch (event.kind) {
      case "done":
      case "answer-finished":
        terminated = true
        return
      case "response-created":
        if (!responseId) responseId = event.responseId
        if (event.chatId) chatId = event.chatId
        events?.onResponseCreated?.(event.responseId, event.chatId)
        return
      case "error":
        streamError =
          classifyJsonError(JSON.stringify({ error: { code: event.code, message: event.message } }), 200, "stream") ??
          classifyStreamError(event.code, event.message, 200)
        terminated = true
        return
      case "usage":
        usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.totalTokens,
          cachedTokens: event.cachedTokens,
          reasoningTokens: event.reasoningTokens,
          textTokens: event.textTokens,
        }
        events?.onUsage?.(usage)
        return
      case "thinking": {
        if (responseId && event.responseId && event.responseId !== responseId) return
        const formatted = formatThinkingSummary(event.delta)
        if (!formatted) return
        const result = incrementalDelta(reasoning, formatted)
        if (result.delta === "FINISHED") return
        reasoning = result.matched
        if (result.delta) events?.onReasoning?.(result.delta)
        return
      }
      case "text": {
        if (responseId && event.responseId && event.responseId !== responseId) return
        if (event.responseId && !responseId) responseId = event.responseId
        const result = incrementalDelta(text, event.content)
        if (result.delta === "FINISHED") return
        text = result.matched
        if (result.delta) events?.onText?.(result.delta)
        return
      }
      case "unknown":
        return
    }
  }

  try {
    for (;;) {
      if (signal?.aborted) throw abortedError("stop")
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const events = parser.feed(decoder.decode(value, { stream: true }))
      for (const event of events) {
        handle(event)
        if (terminated) break
      }
      if (terminated) break
    }
    if (!terminated) {
      const tail = decoder.decode()
      const events = [...(tail ? parser.feed(tail) : []), ...parser.flush()]
      for (const event of events) {
        handle(event)
        if (terminated) break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  if (streamError) {
    return { text, reasoning, responseId, chatId, usage, finishReason: "error", error: streamError }
  }
  return { text, reasoning, responseId, chatId, usage, finishReason: "stop" }
}