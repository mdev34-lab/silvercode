// Shared memoMap runner probe (#609 + #671): proves interruption-safe `Scope.close` joins
// 250ms layer finalizers both when interrupted in the test body and when interrupted partway
// through `Layer.buildWithMemoMap`, leaving `memoMap` unpoisoned for subsequent runs.
import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { inflightOwnedRunCount } from "../owned-deadline"
import { testEffectShared } from "../effect"

class SharedBase extends Context.Service<SharedBase, {}>()("AbandonedSharedBase") {}
class SharedDependent extends Context.Service<SharedDependent, {}>()("AbandonedSharedDependent") {}

const envKey = "SILVERCODE_TEST_ABANDONED_SHARED_ENV"
const previousEnv = process.env[envKey]
const events: string[] = []

const restoreEnv = () => {
  if (previousEnv === undefined) delete process.env[envKey]
  else process.env[envKey] = previousEnv
}

const baseLayer = Layer.effect(
  SharedBase,
  Effect.acquireRelease(
    Effect.sync(() => {
      process.env[envKey] = "active"
      events.push("acquired")
      return {}
    }),
    (_resource, exit) =>
      Effect.promise(async () => {
        events.push(`release-start:${exit._tag}`)
        await new Promise((resolve) => setTimeout(resolve, 250))
        restoreEnv()
        events.push("release-end")
      }),
  ),
)

const partialHangLayer = Layer.effect(
  SharedDependent,
  Effect.gen(function* () {
    yield* SharedBase
    events.push("dependent-hang")
    return yield* Effect.never
  }),
).pipe(Layer.provideMerge(baseLayer))

const itShared = testEffectShared(baseLayer)
const itPartial = testEffectShared(partialHangLayer)

itShared.live("settled shared run acquires and releases cleanly", () =>
  Effect.gen(function* () {
    yield* SharedBase
  }),
)

test("next test observes settled shared release with Success exit", () => {
  expect(process.env[envKey]).toBe(previousEnv)
  expect(events).toEqual(["acquired", "release-start:Success", "release-end"])
  events.length = 0
})

itShared.live("settled shared body failure closes scope with Failure exit and rethrows via Cause.squash", () =>
  Effect.gen(function* () {
    yield* SharedBase
    return yield* Effect.fail(new Error("expected shared body failure"))
  }),
)

test("next test observes settled shared body failure release with Failure exit", () => {
  expect(process.env[envKey]).toBe(previousEnv)
  expect(events).toEqual(["acquired", "release-start:Failure", "release-end"])
  expect(inflightOwnedRunCount()).toBe(0)
  events.length = 0
})

itShared.live(
  "abandoned shared body run joins 250ms Scope.close before next test",
  () =>
    Effect.gen(function* () {
      yield* SharedBase
      yield* Effect.never
    }),
  { timeout: 800 },
)

test("next test observes abandoned shared release with Failure exit", () => {
  expect(process.env[envKey]).toBe(previousEnv)
  expect(events).toEqual(["acquired", "release-start:Failure", "release-end"])
  expect(inflightOwnedRunCount()).toBe(0)
  events.length = 0
})

itPartial.live(
  "abandoned partial Layer.buildWithMemoMap closes already-built memoMap scope",
  () => Effect.void,
  800,
)

itShared.live("subsequent shared run reuses clean memoMap after partial interruption", () =>
  Effect.gen(function* () {
    expect(process.env[envKey]).toBe("active")
    expect(events).toEqual(["acquired", "dependent-hang", "release-start:Failure", "release-end", "acquired"])
    yield* SharedBase
  }),
)
