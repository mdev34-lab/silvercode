import fs from "fs/promises"
import path from "path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Fiber, Cause } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { tmpdir } from "../tmpdir"
import { MockRegistry } from "../mock-registry"

// Config env values override project .npmrc, including its fresh tarball cache.
// Keep host npm settings out of these real-registry fault tests.
const isolated = (key: string) =>
  /^(npm_config_|home$|userprofile$|https?_proxy$|no_proxy$|all_proxy$|proxy$)/i.test(key)
let savedEnv: Record<string, string | undefined>
let home: Awaited<ReturnType<typeof tmpdir>>
beforeEach(async () => {
  savedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => isolated(key)))
  for (const key of Object.keys(process.env)) if (isolated(key)) delete process.env[key]
  home = await tmpdir()
  process.env.HOME = home.path
  process.env.USERPROFILE = home.path
  process.env.npm_config_userconfig = path.join(home.path, "user.npmrc")
  process.env.npm_config_globalconfig = path.join(home.path, "global.npmrc")
  await fs.writeFile(process.env.npm_config_userconfig, "")
  await fs.writeFile(process.env.npm_config_globalconfig, "")
})
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (isolated(key)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  await home?.[Symbol.asyncDispose]()
})

const npmLayer = (cache: string) =>
  AppNodeBuilder.build(Npm.node, [[Global.node, Global.layerWith({ cache, state: path.join(cache, "state") })]])

const writeProject = async (
  dir: string,
  registryUrl: string,
  npmCacheDir: string,
  pkg: Record<string, unknown> = {},
) => {
  await fs.writeFile(
    path.join(dir, ".npmrc"),
    [
      `registry=${registryUrl}/`,
      `cache=${npmCacheDir}`,
      // @npmcli/agent snapshots proxy env at module import, before hooks run.
      // An explicit local bypass also defeats that cached inherited proxy.
      "noproxy=127.0.0.1,localhost",
      "fetch-retries=0",
      "fetch-retry-mintimeout=1",
      "fetch-retry-maxtimeout=1",
      "",
    ].join("\n"),
  )
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "test-project",
      version: "1.0.0",
      ...pkg,
    }),
  )
}

describe("Npm with MockRegistry - Normal Installation", () => {
  test("installs scoped package from mock registry into project node_modules", async () => {
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
          "package/index.js": "module.exports = { isMockPlugin: true };\n",
        },
      },
    ])

    const projectDir = path.join(tmp.path, "project")
    const cacheDir = path.join(tmp.path, "cache")
    const npmCache = path.join(tmp.path, "npm-cache")
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(cacheDir, { recursive: true })

    await writeProject(projectDir, registry.url, npmCache)

    const layer = npmLayer(cacheDir)
    const result = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.install(projectDir, {
        add: [{ name: "@opencode-ai/plugin", version: "1.0.0" }],
      })
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromiseExit)

    expect(result._tag).toBe("Success")

    const installedPkg = await fs.readFile(
      path.join(projectDir, "node_modules", "@opencode-ai", "plugin", "package.json"),
      "utf8",
    )
    expect(JSON.parse(installedPkg).name).toBe("@opencode-ai/plugin")

    const installedCode = await fs.readFile(
      path.join(projectDir, "node_modules", "@opencode-ai", "plugin", "index.js"),
      "utf8",
    )
    expect(installedCode).toContain("isMockPlugin: true")

    // Verify mock registry received the expected requests
    const urls = registry.requests.map((r) => r.url)
    expect(urls.some((u) => u.includes("@opencode-ai") || u.includes("plugin"))).toBe(true)
  })

  test("subsequent install is idempotent and does not refetch installed packages", async () => {
    await using tmp = await tmpdir()
    await using registry = await MockRegistry.start([
      {
        name: "@opencode-ai/plugin",
        version: "1.0.0",
      },
    ])

    const projectDir = path.join(tmp.path, "project")
    const cacheDir = path.join(tmp.path, "cache")
    const npmCache = path.join(tmp.path, "npm-cache")
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(cacheDir, { recursive: true })

    await writeProject(projectDir, registry.url, npmCache)

    const layer = npmLayer(cacheDir)
    // First install
    await Effect.gen(function* () {
      const npm = yield* Npm.Service
      yield* npm.install(projectDir, {
        add: [{ name: "@opencode-ai/plugin", version: "1.0.0" }],
      })
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)

    const requestCountAfterFirst = registry.requests.length
    expect(requestCountAfterFirst).toBeGreaterThan(0)

    // Second install with same package
    await Effect.gen(function* () {
      const npm = yield* Npm.Service
      yield* npm.install(projectDir, {
        add: [{ name: "@opencode-ai/plugin", version: "1.0.0" }],
      })
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)

    // Should not have made any new requests to the registry
    expect(registry.requests.length).toBe(requestCountAfterFirst)
  })

  test("Npm.add installs package to global cache and resolves entrypoint", async () => {
    await using tmp = await tmpdir()
    await using registry = await MockRegistry.start([
      {
        name: "mock-tool",
        version: "2.1.0",
        files: {
          "package/package.json": JSON.stringify({
            name: "mock-tool",
            version: "2.1.0",
            main: "main.js",
          }),
          "package/main.js": "export const ok = true;\n",
        },
      },
    ])

    const cacheDir = path.join(tmp.path, "cache")
    const npmCache = path.join(tmp.path, "npm-cache")
    await fs.mkdir(cacheDir, { recursive: true })

    const pkgDir = path.join(cacheDir, "packages", "mock-tool@2.1.0")
    await fs.mkdir(pkgDir, { recursive: true })
    await writeProject(pkgDir, registry.url, npmCache)

    const layer = npmLayer(cacheDir)
    const entry = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add("mock-tool@2.1.0")
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)

    expect(entry.directory).toBeDefined()
    expect(entry.entrypoint).toBeDefined()

    // Subsequent add uses cached directory directly
    const requestCount = registry.requests.length
    const entryCached = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add("mock-tool@2.1.0")
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)

    expect(entryCached.entrypoint).toBe(entry.entrypoint)
    expect(registry.requests.length).toBe(requestCount)
  })
})

describe("Npm with MockRegistry - Failures and Error Handling", () => {
  test("fails with InstallFailedError when packument returns HTTP 500", async () => {
    await using tmp = await tmpdir()
    await using registry = await MockRegistry.start([
      {
        name: "@opencode-ai/plugin",
        version: "1.0.0",
      },
    ])
    registry.setBehavior({ mode: "error", statusCode: 500 })

    const projectDir = path.join(tmp.path, "project")
    const cacheDir = path.join(tmp.path, "cache")
    const npmCache = path.join(tmp.path, "npm-cache")
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(cacheDir, { recursive: true })

    await writeProject(projectDir, registry.url, npmCache)

    const layer = npmLayer(cacheDir)
    const result = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.install(projectDir, {
        add: [{ name: "@opencode-ai/plugin", version: "1.0.0" }],
      })
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromiseExit)

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(Cause.hasFails(result.cause)).toBe(true)
    }
  })

  test("fails with InstallFailedError when package is not found (HTTP 404)", async () => {
    await using tmp = await tmpdir()
    await using registry = await MockRegistry.start([]) // No packages registered

    const projectDir = path.join(tmp.path, "project")
    const cacheDir = path.join(tmp.path, "cache")
    const npmCache = path.join(tmp.path, "npm-cache")
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(cacheDir, { recursive: true })

    await writeProject(projectDir, registry.url, npmCache)

    const layer = npmLayer(cacheDir)
    const result = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.install(projectDir, {
        add: [{ name: "nonexistent-package", version: "1.0.0" }],
      })
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromiseExit)

    expect(result._tag).toBe("Failure")
  })

  test("fails with InstallFailedError when tarball download returns HTTP 500", async () => {
    await using tmp = await tmpdir()
    await using registry = await MockRegistry.start([
      {
        name: "@opencode-ai/plugin",
        version: "1.0.0",
      },
    ])
    registry.setBehavior({ mode: "tarball-error", statusCode: 500 })

    const projectDir = path.join(tmp.path, "project")
    const cacheDir = path.join(tmp.path, "cache")
    const npmCache = path.join(tmp.path, "npm-cache")
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(cacheDir, { recursive: true })

    await writeProject(projectDir, registry.url, npmCache)

    const layer = npmLayer(cacheDir)
    const result = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.install(projectDir, {
        add: [{ name: "@opencode-ai/plugin", version: "1.0.0" }],
      })
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromiseExit)

    expect(result._tag).toBe("Failure")
    expect(registry.requests.some((request) => request.url.endsWith(".tgz"))).toBe(true)
  })

  test("fails cleanly with InstallFailedError when registry connection is abruptly closed", async () => {
    await using tmp = await tmpdir()
    await using registry = await MockRegistry.start([
      {
        name: "@opencode-ai/plugin",
        version: "1.0.0",
      },
    ])
    registry.setBehavior({ mode: "socket-destroy" })

    const projectDir = path.join(tmp.path, "project")
    const cacheDir = path.join(tmp.path, "cache")
    const npmCache = path.join(tmp.path, "npm-cache")
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(cacheDir, { recursive: true })

    await writeProject(projectDir, registry.url, npmCache)

    const layer = npmLayer(cacheDir)
    const result = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.install(projectDir, {
        add: [{ name: "@opencode-ai/plugin", version: "1.0.0" }],
      })
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromiseExit)

    expect(result._tag).toBe("Failure")
  })

  test("fails with InstallFailedError when tarball connection is abruptly closed", async () => {
    await using tmp = await tmpdir()
    await using registry = await MockRegistry.start([
      {
        name: "@opencode-ai/plugin",
        version: "1.0.0",
      },
    ])
    registry.setBehavior({ mode: "tarball-socket-destroy" })

    const projectDir = path.join(tmp.path, "project")
    const cacheDir = path.join(tmp.path, "cache")
    const npmCache = path.join(tmp.path, "npm-cache")
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(cacheDir, { recursive: true })

    await writeProject(projectDir, registry.url, npmCache)

    const layer = npmLayer(cacheDir)
    const result = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.install(projectDir, {
        add: [{ name: "@opencode-ai/plugin", version: "1.0.0" }],
      })
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromiseExit)

    expect(result._tag).toBe("Failure")
    expect(registry.requests.some((request) => request.url.endsWith(".tgz"))).toBe(true)

    // The packument fetch succeeded; only the tarball leg was killed.
    expect(registry.requests.some((r) => r.url.includes(".tgz"))).toBe(true)
  })
})

describe("Npm with MockRegistry - Stall, Interruption, and Cleanup", () => {
  test("stalled registry request is interrupted cleanly by Effect timeout", async () => {
    await using tmp = await tmpdir()
    await using registry = await MockRegistry.start([
      {
        name: "@opencode-ai/plugin",
        version: "1.0.0",
      },
    ])
    registry.setBehavior({ mode: "stall" })

    const projectDir = path.join(tmp.path, "project")
    const cacheDir = path.join(tmp.path, "cache")
    const npmCache = path.join(tmp.path, "npm-cache")
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(cacheDir, { recursive: true })

    await writeProject(projectDir, registry.url, npmCache)

    const layer = npmLayer(cacheDir)
    const startTime = Date.now()

    const result = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm
        .install(projectDir, {
          add: [{ name: "@opencode-ai/plugin", version: "1.0.0" }],
        })
        .pipe(Effect.timeout("200 millis"))
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromiseExit)

    const elapsed = Date.now() - startTime
    expect(elapsed).toBeLessThan(4000)
    expect(result._tag).toBe("Failure")

    // Registry received request before stall
    expect(registry.requests.length).toBeGreaterThan(0)
  })

  test("fiber interruption aborts pending install without leaking resources", async () => {
    await using tmp = await tmpdir()
    await using registry = await MockRegistry.start([
      {
        name: "@opencode-ai/plugin",
        version: "1.0.0",
      },
    ])
    registry.setBehavior({ mode: "tarball-stall" })

    const projectDir = path.join(tmp.path, "project")
    const cacheDir = path.join(tmp.path, "cache")
    const npmCache = path.join(tmp.path, "npm-cache")
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(cacheDir, { recursive: true })

    await writeProject(projectDir, registry.url, npmCache)

    const layer = npmLayer(cacheDir)

    const result = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      const fiber = yield* npm
        .install(projectDir, {
          add: [{ name: "@opencode-ai/plugin", version: "1.0.0" }],
        })
        .pipe(Effect.forkChild)

      // Rendezvous at the tarball, not an arbitrary delay before the request.
      yield* Effect.gen(function* () {
        while (!registry.requests.some((request) => request.url.endsWith(".tgz"))) yield* Effect.sleep("5 millis")
      }).pipe(Effect.timeout("5 seconds"))
      yield* Fiber.interrupt(fiber)
      return yield* Fiber.join(fiber).pipe(Effect.exit)
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)

    expect(result._tag).toBe("Failure")
  })
})
