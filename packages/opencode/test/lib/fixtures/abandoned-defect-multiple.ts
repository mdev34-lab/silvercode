// Multi-finalizer throws under host `--timeout 800` and shared-runner finalizer throw under
// explicit timeout `800`: every defect is surfaced and attributed to its owning test without
// skipping file `afterEach` or failing subsequent tests.
import { afterEach, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { hangWithLiveHandle } from "./abandoned-keepalive"
import { inflightOwnedRunCount } from "../owned-deadline"
import { testEffect, testEffectShared } from "../effect"

class First extends Context.Service<First, {}>()("AbandonedMultiDefectFirst") {}
class Second extends Context.Service<Second, {}>()("AbandonedMultiDefectSecond") {}
class SharedThrowing extends Context.Service<SharedThrowing, {}>()("AbandonedSharedThrowing") {}

let afterEachCount = 0
afterEach(() => {
  afterEachCount++
})

const multiLayer = Layer.mergeAll(
  Layer.effect(
    First,
    Effect.acquireRelease(
      Effect.succeed({}),
      () =>
        Effect.sync(() => {
          throw new Error("first abandoned finalizer defect")
        }),
    ),
  ),
  Layer.effect(
    Second,
    Effect.acquireRelease(Effect.succeed({}), () => Effect.die(new Error("second abandoned finalizer defect"))),
  ),
)

const sharedThrowingLayer = Layer.effect(
  SharedThrowing,
  Effect.acquireRelease(
    Effect.succeed({}),
    () =>
      Effect.promise(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250))
        throw new Error("shared abandoned finalizer threw")
      }),
  ),
)

const itMulti = testEffect(multiLayer)
const itShared = testEffectShared(sharedThrowingLayer)

itMulti.live("host-abandoned run with two throwing finalizers", () =>
  Effect.gen(function* () {
    yield* First
    yield* Second
    yield* hangWithLiveHandle
  }),
)

test("next test after multi-defect host timeout passes", () => {
  expect(afterEachCount).toBe(1)
  expect(inflightOwnedRunCount()).toBe(0)
})

itShared.live(
  "shared explicit-timeout run whose 250ms finalizer throws",
  () =>
    Effect.gen(function* () {
      yield* SharedThrowing
      yield* Effect.never
    }),
  800,
)

test("next test after shared finalizer defect passes", () => {
  expect(afterEachCount).toBe(3)
  expect(inflightOwnedRunCount()).toBe(0)
})
