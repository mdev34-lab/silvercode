import { beforeEach, expect } from "bun:test"
import path from "path"
import { Effect, Layer, Logger } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { CurrentWorkingDirectory } from "@/config/tui-cwd"
import { TuiConfig } from "../../src/config/tui"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Regression coverage for the TUI background dependency install (issues #271, #305).
// The install fiber must report ordinary failures (not only timeouts), keep the
// timeout path reporting, and never turn a failure into a failed wait.

const TIMEOUT_KEY = "OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS"

const install = {
  mode: "ok" as "ok" | "fail" | "stall",
  calls: 0,
  interrupted: false,
  versions: [] as (string | undefined)[],
}

const npmMock = Layer.mock(Npm.Service)({
  install: (dir, input) =>
    Effect.sync(() => {
      install.calls++
      for (const pkg of input?.add ?? []) install.versions.push(pkg.version)
    }).pipe(
      Effect.andThen(
        install.mode === "ok"
          ? Effect.void
          : install.mode === "fail"
            ? Effect.fail(new Npm.InstallFailedError({ dir, add: (input?.add ?? []).map((pkg) => pkg.name) }))
            : Effect.never,
      ),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          install.interrupted = true
        }),
      ),
    ),
})

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node]), [[Npm.node, npmMock]]))

let callsBeforeRetry = 0
let afterReenabledRetry: readonly string[] = ["unset"]
let reported: readonly string[] = []
let afterRetry: readonly string[] = ["unset"]
const logs: string[] = []
const captureLog = Logger.make((options) => {
  logs.push(String(options.message))
  return undefined
})
const warned = (fragment: string) => logs.some((message) => message.includes(fragment))

const withEnv = <A, E, R>(key: string, value: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[key]
      process.env[key] = value
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }),
  )

const globalFiles = ["opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"].map((file) =>
  path.join(Global.Path.config, file),
)

const clean = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  yield* Effect.forEach(globalFiles, (file) => fs.remove(file, { force: true }).pipe(Effect.ignore), {
    discard: true,
  })
})

// A TUI config with a plugin makes the loader schedule the background install.
const run = (mode: "ok" | "fail" | "stall", timeoutMs: string, retry = false, disableRetry = false, reenableRetry = false) =>
  withEnv(
    TIMEOUT_KEY,
    timeoutMs,
    Effect.acquireUseRelease(
      clean,
      () =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const test = yield* TestInstance
          install.mode = mode
          install.calls = 0
          install.versions = []
          install.interrupted = false
          const local = path.join(test.directory, ".opencode")
          yield* fs.makeDirectory(local, { recursive: true })
          yield* fs.writeJson(path.join(local, "tui.json"), { plugin: ["some-plugin@1.0.0"] })
          const layer = TuiConfig.node
          yield* TuiConfig.Service.use((svc) =>
            Effect.gen(function* () {
              yield* svc.waitForDependencies()
              reported = TuiConfig.installFailures()
              if (retry) {
                install.mode = "ok"
                callsBeforeRetry = install.calls
                yield* (disableRetry
                  ? withEnv("OPENCODE_DISABLE_CONFIG_DEP_INSTALL", "1", svc.retryDependencies())
                  : svc.retryDependencies())
                afterRetry = TuiConfig.installFailures()
                if (reenableRetry) {
                  yield* svc.retryDependencies()
                  afterReenabledRetry = TuiConfig.installFailures()
                }
              }
            }),
          ).pipe(
            Effect.provide(
              LayerNode.compile(layer, [[Npm.node, npmMock]]).pipe(
                Layer.provide(Layer.succeed(CurrentWorkingDirectory, test.directory)),
              ),
            ),
            Effect.provide(Logger.layer([captureLog])),
          )
        }),
      () => clean,
    ),
  )

beforeEach(() => {
  logs.length = 0
  reported = []
  afterRetry = ["unset"]
})

it.instance(
  "reports an ordinary install failure and still completes the wait",
  () =>
    run("fail", "5000").pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(install.calls).toBeGreaterThan(0)
          // The app's own (dev/dirty/branch) version is never a published @opencode-ai/plugin version.
          expect(install.versions.length).toBeGreaterThan(0)
          expect(install.versions.every((v) => v === undefined)).toBe(true)
          expect(warned("background dependency install failed")).toBe(true)
          expect(warned("timed out")).toBe(false)
          expect(reported).toEqual(["Could not install @opencode-ai/plugin"])
        }),
      ),
    ),
  30_000,
)

it.instance(
  "reports a stalled install as a timeout, cancels it, and does not report a failure",
  () =>
    run("stall", "250").pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(install.interrupted).toBe(true)
          expect(warned("background dependency install timed out")).toBe(true)
          expect(warned("background dependency install failed")).toBe(false)
          expect(reported).toEqual([])
        }),
      ),
    ),
  30_000,
)

it.instance(
  "stays silent on a successful install",
  () =>
    run("ok", "5000").pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(install.calls).toBeGreaterThan(0)
          expect(warned("background dependency install")).toBe(false)
          expect(reported).toEqual([])
        }),
      ),
    ),
  30_000,
)

it.instance(
  "retry installs the failed directories again and clears the failure",
  () =>
    run("fail", "5000", true).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(reported).toEqual(["Could not install @opencode-ai/plugin"])
          expect(afterRetry).toEqual([])
        }),
      ),
    ),
  30_000,
)


it.instance("does not install TUI config dependencies while disabled", () =>
  withEnv("OPENCODE_DISABLE_CONFIG_DEP_INSTALL", "1", run("ok", "5000")).pipe(
    Effect.tap(() => Effect.sync(() => {
      expect(install.calls).toBe(0)
      expect(reported).toEqual([])
      expect(warned("background dependency install")).toBe(false)
    })),
  ), 30_000)

it.instance("disabled retry preserves failure evidence without starting another install", () =>
  run("fail", "5000", true, true).pipe(
    Effect.tap(() => Effect.sync(() => {
      expect(callsBeforeRetry).toBeGreaterThan(0)
      expect(install.calls).toBe(callsBeforeRetry)
      expect(afterRetry).toEqual(reported)
      expect(afterRetry).toEqual(["Could not install @opencode-ai/plugin"])
    })),
  ), 30_000)

it.instance("re-enabled retry installs preserved failed directories", () =>
  run("fail", "5000", true, true, true).pipe(
    Effect.tap(() => Effect.sync(() => {
      expect(callsBeforeRetry).toBeGreaterThan(0)
      expect(afterRetry).toEqual(["Could not install @opencode-ai/plugin"])
      expect(install.calls).toBe(callsBeforeRetry * 2)
      expect(afterReenabledRetry).toEqual([])
    })),
  ), 30_000)
