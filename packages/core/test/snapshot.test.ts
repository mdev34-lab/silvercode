import { describe, expect, setDefaultTimeout } from "bun:test"

// Real Git setup per test; Windows runners intermittently exceed the 5s default (#303).
setDefaultTimeout(30_000)
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

describe("Snapshot", () => {
  testEffect(Layer.empty).live("captures and restores Location-scoped changes", () => {
    // Phase markers for the Windows CI flake: if the test hangs again, the last
    // marker before the timeout names the stuck phase.
    const startedAt = Date.now()
    const phase = (name: string) =>
      Effect.sync(() => console.error(`[snapshot-test] phase=${name} elapsedMs=${Date.now() - startedAt}`))
    return Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* phase("init")
          const project = path.join(tmp.path, "project")
          const location = path.join(project, "scope")
          yield* Effect.promise(async () => {
            await fs.mkdir(location, { recursive: true })
            await fs.writeFile(path.join(location, "tracked.txt"), "one\n")
            await fs.writeFile(path.join(project, "outside.txt"), "outside\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })
          yield* phase("git")

          const layer = snapshotLayer(tmp.path, location)
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return
            yield* phase("capture")

            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(location, "tracked.txt"), "two\n")
              await fs.writeFile(path.join(location, "added.txt"), "added\n")
              await fs.writeFile(path.join(project, "outside.txt"), "changed outside\n")
            })
            const after = yield* snapshot.capture()
            expect(after).toBeDefined()
            if (!after) return

            expect(yield* snapshot.files({ from: before, to: after })).toEqual([
              RelativePath.make("scope/added.txt"),
              RelativePath.make("scope/tracked.txt"),
            ])
            yield* phase("files")
            const plan = new Map([[RelativePath.make("scope/tracked.txt"), before]])
            const preview = yield* snapshot.preview({ files: plan, context: 1 })
            expect(preview).toHaveLength(1)
            expect(preview[0]?.path).toBe(RelativePath.make("scope/tracked.txt"))
            yield* phase("preview")
            yield* snapshot.restore({ files: plan })
            expect(yield* read(path.join(location, "tracked.txt"))).toBe("one\n")
            expect(yield* read(path.join(location, "added.txt"))).toBe("added\n")
            expect(yield* read(path.join(project, "outside.txt"))).toBe("changed outside\n")
            yield* phase("restore")
          }).pipe(Effect.provide(layer))
        }),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
          yield* phase("cleanup")
        }),
    )
  }, 30_000)

  testEffect(Layer.empty).live("treats capture outside Git as unavailable", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          expect(
            yield* Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              return yield* snapshot.capture()
            }).pipe(Effect.provide(snapshotLayer(tmp.path, tmp.path))),
          ).toBeUndefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("isolates snapshot indexes by canonical Git worktree", () => {
    // Keep the default budget: the last start/done pair identifies the Windows
    // timeout boundary, including native Git setup and scoped layer disposal.
    const startedAt = Date.now()
    const phase = (name: string) =>
      console.error(`[snapshot-worktree-test] phase=${name} elapsedMs=${Date.now() - startedAt}`)
    return Effect.acquireUseRelease(
      Effect.promise(async () => {
        phase("tmpdir:start")
        const tmp = await tmpdir()
        phase("tmpdir:done")
        return tmp
      }),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const linked = path.join(tmp.path, "linked")
          yield* Effect.promise(async () => {
            phase("files:start")
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "main\n")
            phase("files:done")
            phase("git-init:start")
            await $`git init`.cwd(project).quiet()
            phase("git-init:done")
            phase("git-config:start")
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            phase("git-config:done")
            phase("git-add:start")
            await $`git add .`.cwd(project).quiet()
            phase("git-add:done")
            phase("git-commit:start")
            await $`git commit -m initial`.cwd(project).quiet()
            phase("git-commit:done")
            phase("git-worktree:start")
            await $`git worktree add --detach ${linked} HEAD`.cwd(project).quiet()
            phase("git-worktree:done")
          })

          const capture = (directory: string, name: string) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => phase(`${name}-layer:start`))
              const result = yield* Effect.gen(function* () {
                const snapshot = yield* Snapshot.Service
                yield* Effect.sync(() => phase(`${name}-capture:start`))
                const captured = yield* snapshot.capture()
                yield* Effect.sync(() => phase(`${name}-capture:done`))
                return captured
              }).pipe(Effect.provide(snapshotLayer(tmp.path, directory)))
              // Effect.provide has closed the layer scope before this marker.
              yield* Effect.sync(() => phase(`${name}-layer:done`))
              return result
            })
          expect(yield* capture(project, "project")).toBeDefined()
          expect(yield* capture(linked, "linked")).toBeDefined()

          yield* Effect.sync(() => phase("project-id:start"))
          const projectID = yield* Effect.gen(function* () {
            return (yield* Location.Service).project.id
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))),
            ),
          )
          yield* Effect.sync(() => phase("project-id:done"))
          yield* Effect.sync(() => phase("indexes:start"))
          expect(
            yield* Effect.promise(() => fs.stat(path.join(tmp.path, "snapshot", projectID, Hash.fast(project)))),
          ).toBeDefined()
          expect(
            yield* Effect.promise(() => fs.stat(path.join(tmp.path, "snapshot", projectID, Hash.fast(linked)))),
          ).toBeDefined()
          yield* Effect.sync(() => phase("indexes:done"))
        }),
      (tmp) =>
        Effect.promise(async () => {
          phase("cleanup:start")
          await tmp[Symbol.asyncDispose]()
          phase("cleanup:done")
        }),
    )
  })

  testEffect(Layer.empty).live("checks out a legacy revert snapshot without removing unrelated files", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })

          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return
            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(project, "tracked.txt"), "two\n")
              await fs.writeFile(path.join(project, "unrelated.txt"), "keep\n")
            })
            yield* snapshot.checkout(before)
            expect(yield* read(path.join(project, "tracked.txt"))).toBe("one\n")
            expect(yield* read(path.join(project, "unrelated.txt"))).toBe("keep\n")
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

function snapshotLayer(data: string, directory: string) {
  return AppNodeBuilder.build(Snapshot.node, [
    [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))],
    [Global.node, Global.layerWith({ data, config: path.join(data, "config") })],
  ])
}

function read(file: string) {
  return Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.map((content) => content.replaceAll("\r\n", "\n")))
}
