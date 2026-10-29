// Explicit Bun timeout probe (#671): `it.live(..., 800)` derives `deadlineMs = 720` (`80ms`
// headroom), while the scoped release takes `250ms` (`~970ms` total). Bun abandons the test
// promise at `800ms`; `runOwned` must join the remaining release work before file `afterEach`
// and before the next test starts, with zero unhandled interruption errors.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { inflightOwnedRunCount } from "../owned-deadline"
import { testEffect } from "../effect"

class Resource extends Context.Service<Resource, {}>()("AbandonedExplicitResource") {}

const envKey = "SILVERCODE_TEST_ABANDONED_EXPLICIT_ENV"
const outerKey = "SILVERCODE_TEST_ABANDONED_EXPLICIT_OUTER"
const previousEnv = process.env[envKey]
const events: string[] = []
const outerAtStart: (string | undefined)[] = []
let capturedOuter: string | undefined

const restoreEnv = () => {
  if (previousEnv === undefined) delete process.env[envKey]
  else process.env[envKey] = previousEnv
}

beforeEach(() => {
  outerAtStart.push(process.env[outerKey])
  process.env[outerKey] = "from-beforeEach"
})

afterEach(() => {
  delete process.env[outerKey]
})

const layer = Layer.effect(
  Resource,
  Effect.acquireRelease(
    Effect.sync(() => {
      capturedOuter = process.env[outerKey]
      process.env[outerKey] = "from-layer"
      process.env[envKey] = "active"
      events.push("acquired")
      return {}
    }),
    () =>
      Effect.promise(async () => {
        events.push("release-start")
        await new Promise((resolve) => setTimeout(resolve, 250))
        if (capturedOuter === undefined) delete process.env[outerKey]
        else process.env[outerKey] = capturedOuter
        restoreEnv()
        events.push("release-end")
      }),
  ),
)

const it = testEffect(layer)

it.live(
  "explicit timeout abandons hung Effect.never with 250ms release",
  () =>
    Effect.gen(function* () {
      yield* Resource
      yield* Effect.never
    }),
  800,
)

test("next Bun test sees 250ms release joined and outer afterEach uncontaminated", () => {
  expect(process.env[envKey]).toBe(previousEnv)
  expect(events).toEqual(["acquired", "release-start", "release-end"])
  expect(outerAtStart).toEqual([undefined, undefined])
  expect(inflightOwnedRunCount()).toBe(0)
})

it.live(
  "settled failure still rethrows via Cause.squash",
  () => Effect.fail(new Error("expected settled failure")),
  800,
)
