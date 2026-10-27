import { ownedDeadlineTest, validateOwnedDeadline, type OwnedDeadline } from "./owned-deadline"
import { afterEach, onTestFinished, test, type TestOptions } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Cause, Duration, Effect, Exit, Layer } from "effect"
import * as Scope from "effect/Scope"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import type { Config } from "@/config/config"
import { TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { InstanceStore } from "@/project/instance-store"

type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>)
type InstanceOptions<E, R> = {
  git?: boolean
  config?: Partial<ConfigV1.Info> | (() => Partial<ConfigV1.Info>)
  init?: (directory: string) => Effect.Effect<void, E, R>
}

function isInstanceOptions<E, R>(
  options: InstanceOptions<E, R> | number | TestOptions | undefined,
): options is InstanceOptions<E, R> {
  return !!options && typeof options === "object" && ("git" in options || "config" in options || "init" in options)
}

function instanceArgs<E, R>(
  options?: InstanceOptions<E, R> | number | TestOptions,
  testOptions?: number | TestOptions,
): { instanceOptions: InstanceOptions<E, R> | undefined; testOptions: number | TestOptions | undefined } {
  if (typeof options === "number") return { instanceOptions: undefined, testOptions: options }
  if (isInstanceOptions(options)) return { instanceOptions: options, testOptions }
  return { instanceOptions: undefined, testOptions: options }
}

const body = <A, E, R>(value: Body<A, E, R>) => Effect.suspend(() => (typeof value === "function" ? value() : value))

type Runner = <A, E, R, E2>(value: Body<A, E, R | Scope.Scope>, layer: Layer.Layer<R, E2>, deadline?: OwnedDeadline) => Promise<A>

// A host-level Bun timeout only rejects the test Promise; it never interrupts the Effect
// fiber, so scoped finalizers (and anything they restore) could still run while the next test
// is already running. Own each run instead: a per-test AbortController interrupts the fiber,
// and the test-scoped `onTestFinished` hook joins that interruption, so finalizers complete
// before Bun moves on.
//
// The hook must be registered synchronously from the test callback, before the callback
// yields anything (Bun only collects hooks registered while the callback starts; a hook
// registered later never runs). Runs that settle on their own make it a no-op — it only
// aborts while settlement is still pending — and the callback keeps observing the same
// promise the hook joins, so a genuine failure is still reported to Bun.
//
// Concurrent tests are unsupported: Bun rejects onTestFinished inside test.concurrent, and
// the registration-first ordering above turns that rejection into a test failure before any
// fiber starts rather than an orphan run. Finalizers that hang forever stay unowned: the
// hook joins settlement without a budget of its own, so the before-next guarantee covers
// only finite, cooperative finalizers. A finalizer that never settles can hang the test
// process (observed: a host timeout with an uninterruptible Effect.never release made no
// progress until an external kill); nothing here bounds that case.
// A finite finalizer that outlasts Bun's own hook timeout (observed locally: a 1200ms release with
// --timeout 800) is cut off by that timeout, reported as a hook timeout, and the next test can still
// start while it runs. Bun keeps no wait longer than its hook timeout, so that case stays unowned too.
function runOwned<A, E>(execution: Effect.Effect<A, E>): Promise<A> {
  const controller = new AbortController()
  let settled = false
  // Assigned synchronously right after the hook is registered; the hook can only fire once
  // the test has finished, which is after this function returned.
  let run: Promise<Exit.Exit<A, E>>
  // Registering before the fiber starts keeps a registration failure from orphaning work:
  // Bun rejects onTestFinished outside a serial test (e.g. inside test.concurrent), and with
  // this ordering that rejection propagates out of the test callback before any fiber
  // launches, so an unsupported context fails the calling test instead of leaking a run.
  // Registered twice, one cleanup: Bun runs a hook registered inside a test before the file's own afterEach,
  // while onTestFinished runs after it. Interrupting first keeps a finalizer from restoring a value that the
  // test's afterEach already reset. The second registration is the fallback and is a no-op after the first.
  let released = false
  const release = async () => {
    if (released) return
    released = true
    if (settled) return
    controller.abort()
    const exit = await run
    // Interruption is the expected result of this abort. Anything else came from a finalizer and is surfaced.
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) throw Cause.squash(exit.cause)
  }
  afterEach(release)
  onTestFinished(release)
  run = Effect.runPromiseExit(execution, { signal: controller.signal }).then((exit) => {
    settled = true
    return exit
  })
  return run.then((exit) => {
    if (!Exit.isFailure(exit)) return exit.value
    // Only reachable here because this run was abandoned: the host already reported the
    // timeout, so keep the abandoned callback pending instead of adding a second, redundant
    // interruption failure for a test that is already failed.
    if (controller.signal.aborted) return new Promise<A>(() => {})
    throw Cause.squash(exit.cause)
  })
}

const isolatedRun: Runner = (value, layer, deadline) => {
  const execution = Effect.gen(function* () {
    const exit = yield* body(value).pipe(Effect.scoped, Effect.provide(layer), Effect.exit)
    if (Exit.isFailure(exit)) {
      for (const err of Cause.prettyErrors(exit.cause)) {
        yield* Effect.logError(err)
      }
    }
    return yield* exit
  })
  return deadline ? ownedDeadlineTest(() => execution, deadline)() : runOwned(execution)
}

// Builds the test layer through the shared process-wide memoMap so cached
// services (Bus, Session, …) match Server.Default's instances. Use for tests
// that publish to an in-process HTTP server and need pub/sub identity with
// the server's handlers.
const sharedRun: Runner = (value, layer) =>
  runOwned(
    Effect.gen(function* () {
      // Close the shared scope as a finalizer, not as a trailing statement: when a host
      // timeout interrupts the body, the fiber unwinds past any following statement, so only
      // a finalizer still releases the layer's resources before the run settles.
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
      const ctx = yield* Layer.buildWithMemoMap(layer, memoMap, scope)
      const exit = yield* body(value).pipe(Effect.scoped, Effect.provide(ctx), Effect.exit)
      if (Exit.isFailure(exit)) {
        for (const err of Cause.prettyErrors(exit.cause)) {
          yield* Effect.logError(err)
        }
      }
      return yield* exit
    }).pipe(Effect.scoped),
  )

// A test that declares its own host timeout can be cancelled a little before Bun gives up, so
// cooperative Effect work is interrupted and joined while the test still owns the clock. Bun
// does not expose the configured default (CLI --timeout or its 5000ms default), so tests
// without an explicit timeout cannot pick a deadline and rely on the host-timeout hook in
// `runOwned` instead of a guessed budget.
function ownedFor(opts?: number | TestOptions): OwnedDeadline | undefined {
  const hostTimeoutMs = typeof opts === "number" ? opts : opts?.timeout
  if (hostTimeoutMs === undefined || !Number.isFinite(hostTimeoutMs) || hostTimeoutMs <= 0) return undefined
  const cleanupHeadroomMs = Math.max(1, Math.min(500, Math.floor(hostTimeoutMs / 10)))
  const deadlineMs = hostTimeoutMs - cleanupHeadroomMs
  if (deadlineMs <= 0) return undefined
  return { deadlineMs, hostTimeoutMs, cleanupHeadroomMs }
}

const make = <R, E>(testLayer: Layer.Layer<R, E>, liveLayer: Layer.Layer<R, E>, run: Runner = isolatedRun) => {
  const effect = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test(name, () => run(value, testLayer, ownedFor(opts)), opts)

  effect.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.only(name, () => run(value, testLayer, ownedFor(opts)), opts)

  effect.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.skip(name, () => run(value, testLayer), opts)

  const live = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test(name, () => run(value, liveLayer, ownedFor(opts)), opts)

  live.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.only(name, () => run(value, liveLayer, ownedFor(opts)), opts)

  live.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.skip(name, () => run(value, liveLayer), opts)

  const instance = <A, E2, E3 = never>(
    name: string,
    value: Body<A, E2, R | InstanceStore.Service | TestInstance | Scope.Scope>,
    options?: InstanceOptions<E3, R | Scope.Scope> | number | TestOptions,
    opts?: number | TestOptions,
  ) => {
    const args = instanceArgs(options, opts)
    return test(
      name,
      () => run(body(value).pipe(withTmpdirInstance(args.instanceOptions)), liveLayer, ownedFor(args.testOptions)),
      args.testOptions,
    )
  }

  instance.only = <A, E2, E3 = never>(
    name: string,
    value: Body<A, E2, R | InstanceStore.Service | TestInstance | Scope.Scope>,
    options?: InstanceOptions<E3, R | Scope.Scope> | number | TestOptions,
    opts?: number | TestOptions,
  ) => {
    const args = instanceArgs(options, opts)
    return test.only(
      name,
      () => run(body(value).pipe(withTmpdirInstance(args.instanceOptions)), liveLayer, ownedFor(args.testOptions)),
      args.testOptions,
    )
  }

  instance.skip = <A, E2, E3 = never>(
    name: string,
    value: Body<A, E2, R | InstanceStore.Service | TestInstance | Scope.Scope>,
    options?: InstanceOptions<E3, R | Scope.Scope> | number | TestOptions,
    opts?: number | TestOptions,
  ) => {
    const args = instanceArgs(options, opts)
    return test.skip(
      name,
      () => run(body(value).pipe(withTmpdirInstance(args.instanceOptions)), liveLayer, ownedFor(args.testOptions)),
      args.testOptions,
    )
  }

  return { effect, live, instance }
}

// Test environment with TestClock and TestConsole
const testEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer())

// Live environment - uses real clock, but keeps TestConsole for output capture
const liveEnv = TestConsole.layer

export const it = make<never, never>(testEnv, liveEnv)

export const testEffect = <R, E>(layer: Layer.Layer<R, E>) =>
  make<R, E>(Layer.provideMerge(layer, testEnv), Layer.provideMerge(layer, liveEnv))

// Variant of `testEffect` that builds the test layer through the shared
// process-wide memoMap so services like Bus/Session resolve to the same
// instances Server.Default uses. Use when a test needs pub/sub identity with
// an in-process HTTP server — most tests should stick with `testEffect`.
export const testEffectShared = <R, E>(layer: Layer.Layer<R, E>) =>
  make<R, E>(Layer.provideMerge(layer, testEnv), Layer.provideMerge(layer, liveEnv), sharedRun)

export const awaitWithTimeout = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  message: string,
  duration: Duration.Input = "2 seconds",
) =>
  self.pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.fail(new Error(message)),
    }),
  )

export const pollWithTimeout = <A, E, R>(
  self: Effect.Effect<A | undefined, E, R>,
  message: string,
  duration: Duration.Input = "5 seconds",
) =>
  Effect.gen(function* () {
    while (true) {
      const result = yield* self
      if (result !== undefined) return result
      yield* Effect.sleep("20 millis")
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.fail(new Error(message)),
    }),
  )

// Deliberately separate from sharedRun: opt in only for cooperative Effect work.
// Bun hooks and signal-less Promise work are outside this ownership contract.
export function testEffectOwned<R, E>(layer: Layer.Layer<R, E>, deadline: OwnedDeadline) {
  validateOwnedDeadline(deadline)
  const budget = Object.freeze({ ...deadline })
  const provided = Layer.provideMerge(layer, liveEnv)
  return {
    live: <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>) =>
      test(name, () => isolatedRun(value, provided, budget), budget.hostTimeoutMs),
  }
}
