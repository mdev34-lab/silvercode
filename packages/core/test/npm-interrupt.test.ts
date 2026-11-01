import fs from "fs/promises"
import net from "net"
import path from "path"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { Duration, Effect, Exit, Fiber, Schedule } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { tmpdir } from "./fixture/tmpdir"

// Regression coverage for issue #271: a stalled registry install must be
// cancellable. The fake-Arborist tests stand in for a stalled registry with a
// reify that never settles on its own and rejects when its AbortSignal fires,
// mirroring make-fetch-happen's behavior; the stalled-registry test below
// drives the real Arborist stack against a local TCP blackhole.

// Capture the real constructor by value BEFORE registering the module mock:
// bun's mock.module retroactively patches already-imported namespaces, so a
// `realArborist.Arborist` property read at call time would resolve to the
// mock itself and recurse until the stack overflows (observed on Windows CI).
const RealArborist = (await import("@npmcli/arborist")).Arborist

type ArboristOptions = ConstructorParameters<typeof RealArborist>[0]

const fake = {
  armed: false,
  mode: "stall" as "stall" | "ok",
  reifyCalls: 0,
  signals: [] as AbortSignal[],
  entered: Promise.resolve(),
  enter: () => {},
}

const resetFake = (mode: "stall" | "ok") => {
  fake.armed = true
  fake.mode = mode
  fake.reifyCalls = 0
  fake.signals = []
  // Rendezvous so tests can wait until Arborist.reify was actually entered
  // before interrupting or joining, keeping the assertions deterministic.
  fake.entered = new Promise<void>((resolve) => {
    fake.enter = resolve
  })
}

class FakeArborist {
  opts: ArboristOptions
  constructor(opts: ArboristOptions) {
    this.opts = opts
  }
  reify(opts: ArboristOptions) {
    fake.reifyCalls += 1
    const signal = pickSignal(opts) ?? pickSignal(this.opts)
    if (signal) fake.signals.push(signal)
    fake.enter()
    if (fake.mode === "ok") return Promise.resolve({ edgesOut: new Map() })
    return new Promise((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
        { once: true },
      )
    })
  }
}

const pickSignal = (opts: unknown) =>
  typeof opts === "object" && opts !== null && "signal" in opts && opts.signal instanceof AbortSignal
    ? opts.signal
    : undefined

// bun:test module mocks are process-global and mock.restore() does not undo
// them, so this stand-in delegates to the real Arborist unless a test in this
// file explicitly arms the fake. Other test files (npm.test.ts) keep
// exercising the real install path even when they run after this one.
void mock.module("@npmcli/arborist", () => ({
  Arborist: function Arborist(opts: ArboristOptions) {
    if (fake.armed) return new FakeArborist(opts)
    return new RealArborist(opts)
  },
}))

afterEach(() => {
  fake.armed = false
})

const npmLayer = (cache: string) =>
  AppNodeBuilder.build(Npm.node, [[Global.node, Global.layerWith({ cache, state: path.join(cache, "state") })]])

const lockDirs = (state: string) =>
  Effect.promise(() =>
    fs
      .readdir(path.join(state, "locks"))
      .then((entries) => entries.filter((entry) => entry.endsWith(".lock")))
      .catch(() => [] as string[]),
  )

// Poll instead of reading once: NTFS/security scanners can lag directory
// removal briefly after the interrupted fiber released the lock. A truly
// unreleased lock still fails the test once the 3s budget expires.
const waitLocksReleased = (state: string) =>
  lockDirs(state).pipe(
    Effect.flatMap((dirs) =>
      dirs.length === 0 ? Effect.void : Effect.fail(new Error(`install lock still held: ${dirs.join(", ")}`)),
    ),
    Effect.retry({
      schedule: Schedule.spaced(100).pipe(Schedule.while((meta) => meta.elapsed < 3_000)),
      while: () => true,
    }),
  )

describe("Npm.install cancellation", () => {
  // 30s budget: the test runs two full install cycles (NpmConfig.load + flock
  // + reify each), which is far slower on Windows CI (NTFS + Defender) than
  // bun's 5s default allows.
  test("interrupting a stalled reify aborts the Arborist signal and releases the install lock", async () => {
    await using tmp = await tmpdir()
    const cache = path.join(tmp.path, "cache")
    const state = path.join(cache, "state")
    const dir = path.join(tmp.path, "project")
    await fs.mkdir(dir)
    resetFake("stall")

    await Effect.gen(function* () {
      const npm = yield* Npm.Service
      const fiber = yield* Effect.forkScoped(npm.install(dir, { add: [{ name: "stalled-pkg" }] }))
      yield* Effect.promise(() => fake.entered)
      expect(fake.reifyCalls).toBe(1)
      expect(fake.signals).toHaveLength(1)
      expect(fake.signals[0].aborted).toBe(false)

      yield* Fiber.interrupt(fiber)

      // Actual cancellation: the AbortSignal handed to Arborist (and through it
      // to pacote/npm-registry-fetch) fired, so in-flight registry work is
      // aborted instead of orphaned when the fiber is interrupted.
      expect(fake.signals[0].aborted).toBe(true)
      // Scope disposal: the flock acquired for this install directory was
      // released while unwinding the interrupted fiber.
      yield* waitLocksReleased(state)

      // The released lock is usable again: a follow-up install in the same
      // directory acquires it and completes without waiting on the stalled one.
      // Bounded so a lock-retry loop would fail the assertion instead of
      // burning the whole test budget.
      fake.mode = "ok"
      const exit = yield* npm
        .install(dir, { add: [{ name: "stalled-pkg" }] })
        .pipe(Effect.timeout(Duration.seconds(20)), Effect.exit)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(fake.reifyCalls).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)
  }, 30_000)

  test("a successful reify receives a live signal and completes without aborting it", async () => {
    await using tmp = await tmpdir()
    const cache = path.join(tmp.path, "cache")
    const state = path.join(cache, "state")
    const dir = path.join(tmp.path, "project")
    await fs.mkdir(dir)
    resetFake("ok")

    await Effect.gen(function* () {
      const npm = yield* Npm.Service
      const fiber = yield* Effect.forkScoped(npm.install(dir, { add: [{ name: "healthy-pkg" }] }))
      yield* Effect.promise(() => fake.entered)
      yield* Fiber.join(fiber)
      // Normal installs are untouched by the cancellation wiring.
      expect(fake.signals).toHaveLength(1)
      expect(fake.signals[0].aborted).toBe(false)
      yield* waitLocksReleased(state)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)
  }, 30_000)
})

const waitSocketsClosed = (sockets: Set<net.Socket>) =>
  Effect.sync(() => sockets.size).pipe(
    Effect.flatMap((size) =>
      size === 0 ? Effect.void : Effect.fail(new Error(`registry sockets still open after interrupt: ${size}`)),
    ),
    Effect.retry({
      schedule: Schedule.spaced(100).pipe(Schedule.while((meta) => meta.elapsed < 5_000)),
      while: () => true,
    }),
  )

describe("Npm.install stalled registry", () => {
  // Deterministic stalled registry against the real Arborist stack: a local
  // TCP server that accepts connections and never replies. No module mocks —
  // the rendezvous is the registry socket itself, so this runs on every
  // platform. Interrupting the install must abort the in-flight registry
  // fetch (sockets destroyed via Npm.reify's AbortSignal) and release the
  // install flock, leaving no orphan work behind.
  test("interrupting a real install stalled on the registry cancels in-flight sockets and releases the lock", async () => {
    await using tmp = await tmpdir()
    const cache = path.join(tmp.path, "cache")
    const state = path.join(cache, "state")
    const dir = path.join(tmp.path, "project")
    await fs.mkdir(dir)

    const sockets = new Set<net.Socket>()
    let notifyConnected: (() => void) | undefined
    const connected = new Promise<void>((resolve) => {
      notifyConnected = resolve
    })
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.on("close", () => {
        sockets.delete(socket)
      })
      socket.on("error", () => {})
      notifyConnected?.()
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("expected a TCP port")
    await fs.writeFile(path.join(dir, ".npmrc"), `registry=http://127.0.0.1:${address.port}/\n`)

    try {
      await Effect.gen(function* () {
        const npm = yield* Npm.Service
        const fiber = yield* Effect.forkScoped(npm.install(dir, { add: [{ name: "stalled-pkg" }] }))
        // Rendezvous: Arborist has actually begun registry work against the
        // stalled registry, so the interrupt below cannot race ahead of it.
        yield* Effect.promise(() => connected).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(20),
            orElse: () => Effect.die(new Error("stalled registry never received a connection")),
          }),
        )
        yield* Fiber.interrupt(fiber)
        // Actual cancellation of in-flight Arborist work: the abort signal
        // destroys the stalled registry sockets instead of leaving them open.
        yield* waitSocketsClosed(sockets)
        // Scope disposal: the install flock was released while unwinding.
        yield* waitLocksReleased(state)
      }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 45_000)
})
