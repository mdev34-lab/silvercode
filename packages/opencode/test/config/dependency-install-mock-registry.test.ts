import { test, expect, describe, afterEach, beforeEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { writeSync } from "node:fs"
import http from "node:http"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger } from "effect"
import { HttpClient } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import { Global } from "@opencode-ai/core/global"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceRuntime } from "@/project/instance-runtime"
import type { InstanceContext } from "@/project/instance-context"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AuthTest } from "../fake/auth"
import { AccountTest } from "../fake/account"
import { tmpdir } from "../fixture/fixture"
import { MockRegistry } from "../fixture/mock-registry"

// Diagnostic-only: keep process identity and phase visible if Windows exits before Bun reports (#590).
const installPhase = (phase: string) =>
  writeSync(2, `[dependency-install-phase] ${JSON.stringify({ phase, pid: process.pid, ppid: process.ppid, at: Date.now() })}\n`)

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

const makeIntegrationLayer = (cacheDir: string) =>
  LayerNode.compile(
    LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node, Npm.node, Global.node]),
    [
      [Auth.node, AuthTest.empty],
      [Account.node, AccountTest.empty],
      [
        Global.node,
        Global.layerWith({
          cache: cacheDir,
          state: path.join(cacheDir, "state"),
        }),
      ],
      [httpClient, Layer.succeed(HttpClient.HttpClient, unexpectedHttp)],
    ],
  )

const createProjectFixture = async (
  baseDir: string,
  registryUrl: string,
  npmCacheDir: string,
  configContent: Record<string, unknown> = { formatter: false, lsp: false },
) => {
  const projectDir = path.join(baseDir, "project")
  const opencodeDir = path.join(projectDir, ".opencode")
  await fs.mkdir(opencodeDir, { recursive: true })

  for (const key of Object.keys(process.env)) if (/^npm_config_/i.test(key)) delete process.env[key]
  const globalConfigDir = path.join(baseDir, "global-config")
  // ConfigPaths reads this module-level path, not Global.Service.config.
  Global.Path.config = globalConfigDir
  const home = path.join(baseDir, "home")
  await fs.mkdir(home, { recursive: true })
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.OPENCODE_TEST_HOME = home
  process.env.NPM_CONFIG_REGISTRY = registryUrl
  process.env.NPM_CONFIG_USERCONFIG = path.join(home, ".npmrc")
  process.env.NPM_CONFIG_GLOBALCONFIG = path.join(baseDir, "global.npmrc")
  await Promise.all([
    fs.writeFile(process.env.NPM_CONFIG_USERCONFIG, ""),
    fs.writeFile(process.env.NPM_CONFIG_GLOBALCONFIG, ""),
  ])
  await fs.mkdir(globalConfigDir, { recursive: true })
  const npmrc = [
    `registry=${registryUrl}/`,
    `cache=${npmCacheDir}`,
    "fetch-retries=0",
    "fetch-retry-mintimeout=1",
    "fetch-retry-maxtimeout=1",
    "",
  ].join("\n")
  // Config starts installs for both directories. Neither may escape to the public registry.
  await Promise.all([opencodeDir, globalConfigDir].map((dir) => fs.writeFile(path.join(dir, ".npmrc"), npmrc)))

  await fs.writeFile(path.join(opencodeDir, "opencode.json"), JSON.stringify(configContent))

  const ctx: InstanceContext = {
    directory: projectDir,
    worktree: projectDir,
    project: { id: ProjectV2.ID.make("test-project"), root: projectDir } as unknown as InstanceContext["project"],
  }

  return { projectDir, opencodeDir, globalConfigDir, ctx }
}

const originalFlag = process.env.OPENCODE_DISABLE_CONFIG_DEP_INSTALL
const originalConfig = Global.Path.config
let savedEnvironment: Record<string, string | undefined>
const isolatedKey = (key: string) => /^(npm_config_|home$|userprofile$|opencode_test_home$)/i.test(key)

beforeEach(async () => {
  savedEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => isolatedKey(key)))
  for (const key of Object.keys(process.env)) if (/^npm_config_/i.test(key)) delete process.env[key]
  delete process.env.OPENCODE_DISABLE_CONFIG_DEP_INSTALL
  await InstanceRuntime.disposeAllInstances()
})

afterEach(async () => {
  await InstanceRuntime.disposeAllInstances()
  Global.Path.config = originalConfig
  for (const key of Object.keys(process.env)) if (isolatedKey(key)) delete process.env[key]
  Object.assign(process.env, savedEnvironment)
  if (originalFlag === undefined) {
    delete process.env.OPENCODE_DISABLE_CONFIG_DEP_INSTALL
  } else {
    process.env.OPENCODE_DISABLE_CONFIG_DEP_INSTALL = originalFlag
  }
})

describe("Config Dependency Install Integration with MockRegistry", () => {
  // The windows CI runner pays a heavy per-process spawn cost (CreateProcess + AV
  // scan), and this test shells out to a real package install, so it gets double the
  // suite's 30s budget instead of flaking at the bound. A cold install no longer fits
  // in 60s on that runner (timed out at exactly 60006ms twice), so windows gets 120s.
  const budget = process.platform === "win32" ? 120_000 : 60_000
  test(
    "installs @opencode-ai/plugin in background and waitForDependencies joins successfully",
    async () => {
      await using tmp = await tmpdir()
      await using registry = await MockRegistry.start([
        {
          name: "@opencode-ai/plugin",
          version: "1.0.0",
          files: {
            "package/package.json": JSON.stringify({
              name: "@opencode-ai/plugin",
              version: "1.0.0",
              main: "index.js",
            }),
            "package/index.js": "module.exports = { mockPluginLoaded: true };\n",
          },
        },
      ])

      const cacheDir = path.join(tmp.path, "cache")
      const npmCacheDir = path.join(tmp.path, "npm-cache")
      await fs.mkdir(cacheDir, { recursive: true })

      // Deliberately hostile inherited config must not influence the real installs.
      const hostileHome = path.join(tmp.path, "host-home")
      await fs.mkdir(hostileHome, { recursive: true })
      await fs.writeFile(path.join(hostileHome, ".npmrc"), "registry=http://127.0.0.1:1/\n")
      process.env.HOME = hostileHome
      process.env.USERPROFILE = hostileHome
      process.env.npm_config_registry = "http://127.0.0.1:1"
      process.env.NPM_CONFIG_USERCONFIG = path.join(hostileHome, ".npmrc")
      const { opencodeDir, globalConfigDir, ctx } = await createProjectFixture(tmp.path, registry.url, npmCacheDir)
      const layer = makeIntegrationLayer(cacheDir)

      const result = await Effect.gen(function* () {
        const cfg = yield* Config.Service
        const configInfo = yield* cfg.get()
        yield* cfg.waitForDependencies()
        expect(yield* cfg.directories()).toEqual([globalConfigDir, opencodeDir])
        return configInfo
      }).pipe(Effect.provideService(InstanceRef, ctx), Effect.scoped, Effect.provide(layer), Effect.runPromiseExit)

      expect(result._tag).toBe("Success")

      // Check that @opencode-ai/plugin is installed in .opencode/node_modules
      const pluginPkgJsonPath = path.join(opencodeDir, "node_modules", "@opencode-ai", "plugin", "package.json")
      const installed = await fs.readFile(pluginPkgJsonPath, "utf8")
      expect(JSON.parse(installed)).toMatchObject({ name: "@opencode-ai/plugin", version: "1.0.0" })
      const globalInstalled = JSON.parse(
        await fs.readFile(path.join(globalConfigDir, "node_modules", "@opencode-ai", "plugin", "package.json"), "utf8"),
      )
      expect(globalInstalled).toMatchObject({ name: "@opencode-ai/plugin", version: "1.0.0" })
      for (const dir of [globalConfigDir, opencodeDir]) {
        const lock = JSON.parse(await fs.readFile(path.join(dir, "package-lock.json"), "utf8"))
        const resolved = Object.values(lock.packages as Record<string, { resolved?: string }>).flatMap((pkg) =>
          pkg.resolved ? [pkg.resolved] : [],
        )
        expect(resolved.length).toBeGreaterThan(0)
        expect(resolved.every((url: string) => url.startsWith(registry.url + "/"))).toBe(true)
      }

      // Verify mock registry received requests
      const urls = registry.requests.map((r) => r.url)
      expect(urls.some((u) => u.includes("@opencode-ai") || u.includes("plugin"))).toBe(true)
    },
    budget,
  )

  // Same windows spawn-cost class as the background-install test above: the
  // recover path crossed the suite's 30s flag on a loaded runner (#485).
  const budget500 = process.platform === "win32" ? 90_000 : 30_000
  test(
    "config loads successfully and waitForDependencies recovers when mock registry returns HTTP 500",
    async () => {
      await using tmp = await tmpdir()
      await using registry = await MockRegistry.start([
        {
          name: "@opencode-ai/plugin",
          version: "1.0.0",
        },
      ])
      registry.setBehavior({ mode: "error", statusCode: 500 })

      const cacheDir = path.join(tmp.path, "cache")
      const npmCacheDir = path.join(tmp.path, "npm-cache")
      await fs.mkdir(cacheDir, { recursive: true })

      const { ctx } = await createProjectFixture(tmp.path, registry.url, npmCacheDir)
      const layer = makeIntegrationLayer(cacheDir)

      const result = await Effect.gen(function* () {
        const cfg = yield* Config.Service
        const configInfo = yield* cfg.get()
        // waitForDependencies should join the background fiber without throwing unhandled error
        yield* cfg.waitForDependencies()
        return configInfo
      }).pipe(Effect.provideService(InstanceRef, ctx), Effect.scoped, Effect.provide(layer), Effect.runPromiseExit)

      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.value).toBeDefined()
      }
    },
    budget500,
  )

  test("config loads successfully when mock registry connection is abruptly closed", async () => {
    await using tmp = await tmpdir()
    await using registry = await MockRegistry.start([
      {
        name: "@opencode-ai/plugin",
        version: "1.0.0",
      },
    ])
    registry.setBehavior({ mode: "socket-destroy" })

    const cacheDir = path.join(tmp.path, "cache")
    const npmCacheDir = path.join(tmp.path, "npm-cache")
    await fs.mkdir(cacheDir, { recursive: true })

    const { ctx } = await createProjectFixture(tmp.path, registry.url, npmCacheDir)
    const layer = makeIntegrationLayer(cacheDir)

    const result = await Effect.gen(function* () {
      const cfg = yield* Config.Service
      const configInfo = yield* cfg.get()
      yield* cfg.waitForDependencies()
      return configInfo
    }).pipe(Effect.provideService(InstanceRef, ctx), Effect.scoped, Effect.provide(layer), Effect.runPromiseExit)

    expect(result._tag).toBe("Success")
  })

  test("skips dependency install when OPENCODE_DISABLE_CONFIG_DEP_INSTALL is set", async () => {
    process.env.OPENCODE_DISABLE_CONFIG_DEP_INSTALL = "1"

    await using tmp = await tmpdir()
    await using registry = await MockRegistry.start([
      {
        name: "@opencode-ai/plugin",
        version: "1.0.0",
      },
    ])

    const cacheDir = path.join(tmp.path, "cache")
    const npmCacheDir = path.join(tmp.path, "npm-cache")
    await fs.mkdir(cacheDir, { recursive: true })

    const { ctx } = await createProjectFixture(tmp.path, registry.url, npmCacheDir)
    const layer = makeIntegrationLayer(cacheDir)

    const result = await Effect.gen(function* () {
      const cfg = yield* Config.Service
      const configInfo = yield* cfg.get()
      yield* cfg.waitForDependencies()
      return configInfo
    }).pipe(Effect.provideService(InstanceRef, ctx), Effect.scoped, Effect.provide(layer), Effect.runPromiseExit)

    expect(result._tag).toBe("Success")
    // Mock registry must NOT have received any requests
    expect(registry.requests.length).toBe(0)
  })

  test("config get returns immediately on registry stall and waitForDependencies respects timeout", async () => {
    installPhase("caller-timeout:enter")
    const previousTimeout = process.env.OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS
    process.env.OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS = "1000"
    try {
      await using tmp = await tmpdir()
      await using registry = await MockRegistry.start([
        {
          name: "@opencode-ai/plugin",
          version: "1.0.0",
        },
      ])
      registry.setBehavior({ mode: "stall" })

      const cacheDir = path.join(tmp.path, "cache")
      const npmCacheDir = path.join(tmp.path, "npm-cache")
      await fs.mkdir(cacheDir, { recursive: true })

      const { ctx } = await createProjectFixture(tmp.path, registry.url, npmCacheDir)
      const layer = makeIntegrationLayer(cacheDir)

      const result = await Effect.gen(function* () {
        const cfg = yield* Config.Service
        return yield* Effect.gen(function* () {
          // Config.get() returns promptly even if background install stalls.
          const configInfo = yield* cfg.get()
          const waitResult = yield* cfg.waitForDependencies().pipe(Effect.timeout("200 millis"), Effect.exit)
          return { configInfo, waitResult }
        }).pipe(
          // A caller timeout does not cancel detached installs. Drain before their
          // registry, lock state, or temp directory is disposed, including errors.
          Effect.ensuring(cfg.waitForDependencies()),
        )
      }).pipe(Effect.provideService(InstanceRef, ctx), Effect.scoped, Effect.provide(layer), Effect.runPromiseExit)

      // Lock cleanup must finish before the enclosing temp directory is removed.
      expect(await fs.readdir(path.join(cacheDir, "state", "locks"))).toEqual([])
      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.value.configInfo).toBeDefined()
        expect(result.value.waitResult._tag).toBe("Failure")
      }
    } finally {
      installPhase("caller-timeout:finally")
      if (previousTimeout === undefined) delete process.env.OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS
      else process.env.OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS = previousTimeout
    }
  })

  test("total install budget interrupts slow startup before HTTP and waitForDependencies joins", async () => {
    installPhase("startup:enter")
    const previousTimeout = process.env.OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS
    process.env.OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS = "250"
    const logs: string[] = []
    const captureLog = Logger.make((options) => {
      logs.push(String(options.message))
      return undefined
    })
    try {
      await using tmp = await tmpdir()
      await using registry = await MockRegistry.start([
        {
          name: "@opencode-ai/plugin",
          version: "1.0.0",
        },
      ])
      registry.setBehavior({ mode: "stall" })

      const cacheDir = path.join(tmp.path, "cache")
      const npmCacheDir = path.join(tmp.path, "npm-cache")
      await fs.mkdir(cacheDir, { recursive: true })

      const { ctx } = await createProjectFixture(tmp.path, registry.url, npmCacheDir)
      const started: string[] = []
      const interrupted: string[] = []
      const slowStart = Layer.effect(
        Npm.Service,
        Effect.gen(function* () {
          const actual = yield* Npm.Service
          return Npm.Service.of({
            ...actual,
            install: (dir, input) =>
              Effect.sync(() => started.push(dir)).pipe(
                // The total budget also covers work before the first HTTP request.
                Effect.andThen(Effect.sleep("300 millis")),
                Effect.andThen(actual.install(dir, input)),
                Effect.onInterrupt(() => Effect.sync(() => interrupted.push(dir))),
              ),
          })
        }),
      ).pipe(Layer.provide(LayerNode.compile(Npm.node)))
      const layer = LayerNode.compile(Config.node, [
        [Auth.node, AuthTest.empty],
        [Account.node, AccountTest.empty],
        [Npm.node, slowStart],
        [Global.node, Global.layerWith({ cache: cacheDir, state: path.join(cacheDir, "state") })],
        [httpClient, Layer.succeed(HttpClient.HttpClient, unexpectedHttp)],
      ])

      const startedAt = Date.now()
      const result = await Effect.gen(function* () {
        const cfg = yield* Config.Service
        const configInfo = yield* cfg.get()
        // No Effect.timeout wrap: the install's own bound must interrupt the
        // stalled fiber and let waitForDependencies join successfully.
        yield* cfg.waitForDependencies()
        return configInfo
      })
        .pipe(Effect.provide(Logger.layer([captureLog])))
        .pipe(Effect.provideService(InstanceRef, ctx), Effect.scoped, Effect.provide(layer), Effect.runPromiseExit)
      installPhase("startup:joined")
      const elapsed = Date.now() - startedAt

      expect(result._tag).toBe("Success")
      // The 250ms bound expired before the join returned...
      expect(elapsed).toBeGreaterThanOrEqual(200)
      // ...and the join returned instead of hanging on the stalled registry.
      // The 10s wall bound needs headroom on the loaded windows runner, where
      // the same join crossed it under load (#485).
      expect(elapsed).toBeLessThan(process.platform === "win32" ? 30_000 : 10_000)
      expect(started.length).toBeGreaterThan(0)
      expect(interrupted.sort()).toEqual(started.sort())
      expect(registry.requests).toHaveLength(0)
      // The bound expiry is reported as a timeout, not as an install failure.
      expect(logs.some((message) => message.includes("background dependency install timed out"))).toBe(true)
      expect(logs.some((message) => message.includes("background dependency install failed"))).toBe(false)
    } finally {
      installPhase("startup:finally")
      if (previousTimeout === undefined) delete process.env.OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS
      else process.env.OPENCODE_CONFIG_DEP_INSTALL_TIMEOUT_MS = previousTimeout
    }
  })

  test("interrupting a real stalled registry request closes its TCP socket and releases locks", async () => {
    installPhase("tcp:enter")
    await using tmp = await tmpdir()
    const entered = Deferred.makeUnsafe<void>()
    const closed = Deferred.makeUnsafe<void>()
    const server = http.createServer((request) => {
      installPhase("tcp:request")
      // Observe the socket carrying this exact stalled request, not an unrelated close.
      request.socket.once("close", () => {
        installPhase("tcp:socket-closed")
        Deferred.doneUnsafe(closed, Effect.void)
      })
      Deferred.doneUnsafe(entered, Effect.void)
    })
    const sockets = new Set<import("node:net").Socket>()
    server.on("connection", (socket) => {
      sockets.add(socket)
      socket.once("close", () => {
        sockets.delete(socket)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    installPhase("tcp:listening")
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("missing registry address")
      const cacheDir = path.join(tmp.path, "cache")
      const fixture = await createProjectFixture(
        tmp.path,
        `http://127.0.0.1:${address.port}`,
        path.join(tmp.path, "npm-cache"),
      )
      const result = await Effect.gen(function* () {
        const npm = yield* Npm.Service
        const fiber = yield* npm
          .install(fixture.opencodeDir, {
            add: [{ name: "@opencode-ai/plugin", version: "1.0.0" }],
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
        yield* Effect.sync(() => installPhase("tcp:interrupting"))
        yield* Fiber.interrupt(fiber)
        yield* Effect.sync(() => installPhase("tcp:interrupted"))
        yield* Deferred.await(closed).pipe(Effect.timeout("5 seconds"))
        return yield* Fiber.await(fiber)
      }).pipe(Effect.scoped, Effect.provide(makeIntegrationLayer(cacheDir)), Effect.runPromise)
      installPhase("tcp:joined")
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.hasInterrupts(result.cause)).toBe(true)
      expect(await fs.readdir(path.join(cacheDir, "state", "locks"))).toEqual([])
    } finally {
      installPhase("tcp:finally")
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      installPhase("tcp:cleanup-complete")
    }
  }, 15000)
})
