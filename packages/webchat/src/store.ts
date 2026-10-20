/**
 * ThreadStore persists threads so a process restart reuses the same upstream
 * chat instead of recreating it. One JSON file (`threads.json`) holds all
 * threads of one provider profile; keys are the canonical thread ids.
 */
import fs from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import type { WebChatThread } from "./types"

export interface ThreadStoreOptions {
  file?: string
}

const DEFAULT_SUBDIR = path.join("webchat", "threads.json")

/**
 * Validate one persisted thread entry, or drop it when it cannot be used.
 *
 * The file is shared state: another process or an older build may have
 * written it, and a thread is only trusted as far as its binding pair goes.
 * An unusable entry (no id, no model, no message list) is discarded; an entry
 * with a blank chat id or a blank continuation anchor is repaired instead —
 * both are downstream of `providerId`/`responseId` and would otherwise be
 * sent upstream as if they were live.
 */
export function sanitizeThread(entry: unknown): WebChatThread | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined
  const thread = entry as Partial<WebChatThread> & { messages?: unknown }
  if (typeof thread.id !== "string" || !thread.id) return undefined
  if (typeof thread.model !== "string" || !thread.model) return undefined
  if (!Array.isArray(thread.messages)) return undefined

  const messages: WebChatThread["messages"] = []
  for (const candidate of thread.messages) {
    const message = sanitizeMessage(candidate)
    if (message) messages.push(message)
  }

  const now = Date.now()
  const createdAt = typeof thread.createdAt === "number" && Number.isFinite(thread.createdAt) ? thread.createdAt : now
  const updatedAt = typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt) ? thread.updatedAt : now
  const providerId =
    typeof thread.providerId === "string" && thread.providerId.trim() ? thread.providerId.trim() : undefined
  const seedText = typeof thread.seedText === "string" && thread.seedText ? thread.seedText : undefined
  // The provenance cursor is load-bearing (sdk.ts verifies it before reusing
  // an upstream binding), so it must survive the load path. Validate like the
  // other optional fields: a malformed cursor is dropped, which fails safe
  // into a rebind.
  const cursor = thread.contextCursor
  const contextCursor =
    cursor &&
    typeof cursor === "object" &&
    !Array.isArray(cursor) &&
    typeof cursor.fingerprint === "string" &&
    cursor.fingerprint &&
    typeof cursor.messages === "number" &&
    Number.isFinite(cursor.messages) &&
    typeof cursor.recordedAt === "number" &&
    Number.isFinite(cursor.recordedAt)
      ? { fingerprint: cursor.fingerprint, messages: cursor.messages, recordedAt: cursor.recordedAt }
      : undefined
  return {
    id: thread.id,
    model: thread.model,
    messages,
    createdAt,
    updatedAt,
    ...(providerId ? { providerId } : {}),
    ...(typeof thread.title === "string" && thread.title ? { title: thread.title } : {}),
    ...(seedText ? { seedText } : {}),
    ...(contextCursor ? { contextCursor } : {}),
  }
}

function sanitizeMessage(candidate: unknown): WebChatThread["messages"][number] | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined
  const message = candidate as Partial<WebChatThread["messages"][number]> & { parts?: unknown }
  if (typeof message.id !== "string" || !message.id) return undefined
  const role = message.role
  if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") return undefined
  const content = typeof message.content === "string" ? message.content : ""
  const parts = Array.isArray(message.parts)
    ? message.parts.filter((part): part is WebChatThread["messages"][number]["parts"][number] => {
        return Boolean(part) && typeof part === "object" && typeof (part as { type?: unknown }).type === "string"
      })
    : []
  let providerState: Record<string, unknown> | undefined
  if (message.providerState && typeof message.providerState === "object" && !Array.isArray(message.providerState)) {
    const state = message.providerState as Record<string, unknown>
    const responseId = state["responseId"]
    const anchorIsUsable = typeof responseId === "string" && responseId.trim()
    const rest = { ...state }
    // Trim padded anchors instead of sending them upstream verbatim.
    if (anchorIsUsable) rest["responseId"] = responseId.trim()
    else delete rest["responseId"]
    if (Object.keys(rest).length > 0) providerState = rest
  }
  return {
    id: message.id,
    role,
    content,
    parts,
    ...(providerState ? { providerState } : {}),
    ...(typeof message.createdAt === "number" && Number.isFinite(message.createdAt)
      ? { createdAt: message.createdAt }
      : {}),
  }
}

export class ThreadStore {
  private readonly file: string
  private readonly threads = new Map<string, WebChatThread>()
  private loaded = false

  constructor(options: ThreadStoreOptions = {}) {
    this.file = options.file ?? path.join(Global.Path.data, DEFAULT_SUBDIR)
  }

  static inDataDir(): ThreadStore {
    return new ThreadStore()
  }

  private open(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = fs.readFileSync(this.file, "utf8")
      const parsed = JSON.parse(raw) as { threads: WebChatThread[] }
      if (parsed && Array.isArray(parsed.threads)) {
        for (const thread of parsed.threads) {
          const usable = sanitizeThread(thread)
          if (usable) this.threads.set(usable.id, usable)
          else {
            // Name the dropped entry (id only, never its content) so schema drift is
            // diagnosable; the next flush rewrites the file without it.
            const id = (thread as { id?: unknown } | null)?.id
            console.error("[webchat] dropped unusable persisted thread", typeof id === "string" ? id : "(no id)")
          }
        }
      }
    } catch {
      // First run / corrupt state: start empty.
    }
  }

  get(id: string): WebChatThread | undefined {
    this.open()
    return this.threads.get(id)
  }

  all(): WebChatThread[] {
    this.open()
    return [...this.threads.values()]
  }

  put(thread: WebChatThread): void {
    this.open()
    this.threads.set(thread.id, thread)
    this.flush()
  }

  remove(id: string): void {
    this.open()
    if (this.threads.delete(id)) this.flush()
  }

  clear(): void {
    this.threads.clear()
    this.flush()
  }

  private flush(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const payload = { threads: [...this.threads.values()] }
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload), "utf8")
      fs.renameSync(tmp, this.file)
    } catch (error) {
      // Persistence is best-effort: a failed disk write must not kill a turn.
      console.error("[webchat] failed to persist threads", error)
    }
  }
}