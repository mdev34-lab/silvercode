import { describe, expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import { runScopedEffect } from "./effect"

describe("runScopedEffect", () => {
  test("cancelling an unsettled scoped effect interrupts it and settles finalizers before returning", async () => {
    const started = Deferred.makeUnsafe<void>()
    let finalized = false

    const handle = runScopedEffect(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              await Bun.sleep(15)
              finalized = true
            }),
          )
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }),
      ),
    )

    await Effect.runPromise(Deferred.await(started))
    expect(finalized).toBe(false)

    await handle.cancel()
    expect(finalized).toBe(true)
  })
})
