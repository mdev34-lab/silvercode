import { test, expect } from "bun:test"
import { Effect, Layer, Context } from "effect"
import { testEffect } from "../effect"
class Resource extends Context.Service<Resource, { value: string }>()("DefaultOwnedTestResource") {}
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
// Default testEffect path: no per-test timeout, only the host default (--timeout 1000 from the runner).
const it = testEffect(layer)
it.live(
  "default path times out after layer acquisition",
  () =>
    Effect.gen(function* () {
      yield* Resource
      yield* Effect.never
    }),
)
test("next Bun test sees default-path layer finalized", () => {
  expect(flag).toBe("original")
  expect(events).toEqual(["acquired", "release-start", "release-end"])
})
