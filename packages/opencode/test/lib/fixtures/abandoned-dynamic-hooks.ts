// Issue 3 & Issue 3c probe:
// 1. Dynamic `afterEach` registered inside the test body (or immediately after `runOwned`) that throws
//    must not pre-empt `releaseScope`, leak the fiber into the next test, or emit unhandled errors.
// 2. Two overlapping `runOwned` runs in one test that both defect on abandonment must surface both
//    defects and leak neither key in `runs`.
import { afterEach, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { inflightOwnedRunCount, runOwned } from "../owned-deadline"
import { testEffect } from "../effect"
import { hangWithLiveHandle } from "./abandoned-keepalive"

class DynamicHookProbe extends Context.Service<DynamicHookProbe, {}>()("AbandonedDynamicHookProbe") {}

const envKey = "SILVERCODE_TEST_ABANDONED_DYN_HOOK_ENV"
const previousEnv = process.env[envKey]
const events: string[] = []

const restoreEnv = () => {
  if (previousEnv === undefined) delete process.env[envKey]
  else process.env[envKey] = previousEnv
}

const slowReleaseLayer = Layer.effect(
  DynamicHookProbe,
  Effect.acquireRelease(
    Effect.sync(() => {
      process.env[envKey] = "active"
      events.push("acquire")
      return {}
    }),
    () =>
      Effect.promise(async () => {
        events.push("release-start")
        await new Promise((resolve) => setTimeout(resolve, 200))
        restoreEnv()
        events.push("release-end")
      }),
  ),
)

const it = testEffect(slowReleaseLayer)

it.live(
  "dynamic afterEach inside testEffect body runs after fiber join even when it throws",
  () =>
    Effect.gen(function* () {
      yield* DynamicHookProbe
      afterEach(() => {
        events.push("body-dyn-afterEach-throw")
        throw new Error("body dynamic afterEach boom")
      })
      yield* Effect.never
    }),
  600,
)

test(
  "next test after throwing body dynamic afterEach sees joined release and no unhandled error",
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(process.env[envKey]).toBe(previousEnv)
    expect(events).toEqual(["acquire", "release-start", "release-end", "body-dyn-afterEach-throw"])
    expect(inflightOwnedRunCount()).toBe(0)
    events.length = 0
  },
  1000,
)

test(
  "dynamic afterEach registered after direct runOwned call runs after fiber join",
  () => {
    const running = runOwned(
      Effect.acquireUseRelease(
        Effect.sync(() => {
          process.env[envKey] = "active"
          events.push("direct-acquire")
        }),
        () => Effect.never,
        () =>
          Effect.promise(async () => {
            events.push("direct-release-start")
            await new Promise((resolve) => setTimeout(resolve, 200))
            restoreEnv()
            events.push("direct-release-end")
          }),
      ),
      { deadlineMs: 450, hostTimeoutMs: 600, cleanupHeadroomMs: 150 },
    )
    afterEach(() => {
      events.push("post-runOwned-dyn-afterEach-throw")
      throw new Error("post-runOwned dynamic afterEach boom")
    })
    return running
  },
  600,
)

test(
  "next test after post-runOwned throwing dynamic afterEach sees joined release",
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(process.env[envKey]).toBe(previousEnv)
    expect(events).toEqual([
      "direct-acquire",
      "direct-release-start",
      "direct-release-end",
      "post-runOwned-dyn-afterEach-throw",
    ])
    expect(inflightOwnedRunCount()).toBe(0)
    events.length = 0
  },
  1000,
)

const overlapEvents: string[] = []

test(
  "two overlapping runOwned runs both defecting surface both defects and leak neither key",
  async () => {
    const first = runOwned(
      Effect.acquireUseRelease(
        Effect.void,
        () => hangWithLiveHandle,
        () =>
          Effect.promise(async () => {
            await new Promise((resolve) => setTimeout(resolve, 120))
            overlapEvents.push("run-1-joined")
            throw new Error("overlapping run 1 finalizer defect")
          }),
      ),
    )
    const second = runOwned(
      Effect.acquireUseRelease(
        Effect.void,
        () => hangWithLiveHandle,
        () =>
          Effect.promise(async () => {
            await new Promise((resolve) => setTimeout(resolve, 120))
            overlapEvents.push("run-2-joined")
            throw new Error("overlapping run 2 finalizer defect")
          }),
      ),
    )
    await Promise.all([first, second])
  },
  500,
)

test("follow-up test after overlapping runOwned defects sees zero leaked keys", () => {
  expect(overlapEvents.slice().sort()).toEqual(["run-1-joined", "run-2-joined"])
  expect(inflightOwnedRunCount()).toBe(0)
})
