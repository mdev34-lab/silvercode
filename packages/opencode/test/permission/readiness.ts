import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Deferred, Effect, Exit, Queue } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { InstanceRef } from "../../src/effect/instance-ref"
import { Permission } from "../../src/permission"

// The readiness guard is one second, unchanged from the polling waits this replaces. No
// budget is widened here; `readiness` is the same number the old waits used.
const readiness = "1 second"

interface AskEntry {
  readonly directory: string | undefined
  exit: Exit.Exit<unknown, unknown> | undefined
}

/**
 * An explicit ownership handle for a set of asks. A wait that passes a cohort owns every ask
 * registered into it (including ones pre-started before the wait), and fail-fasts when all of
 * the cohort's asks settle without producing the expected pending count. This is what
 * distinguishes an ask the wait is intended to consume (registered into its cohort) from an
 * unrelated prior ask in the same service+directory (in a different cohort, or none): the
 * prior ask cannot fail this wait. A cohort with no wait owning it is released explicitly
 * via `releaseCohort`; a cohort with one or more owning waits is released when the LAST owner
 * completes (ref-counted), so a concurrent W1/W2 both owning a cohort cannot hide the shared
 * ask's outcome from each other.
 */
export interface Cohort {
  readonly asks: AskEntry[]
  // Number of active waitForPending waits owning this cohort. Decremented on each wait's
  // completion; the cohort's settled entries are released only when this reaches zero.
  refCount: number
  readonly wakeWaiters: Set<(value: void) => void>
}

export const makeCohort = () => Effect.sync(() => ({ asks: [], refCount: 0, wakeWaiters: new Set() }) as Cohort)

// Explicit release: splices every entry. For a cohort whose owner is done with it but that no
// wait owns (abandoned prior cohort). A wait-owned cohort is released at last-owner
// completion instead.
export const releaseCohort = (cohort: Cohort) =>
  Effect.sync(() => {
    cohort.asks.length = 0
  })

// Test-only: the number of entries currently retained in this cohort. Used to verify that an
// abandoned prior cohort is released within the service (not retained until GC).
export const cohortSize = (cohort: Cohort) => Effect.sync(() => cohort.asks.length)

const directoryOf = () => Effect.map(InstanceRef, (ctx) => ctx?.directory)

const describeExit = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "it completed without registering a request"
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
}

/**
 * Records an `ask` execution so a readiness wait scoped to its cohort can distinguish a slow
 * publication from one that can no longer arrive. Purely observational: it never changes the
 * ask's exit and never swallows its cause. When the ask settles it wakes every active wait
 * owning the cohort (a settlement that did not publish `Asked` — an allow rule, a deny, the
 * countdown — would otherwise leave a parked `Queue.take` to burn the one-second guard). With
 * no cohort, the ask is not owned by any wait's fail-fast (it still registers pending via
 * `permission.ask`, which the success check reads through `permission.list()`).
 */
export const trackAsk = <A, E, R>(self: Effect.Effect<A, E, R>, cohort?: Cohort) =>
  Effect.gen(function* () {
    if (cohort === undefined) {
      return yield* self
    }
    const directory = yield* directoryOf()
    const entry: AskEntry = { directory, exit: undefined }
    cohort.asks.push(entry)
    return yield* self.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          entry.exit = exit
          for (const wake of Array.from(cohort.wakeWaiters)) {
            try {
              wake(undefined)
            } catch {
              // The wait's queue may already be closed when its scope finalized first.
            }
          }
        }),
      ),
    )
  })

// The same failure the polling waits produced, so every existing assertion on the guard
// still reads the same string.
const timedOut = (count: number) =>
  new Error(`timed out waiting for ${count} pending permission request(s)`)

// A request that settled without ever being observable can never become observable. This is
// not a duration — there is nothing left to wait for — so it fails immediately and carries
// the ask's own outcome. `tracked` is the wait's already-filtered cohort, so the causes
// listed are only the asks that wait owns (a prior cohort's outcome never appears here).
const settledWithout = (tracked: ReadonlyArray<AskEntry>, count: number, seen: number) => {
  const causes = tracked.map((entry) => (entry.exit === undefined ? "" : describeExit(entry.exit)))
  return new Error(
    `timed out waiting for ${count} pending permission request(s): saw ${seen}, ` +
      `every ask in this directory already settled (${causes.join("; ")})`,
  )
}

export interface WaitForPendingOptions {
  // When set, the wait completes this deferred the first time it parks on `Queue.take`
  // (its first inspect found nothing to fail or succeed on). Completed AFTER inspect and
  // BEFORE `Queue.take` suspends the fiber, so the caller's `Deferred.await(parked)` resumes
  // only once the wait is parked — a settle that follows is a settle-after-park,
  // deterministically, with no fixed sleep and no polling.
  readonly parked?: Deferred.Deferred<void, never>
}

/**
 * Waits for exactly `count` pending requests in the current instance, guarded by the
 * unchanged one-second readiness deadline.
 *
 * With a `cohort`: the wait owns every ask registered into that cohort (including ones
 * pre-started before the wait). It fail-fasts when all of the cohort's asks (in this
 * directory) settle without producing the expected pending count, reporting the ask's own
 * outcome. This preserves the original ask-then-wait contract (fork an ask, await it, then
 * wait and fail-fast with its outcome) AND excludes unrelated prior asks in other cohorts.
 * The cohort's settled entries are released when the LAST owning wait completes (refCount),
 * so concurrent W1/W2 both owning the cohort cannot hide the shared ask from each other.
 *
 * Without a cohort: no fail-fast (the existing assert-pending/timeout callers). The
 * pending-count success check reads `permission.list()` and is unaffected.
 */
export const waitForPending = (
  count: number,
  cohort?: Cohort,
  options?: WaitForPendingOptions,
) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const directory = yield* directoryOf()
    const signals = yield* Queue.unbounded<void>()
    const unsubscribe = yield* events.listen((event) => {
      if (event.type === Permission.Event.Asked.type || event.type === Permission.Event.Replied.type)
        Queue.offerUnsafe(signals, undefined)
      return Effect.void
    })
    const wake = () => {
      Queue.offerUnsafe(signals, undefined)
    }
    if (cohort !== undefined) {
      cohort.refCount = cohort.refCount + 1
      cohort.wakeWaiters.add(wake)
    }

    const inspect = Effect.gen(function* () {
      const pending = yield* permission.list()
      if (pending.length === count) return pending
      if (cohort !== undefined) {
        const tracked = cohort.asks.filter((entry) => entry.directory === directory)
        if (tracked.length > 0 && tracked.every((entry) => entry.exit !== undefined))
          return yield* Effect.fail(settledWithout(tracked, count, pending.length))
      }
      return undefined
    })

    const loop = Effect.gen(function* () {
      let firstPark = true
      while (true) {
        const pending = yield* inspect
        if (pending) return pending
        if (firstPark) {
          firstPark = false
          if (options?.parked !== undefined) {
            // Ordering: AFTER the first inspect returned nothing and BEFORE `Queue.take`
            // suspends this fiber. `Deferred.succeed` completes synchronously and schedules
            // the awaiter; `Queue.take` on an empty queue then suspends this fiber, so the
            // scheduler runs the awaiter only once this wait is parked.
            yield* Deferred.succeed(options.parked, undefined)
          }
        }
        yield* Queue.take(signals)
      }
    })

    return yield* loop.pipe(
      Effect.timeoutOrElse({
        duration: readiness,
        orElse: () => Effect.fail(timedOut(count)),
      }),
      // Cleanup runs when the wait terminates (success, fail-fast, guard, interruption) —
      // not only when the service is GC'd. Removes the wake callback and unsubscribes the
      // listener. For a wait-owned cohort: decrements refCount and, ONLY when this was the
      // last owner (refCount <= 0), releases the cohort's settled entries — so a concurrent
      // owner still needing the outcome keeps it.
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            if (cohort !== undefined) {
              cohort.wakeWaiters.delete(wake)
              cohort.refCount = cohort.refCount - 1
              if (cohort.refCount <= 0) {
                for (let i = cohort.asks.length - 1; i >= 0; i--) {
                  if (cohort.asks[i].exit !== undefined) cohort.asks.splice(i, 1)
                }
              }
            }
          })
          yield* unsubscribe
        }),
      ),
    )
  })

/**
 * Waits until `count` outcomes have been collected by an `EventV2Bridge.listen` listener.
 * `permission.replied` is published inline, so a listener registered before the publish has
 * already recorded the outcome by the time the publishing turn yields, and the wait is
 * woken from that same turn.
 */
export const waitForReplies = (replies: ReadonlyArray<unknown>, count: number) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const signals = yield* Queue.unbounded<void>()
    const unsubscribe = yield* events.listen((event) => {
      if (event.type === Permission.Event.Replied.type) Queue.offerUnsafe(signals, undefined)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    const loop = Effect.gen(function* () {
      while (replies.length < count) yield* Queue.take(signals)
    })

    return yield* loop.pipe(
      Effect.timeoutOrElse({
        duration: readiness,
        orElse: () => Effect.fail(new Error(`timed out waiting for ${count} permission replied event(s)`)),
      }),
    )
  })

/**
 * Waits for a listening fiber to have entered a publication on the current turn. Replaces a
 * fixed sleep chosen by the test, under the same one-second guard: if the listener never
 * runs, this fails with the readiness message instead of interrupting at an arbitrary
 * instant. The deferred's value type is preserved, so a listener that records a numeric
 * `expiresAt` returns that number to the caller instead of `void`.
 */
export const awaitListener = <A>(entered: Deferred.Deferred<A, never>, waiting: string) =>
  Deferred.await(entered).pipe(
    Effect.timeoutOrElse({
      duration: readiness,
      orElse: () => Effect.fail(new Error(`${waiting}: the listener never entered the publish`)),
    }),
  )

export const permissionReadiness = {
  trackAsk,
  waitForPending,
  waitForReplies,
  awaitListener,
  makeCohort,
  releaseCohort,
  cohortSize,
                                                }
