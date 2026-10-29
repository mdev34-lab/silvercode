import { beginOwned, ownedFor, runOwned, validateOwnedDeadline, type OwnedDeadline } from "./owned-deadline"
import { test, type TestOptions } from "bun:test"
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

const runExecution = <A, E>(scoped: Effect.Effect<A, E>, deadline?: OwnedDeadline): Promise<A> =>
  runOwned(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(scoped)
      if (Exit.isFailure(exit)) {
        for (const err of Cause.prettyErrors(exit.cause)) {
          yield* Effect.logError(err)
        }
      }
      return yield* exit
    }),
    deadline,
  )

const isolatedRun: Runner = (value, layer, deadline) =>
  runExecution(body(value).pipe(Effect.scoped, Effect.provide(layer)), deadline)

// Builds the test layer through the shared process-wide memoMap so cached
// services (Bus, Session, …) match Server.Default's instances. Use for tests
// that publish to an in-process HTTP server and need pub/sub identity with
// the server's handlers.
const sharedRun: Runner = (value, layer, deadline) =>
  runExecution(
    Effect.acquireUseRelease(
      Scope.make(),
      (scope) =>
        Effect.gen(function* () {
          const ctx = yield* Layer.buildWithMemoMap(layer, memoMap, scope)
          return yield* body(value).pipe(Effect.scoped, Effect.provide(ctx))
        }),
      (scope, exit) => Scope.close(scope, exit),
    ),
    deadline,
  )

const make = <R, E>(testLayer: Layer.Layer<R, E>, liveLayer: Layer.Layer<R, E>, run: Runner = isolatedRun) => {
  const effect = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test(name, () => beginOwned(() => run(value, testLayer, ownedFor(opts))), opts)

  effect.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.only(name, () => beginOwned(() => run(value, testLayer, ownedFor(opts))), opts)

  effect.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.skip(name, () => beginOwned(() => run(value, testLayer)), opts)

  const live = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test(name, () => beginOwned(() => run(value, liveLayer, ownedFor(opts))), opts)

  live.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.only(name, () => beginOwned(() => run(value, liveLayer, ownedFor(opts))), opts)

  live.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.skip(name, () => beginOwned(() => run(value, liveLayer)), opts)

  const instance = <A, E2, E3 = never>(
    name: string,
    value: Body<A, E2, R | InstanceStore.Service | TestInstance | Scope.Scope>,
    options?: InstanceOptions<E3, R | Scope.Scope> | number | TestOptions,
    opts?: number | TestOptions,
  ) => {
    const args = instanceArgs(options, opts)
    return test(
      name,
      () => beginOwned(() => run(body(value).pipe(withTmpdirInstance(args.instanceOptions)), liveLayer, ownedFor(args.testOptions))),
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
      () => beginOwned(() => run(body(value).pipe(withTmpdirInstance(args.instanceOptions)), liveLayer, ownedFor(args.testOptions))),
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
      () => beginOwned(() => run(body(value).pipe(withTmpdirInstance(args.instanceOptions)), liveLayer, ownedFor(args.testOptions))),
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
