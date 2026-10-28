// Issue 2 probe: `undefined` failure/defect values (`Effect.fail(undefined)` / `Effect.die(undefined)`)
// must never collide with a missing-defect sentinel or let a raced test pass green.
import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { inflightOwnedRunCount, runOwned } from "../owned-deadline"
import { testEffect } from "../effect"

class UndefinedProbe extends Context.Service<UndefinedProbe, {}>()("AbandonedUndefinedDefectProbe") {}

const undefinedFinalizerLayer = Layer.effect(
  UndefinedProbe,
  Effect.acquireRelease(
    Effect.succeed({}),
    () =>
      Effect.promise(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150))
      }).pipe(Effect.andThen(Effect.die(undefined))),
  ),
)

const it = testEffect(undefinedFinalizerLayer)

test("raced unawaited runOwned dying with undefined in finalizer fails instead of passing green", () => {
  void runOwned(
    Effect.acquireUseRelease(
      Effect.void,
      () => Effect.never,
      () => Effect.die(undefined),
    ),
  )
})

test("raced unawaited runOwned failing with undefined fails instead of passing green", () => {
  void runOwned(
    Effect.sleep("50 millis").pipe(
      Effect.onInterrupt(() => Effect.fail(undefined).pipe(Effect.orDie)),
    ),
  )
})

it.live(
  "abandoned explicit-timeout run whose finalizer dies with undefined",
  () =>
    Effect.gen(function* () {
      yield* UndefinedProbe
      yield* Effect.never
    }),
  500,
)

test("follow-up test observes zero inflight runs after undefined defects", () => {
  expect(inflightOwnedRunCount()).toBe(0)
})
