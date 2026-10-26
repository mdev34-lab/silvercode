import { test, expect } from "bun:test"
import { Effect, Layer, Context } from "effect"
import { testEffect } from "../effect"
class Resource extends Context.Service<Resource, { value: string }>()("ImplicitOwnedTestResource") {}
const events: string[] = []
let flag = "original"
const layer = Layer.effect(
  Resource,
  Effect.acquireRelease(
    Effect.sync(() => {
      flag = "active"
      events.push("acquired")
      return { value: "ok" }
    }),
    () =>
      Effect.promise(async () => {
        events.push("release-start")
        await new Promise((r) => setTimeout(r, 30))
        flag = "original"
        events.push("release-end")
      }),
  ),
)
// No per-test timeout: the host timeout comes only from `bun test --timeout` on the command line.
const it = testEffect(layer)
it.live("implicit host timeout after layer acquisition", () =>
  Effect.gen(function* () {
    yield* Resource
    yield* Effect.never
  }),
)
test("next Bun test sees the implicitly timed out layer finalized", () => {
  expect(flag).toBe("original")
  expect(events).toEqual(["acquired", "release-start", "release-end"])
})
