// Spawned with `bun test --timeout 800` by host-timeout.test.ts. The first test hangs on
// Effect.never while a scoped resource holds an environment value, so Bun abandons the test
// callback. testEffect's per-test onTestFinished hook must interrupt and join the fiber, so
// the release finalizer restores the previous value before the next test runs.
import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { testEffect } from "../effect"

class Resource extends Context.Service<Resource, {}>()("HostTimeoutResource") {}

const key = "SILVERCODE_TEST_HOST_TIMEOUT_VALUE"
const previous = process.env[key]
const events: string[] = []

const restore = () => {
  if (previous === undefined) delete process.env[key]
  else process.env[key] = previous
}

const layer = Layer.effect(
  Resource,
  Effect.acquireRelease(
    Effect.sync(() => {
      process.env[key] = "active"
      events.push("acquired")
      return {}
    }),
    () =>
      Effect.promise(async () => {
        events.push("release-start")
        await new Promise((resolve) => setTimeout(resolve, 50))
        restore()
        events.push("release-end")
      }),
  ),
)

const it = testEffect(layer)

it.live("hangs on a scoped Effect until the host timeout abandons it", () =>
  Effect.gen(function* () {
    yield* Resource
    yield* Effect.never
  }),
)

test("next Bun test sees the restored environment value", () => {
  expect(process.env[key]).toBe(previous)
  expect(events).toEqual(["acquired", "release-start", "release-end"])
})

it.live("a settled failure is still reported", () => Effect.fail(new Error("expected settled failure")))
