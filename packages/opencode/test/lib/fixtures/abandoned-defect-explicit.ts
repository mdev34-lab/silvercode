// Abandoned explicit-timeout run whose 250ms release finalizer THROWS:
// - The timed-out test fails and the thrown finalizer error is surfaced and attributed to it.
// - File-level `afterEach` still runs after the Effect finalizer finishes.
// - Zero unhandled errors escape between tests, and the next test passes cleanly.
import { afterEach, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { inflightOwnedRunCount } from "../owned-deadline"
import { testEffect } from "../effect"

class ThrowingResource extends Context.Service<ThrowingResource, {}>()("AbandonedThrowingResource") {}

const envKey = "SILVERCODE_TEST_ABANDONED_DEFECT_ENV"
const previousEnv = process.env[envKey]
const order: string[] = []

const restoreEnv = () => {
  if (previousEnv === undefined) delete process.env[envKey]
  else process.env[envKey] = previousEnv
}

afterEach(() => {
  order.push("file-afterEach")
})

const layer = Layer.effect(
  ThrowingResource,
  Effect.acquireRelease(
    Effect.sync(() => {
      process.env[envKey] = "active"
      order.push("acquired")
      return {}
    }),
    () =>
      Effect.promise(async () => {
        order.push("release-start")
        await new Promise((resolve) => setTimeout(resolve, 250))
        restoreEnv()
        order.push("release-throw")
        throw new Error("explicit abandoned finalizer threw")
      }),
  ),
)

const it = testEffect(layer)

it.live(
  "abandoned explicit-timeout run whose finalizer throws",
  () =>
    Effect.gen(function* () {
      yield* ThrowingResource
      yield* Effect.never
    }),
  800,
)

test("next test passes and observes restored env and file afterEach", () => {
  expect(process.env[envKey]).toBe(previousEnv)
  expect(order).toEqual(["acquired", "release-start", "release-throw", "file-afterEach"])
  expect(inflightOwnedRunCount()).toBe(0)
})
