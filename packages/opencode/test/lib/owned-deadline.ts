import { Cause, Effect, Exit } from "effect"

export type OwnedDeadline = {
  deadlineMs: number
  hostTimeoutMs: number
  cleanupHeadroomMs: number
}

/** Cancellation starts at the deadline. Finalizers are joined, not time-bounded. */
export function validateOwnedDeadline(options: OwnedDeadline) {
  const { deadlineMs, hostTimeoutMs, cleanupHeadroomMs } = options
  if (![deadlineMs, hostTimeoutMs, cleanupHeadroomMs].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error("Owned deadline, host timeout and cleanup headroom must be positive finite milliseconds")
  }
  if (deadlineMs + cleanupHeadroomMs > hostTimeoutMs) {
    throw new Error("Owned deadline must leave the explicit cleanup headroom before the host timeout")
  }
}

export async function runWithOwnedDeadline<A, E>(effect: Effect.Effect<A, E, never>, options: OwnedDeadline) {
  validateOwnedDeadline(options)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.deadlineMs)
  try {
    return await Effect.runPromiseExit(effect, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Opt-in Bun callback wrapper. Callers must pass the same hostTimeoutMs to Bun. */
export function ownedDeadlineTest<A, E>(effect: () => Effect.Effect<A, E, never>, options: OwnedDeadline) {
  validateOwnedDeadline(options)
  const budget = Object.freeze({ ...options })
  return async () => {
    const exit = await runWithOwnedDeadline(Effect.suspend(effect), budget)
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    return exit.value
  }
}
