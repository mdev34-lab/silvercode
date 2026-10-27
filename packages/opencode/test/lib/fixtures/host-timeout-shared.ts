// Same probe as host-timeout.ts for the memoMap-backed shared runner, where the layer scope is
// closed by a finalizer instead of a trailing statement. A host timeout must still release the
// layer before the next test observes the environment, and a settled run must still release it.
import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { hangWithLiveHandle } from "./host-timeout-keepalive"
import { testEffectShared } from "../effect"

class Resource extends Context.Service<Resource, {}>()("HostTimeoutSharedResource") {}

const key = "SILVERCODE_TEST_HOST_TIMEOUT_SHARED_VALUE"
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

const it = testEffectShared(layer)

it.live("settles after acquiring the shared resource", () =>
  Effect.gen(function* () {
    yield* Resource
  }),
)

test("next Bun test sees the settled shared run released", () => {
  expect(process.env[key]).toBe(previous)
  expect(events).toEqual(["acquired", "release-start", "release-end"])
  events.length = 0
})

it.live("hangs on a scoped Effect until the host timeout abandons it", () =>
  Effect.gen(function* () {
    yield* Resource
    yield* hangWithLiveHandle
  }),
)

test("next Bun test sees the restored shared environment value", () => {
  expect(process.env[key]).toBe(previous)
  expect(events).toEqual(["acquired", "release-start", "release-end"])
})

it.live("a settled failure is still reported", () => Effect.fail(new Error("expected settled failure")))
