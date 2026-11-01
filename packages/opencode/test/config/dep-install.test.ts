import { beforeEach, describe, expect, test } from "bun:test"
import { Duration, Effect, Layer, Logger } from "effect"
import { HttpClient } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Npm } from "@opencode-ai/core/npm"
import { Config } from "@/config/config"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { Env } from "../../src/env"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { disposeAllInstancesEffect } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

// Regression coverage for issue #271: config initialization forks a background
// @opencode-ai/plugin registry install per config directory and plugin loading
// joins those fibers. A stalled registry install used to keep
// waitForDependencies — and everything downstream of it, up to instance
// disposal — waiting indefinitely. The install is now bounded (60s design
// proposal, OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS override); on expiry the
// install fiber is interrupted (no orphan work) and a warning is logged.

const TIMEOUT_KEY = "OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS"

const install = {
  mode: "stall" as "stall" | "ok" | "fail",
  started: false,
  interrupted: false,
  calls: [] as { dir: string; add?: { name: string; version?: string }[] }[],
  entered: Promise.resolve(),
  enter: () => {},
}

const resetInstall = (mode: "stall" | "ok" | "fail") => {
  install.mode = mode
  install.started = false
  install.interrupted = false
  install.calls = []
  // Rendezvous so tests know the background install fiber actually started
  // before measuring waits or disposing, keeping assertions deterministic.
  install.entered = new Promise<void>((resolve) => {
    install.enter = resolve
  })
}

// Stands in for a stalled registry: the install fiber enters, then suspends
// forever. Only interruption ends it, and interruption is recorded so tests
// can assert the bounded wait actually cancelled the fiber instead of
// abandoning orphan work.
const npmStall = Layer.mock(Npm.Service)({
  install: (dir, input) =>
    Effect.sync(() => {
      install.calls.push({ dir, add: input?.add })
      install.started = true
      install.enter()
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

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

const configLayer = LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
  [Auth.node, AuthTest.empty],
  [Account.node, AccountTest.empty],
  [Npm.node, npmStall],
  [httpClient, Layer.succeed(HttpClient.HttpClient, unexpectedHttp)],
])

const it = testEffect(configLayer)

const logs: string[] = []
const captureLog = Logger.make((options) => {
  logs.push(String(options.message))
  return undefined
})

const withLogCapture = <A, E, R>(self: Effect.Effect<A, E, R>) => self.pipe(Effect.provide(Logger.layer([captureLog])))

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

const warned = (fragment: string) => logs.some((message) => message.includes(fragment))

beforeEach(() => {
  logs.length = 0
})

it.instance(
  "bounds a stalled dependency install, cancels it, and reports the timeout",
  () =>
    withEnv(
      TIMEOUT_KEY,
      "250",
      withLogCapture(
        Effect.gen(function* () {
          resetInstall("stall")
          const startedAt = Date.now()
          yield* Config.use.get()
          yield* Config.use.waitForDependencies()
          const elapsed = Date.now() - startedAt
          expect(install.started).toBe(true)
          // The join waited for the bound to expire rather than resolving early...
          expect(elapsed).toBeGreaterThanOrEqual(200)
          // ...and returned promptly instead of hanging like an unbounded install.
          expect(elapsed).toBeLessThan(10_000)
          // Actual cancellation: the stalled install fiber was interrupted, so no
          // orphan install work outlives the bounded wait.
          expect(install.interrupted).toBe(true)
          // The incomplete install is reported as a timeout, not as a failure.
          expect(warned("background dependency install timed out")).toBe(true)
          expect(warned("background dependency install failed")).toBe(false)
        }),
      ),
    ),
  30_000,
)

it.instance(
  "disposes the instance without waiting for a stalled install, which self-terminates at the bound",
  () =>
    withEnv(
      TIMEOUT_KEY,
      "8000",
      withLogCapture(
        Effect.gen(function* () {
          resetInstall("stall")
          yield* Config.use.get()
          yield* awaitWithTimeout(
            Effect.promise(() => install.entered),
            "dependency install never started",
            "10 seconds",
          )
          const startedAt = Date.now()
          yield* disposeAllInstancesEffect
          const elapsed = Date.now() - startedAt
          // Disposal returned while the install was still stalled (its 8s bound
          // had not expired), so disposal does not wait on the install fiber.
          // The generous bound keeps slow Windows CI runners deterministic.
          expect(elapsed).toBeLessThan(8000)
          expect(install.interrupted).toBe(false)
          // The detached install fiber does not outlive its bound even though
          // nobody joined it: it self-terminates, leaving no orphan work.
          yield* Effect.sleep(Duration.millis(9000))
          expect(install.interrupted).toBe(true)
          expect(warned("background dependency install timed out")).toBe(true)
        }),
      ),
    ),
  30_000,
)

it.instance(
  "completes normal installs and preserves the plugin dependency requirement",
  () =>
    withEnv(
      TIMEOUT_KEY,
      "5000",
      withLogCapture(
        Effect.gen(function* () {
          resetInstall("ok")
          yield* Config.use.get()
          yield* Config.use.waitForDependencies()
          expect(install.calls.length).toBeGreaterThan(0)
          expect(install.interrupted).toBe(false)
          // Plugins that need @opencode-ai/plugin still get it installed on the
          // normal path: the bound does not skip or truncate the requirement.
          expect(install.calls.every((call) => call.add?.some((pkg) => pkg.name === "@opencode-ai/plugin"))).toBe(true)
          expect(warned("background dependency install")).toBe(false)
        }),
      ),
    ),
  30_000,
)

it.instance(
  "warns and continues when the dependency install fails",
  () =>
    withEnv(
      TIMEOUT_KEY,
      "5000",
      withLogCapture(
        Effect.gen(function* () {
          resetInstall("fail")
          yield* Config.use.get()
          yield* Config.use.waitForDependencies()
          expect(install.calls.length).toBeGreaterThan(0)
          expect(install.interrupted).toBe(false)
          // Failed installs are reported and do not fail config loading; plugin
          // loading later surfaces per-plugin errors for anything still missing.
          expect(warned("background dependency install failed")).toBe(true)
          expect(warned("timed out")).toBe(false)
        }),
      ),
    ),
  30_000,
)

describe("OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS", () => {
  test("defaults to the 60s design proposal and rejects invalid overrides", () => {
    const previous = process.env[TIMEOUT_KEY]
    try {
      delete process.env[TIMEOUT_KEY]
      expect(Flag.OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS).toBe(60_000)
      process.env[TIMEOUT_KEY] = "250"
      expect(Flag.OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS).toBe(250)
      process.env[TIMEOUT_KEY] = "not-a-number"
      expect(Flag.OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS).toBe(60_000)
      process.env[TIMEOUT_KEY] = "-5"
      expect(Flag.OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS).toBe(60_000)
      process.env[TIMEOUT_KEY] = "0"
      expect(Flag.OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS).toBe(60_000)
    } finally {
      if (previous === undefined) delete process.env[TIMEOUT_KEY]
      else process.env[TIMEOUT_KEY] = previous
    }
  })
})
