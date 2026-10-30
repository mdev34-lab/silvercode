// No elapsed-time assertions or cleanup sleeps: the finalizer cannot finish until
// the parent sees Bun report the hook cutoff and opens the gate over stdin.
import { afterAll, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../effect"
import { inflightOwnedRunCount } from "../owned-deadline"
import { hangWithLiveHandle } from "./abandoned-keepalive"

const envKey = "SILVERCODE_TEST_ABANDONED_ENTRY_ENV"
const previousEnv = process.env[envKey]
const events: string[] = []
const gate = new Response(Bun.stdin.stream()).text()

const restoreEnv = () => {
  if (previousEnv === undefined) delete process.env[envKey]
  else process.env[envKey] = previousEnv
}
afterAll(restoreEnv)

const it = testEffect(Layer.empty)
it.live("host timeout interrupts a scope whose finalizer outlives the cleanup hook", () =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env[envKey] = "active"
        events.push("acquired")
      }),
      () =>
        Effect.promise(async () => {
          events.push("finalizer-start")
          expect(await gate).toBe("release\n")
          restoreEnv()
          events.push("finalizer-end")
        }),
    )
    yield* Effect.never.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          events.push("child-interrupted")
        }),
      ),
      Effect.forkChild,
    )
    yield* hangWithLiveHandle
    yield* Effect.sync(() => {
      events.push("orphan-body-write")
    })
  }),
)

test("next plain test enters only after abandoned scope and child are joined", () => {
  expect(process.env[envKey]).toBe(previousEnv)
  expect(events).toEqual(["acquired", "finalizer-start", "finalizer-end", "child-interrupted"])
  expect(inflightOwnedRunCount()).toBe(0)
  process.env[envKey] = "newer-test"
  events.push("next-test")
})

test("no abandoned work or late finalizer overwrites the newer test state", async () => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(process.env[envKey]).toBe("newer-test")
  expect(events).toEqual(["acquired", "finalizer-start", "finalizer-end", "child-interrupted", "next-test"])
  expect(inflightOwnedRunCount()).toBe(0)
})
