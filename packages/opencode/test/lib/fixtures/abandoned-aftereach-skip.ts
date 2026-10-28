// Issue 1A probe: when a suite or file `afterEach` throws OR hits Bun's hook timeout, Bun 1.3.14
// skips `onTestFinished`. Verifies the abandoned finalizer defect is still surfaced (not hidden)
// and no key leaks in `runs`.
import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { inflightOwnedRunCount } from "../owned-deadline"
import { testEffect } from "../effect"

class SkipProbe extends Context.Service<SkipProbe, {}>()("AbandonedAfterEachSkipProbe") {}

const envKey = "SILVERCODE_TEST_ABANDONED_AE_SKIP_ENV"
const previousEnv = process.env[envKey]

const restoreEnv = () => {
  if (previousEnv === undefined) delete process.env[envKey]
  else process.env[envKey] = previousEnv
}

const makeDefectLayer = (message: string) =>
  Layer.effect(
    SkipProbe,
    Effect.acquireRelease(
      Effect.sync(() => {
        process.env[envKey] = "active"
        return {}
      }),
      () =>
        Effect.promise(async () => {
          await new Promise((resolve) => setTimeout(resolve, 150))
          restoreEnv()
          throw new Error(message)
        }),
    ),
  )

const itThrow = testEffect(makeDefectLayer("defect survived throwing afterEach"))
const itTimeout = testEffect(makeDefectLayer("defect survived timed-out afterEach"))

describe("suite whose afterEach throws on the timed-out test", () => {
  let throwInSuiteAfterEach = true
  afterEach(() => {
    if (throwInSuiteAfterEach) {
      throwInSuiteAfterEach = false
      throw new Error("suite afterEach boom")
    }
  })

  itThrow.live(
    "abandoned run whose suite afterEach throws skipping onTestFinished",
    () =>
      Effect.gen(function* () {
        yield* SkipProbe
        yield* Effect.never
      }),
    500,
  )

  test("next test after throwing afterEach observes restored env and zero leaked keys", () => {
    expect(process.env[envKey]).toBe(previousEnv)
    expect(inflightOwnedRunCount()).toBe(0)
  })
})

describe("suite whose afterEach hits Bun hook timeout on the timed-out test", () => {
  let hangSuiteAfterEach = true
  afterEach(async () => {
    if (hangSuiteAfterEach) {
      hangSuiteAfterEach = false
      await new Promise((resolve) => setTimeout(resolve, 950))
    }
  })

  itTimeout.live(
    "abandoned run whose suite afterEach hits hook timeout skipping onTestFinished",
    () =>
      Effect.gen(function* () {
        yield* SkipProbe
        yield* Effect.never
      }),
    500,
  )

  test("next test after timed-out afterEach observes restored env and zero leaked keys", () => {
    expect(process.env[envKey]).toBe(previousEnv)
    expect(inflightOwnedRunCount()).toBe(0)
  })
})
