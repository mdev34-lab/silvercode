export * as AttachmentStore from "./attachment-store"
export {
  Service,
  type Interface,
  type MaterializeInput,
  type CopyInput,
  type InventoryRow,
} from "./attachment-store/service"

/**
 * Materializes conversation attachments (pasted media, mentioned files, remote
 * URLs) into a managed directory and records the local `path`/`size` on the
 * durable `Prompt.FileAttachment`. This turns the previously opaque attachment
 * URI into bytes the agent can read, reference, and later persist as a project
 * file via the `attachment` tool. Failures degrade gracefully: an attachment
 * that cannot be fetched (or exceeds the size budget) is admitted unchanged and
 * flagged unavailable, preserving durable history.
 */
import path from "path"
import { fileURLToPath } from "url"
import { Duration, Effect, Layer, Schedule } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { LayerNodePlatform } from "./effect/app-node-platform"
import { LocationMutation } from "./location-mutation"
import { PermissionV2 } from "./permission"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Identifier } from "./util/identifier"
import { collectBoundedResponseBody } from "./tool/http-body"
import { SessionSchema } from "./session/schema"
import { SessionStore } from "./session/store"
import { AgentV2 } from "./agent"
import { SessionMessage } from "./session/message"
import { FileAttachment } from "./session/prompt"
import { AttachmentStoreService } from "./attachment-store/service"
import { Database } from "./database/database"
import { MessageTable, PartTable } from "./session/sql"
import { asc, eq } from "drizzle-orm"
import type { SessionV1 } from "./v1/session"

export const MANAGED_DIRECTORY = "attachments"
export const MAX_BYTES = 50 * 1024 * 1024
export const RETENTION = Duration.days(7)

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/aiff": "aiff",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
  "application/json": "json",
  "application/xml": "xml",
  "application/pdf": "pdf",
  "application/zip": "zip",
}

const parseDataUri = (uri: string): { mime: string; base64: boolean; payload: string } | null => {
  const match = uri.match(/^data:([^;,]+)(;[^,]*)?,([\s\S]*)$/)
  if (!match) return null
  return { mime: match[1].toLowerCase(), base64: match[2]?.includes("base64") ?? false, payload: match[3] }
}

const finalMime = (uri: string, declared: string | undefined, name?: string) => {
  const parsed = parseDataUri(uri)
  if (parsed) return parsed.mime
  if (declared && declared !== "application/octet-stream") return declared.toLowerCase()
  const target = uri.startsWith("file://") ? fileURLToPath(uri) : (name ?? uri)
  return FSUtil.mimeType(target)
}

const extensionFor = (mime: string) => EXTENSIONS[mime] ?? "bin"

const sourceOf = (uri: string, kind?: string) => {
  if (kind) return kind
  if (uri.startsWith("data:")) return "paste"
  if (uri.startsWith("http://") || uri.startsWith("https://")) return "url"
  if (uri.startsWith("file://")) return "file"
  return "unknown"
}

type LegacyPartData = Omit<SessionV1.Part, "id" | "sessionID" | "messageID">
type LegacyFilePartData = Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">
const isLegacyFilePart = (part: LegacyPartData): part is LegacyFilePartData => part.type === "file"

const readBytes = (
  fs: FSUtil.Interface,
  location: LocationMutation.Interface,
  permission: PermissionV2.Interface,
  sessionID: SessionSchema.ID,
  agent: AgentV2.ID | undefined,
  uri: string,
) =>
  Effect.gen(function* () {
    const target = yield* location.resolve({ path: fileURLToPath(uri), kind: "file" })
    const external = target.externalDirectory
    const source = { type: "tool" as const, messageID: SessionMessage.ID.create(), callID: "attachment-materialize" }
    if (external)
      yield* permission.assert({
        ...LocationMutation.externalDirectoryPermission(external),
        sessionID,
        agent,
        source,
      })
    yield* permission.assert({
      action: "read",
      resources: [target.resource],
      sessionID,
      agent,
      source,
    })
    const info = yield* fs.stat(target.canonical).pipe(Effect.orElseSucceed(() => undefined))
    const size = info && "size" in info ? Number(info.size) : Number.NaN
    if (Number.isFinite(size) && size > MAX_BYTES)
      return yield* Effect.fail(new Error(`Attachment exceeds the ${MAX_BYTES} byte limit`))
    return yield* fs.readFile(target.canonical)
  })

const fetchBytes = (
  http: HttpClient.HttpClient,
  permission: PermissionV2.Interface,
  sessionID: SessionSchema.ID,
  agent: AgentV2.ID | undefined,
  uri: string,
) =>
  Effect.gen(function* () {
    yield* permission.assert({
      action: "web",
      resources: [uri],
      sessionID,
      agent,
      source: { type: "tool", messageID: SessionMessage.ID.create(), callID: "attachment-materialize" },
    })
    const response = yield* http
      .execute(HttpClientRequest.get(uri))
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))
    const bytes = yield* collectBoundedResponseBody(
      response,
      MAX_BYTES,
      () => new Error(`Attachment exceeds the ${MAX_BYTES} byte limit`),
    )
    return bytes as Uint8Array
  })

const layer = Layer.effect(
  AttachmentStoreService.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const http = yield* HttpClient.HttpClient
    const location = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    const directory = path.join(global.data, MANAGED_DIRECTORY)

    const write = Effect.fn("AttachmentStore.write")(function* (
      sessionID: string,
      id: string,
      mime: string,
      bytes: Uint8Array,
    ) {
      const file = path.join(directory, sessionID, `${id}.${extensionFor(mime)}`)
      yield* fs.ensureDir(path.dirname(file)).pipe(Effect.mapError((cause) => new Error(String(cause))))
      yield* fs.writeFile(file, bytes).pipe(Effect.mapError((cause) => new Error(String(cause))))
      return file
    })

    const sessionStore = yield* SessionStore.Service
    const { db } = yield* Database.Service

    const legacyAttachments = Effect.fn("AttachmentStore.legacyAttachments")(function* (sessionID: SessionSchema.ID) {
      const rows = yield* db
        .select({ id: PartTable.id, part: PartTable.data, message: MessageTable.data })
        .from(PartTable)
        .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
        .where(eq(PartTable.session_id, sessionID))
        .orderBy(asc(PartTable.time_created), asc(PartTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.flatMap((row) => {
        if (row.message.role !== "user" || !isLegacyFilePart(row.part)) return []
        return [{ ...row.part, id: row.id }]
      })
    })

    const managedEntries = (sessionID: SessionSchema.ID) =>
      fs
        .readDirectoryEntries(path.join(directory, sessionID))
        .pipe(Effect.orElseSucceed(() => [] as { name: string }[]))

    const managedFile = (entries: ReadonlyArray<{ name: string }>, id: string) =>
      entries.find((entry) => entry.name === `${id}${path.extname(entry.name)}`)

    const managedSize = (sessionID: SessionSchema.ID, entry: { name: string } | undefined) =>
      entry
        ? fs.stat(path.join(directory, sessionID, entry.name)).pipe(
            Effect.map((info) => ("size" in info ? Number(info.size) : undefined)),
            Effect.orElseSucceed(() => undefined),
          )
        : Effect.succeed(undefined)

    const materialize = Effect.fn("AttachmentStore.materialize")(function* (
      input: AttachmentStoreService.MaterializeInput,
    ) {
      const { attachment } = input
      const id = attachment.id ?? Identifier.ascending()
      const mime = finalMime(attachment.uri, undefined, attachment.name)
      const fallback = () =>
        FileAttachment.create({
          id,
          uri: attachment.uri,
          mime,
          name: attachment.name,
          description: attachment.description,
          source: attachment.source,
        })
      return yield* Effect.gen(function* () {
        let bytes: Uint8Array | undefined
        if (attachment.uri.startsWith("data:")) {
          const parsed = parseDataUri(attachment.uri)
          bytes = parsed
            ? parsed.base64
              ? Buffer.from(parsed.payload, "base64")
              : Buffer.from(decodeURIComponent(parsed.payload), "utf8")
            : Buffer.from([])
        } else if (attachment.uri.startsWith("http://") || attachment.uri.startsWith("https://")) {
          bytes = yield* fetchBytes(http, permission, input.sessionID, input.agent, attachment.uri)
        } else if (attachment.uri.startsWith("file://")) {
          bytes = yield* readBytes(fs, location, permission, input.sessionID, input.agent, attachment.uri)
        } else {
          return fallback()
        }
        if (bytes.length > MAX_BYTES) return fallback()
        const file = yield* write(input.sessionID, id, mime, bytes)
        return FileAttachment.create({
          id,
          uri: attachment.uri,
          mime,
          name: attachment.name,
          description: attachment.description,
          source: attachment.source,
          path: file,
          size: bytes.length,
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.log(`attachment materialization failed: ${String(error)}`).pipe(
            Effect.andThen(() => Effect.succeed(fallback())),
          ),
        ),
      )
    })

    const inventory = Effect.fn("AttachmentStore.inventory")(function* (sessionID: SessionSchema.ID) {
      const [messages, legacy, entries] = yield* Effect.all([
        sessionStore.context(sessionID).pipe(Effect.orDie),
        legacyAttachments(sessionID),
        managedEntries(sessionID),
      ])
      const canonical = messages
        .filter((message): message is Extract<typeof message, { type: "user" }> => message.type === "user")
        .flatMap((message) => message.files ?? [])
        .filter((attachment): attachment is FileAttachment & { id: string } => attachment?.id !== undefined)

      const rows = new Map<string, AttachmentStoreService.InventoryRow>()
      for (const attachment of canonical) {
        const managed = managedFile(entries, attachment.id)
        const size = yield* managedSize(sessionID, managed)
        rows.set(attachment.id, {
          id: attachment.id,
          name: attachment.name,
          mime: attachment.mime,
          source: sourceOf(attachment.uri),
          size: size ?? attachment.size,
          unavailable: managed ? undefined : true,
        })
      }
      for (const attachment of legacy) {
        if (rows.has(attachment.id)) continue
        const managed = managedFile(entries, attachment.id)
        rows.set(attachment.id, {
          id: attachment.id,
          name: attachment.filename,
          mime: attachment.mime,
          source: sourceOf(attachment.url, attachment.source?.type),
          size: yield* managedSize(sessionID, managed),
          unavailable: managed ? undefined : true,
        })
      }
      return [...rows.values()]
    })

    const copyTo = Effect.fn("AttachmentStore.copyTo")(function* (input: AttachmentStoreService.CopyInput) {
      const target = yield* location
        .resolve({ path: input.target, kind: "file" })
        .pipe(Effect.mapError((error) => new Error(String(error))))
      const external = target.externalDirectory
      const source = { type: "tool" as const, messageID: SessionMessage.ID.create(), callID: input.id }
      if (external)
        yield* permission.assert({
          ...LocationMutation.externalDirectoryPermission(external),
          sessionID: input.sessionID,
          agent: input.agent,
          source,
        })
      yield* permission.assert({
        action: "edit",
        resources: [target.resource],
        save: ["*"],
        sessionID: input.sessionID,
        agent: input.agent,
        source,
      })
      let entries = yield* managedEntries(input.sessionID)
      let match = managedFile(entries, input.id)
      if (!match) {
        const attachment = (yield* legacyAttachments(input.sessionID)).find((item) => item.id === input.id)
        if (attachment) {
          yield* materialize({
            sessionID: input.sessionID,
            agent: input.agent,
            attachment: {
              id: attachment.id,
              uri: attachment.url,
              name: attachment.filename,
            },
          })
          entries = yield* managedEntries(input.sessionID)
          match = managedFile(entries, input.id)
        }
      }
      if (!match) return yield* Effect.fail(new Error(`Attachment ${input.id} not found in managed store`))
      const bytes = yield* fs
        .readFile(path.join(directory, input.sessionID, match.name))
        .pipe(Effect.mapError((cause) => new Error(String(cause))))
      yield* fs.ensureDir(path.dirname(target.canonical)).pipe(Effect.mapError((cause) => new Error(String(cause))))
      yield* fs.writeFile(target.canonical, bytes).pipe(Effect.mapError((cause) => new Error(String(cause))))
      return { resource: target.resource }
    })

    const cleanup = Effect.fn("AttachmentStore.cleanup")(function* () {
      const entries = yield* fs.readDirectoryEntries(directory).pipe(Effect.catch(() => Effect.succeed([])))
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      for (const entry of entries) {
        if (entry.type !== "directory") continue
        const sub = path.join(directory, entry.name)
        const files = yield* fs.readDirectoryEntries(sub).pipe(Effect.catch(() => Effect.succeed([])))
        for (const file of files) {
          const full = path.join(sub, file.name)
          const info = yield* fs.stat(full).pipe(Effect.orElseSucceed(() => undefined))
          const modified = info && "mtimeMs" in info ? Number(info.mtimeMs) : 0
          if (modified !== 0 && modified < cutoff) yield* fs.remove(full).pipe(Effect.catch(() => Effect.void))
        }
      }
    })

    return AttachmentStoreService.Service.of({ materialize, inventory, copyTo, cleanup })
  }),
)

export const node = makeLocationNode({
  service: AttachmentStoreService.Service,
  layer,
  deps: [
    FSUtil.node,
    Global.node,
    LocationMutation.node,
    PermissionV2.node,
    LayerNodePlatform.httpClient,
    SessionStore.node,
    Database.node,
  ],
})

/** Runs retention scanning once globally rather than once per active Location. */
const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const directory = path.join(global.data, MANAGED_DIRECTORY)
    const prune = Effect.gen(function* () {
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      for (const entry of yield* fs
        .readDirectoryEntries(directory)
        .pipe(Effect.orElseSucceed(() => [] as { name: string; type?: string }[]))) {
        if (entry.type !== "directory") continue
        const sub = path.join(directory, entry.name)
        for (const file of yield* fs
          .readDirectoryEntries(sub)
          .pipe(Effect.orElseSucceed(() => [] as { name: string }[]))) {
          const full = path.join(sub, file.name)
          const info = yield* fs.stat(full).pipe(Effect.orElseSucceed(() => undefined))
          const modified = info && "mtimeMs" in info ? Number(info.mtimeMs) : 0
          if (modified !== 0 && modified < cutoff) yield* fs.remove(full).pipe(Effect.ignore)
        }
      }
    })
    yield* prune.pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped)
  }),
)

export const cleanupNode = makeGlobalNode({
  name: "attachment-store-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node],
})
