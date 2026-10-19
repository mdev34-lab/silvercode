/**
 * Canonical data model for the webchat backbone.
 *
 * A webchat provider owns server-side threaded conversations (like Qwen
 * Chat's message tree). SilverCode's model layer talks to each provider in
 * these terms instead of per-turn ephemeral chats: turns are incremental
 * ops on a persistent thread, tool calls are first-class nodes, and the
 * thread can be edited or forked without recreating a conversation from
 * scratch.
 *
 * The types here are provider-neutral. Qwen specifics (fids, response ids,
 * upstream payloads) live in the adapter's own modules and are bridged into
 * `WebChatMessage.providerState`.
 */

export type WebChatRole = "user" | "assistant" | "tool" | "system"

export interface WebChatTextPart {
  type: "text"
  text: string
}

export interface WebChatToolCallPart {
  type: "tool-call"
  id: string
  name: string
  /** Parsed JSON arguments (never the raw string). */
  args: unknown
}

export interface WebChatToolResultPart {
  type: "tool-result"
  id: string
  name: string
  output: string
}

export type WebChatPart = WebChatTextPart | WebChatToolCallPart | WebChatToolResultPart

export interface WebChatMessage {
  /** Stable node id, unique within the thread (upstream `fid` for Qwen). */
  id: string
  role: WebChatRole
  /** Flat textual view of the message (union of parts with tool framing). */
  content: string
  parts: WebChatPart[]
  /**
   * Opaque provider continuation state carried on this node (for Qwen: the
   * `responseId` of an assistant node, used as the next turn's `parent_id`).
   */
  providerState?: Record<string, unknown>
  createdAt?: number
}

/**
 * Provenance cursor for the upstream transcript mirror.
 *
 * Recorded by the model layer when a turn commits: `fingerprint` covers the
 * exact conversation transcript (rendered prompt minus system messages, plus
 * media descriptors) that the bound upstream chat is believed to mirror at
 * that point. Before a later turn reuses the binding — chaining a trimmed
 * prompt tail onto `providerId` — the caller re-fingerprints its current
 * prompt prefix and compares. A mismatch means local history diverged from
 * the upstream transcript (a provider switch inserted foreign turns, a
 * message was edited, a compaction rewrote history), so the binding must be
 * discarded and the full prompt re-sent on a fresh chat instead of silently
 * dropping context the upstream never saw.
 */
export interface WebChatContextCursor {
  /** Fingerprint of the rendered transcript committed by the last turn. */
  fingerprint: string
  /** Number of prompt messages (system included) the fingerprint covered. */
  messages: number
  /** Epoch ms when the turn that produced this cursor committed. */
  recordedAt: number
}

export interface WebChatThread {
  /** Canonical thread id, stable across processes. */
  id: string
  /** Model id the thread belongs to. */
  model: string
  /** Upstream conversation id (Qwen `chatId`), once created. */
  providerId?: string
  title?: string
  /** First-turn content still pending (used by forks/compaction). */
  seedText?: string
  /** Ordered message list; the last entry is the thread head. */
  messages: WebChatMessage[]
  /**
   * Provenance cursor of the last committed turn (see `WebChatContextCursor`).
   * Verified before the binding is reused; cleared together with the binding
   * when the local transcript diverged from the upstream mirror.
   */
  contextCursor?: WebChatContextCursor
  createdAt: number
  updatedAt: number
}

/** Provider-neutral tool declaration sent on a turn. */
export interface WebChatTool {
  name: string
  description: string
  inputSchema: unknown
}

export interface WebChatTurnInput {
  thread: WebChatThread
  /** Rendered content of this turn only (incremental, not the transcript). */
  content: string
  tools?: WebChatTool[]
  signal?: AbortSignal
}

export interface WebChatUsage {
  inputTokens?: number
  cacheRead?: number
  outputTokens?: number
  textTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

export type WebChatEvent =
  | { type: "thinking-start" }
  | { type: "thinking-delta"; delta: string }
  | { type: "thinking-end" }
  | { type: "text-start" }
  | { type: "text-delta"; delta: string }
  | { type: "text-end" }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "usage"; usage: WebChatUsage }
  | { type: "response-metadata"; responseId?: string }
  | { type: "error"; error: unknown }
  | { type: "finish"; finishReason: "stop" | "tool-calls" }
  /** Terminal event; carries the thread updated through this turn. */
  | { type: "done"; thread: WebChatThread }

export interface WebChatEditInput {
  thread: WebChatThread
  messageId: string
  content: string
}

export interface WebChatForkInput {
  thread: WebChatThread
  /** Optional seed content for the fork's first turn (compaction only). */
  seed?: string
}

export interface WebChatProvider {
  readonly id: string
  createThread(input: { model: string; title?: string }): Promise<WebChatThread>
  /** Run one incremental turn on an existing thread. Yields events; the
   * terminal `done` event carries the updated thread. */
  runTurn(input: WebChatTurnInput): AsyncGenerator<WebChatEvent>
  editMessage(input: WebChatEditInput): Promise<WebChatThread>
  forkThread(input: WebChatForkInput): Promise<WebChatThread>
  /** Reconcile the local thread against the server (best-effort). */
  readThread(input: { thread: WebChatThread }): Promise<WebChatThread>
  deleteThread(input: { thread: WebChatThread }): Promise<void>
  /** Abort any in-flight turn and release provider resources. */
  stop(): Promise<void>
}