// Spawned with `bun test --timeout 800` by host-timeout.test.ts. The release finalizer of a hung, abandoned run
// fails. Interruption is the expected result of the abort, but a finalizer defect must still be reported.
import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { hangWithLiveHandle } from "./host-timeout-keepalive"
import { testEffect } from "../effect"

class Resource extends Context.Service<Resource, {}>()("HostTimeoutDefectResource") {}

const layer = Layer.effect(
  Resource,
  Effect.acquireRelease(Effect.succeed({}), () => Effect.die(new Error("finalizer defect marker"))),
)

const it = testEffect(layer)

it.live("hangs until the host timeout abandons it", () =>
  Effect.gen(function* () {
    yield* Resource
    yield* hangWithLiveHandle
  }),
)

test("next test still runs", () => {
  expect(1).toBe(1)
})
