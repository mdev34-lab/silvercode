// Bounded best-effort cleanup for the HttpApi exerciser.
//
// Effect finalizers run uninterruptibly, so an Effect timeout cannot bound them.
// boundedCleanup races a cleanup promise against a plain timer instead. This is
// partial containment: it bounds each cleanup step it wraps, not the whole run,
// and a promise that times out keeps running in the background. Its later
// completion is logged and counted as "abandoned" until it settles.
//
// Cleanup errors and timeouts are logged and swallowed. They must not hang the
// run or replace the scenario's own result.

import { setTimeout as sleep } from "node:timers/promises"

export const CLEANUP_BOUND_MS = 60_000

export type CleanupOutcome = "done" | "failed" | "timed-out"

export type CleanupTimer = {
  promise: Promise<void>
  cancel: () => void
}

export type CleanupOptions = {
  boundMs?: number
  timer?: (ms: number) => CleanupTimer
  log?: (...args: unknown[]) => void
}

const abandoned = { count: 0 }

const realTimer = (ms: number): CleanupTimer => {
  const cancel = new AbortController()
  return {
    promise: sleep(ms, undefined, { signal: cancel.signal }).then(
      () => undefined,
      () => undefined,
    ),
    cancel: () => cancel.abort(),
  }
}

/** Number of timed-out cleanups that have not settled yet (diagnostics only). */
export function abandonedCleanups() {
  return abandoned.count
}

export function boundedCleanup(
  label: string,
  promise: Promise<unknown>,
  options: CleanupOptions = {},
): Promise<CleanupOutcome> {
  const bound = options.boundMs ?? CLEANUP_BOUND_MS
  const log = options.log ?? ((...args: unknown[]) => console.error(...args))
  const timer = (options.timer ?? realTimer)(bound)

  const settled = promise.then(
    (): CleanupOutcome => "done",
    (error: unknown): CleanupOutcome => {
      log(`[reset] ${label} failed; continuing`, error)
      return "failed"
    },
  )
  const expired = timer.promise.then((): CleanupOutcome => "timed-out")

  return Promise.race([settled, expired]).then((outcome) => {
    // Abort the timer as soon as the race settles so a fast success leaves nothing pending.
    timer.cancel()
    if (outcome !== "timed-out") return outcome

    abandoned.count += 1
    log(
      `[reset] ${label} did not finish within ${bound / 1000}s; continuing (${abandoned.count} abandoned cleanup(s) pending)`,
    )
    void settled.then((outcome) => {
      abandoned.count -= 1
      log(`[reset] ${label} settled after timeout (${outcome})`)
    })
    return "timed-out"
  })
}
