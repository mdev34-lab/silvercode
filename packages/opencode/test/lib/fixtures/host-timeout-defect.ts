// Spawned with `bun test --timeout 800` by host-timeout.test.ts. The release finalizer of a hung, abandoned run
// fails, and so does a second finalizer. Interruption is the expected result of the abort, but every finalizer
// defect must still be reported, and the report must not stop the file's own afterEach from running.
import { afterEach, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { hangWithLiveHandle } from "./host-timeout-keepalive"
import { testEffect } from "../effect"

class Resource extends Context.Service<Resource, {}>()("HostTimeoutDefectResource") {}
class Second extends Context.Service<Second, {}>()("HostTimeoutDefectSecond") {}

let fileAfterEachRan = false
afterEach(() => {
  fileAfterEachRan = true
})

const layer = Layer.mergeAll(
  Layer.effect(
    Resource,
    Effect.acquireRelease(Effect.succeed({}), () => Effect.die(new Error("finalizer defect marker"))),
  ),
  Layer.effect(
    Second,
    Effect.acquireRelease(Effect.succeed({}), () => Effect.die(new Error("second finalizer defect marker"))),
  ),
)

const it = testEffect(layer)

it.live("hangs until the host timeout abandons it", () =>
  Effect.gen(function* () {
    yield* Resource
    yield* Second
    yield* hangWithLiveHandle
  }),
)

test("next test sees that the file afterEach still ran", () => {
  expect(fileAfterEachRan).toBe(true)
})
