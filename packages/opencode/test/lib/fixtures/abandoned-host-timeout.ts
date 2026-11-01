// Host-level Bun timeout probe (#609): spawned with `bun test --timeout 800` and no per-test
// timeout options, covering both `testEffect` and `testEffectShared`.
import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { hangWithLiveHandle } from "./abandoned-keepalive"
import { inflightOwnedRunCount } from "../owned-deadline"
import { testEffect, testEffectShared } from "../effect"

class IsolatedResource extends Context.Service<IsolatedResource, {}>()("AbandonedHostIsolated") {}
class SharedResource extends Context.Service<SharedResource, {}>()("AbandonedHostShared") {}

const envKey = "SILVERCODE_TEST_ABANDONED_HOST_ENV"
const previousEnv = process.env[envKey]
const events: string[] = []

const restoreEnv = () => {
  if (previousEnv === undefined) delete process.env[envKey]
  else process.env[envKey] = previousEnv
}

const makeLayer = <S>(tag: Context.Service<S, {}>, label: string) =>
  Layer.effect(
    tag,
    Effect.acquireRelease(
      Effect.sync(() => {
        process.env[envKey] = label
        events.push(`${label}:acquired`)
        return {}
      }),
      () =>
        Effect.promise(async () => {
          events.push(`${label}:release-start`)
          await new Promise((resolve) => setTimeout(resolve, 150))
          restoreEnv()
          events.push(`${label}:release-end`)
        }),
    ),
  )

const itIsolated = testEffect(makeLayer(IsolatedResource, "isolated"))
const itShared = testEffectShared(makeLayer(SharedResource, "shared"))

itIsolated.live("host timeout abandons isolated run with no per-test option", () =>
  Effect.gen(function* () {
    yield* IsolatedResource
    yield* hangWithLiveHandle
  }),
)

test("next test sees isolated host-timed-out layer finalized", () => {
  expect(process.env[envKey]).toBe(previousEnv)
  expect(events).toEqual(["isolated:acquired", "isolated:release-start", "isolated:release-end"])
  expect(inflightOwnedRunCount()).toBe(0)
  events.length = 0
})

itShared.live("host timeout abandons shared run with no per-test option", () =>
  Effect.gen(function* () {
    yield* SharedResource
    yield* hangWithLiveHandle
  }),
)

test("next test sees shared host-timed-out layer finalized", () => {
  expect(process.env[envKey]).toBe(previousEnv)
  expect(events).toEqual(["shared:acquired", "shared:release-start", "shared:release-end"])
  expect(inflightOwnedRunCount()).toBe(0)
})
