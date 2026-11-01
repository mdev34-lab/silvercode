import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Instruction } from "../../src/session/instruction"
import { LSP } from "../../src/lsp/lsp"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionID, MessageID } from "../../src/session/schema"
import { Truncate } from "@/tool/truncate"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { ReadTool } from "../../src/tool/read"
import { Workdir } from "../../src/session/workdir"
import type * as Tool from "../../src/tool/tool"
import {
  disposeAllInstances,
  provideInstance,
  TestInstance,
  testInstanceStoreLayer,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * A session's working folder resolves paths but never widens permissions.
 *
 * These are the regression controls for that contract: a delegated child's
 * relative paths must resolve from ITS folder (so a parent and its children
 * never share a resolution base), and anything the folder reaches outside the
 * project must still go through the same `external_directory` approval a direct
 * access would - including a folder reached through a symlink.
 */

afterEach(async () => {
  await disposeAllInstances()
})

const toolLayer = () =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      Instruction.node,
      LSP.node,
      Ripgrep.node,
      Truncate.node,
    ]),
  )

const it = testEffect(Layer.mergeAll(toolLayer(), testInstanceStoreLayer))

const base = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "work",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...base,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    } satisfies Tool.Context,
  }
}

const put = Effect.fn("WorkdirTest.put")(function* (file: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, content)
})

const read = Effect.fn("WorkdirTest.read")(function* (dir: string, args: { filePath: string }, ctx: Tool.Context) {
  const init = yield* ReadTool
  const tool = yield* init.init()
  return yield* provideInstance(dir)(tool.execute(args, ctx))
})

const grep = Effect.fn("WorkdirTest.grep")(function* (dir: string, args: { pattern: string }, ctx: Tool.Context) {
  const init = yield* GrepTool
  const tool = yield* init.init()
  return yield* provideInstance(dir)(tool.execute(args, ctx))
})

const glob = Effect.fn("WorkdirTest.glob")(function* (dir: string, args: { pattern: string }, ctx: Tool.Context) {
  const init = yield* GlobTool
  const tool = yield* init.init()
  return yield* provideInstance(dir)(tool.execute(args, ctx))
})

const settle = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isFailure(exit)) return { ok: false as const, error: String(Cause.squash(exit.cause)) }
    return { ok: true as const, value: exit.value, error: "" }
  })

describe("session workdir selection", () => {
  it.live(
    "resolves a relative folder from the folder the caller already works in",
    () =>
      Effect.gen(function* () {
        const parent = yield* tmpdirScoped()
        const fs = yield* FSUtil.Service
        yield* put(path.join(parent, "child", "keep.txt"), "x")

        const resolved = yield* Workdir.resolve({ fs, requested: "child", base: parent })

        expect(resolved).toBe(path.join(parent, "child"))
        expect(path.isAbsolute(resolved)).toBe(true)
      }),
    30_000,
  )

  it.live(
    "resolves an absolute folder to the same canonical path as a relative one",
    () =>
      Effect.gen(function* () {
        const parent = yield* tmpdirScoped()
        const fs = yield* FSUtil.Service
        yield* put(path.join(parent, "child", "keep.txt"), "x")

        const relative = yield* Workdir.resolve({ fs, requested: "child", base: parent })
        const absolute = yield* Workdir.resolve({ fs, requested: path.join(parent, "child"), base: parent })
        const traversed = yield* Workdir.resolve({ fs, requested: path.join("child", "..", "child"), base: parent })

        // Choosing a folder means the same thing however it was spelled, which is
        // what lets a resumed task compare a new request with its recorded one.
        expect(absolute).toBe(relative)
        expect(traversed).toBe(relative)
        expect(Workdir.same(absolute, relative)).toBe(true)
      }),
    30_000,
  )

  it.live(
    "rejects a folder that is missing, is a file, or is empty",
    () =>
      Effect.gen(function* () {
        const parent = yield* tmpdirScoped()
        const fs = yield* FSUtil.Service
        yield* put(path.join(parent, "file.txt"), "x")

        const missing = yield* settle(Workdir.resolve({ fs, requested: "missing", base: parent }))
        const file = yield* settle(Workdir.resolve({ fs, requested: "file.txt", base: parent }))
        const empty = yield* settle(Workdir.resolve({ fs, requested: "", base: parent }))

        expect(missing.ok).toBe(false)
        expect(missing.error).toContain("does not exist")
        expect(file.ok).toBe(false)
        expect(file.error).toContain("not a directory")
        expect(empty.ok).toBe(false)
        expect(empty.error).toContain("cannot be empty")
      }),
    30_000,
  )

  it.live(
    "canonicalizes a folder reached through a symlink to its real target",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const project = yield* tmpdirScoped()
        const external = yield* tmpdirScoped()
        yield* Effect.promise(() =>
          import("fs/promises").then((fs) => fs.symlink(external, path.join(project, "link"))),
        )

        const fs = yield* FSUtil.Service
        const resolved = yield* Workdir.resolve({ fs, requested: "link", base: project })

        // The selection is recorded where it really points. Storing the
        // internal-looking name instead would let every path under it be read as
        // if it were inside the project.
        expect(resolved).toBe(external)
        expect(FSUtil.contains(project, resolved)).toBe(false)
      }),
    30_000,
  )
})

describe("tool working folder", () => {
  it.instance("read resolves a relative path from the session folder, not the project directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* put(path.join(test.directory, "same.txt"), "project copy")
      yield* put(path.join(test.directory, "child", "same.txt"), "child copy")

      const child = yield* read(
        test.directory,
        { filePath: "same.txt" },
        {
          ...base,
          cwd: path.join(test.directory, "child"),
        },
      )
      const parent = yield* read(test.directory, { filePath: "same.txt" }, base)

      expect(child.output).toContain("child copy")
      expect(parent.output).toContain("project copy")
    }),
  )

  it.instance("grep and glob default to the session folder", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* put(path.join(test.directory, "root-only.txt"), "needle")
      yield* put(path.join(test.directory, "child", "child-only.txt"), "needle")

      const ctx = { ...base, cwd: path.join(test.directory, "child") }
      const searched = yield* grep(test.directory, { pattern: "needle" }, ctx)
      const listed = yield* glob(test.directory, { pattern: "*.txt" }, ctx)

      expect(searched.output).toContain("child-only.txt")
      expect(searched.output).not.toContain("root-only.txt")
      expect(listed.output).toContain("child-only.txt")
      expect(listed.output).not.toContain("root-only.txt")
    }),
  )

  it.instance("a session folder inside the project asks for nothing extra", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* put(path.join(test.directory, "child", "inside.txt"), "inside")

      const { items, next } = asks()
      const result = yield* read(
        test.directory,
        { filePath: "inside.txt" },
        {
          ...next,
          cwd: path.join(test.directory, "child"),
        },
      )

      expect(result.output).toContain("inside")
      expect(items.some((item) => item.permission === "external_directory")).toBe(false)
    }),
  )

  it.instance("a session folder outside the project still asks for external access", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const outer = yield* tmpdirScoped()
      yield* put(path.join(outer, "secret.txt"), "secret")

      const { items, next } = asks()
      // The test answers every ask, so the read completes; what matters is that
      // the ask happened. Selecting the folder carried no authorization with it.
      const result = yield* read(test.directory, { filePath: "secret.txt" }, { ...next, cwd: outer })

      expect(result.output).toContain("secret")
      expect(items.some((item) => item.permission === "external_directory")).toBe(true)
      expect(items.some((item) => item.permission === "read")).toBe(true)
    }),
  )

  it.instance("a folder whose symlink target is outside the project still asks", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const test = yield* TestInstance
      const outer = yield* tmpdirScoped()
      yield* put(path.join(outer, "secret.txt"), "secret")
      yield* Effect.promise(() =>
        import("fs/promises").then((fs) => fs.symlink(outer, path.join(test.directory, "link"))),
      )

      // The selection is the canonical target, so the external boundary sees an
      // external directory rather than an internal-looking project path.
      const fs = yield* FSUtil.Service
      const cwd = yield* Workdir.resolve({ fs, requested: "link", base: test.directory })
      const { items, next } = asks()
      yield* read(test.directory, { filePath: "secret.txt" }, { ...next, cwd })

      expect(items.some((item) => item.permission === "external_directory")).toBe(true)
    }),
  )
})
