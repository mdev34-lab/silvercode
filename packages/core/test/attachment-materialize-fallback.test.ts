import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, FileSystem, Layer } from "effect"
import * as PlatformError from "effect/PlatformError"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AttachmentStore } from "@opencode-ai/core/attachment-store"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_attachment_fallback")
const agent = AgentV2.ID.make("work")

interface HarnessOptions {
  readonly workspaceDir: string
  readonly dataDir: string
  readonly stat?: (target: string, base: FSUtil.Interface) => ReturnType<FSUtil.Interface["stat"]>
  readonly readFile?: (target: string, base: FSUtil.Interface) => ReturnType<FSUtil.Interface["readFile"]>
  readonly writeFile?: (
    target: string,
    data: Uint8Array,
    options: Parameters<FSUtil.Interface["writeFile"]>[2],
    base: FSUtil.Interface,
  ) => ReturnType<FSUtil.Interface["writeFile"]>
  readonly assertPermission?: (input: PermissionV2.AssertInput) => ReturnType<PermissionV2.Interface["assert"]>
  readonly httpExecute?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
  readonly messages?: () => ReadonlyArray<SessionMessage.Message>
}

const fsFailure = (method: string, target: string, message: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: target,
    cause: new Error(message),
  })

function makeHarness(options: HarnessOptions) {
  const reads: string[] = []
  const writes: Array<{ readonly path: string; readonly size: number }> = []
  const permissions: PermissionV2.AssertInput[] = []
  const requests: string[] = []

  const controlledFS = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const base = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...base,
        stat: (target) => (options.stat ? options.stat(target, base) : base.stat(target)),
        readFile: (target) => {
          reads.push(target)
          return options.readFile ? options.readFile(target, base) : base.readFile(target)
        },
        writeFile: (target, data, writeOptions) => {
          writes.push({ path: target, size: data.byteLength })
          return options.writeFile
            ? options.writeFile(target, data, writeOptions, base)
            : base.writeFile(target, data, writeOptions)
        },
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

  const controlledPermission = Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      ask: (input) => Effect.succeed({ id: input.id ?? PermissionV2.ID.create(), effect: "allow" }),
      assert: (input) => {
        permissions.push(input)
        return options.assertPermission ? options.assertPermission(input) : Effect.void
      },
      reply: () => Effect.void,
      get: () => Effect.succeed(undefined),
      forSession: () => Effect.succeed([]),
      list: () => Effect.succeed([]),
    }),
  )

  const controlledHttp = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request.url)
      if (options.httpExecute) return options.httpExecute(request)
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok", { status: 200 })))
    }),
  )

  const controlledSessionStore = Layer.succeed(
    SessionStore.Service,
    SessionStore.Service.of({
      get: () => Effect.succeed(undefined),
      context: () => Effect.succeed([...(options.messages?.() ?? [])]),
      runnerContext: () => Effect.succeed([]),
      message: () => Effect.succeed(undefined),
    }),
  )

  const layer = Layer.fresh(
    LayerNode.compile(AttachmentStore.node, [
      [FSUtil.node, controlledFS],
      [Global.node, Global.layerWith({ data: options.dataDir })],
      [
        Location.node,
        Layer.succeed(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(options.workspaceDir) })),
        ),
      ],
      [PermissionV2.node, controlledPermission],
      [LayerNodePlatform.httpClient, controlledHttp],
      [SessionStore.node, controlledSessionStore],
      [Database.node, Database.layerFromPath(":memory:")],
    ]),
  )

  return {
    reads,
    writes,
    permissions,
    requests,
    provide: Effect.provide(layer),
  }
}

function withDirs<A, E, R>(
  run: (dirs: {
    readonly workspaceDir: string
    readonly dataDir: string
    readonly externalDir: string
  }) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const workspaceDir = path.join(tmp.path, "workspace")
        const dataDir = path.join(tmp.path, "data")
        const externalDir = path.join(tmp.path, "external")
        yield* Effect.promise(() =>
          Promise.all([
            fs.mkdir(workspaceDir, { recursive: true }),
            fs.mkdir(dataDir, { recursive: true }),
            fs.mkdir(externalDir, { recursive: true }),
          ]),
        )
        return yield* run({ workspaceDir, dataDir, externalDir })
      }),
    ),
  )
}

describe("AttachmentStore.materialize MIME-less PromptInput fallback contract", () => {
  it.live("materializes valid MIME-less file attachments on success with derived MIME and inventory state", () =>
    withDirs(({ workspaceDir, dataDir }) =>
      Effect.gen(function* () {
        const textPath = path.join(workspaceDir, "note.txt")
        const pngPath = path.join(workspaceDir, "diagram.png")
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
        yield* Effect.promise(() =>
          Promise.all([fs.writeFile(textPath, "hello world"), fs.writeFile(pngPath, pngBytes)]),
        )

        const history: SessionMessage.Message[] = []
        const harness = makeHarness({
          workspaceDir,
          dataDir,
          messages: () => history,
        })

        const textInput = PromptInput.FileAttachment.create({
          id: "att_note",
          uri: pathToFileURL(textPath).href,
          name: "note.txt",
          description: "text note",
          source: { start: 4, end: 13, text: "@note.txt" },
        })
        const pngInput = PromptInput.FileAttachment.create({
          uri: pathToFileURL(pngPath).href,
          name: "diagram.png",
        })
        expect("mime" in textInput).toBe(false)
        expect("mime" in pngInput).toBe(false)

        const { textResult, pngResult, inventory } = yield* Effect.gen(function* () {
          const store = yield* AttachmentStore.Service
          const textMaterialized = yield* store.materialize({
            sessionID,
            agent,
            attachment: textInput,
          })
          const pngMaterialized = yield* store.materialize({
            sessionID,
            agent,
            attachment: pngInput,
          })
          history.push(
            SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_success"),
              type: "user",
              text: "see @note.txt",
              files: [textMaterialized, pngMaterialized],
              time: { created: DateTime.makeUnsafe(0) },
            }),
          )
          return {
            textResult: textMaterialized,
            pngResult: pngMaterialized,
            inventory: yield* store.inventory(sessionID),
          }
        }).pipe(harness.provide)

        expect(harness.reads).toHaveLength(2)
        expect(harness.writes).toHaveLength(2)
        expect(textResult).toEqual({
          id: "att_note",
          uri: pathToFileURL(textPath).href,
          mime: "text/plain",
          name: "note.txt",
          description: "text note",
          source: { start: 4, end: 13, text: "@note.txt" },
          path: path.join(dataDir, AttachmentStore.MANAGED_DIRECTORY, sessionID, "att_note.txt"),
          size: 11,
        })
        expect(yield* Effect.promise(() => fs.readFile(textResult.path!, "utf8"))).toBe("hello world")

        expect(pngResult.id).toBeDefined()
        expect(pngResult.mime).toBe("image/png")
        expect(pngResult.size).toBe(11)
        expect(pngResult.path).toBe(
          path.join(dataDir, AttachmentStore.MANAGED_DIRECTORY, sessionID, `${pngResult.id}.png`),
        )
        expect(harness.permissions.map((entry) => ({ action: entry.action, resources: entry.resources }))).toEqual([
          { action: "read", resources: ["note.txt"] },
          { action: "read", resources: ["diagram.png"] },
        ])
        expect(inventory).toEqual([
          {
            id: "att_note",
            name: "note.txt",
            mime: "text/plain",
            source: "file",
            size: 11,
            unavailable: undefined,
          },
          {
            id: pngResult.id!,
            name: "diagram.png",
            mime: "image/png",
            source: "file",
            size: 11,
            unavailable: undefined,
          },
        ])
      }),
    ),
  )

  it.live("preserves fiber cancellation and inner resource cleanup without degrading into fallback", () =>
    withDirs(({ workspaceDir, dataDir }) =>
      Effect.gen(function* () {
        const slowPath = path.join(workspaceDir, "slow.txt")
        yield* Effect.promise(() => fs.writeFile(slowPath, "hello"))

        const enteredRead = yield* Deferred.make<void>()
        let readCleanedUp = false

        const harness = makeHarness({
          workspaceDir,
          dataDir,
          readFile: () =>
            Deferred.succeed(enteredRead, undefined).pipe(
              Effect.andThen(() => Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  readCleanedUp = true
                }),
              ),
            ),
        })

        const slowInput = PromptInput.FileAttachment.create({
          id: "att_cancel",
          uri: pathToFileURL(slowPath).href,
          name: "slow.txt",
        })

        const exit = yield* Effect.gen(function* () {
          const store = yield* AttachmentStore.Service
          const fiber = yield* Effect.forkChild(store.materialize({ sessionID, agent, attachment: slowInput }))
          yield* Deferred.await(enteredRead)
          yield* Fiber.interrupt(fiber)
          return yield* Fiber.await(fiber)
        }).pipe(harness.provide)

        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(readCleanedUp).toBe(true)
        expect(harness.reads).toHaveLength(1)
        expect(harness.writes).toHaveLength(0)
      }),
    ),
  )

  it.live("degrades gracefully with derived MIME when filesystem read fails on valid MIME-less inputs", () =>
    withDirs(({ workspaceDir, dataDir }) =>
      Effect.gen(function* () {
        const textPath = path.join(workspaceDir, "note.txt")
        const pngPath = path.join(workspaceDir, "diagram.png")
        const binaryPath = path.join(workspaceDir, "archive.unknownext")
        yield* Effect.promise(() =>
          Promise.all([
            fs.writeFile(textPath, "hello world"),
            fs.writeFile(pngPath, "png"),
            fs.writeFile(binaryPath, "raw"),
          ]),
        )

        const history: SessionMessage.Message[] = []
        const harness = makeHarness({
          workspaceDir,
          dataDir,
          readFile: (target) => Effect.fail(fsFailure("readFile", target, "forced read failure")),
          messages: () => history,
        })

        const textInput = PromptInput.FileAttachment.create({
          id: "att_read_fail_txt",
          uri: pathToFileURL(textPath).href,
          name: "note.txt",
          description: "unreadable note",
          source: { start: 0, end: 9, text: "@note.txt" },
        })
        const pngInput = PromptInput.FileAttachment.create({
          uri: pathToFileURL(pngPath).href,
          name: "diagram.png",
          source: { start: 10, end: 22, text: "@diagram.png" },
        })
        const unknownInput = PromptInput.FileAttachment.create({
          id: "att_read_fail_bin",
          uri: pathToFileURL(binaryPath).href,
          name: "archive.unknownext",
        })
        expect("mime" in textInput).toBe(false)
        expect("mime" in pngInput).toBe(false)
        expect("mime" in unknownInput).toBe(false)

        const { textFallback, pngFallback, unknownFallback, inventory, copyExit } = yield* Effect.gen(function* () {
          const store = yield* AttachmentStore.Service
          const first = yield* store.materialize({ sessionID, agent, attachment: textInput })
          const second = yield* store.materialize({ sessionID, agent, attachment: pngInput })
          const third = yield* store.materialize({ sessionID, agent, attachment: unknownInput })

          history.push(
            SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_fallback"),
              type: "user",
              text: "@note.txt @diagram.png",
              files: [first, second, third],
              time: { created: DateTime.makeUnsafe(0) },
            }),
          )

          const rows = yield* store.inventory(sessionID)
          const copy = yield* Effect.exit(
            store.copyTo({
              sessionID,
              agent,
              id: "att_read_fail_txt",
              target: "copied.txt",
            }),
          )

          return {
            textFallback: first,
            pngFallback: second,
            unknownFallback: third,
            inventory: rows,
            copyExit: copy,
          }
        }).pipe(harness.provide)

        expect(harness.reads).toHaveLength(3)
        expect(harness.writes).toHaveLength(0)

        expect(textFallback).toEqual({
          id: "att_read_fail_txt",
          uri: pathToFileURL(textPath).href,
          mime: "text/plain",
          name: "note.txt",
          description: "unreadable note",
          source: { start: 0, end: 9, text: "@note.txt" },
          path: undefined,
          size: undefined,
        })
        expect(pngFallback.id).toBeDefined()
        expect(pngFallback).toEqual({
          id: pngFallback.id,
          uri: pathToFileURL(pngPath).href,
          mime: "image/png",
          name: "diagram.png",
          description: undefined,
          source: { start: 10, end: 22, text: "@diagram.png" },
          path: undefined,
          size: undefined,
        })
        expect(unknownFallback).toEqual({
          id: "att_read_fail_bin",
          uri: pathToFileURL(binaryPath).href,
          mime: "application/octet-stream",
          name: "archive.unknownext",
          description: undefined,
          source: undefined,
          path: undefined,
          size: undefined,
        })

        expect(inventory).toEqual([
          {
            id: "att_read_fail_txt",
            name: "note.txt",
            mime: "text/plain",
            source: "file",
            size: undefined,
            unavailable: true,
          },
          {
            id: pngFallback.id!,
            name: "diagram.png",
            mime: "image/png",
            source: "file",
            size: undefined,
            unavailable: true,
          },
          {
            id: "att_read_fail_bin",
            name: "archive.unknownext",
            mime: "application/octet-stream",
            source: "file",
            size: undefined,
            unavailable: true,
          },
        ])
        expect(Exit.isFailure(copyExit)).toBe(true)
        if (Exit.isFailure(copyExit)) {
          expect(Cause.hasDies(copyExit.cause)).toBe(false)
          expect(String(Cause.squash(copyExit.cause))).toContain("not found in managed store")
        }
      }),
    ),
  )

  it.live("degrades gracefully with derived MIME when managed write or remote HTTP fetch fails", () =>
    withDirs(({ workspaceDir, dataDir }) =>
      Effect.gen(function* () {
        const pngPath = path.join(workspaceDir, "shot.png")
        yield* Effect.promise(() => fs.writeFile(pngPath, Buffer.from([1, 2, 3, 4])))

        const harness = makeHarness({
          workspaceDir,
          dataDir,
          writeFile: (target) => Effect.fail(fsFailure("writeFile", target, "disk full")),
          httpExecute: (request) =>
            request.url.endsWith("/status-503")
              ? Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })))
              : Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      cause: new Error("offline"),
                    }),
                  }),
                ),
        })

        const writeFailInput = PromptInput.FileAttachment.create({
          uri: pathToFileURL(pngPath).href,
          name: "shot.png",
        })
        const httpStatusInput = PromptInput.FileAttachment.create({
          id: "att_http_503",
          uri: "https://example.invalid/files/status-503",
          name: "architecture.pdf",
          source: { start: 0, end: 39, text: "https://example.invalid/files/status-503" },
        })
        const httpTransportInput = PromptInput.FileAttachment.create({
          id: "att_http_err",
          uri: "https://example.invalid/diagram.svg",
        })

        const { writeFallback, httpStatusFallback, httpTransportFallback } = yield* Effect.gen(function* () {
          const store = yield* AttachmentStore.Service
          return {
            writeFallback: yield* store.materialize({ sessionID, agent, attachment: writeFailInput }),
            httpStatusFallback: yield* store.materialize({ sessionID, agent, attachment: httpStatusInput }),
            httpTransportFallback: yield* store.materialize({ sessionID, agent, attachment: httpTransportInput }),
          }
        }).pipe(harness.provide)

        expect(harness.reads).toHaveLength(1)
        expect(harness.writes).toHaveLength(1)
        expect(harness.requests).toEqual([
          "https://example.invalid/files/status-503",
          "https://example.invalid/diagram.svg",
        ])

        expect(writeFallback.id).toBeDefined()
        expect(writeFallback.mime).toBe("image/png")
        expect(writeFallback.path).toBeUndefined()
        expect(writeFallback.size).toBeUndefined()

        expect(httpStatusFallback).toEqual({
          id: "att_http_503",
          uri: "https://example.invalid/files/status-503",
          mime: "application/pdf",
          name: "architecture.pdf",
          description: undefined,
          source: { start: 0, end: 39, text: "https://example.invalid/files/status-503" },
          path: undefined,
          size: undefined,
        })
        expect(httpTransportFallback).toEqual({
          id: "att_http_err",
          uri: "https://example.invalid/diagram.svg",
          mime: "image/svg+xml",
          name: undefined,
          description: undefined,
          source: undefined,
          path: undefined,
          size: undefined,
        })
      }),
    ),
  )

  it.live(
    "preserves external_directory/read permission checks, degrades on blocked rules, and keeps declined defects",
    () =>
      withDirs(({ workspaceDir, dataDir, externalDir }) =>
        Effect.gen(function* () {
          const externalPdf = path.join(externalDir, "outside.pdf")
          yield* Effect.promise(() => fs.writeFile(externalPdf, "%PDF-1.7"))

          const blockedHarness = makeHarness({
            workspaceDir,
            dataDir,
            assertPermission: (input) =>
              input.action === "read"
                ? Effect.fail(
                    new PermissionV2.BlockedError({
                      rules: [{ action: "read", resource: "*", effect: "deny" }],
                    }),
                  )
                : Effect.void,
          })

          const externalInput = PromptInput.FileAttachment.create({
            id: "att_blocked",
            uri: pathToFileURL(externalPdf).href,
            name: "outside.pdf",
            source: { start: 0, end: 12, text: "@outside.pdf" },
          })

          const blockedFallback = yield* Effect.gen(function* () {
            const store = yield* AttachmentStore.Service
            return yield* store.materialize({ sessionID, agent, attachment: externalInput })
          }).pipe(blockedHarness.provide)

          expect(blockedHarness.permissions.map((entry) => entry.action)).toEqual(["external_directory", "read"])
          expect(blockedHarness.reads).toHaveLength(0)
          expect(blockedHarness.writes).toHaveLength(0)
          expect(blockedFallback).toEqual({
            id: "att_blocked",
            uri: pathToFileURL(externalPdf).href,
            mime: "application/pdf",
            name: "outside.pdf",
            description: undefined,
            source: { start: 0, end: 12, text: "@outside.pdf" },
            path: undefined,
            size: undefined,
          })

          const declinedHarness = makeHarness({
            workspaceDir,
            dataDir,
            assertPermission: () => Effect.die(new PermissionV2.DeclinedError()),
          })

          const declinedExit = yield* Effect.exit(
            Effect.gen(function* () {
              const store = yield* AttachmentStore.Service
              return yield* store.materialize({ sessionID, agent, attachment: externalInput })
            }).pipe(declinedHarness.provide),
          )

          expect(Exit.isFailure(declinedExit)).toBe(true)
          if (Exit.isFailure(declinedExit)) {
            expect(Cause.hasDies(declinedExit.cause)).toBe(true)
            expect(Cause.squash(declinedExit.cause)).toBeInstanceOf(PermissionV2.DeclinedError)
          }
          expect(declinedHarness.reads).toHaveLength(0)
          expect(declinedHarness.writes).toHaveLength(0)
        }),
      ),
  )

  it.live("qualifies unsupported-URI branch with derived MIME and zero reads or writes", () =>
    withDirs(({ workspaceDir, dataDir }) =>
      Effect.gen(function* () {
        const harness = makeHarness({ workspaceDir, dataDir })

        const unsupportedZip = PromptInput.FileAttachment.create({
          id: "att_unsupported_zip",
          uri: "s3://bucket/releases/bundle.zip",
          source: { start: 0, end: 32, text: "s3://bucket/releases/bundle.zip" },
        })
        const unsupportedNamedJson = PromptInput.FileAttachment.create({
          id: "att_unsupported_json",
          uri: "custom:opaque-ref",
          name: "payload.json",
        })
        const unsupportedUnknown = PromptInput.FileAttachment.create({
          id: "att_unsupported_bin",
          uri: "custom:opaque-ref",
        })

        const results = yield* Effect.gen(function* () {
          const store = yield* AttachmentStore.Service
          return {
            unsupportedZip: yield* store.materialize({ sessionID, agent, attachment: unsupportedZip }),
            unsupportedNamedJson: yield* store.materialize({ sessionID, agent, attachment: unsupportedNamedJson }),
            unsupportedUnknown: yield* store.materialize({ sessionID, agent, attachment: unsupportedUnknown }),
          }
        }).pipe(harness.provide)

        expect(harness.permissions).toHaveLength(0)
        expect(harness.reads).toHaveLength(0)
        expect(harness.writes).toHaveLength(0)
        expect(harness.requests).toHaveLength(0)

        expect(results.unsupportedZip).toEqual({
          id: "att_unsupported_zip",
          uri: "s3://bucket/releases/bundle.zip",
          mime: "application/zip",
          name: undefined,
          description: undefined,
          source: { start: 0, end: 32, text: "s3://bucket/releases/bundle.zip" },
          path: undefined,
          size: undefined,
        })
        expect(results.unsupportedNamedJson.mime).toBe("application/json")
        expect(results.unsupportedNamedJson.path).toBeUndefined()
        expect(results.unsupportedUnknown.mime).toBe("application/octet-stream")
        expect(results.unsupportedUnknown.path).toBeUndefined()
      }),
    ),
  )

  it.live("qualifies post-read oversize bytes branch with derived MIME and zero writes", () =>
    withDirs(({ workspaceDir, dataDir }) =>
      Effect.gen(function* () {
        const readOversizePath = path.join(workspaceDir, "manual.pdf")
        yield* Effect.promise(() => fs.writeFile(readOversizePath, "stub"))
        const canonicalReadOversize = yield* Effect.promise(() => fs.realpath(readOversizePath))
        let sawResolveStat = false

        const harness = makeHarness({
          workspaceDir,
          dataDir,
          stat: (target, base) => {
            if (path.resolve(target) === path.resolve(canonicalReadOversize)) {
              if (!sawResolveStat) {
                sawResolveStat = true
                return base.stat(target)
              }
              return Effect.fail(fsFailure("stat", target, "size unavailable"))
            }
            return base.stat(target)
          },
          readFile: (target, base) => {
            if (path.resolve(target) === path.resolve(canonicalReadOversize)) {
              return Effect.succeed(new Uint8Array(AttachmentStore.MAX_BYTES + 1))
            }
            return base.readFile(target)
          },
        })

        const readOversizeInput = PromptInput.FileAttachment.create({
          id: "att_oversize_bytes",
          uri: pathToFileURL(readOversizePath).href,
          name: "manual.pdf",
          source: { start: 0, end: 11, text: "@manual.pdf" },
        })

        const result = yield* Effect.gen(function* () {
          const store = yield* AttachmentStore.Service
          return yield* store.materialize({ sessionID, agent, attachment: readOversizeInput })
        }).pipe(harness.provide)

        expect(harness.reads).toEqual([canonicalReadOversize])
        expect(harness.writes).toHaveLength(0)
        expect(result).toEqual({
          id: "att_oversize_bytes",
          uri: pathToFileURL(readOversizePath).href,
          mime: "application/pdf",
          name: "manual.pdf",
          description: undefined,
          source: { start: 0, end: 11, text: "@manual.pdf" },
          path: undefined,
          size: undefined,
        })
      }),
    ),
  )

  it.live("qualifies stat and HTTP Content-Length oversize budget failures with derived MIME and zero writes", () =>
    withDirs(({ workspaceDir, dataDir }) =>
      Effect.gen(function* () {
        const statOversizePath = path.join(workspaceDir, "clip.mp4")
        yield* Effect.promise(() => fs.writeFile(statOversizePath, "stub"))
        const canonicalStatOversize = yield* Effect.promise(() => fs.realpath(statOversizePath))
        let sawResolveStat = false

        const harness = makeHarness({
          workspaceDir,
          dataDir,
          stat: (target, base) => {
            if (path.resolve(target) === path.resolve(canonicalStatOversize)) {
              if (!sawResolveStat) {
                sawResolveStat = true
                return base.stat(target)
              }
              return base.stat(target).pipe(
                Effect.map((info) => ({
                  ...info,
                  size: FileSystem.Size(AttachmentStore.MAX_BYTES + 1),
                })),
              )
            }
            return base.stat(target)
          },
          httpExecute: (request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response("stub", {
                  status: 200,
                  headers: { "content-length": String(AttachmentStore.MAX_BYTES + 1) },
                }),
              ),
            ),
        })

        const statOversizeInput = PromptInput.FileAttachment.create({
          id: "att_oversize_stat",
          uri: pathToFileURL(statOversizePath).href,
          name: "clip.mp4",
        })
        const httpOversizeInput = PromptInput.FileAttachment.create({
          id: "att_oversize_http",
          uri: "https://example.invalid/releases/archive.zip",
          name: "archive.zip",
        })

        const { statOversize, httpOversize } = yield* Effect.gen(function* () {
          const store = yield* AttachmentStore.Service
          return {
            statOversize: yield* store.materialize({ sessionID, agent, attachment: statOversizeInput }),
            httpOversize: yield* store.materialize({ sessionID, agent, attachment: httpOversizeInput }),
          }
        }).pipe(harness.provide)

        expect(harness.reads).toHaveLength(0)
        expect(harness.writes).toHaveLength(0)
        expect(harness.requests).toEqual(["https://example.invalid/releases/archive.zip"])
        expect(statOversize).toEqual({
          id: "att_oversize_stat",
          uri: pathToFileURL(statOversizePath).href,
          mime: "video/mp4",
          name: "clip.mp4",
          description: undefined,
          source: undefined,
          path: undefined,
          size: undefined,
        })
        expect(httpOversize).toEqual({
          id: "att_oversize_http",
          uri: "https://example.invalid/releases/archive.zip",
          mime: "application/zip",
          name: "archive.zip",
          description: undefined,
          source: undefined,
          path: undefined,
          size: undefined,
        })
      }),
    ),
  )
})
