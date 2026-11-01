import { describe, expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import { ownedFor, runOwned, runScopedEffect } from "./effect"
import { inflightOwnedRunCount } from "./owned-deadline"

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

  test("cancelling an unsettled scoped effect surfaces finalizer defects and reports to stderr", async () => {
    const started = Deferred.makeUnsafe<void>()
    const stderrLines: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      stderrLines.push(args.map(String).join(" "))
    }

    try {
      const handle = runScopedEffect(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.die(new Error("finalizer boom")))
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }),
        ),
      )

      await Effect.runPromise(Deferred.await(started))
      const caught = await handle.cancel().catch((err: unknown) => err)
      expect(caught).toBeInstanceOf(Error)
      expect(String(caught)).toContain("finalizer boom")
      expect(stderrLines.some((line) => line.includes("[owned-deadline] abandoned finalizer defect:"))).toBe(true)
      expect(stderrLines.some((line) => line.includes("finalizer boom"))).toBe(true)
    } finally {
      console.error = originalError
    }
  })

  test("cancelling an unsettled scoped effect aggregates multiple finalizer defects", async () => {
    const started = Deferred.makeUnsafe<void>()
    const originalError = console.error
    console.error = () => {}

    try {
      const handle = runScopedEffect(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.die(new Error("defect alpha")))
            yield* Effect.addFinalizer(() => Effect.die(new Error("defect beta")))
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }),
        ),
      )

      await Effect.runPromise(Deferred.await(started))
      const caught = await handle.cancel().catch((err) => err)
      expect(caught).toBeInstanceOf(AggregateError)
      expect(String(caught.message)).toContain("defect alpha")
      expect(String(caught.message)).toContain("defect beta")
    } finally {
      console.error = originalError
    }
  })

  test("shares owned-deadline lifecycle helpers across core tests", async () => {
    expect(ownedFor(undefined)).toBeUndefined()
    expect(ownedFor(1_000)).toEqual({
      deadlineMs: 900,
      hostTimeoutMs: 1_000,
      cleanupHeadroomMs: 100,
    })
    expect(await runOwned(Effect.succeed("shared-ok"))).toBe("shared-ok")
    expect(inflightOwnedRunCount()).toBe(0)
  })
})
