// Synchronous `onTestFinished` registration guard: inside `test.concurrent`, Bun rejects
// `onTestFinished` synchronously at test start, so `runOwned` fails before launching any fiber
// or inserting into the keyed run map.
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { inflightOwnedRunCount, runOwned } from "../owned-deadline"

let fiberLaunched = false

test.concurrent("concurrent caller 1 fails before fiber starts", () =>
  runOwned(
    Effect.sync(() => {
      fiberLaunched = true
    }),
  ),
)

test.concurrent("concurrent caller 2 fails before fiber starts", () =>
  runOwned(
    Effect.sync(() => {
      fiberLaunched = true
    }),
  ),
)

test("serial follow-up sees zero orphan fibers and empty keyed map", () => {
  expect(fiberLaunched).toBe(false)
  expect(inflightOwnedRunCount()).toBe(0)
})
