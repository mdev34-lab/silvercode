import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Instruction } from "../../src/session/instruction"
import { LSP } from "../../src/lsp/lsp"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionID, MessageID } from "../../src/session/schema"
import { Truncate } from "@/tool/truncate"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EditTool } from "../../src/tool/edit"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { ReadTool } from "../../src/tool/read"
import { WriteTool } from "../../src/tool/write"
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
      EventV2Bridge.node,
      Format.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      Instruction.node,
      LSP.node,
      Ripgrep.node,
      Truncate.node,
    ]),
  )

const it = testEffect(Layer.mergeAll(toolLayer(), testInstanceStoreLayer))

// Platform-gated controls report as skipped on the other runner instead of
// passing vacuously, so "this has not run here" is visible in the result.
const windowsOnly = process.platform === "win32" ? it.live : it.live.skip
const posixOnly = process.platform === "win32" ? it.live.skip : it.live
const posixOnlyInstance = process.platform === "win32" ? it.instance.skip : it.instance

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

const get = (file: string) => Effect.promise(() => import("fs/promises").then((fs) => fs.readFile(file, "utf-8")))

const read = Effect.fn("WorkdirTest.read")(function* (dir: string, args: { filePath: string }, ctx: Tool.Context) {
  const init = yield* ReadTool
  const tool = yield* init.init()
  return yield* provideInstance(dir)(tool.execute(args, ctx))
})

const grep = Effect.fn("WorkdirTest.grep")(function* (
  dir: string,
  args: { pattern: string; path?: string },
  ctx: Tool.Context,
) {
  const init = yield* GrepTool
  const tool = yield* init.init()
  return yield* provideInstance(dir)(tool.execute(args, ctx))
})

const glob = Effect.fn("WorkdirTest.glob")(function* (
  dir: string,
  args: { pattern: string; path?: string },
  ctx: Tool.Context,
) {
  const init = yield* GlobTool
  const tool = yield* init.init()
  return yield* provideInstance(dir)(tool.execute(args, ctx))
})

const edit = Effect.fn("WorkdirTest.edit")(function* (
  dir: string,
  args: { filePath: string; oldString: string; newString: string },
  ctx: Tool.Context,
) {
  const init = yield* EditTool
  const tool = yield* init.init()
  return yield* provideInstance(dir)(tool.execute(args, ctx))
})

const write = Effect.fn("WorkdirTest.write")(function* (
  dir: string,
  args: { filePath: string; content: string },
  ctx: Tool.Context,
) {
  const init = yield* WriteTool
  const tool = yield* init.init()
  return yield* provideInstance(dir)(tool.execute(args, ctx))
})

const applyPatch = Effect.fn("WorkdirTest.applyPatch")(function* (
  dir: string,
  args: { patchText: string },
  ctx: Tool.Context,
) {
  const init = yield* ApplyPatchTool
  const tool = yield* init.init()
  return yield* provideInstance(dir)(tool.execute(args, ctx))
})

const denyExternal = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...base,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.gen(function* () {
          items.push(req)
          if (req.permission === "external_directory") {
            yield* Effect.die(new Error(`external_directory denied: ${req.patterns.join(",")}`))
          }
        }),
    } satisfies Tool.Context,
  }
}

const siblingOutside = (projectDir: string, label: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const dir = path.join(path.dirname(projectDir), `opencode-ext-${label}-${Math.random().toString(36).slice(2)}`)
      yield* fs.ensureDir(dir)
      return dir
    }),
    (dir) => Effect.promise(() => import("fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }))),
  )

const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
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

  posixOnly(
    "canonicalizes a folder reached through a symlink to its real target",
    () =>
      Effect.gen(function* () {
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

describe("a folder request is read by the platform's rules", () => {
  test("a relative, an absolute and a traversed spelling are told apart", () => {
    expect(Workdir.classify("child")).toBe("relative")
    expect(Workdir.classify("../child")).toBe("relative")
    expect(Workdir.classify(path.join("child", "..", "child"))).toBe("relative")
    // A POSIX-looking `/srv/...` is drive-rooted on Windows, not absolute.
    // Resolve a native path so this control uses the runner's absolute spelling.
    expect(Workdir.classify(path.resolve("srv", "project", "child"))).toBe("absolute")

    for (const platform of ["linux", "darwin"] as const) {
      expect(Workdir.classify("/srv/project/child", platform)).toBe("absolute")
      expect(Workdir.classify("//folder", platform)).toBe("absolute")
      expect(Workdir.classify("///folder", platform)).toBe("absolute")
      expect(Workdir.classify("child", platform)).toBe("relative")
      expect(Workdir.classify("./child", platform)).toBe("relative")
      expect(Workdir.classify("../child", platform)).toBe("relative")
    }
  })

  test("Windows spellings are read by the same rules on any runner", () => {
    // Absolute, and a UNC path names its own target rather than leaning on the
    // process, so both may be used as they are.
    const winAbsolute = [
      "C:\\",
      "C:/",
      "C:\\projects\\child",
      "C:/projects/child",
      "\\\\server\\share",
      "\\\\server\\share\\child",
      "//server/share",
      "//server/share/child",
    ]
    for (const spelling of winAbsolute) {
      expect(Workdir.classify(spelling, "win32")).toBe("absolute")
      expect(path.win32.resolve("C:\\work\\one", spelling)).toBe(path.win32.resolve("D:\\work\\two", spelling))
    }

    // `C:child` follows that drive's current directory, and `\child`, `/child`,
    // or an incomplete/over-slashed prefix (`//folder`, `///folder`, `\\folder`)
    // normalizes to a single leading backslash on the process's current drive:
    // none of them names a folder the caller asked for.
    expect(Workdir.classify("C:", "win32")).toBe("process-relative")
    expect(Workdir.classify("C:child", "win32")).toBe("process-relative")

    const ambientDriveRooted = [
      "\\",
      "/",
      "\\child",
      "/child",
      "//",
      "\\\\",
      "//folder",
      "///folder",
      "\\\\folder",
      "\\\\\\folder",
      "///server/share",
      "\\\\\\server\\share",
      "//server/",
      "\\\\server\\",
      "\\/folder",
      "/\\folder",
    ]
    for (const spelling of ambientDriveRooted) {
      expect(Workdir.classify(spelling, "win32")).toBe("process-relative")
      const normalized = path.win32.normalize(spelling)
      expect(normalized.startsWith("\\") && !normalized.startsWith("\\\\")).toBe(true)
      expect(path.win32.resolve("C:\\work\\one", spelling)).not.toBe(path.win32.resolve("D:\\work\\two", spelling))
    }

    for (const spelling of ["child", "./child", ".\\child", "../child", "..\\child"]) {
      expect(Workdir.classify(spelling, "win32")).toBe("relative")
    }
  })

  test("a case difference is the same folder on Windows and a different one elsewhere", () => {
    expect(Workdir.same("C:\\Projects\\Child", "c:\\projects\\child", "win32")).toBe(true)
    expect(Workdir.same("/srv/Project", "/srv/project", "linux")).toBe(false)
    expect(Workdir.same("/srv/project", "/srv/project", "linux")).toBe(true)
  })

  test("~ expands to the home directory and nothing else is expanded", () => {
    expect(Workdir.expand("~/child", "/home/user")).toBe("/home/user/child")
    expect(Workdir.expand("~", "/home/user")).toBe("/home/user")
    expect(Workdir.expand("~other/child", "/home/user")).toBe("~other/child")
    expect(Workdir.expand("child/~/x", "/home/user")).toBe("child/~/x")
  })

  windowsOnly(
    "refuses a drive-relative or drive-rooted request instead of resolving it from the process",
    () =>
      Effect.gen(function* () {
        const project = yield* tmpdirScoped()
        const fs = yield* FSUtil.Service
        // `C:` for the drive the temp folder is on.
        const drive = (project.match(/^[A-Za-z]:/) ?? [""])[0]
        // Existing top-level folder on the temp drive (e.g. `Users`), so any
        // prefix that leaked through as `"absolute"` and normalized to `\Users`
        // would hit a real folder on disk unless `classify` refuses it first.
        const top = path.win32.relative(path.win32.parse(project).root, project).split(path.win32.sep)[0] || "Users"

        const driveRelative = yield* settle(Workdir.resolve({ fs, requested: `${drive}child`, base: project }))
        const driveRooted = yield* settle(
          Workdir.resolve({ fs, requested: `\\${path.basename(project)}`, base: project }),
        )
        const doubleForward = yield* settle(Workdir.resolve({ fs, requested: `//${top}`, base: project }))
        const tripleForward = yield* settle(Workdir.resolve({ fs, requested: `///${top}`, base: project }))
        const doubleBack = yield* settle(Workdir.resolve({ fs, requested: `\\\\${top}`, base: project }))

        // All of these would otherwise be resolved from state the caller never named.
        for (const refused of [driveRelative, driveRooted, doubleForward, tripleForward, doubleBack]) {
          expect(refused.ok).toBe(false)
          expect(refused.error).toContain("must be an absolute path")
        }
      }),
    30_000,
  )

  windowsOnly(
    "records a folder reached through a junction as its real target",
    () =>
      Effect.gen(function* () {
        const project = yield* tmpdirScoped()
        const external = yield* tmpdirScoped()
        // A junction is what a Windows user actually finds on disk; a directory
        // symlink needs a privilege the runner may not have.
        yield* Effect.promise(() =>
          import("fs/promises").then((fs) => fs.symlink(external, path.join(project, "link"), "junction")),
        )

        const fs = yield* FSUtil.Service
        const resolved = yield* Workdir.resolve({ fs, requested: "link", base: project })

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

  posixOnlyInstance("a folder whose symlink target is outside the project still asks", () =>
    Effect.gen(function* () {
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

  it.instance(
    "grep and glob resolve an explicit relative path from the session folder and gate external traversal",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const child = path.join(test.directory, "child")
        const outer = yield* siblingOutside(test.directory, "search")
        yield* put(path.join(test.directory, "sub", "root-sub.txt"), "needle in root sub")
        yield* put(path.join(child, "sub", "child-sub.txt"), "needle in child sub")
        yield* put(path.join(test.directory, "sibling", "peer.txt"), "needle in peer")
        yield* put(path.join(outer, "ext-sub", "outside.txt"), "needle outside")

        const internal = asks()
        const ctx = { ...internal.next, cwd: child }
        const subGrep = yield* grep(test.directory, { pattern: "needle", path: "sub" }, ctx)
        const subGlob = yield* glob(test.directory, { pattern: "*.txt", path: "sub" }, ctx)
        const peerGrep = yield* grep(test.directory, { pattern: "needle", path: "../sibling" }, ctx)
        const peerGlob = yield* glob(test.directory, { pattern: "*.txt", path: "../sibling" }, ctx)

        expect(subGrep.output).toContain("child-sub.txt")
        expect(subGrep.output).not.toContain("root-sub.txt")
        expect(subGlob.output).toContain("child-sub.txt")
        expect(subGlob.output).not.toContain("root-sub.txt")
        expect(peerGrep.output).toContain("peer.txt")
        expect(peerGlob.output).toContain("peer.txt")
        expect(internal.items.some((item) => item.permission === "external_directory")).toBe(false)

        const relExternal = path.relative(child, path.join(outer, "ext-sub"))
        expect(path.isAbsolute(relExternal)).toBe(false)

        const denied = denyExternal()
        const blockedGrep = yield* settle(
          grep(test.directory, { pattern: "needle", path: relExternal }, { ...denied.next, cwd: child }),
        )
        const blockedGlob = yield* settle(
          glob(test.directory, { pattern: "*.txt", path: relExternal }, { ...denied.next, cwd: child }),
        )
        expect(blockedGrep.ok).toBe(false)
        expect(blockedGrep.error).toContain("external_directory denied")
        expect(blockedGlob.ok).toBe(false)
        expect(blockedGlob.error).toContain("external_directory denied")

        const allowed = asks()
        const extGrep = yield* grep(
          test.directory,
          { pattern: "needle", path: relExternal },
          { ...allowed.next, cwd: child },
        )
        const extGlob = yield* glob(
          test.directory,
          { pattern: "*.txt", path: relExternal },
          { ...allowed.next, cwd: child },
        )
        expect(extGrep.output).toContain("outside.txt")
        expect(extGlob.output).toContain("outside.txt")
        expect(allowed.items.filter((item) => item.permission === "external_directory")).toHaveLength(2)
      }),
  )

  it.instance("apply_patch resolves relative add, update, delete, and move paths from the session folder", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* FSUtil.Service
      const child = path.join(test.directory, "child")

      // Seed identical relative layouts in both the project root and the child folder.
      yield* put(path.join(test.directory, "modify.txt"), "root line\n")
      yield* put(path.join(test.directory, "delete.txt"), "keep root\n")
      yield* put(path.join(test.directory, "old", "move.txt"), "root move\n")

      yield* put(path.join(child, "modify.txt"), "child before\n")
      yield* put(path.join(child, "delete.txt"), "remove child\n")
      yield* put(path.join(child, "old", "move.txt"), "move before\n")

      const patchText = [
        "*** Begin Patch",
        "*** Add File: nested/added.txt",
        "+child added",
        "*** Update File: modify.txt",
        "@@",
        "-child before",
        "+child after",
        "*** Delete File: delete.txt",
        "*** Update File: old/move.txt",
        "*** Move to: renamed/moved.txt",
        "@@",
        "-move before",
        "+move after",
        "*** End Patch",
      ].join("\n")

      const { items, next } = asks()
      yield* applyPatch(test.directory, { patchText }, { ...next, cwd: child })

      expect(yield* get(path.join(child, "nested", "added.txt"))).toBe("child added\n")
      expect(yield* get(path.join(child, "modify.txt"))).toBe("child after\n")
      expect(yield* fs.existsSafe(path.join(child, "delete.txt"))).toBe(false)
      expect(yield* fs.existsSafe(path.join(child, "old", "move.txt"))).toBe(false)
      expect(yield* get(path.join(child, "renamed", "moved.txt"))).toBe("move after\n")

      // Project-root counterparts stay untouched, and no external approval was needed.
      expect(yield* fs.existsSafe(path.join(test.directory, "nested", "added.txt"))).toBe(false)
      expect(yield* get(path.join(test.directory, "modify.txt"))).toBe("root line\n")
      expect(yield* get(path.join(test.directory, "delete.txt"))).toBe("keep root\n")
      expect(yield* get(path.join(test.directory, "old", "move.txt"))).toBe("root move\n")
      expect(yield* fs.existsSafe(path.join(test.directory, "renamed", "moved.txt"))).toBe(false)
      expect(items.some((item) => item.permission === "external_directory")).toBe(false)
      expect(items.some((item) => item.permission === "edit")).toBe(true)
    }),
  )

  it.instance("apply_patch gates relative and absolute external move destinations and external session folders", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* FSUtil.Service
      const child = path.join(test.directory, "child")
      const outer = yield* siblingOutside(test.directory, "patch")
      yield* put(path.join(child, "source.txt"), "before move\n")
      yield* put(path.join(child, "abs-source.txt"), "before abs move\n")

      const relDest = path.relative(child, path.join(outer, "dest", "moved.txt"))
      expect(path.isAbsolute(relDest)).toBe(false)

      const moveToExternal = [
        "*** Begin Patch",
        "*** Update File: source.txt",
        `*** Move to: ${relDest}`,
        "@@",
        "-before move",
        "+after move",
        "*** End Patch",
      ].join("\n")

      // Denying external_directory on the destination leaves the internal source untouched.
      const rejected = denyExternal()
      const failedMove = yield* settle(
        applyPatch(test.directory, { patchText: moveToExternal }, { ...rejected.next, cwd: child }),
      )
      expect(failedMove.ok).toBe(false)
      expect(failedMove.error).toContain("external_directory denied")
      expect(yield* get(path.join(child, "source.txt"))).toBe("before move\n")
      expect(yield* fs.existsSafe(path.join(outer, "dest", "moved.txt"))).toBe(false)

      // When external_directory is granted, the source inside child moves to the external target.
      const permitted = asks()
      yield* applyPatch(test.directory, { patchText: moveToExternal }, { ...permitted.next, cwd: child })
      expect(yield* fs.existsSafe(path.join(child, "source.txt"))).toBe(false)
      expect(yield* get(path.join(outer, "dest", "moved.txt"))).toBe("after move\n")
      const extAsks = permitted.items.filter((item) => item.permission === "external_directory")
      expect(extAsks).toHaveLength(1)
      const expectedGlob =
        process.platform === "win32"
          ? FSUtil.normalizePathPattern(path.join(outer, "dest", "*"))
          : path.join(outer, "dest", "*").replaceAll("\\", "/")
      expect(extAsks[0]?.patterns).toEqual([expectedGlob])

      // An explicit absolute external move destination is gated the same way.
      const absDest = path.join(outer, "abs-dest", "moved.txt")
      const absMovePatch = [
        "*** Begin Patch",
        "*** Update File: abs-source.txt",
        `*** Move to: ${absDest}`,
        "@@",
        "-before abs move",
        "+after abs move",
        "*** End Patch",
      ].join("\n")
      const rejectedAbs = denyExternal()
      const failedAbs = yield* settle(
        applyPatch(test.directory, { patchText: absMovePatch }, { ...rejectedAbs.next, cwd: child }),
      )
      expect(failedAbs.ok).toBe(false)
      expect(yield* get(path.join(child, "abs-source.txt"))).toBe("before abs move\n")
      const permittedAbs = asks()
      yield* applyPatch(test.directory, { patchText: absMovePatch }, { ...permittedAbs.next, cwd: child })
      expect(yield* fs.existsSafe(path.join(child, "abs-source.txt"))).toBe(false)
      expect(yield* get(absDest)).toBe("after abs move\n")
      expect(permittedAbs.items.filter((item) => item.permission === "external_directory")).toHaveLength(1)

      // An external session folder itself still asks external_directory for relative add/update/delete/move.
      yield* put(path.join(outer, "keep.txt"), "keep v1\n")
      yield* put(path.join(outer, "drop.txt"), "drop v1\n")
      const externalPatch = [
        "*** Begin Patch",
        "*** Add File: created.txt",
        "+created outside",
        "*** Update File: keep.txt",
        "*** Move to: sub/kept.txt",
        "@@",
        "-keep v1",
        "+keep v2",
        "*** Delete File: drop.txt",
        "*** End Patch",
      ].join("\n")

      const rejectedOuter = denyExternal()
      const blockedOuter = yield* settle(
        applyPatch(test.directory, { patchText: externalPatch }, { ...rejectedOuter.next, cwd: outer }),
      )
      expect(blockedOuter.ok).toBe(false)
      expect(yield* fs.existsSafe(path.join(outer, "created.txt"))).toBe(false)
      expect(yield* get(path.join(outer, "keep.txt"))).toBe("keep v1\n")
      expect(yield* get(path.join(outer, "drop.txt"))).toBe("drop v1\n")

      const allowedOuter = asks()
      yield* applyPatch(test.directory, { patchText: externalPatch }, { ...allowedOuter.next, cwd: outer })
      expect(yield* get(path.join(outer, "created.txt"))).toBe("created outside\n")
      expect(yield* fs.existsSafe(path.join(outer, "keep.txt"))).toBe(false)
      expect(yield* get(path.join(outer, "sub", "kept.txt"))).toBe("keep v2\n")
      expect(yield* fs.existsSafe(path.join(outer, "drop.txt"))).toBe(false)
      expect(
        allowedOuter.items.filter((item) => item.permission === "external_directory").length,
      ).toBeGreaterThanOrEqual(3)
    }),
  )

  it.instance(
    "edit, write, and piped read resolve from the session folder while keeping external_directory checks",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const outer = yield* siblingOutside(test.directory, "rw")
        yield* put(path.join(test.directory, "piped.txt"), "root piped\n")
        yield* put(path.join(outer, "piped.txt"), "outer piped\n")
        yield* put(path.join(outer, "edit.txt"), "before\n")

        const rejected = denyExternal()
        expect(
          (yield* settle(
            write(test.directory, { filePath: "wrote.txt", content: "x\n" }, { ...rejected.next, cwd: outer }),
          )).ok,
        ).toBe(false)
        expect(
          (yield* settle(
            edit(
              test.directory,
              { filePath: "edit.txt", oldString: "before", newString: "after" },
              { ...rejected.next, cwd: outer },
            ),
          )).ok,
        ).toBe(false)
        expect(
          (yield* settle(read(test.directory, { filePath: "piped.txt | head -n 1" }, { ...rejected.next, cwd: outer })))
            .ok,
        ).toBe(false)
        expect(yield* fs.existsSafe(path.join(outer, "wrote.txt"))).toBe(false)
        expect(yield* get(path.join(outer, "edit.txt"))).toBe("before\n")

        const allowed = asks()
        const ctx = { ...allowed.next, cwd: outer }
        yield* write(test.directory, { filePath: "wrote.txt", content: "written\n" }, ctx)
        yield* edit(test.directory, { filePath: "edit.txt", oldString: "before", newString: "after" }, ctx)
        const piped = yield* read(test.directory, { filePath: "piped.txt | head -n 1" }, ctx)

        expect(yield* get(path.join(outer, "wrote.txt"))).toBe("written\n")
        expect(yield* get(path.join(outer, "edit.txt"))).toBe("after\n")
        expect(piped.output).toContain("outer piped")
        expect(piped.output).not.toContain("root piped")
        expect(allowed.items.filter((item) => item.permission === "external_directory")).toHaveLength(3)
      }),
  )
})
