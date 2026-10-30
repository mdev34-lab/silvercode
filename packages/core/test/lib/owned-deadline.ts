import { afterEach, onTestFinished, type TestOptions } from "bun:test"
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

// When a test declares its own host timeout, start cooperative Effect cancellation a little
// before Bun gives up; if cleanup still outlasts the host timeout (or when no explicit timeout
// is declared and Bun's host timeout fires), `runOwned` joins the abandoned fiber before the
// next test starts.
export function ownedFor(opts?: number | TestOptions): OwnedDeadline | undefined {
  const hostTimeoutMs = typeof opts === "number" ? opts : opts?.timeout
  if (hostTimeoutMs === undefined || !Number.isFinite(hostTimeoutMs) || hostTimeoutMs <= 0) return undefined
  const cleanupHeadroomMs = Math.max(1, Math.min(500, Math.floor(hostTimeoutMs / 10)))
  const deadlineMs = hostTimeoutMs - cleanupHeadroomMs
  if (deadlineMs <= 0) return undefined
  return { deadlineMs, hostTimeoutMs, cleanupHeadroomMs }
}

type DefectBox = {
  readonly value: unknown
}

type OwnedRun = {
  readonly key: symbol
  readonly controller: AbortController
  timer: ReturnType<typeof setTimeout> | undefined
  exit: Promise<Exit.Exit<unknown, unknown>>
  settled: boolean
  abandoned: boolean
  released: boolean
  hasDefect: boolean
  defect: unknown
}

type OwnedTestScope = {
  readonly runs: OwnedRun[]
  readonly defects: DefectBox[]
  closed: boolean
  reported: boolean
  releasePromise: Promise<void> | undefined
}

// Keyed per-run ownership table of currently in-flight fibers: each `runOwned` invocation owns
// only its own symbol key and removes it unconditionally when `exit` settles.
const runs = new Map<symbol, OwnedRun>()

let activeScope: OwnedTestScope | undefined

export function inflightOwnedRunCount(): number {
  return runs.size
}

function createScope(): OwnedTestScope {
  return {
    runs: [],
    defects: [],
    closed: false,
    reported: false,
    releasePromise: undefined,
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function toAbandonedDefect(cause: Cause.Cause<unknown>): DefectBox {
  const errors = Cause.prettyErrors(cause)
  if (errors.length <= 1) return { value: Cause.squash(cause) }
  return {
    value: new AggregateError(
      errors,
      `${errors.length} finalizer failures after the run was abandoned: ${errors.map((error) => error.message).join("; ")}`,
    ),
  }
}

function combineDefects(defects: readonly DefectBox[]): DefectBox {
  if (defects.length === 1) return defects[0]
  const errors = defects.map((box) => toError(box.value))
  return {
    value: new AggregateError(
      errors,
      `${errors.length} abandoned run failures: ${errors.map((error) => error.message).join("; ")}`,
    ),
  }
}

function formatAbandonedDefect(value: unknown): string {
  if (value instanceof AggregateError) {
    const details = value.errors.map((err) => (err instanceof Error ? (err.stack ?? err.message) : String(err)))
    return [value.stack ?? `${value.name}: ${value.message}`, ...details].join("\n")
  }
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  return String(value)
}

function reportAbandonedCause(cause: Cause.Cause<unknown>): DefectBox | undefined {
  if (Cause.hasInterruptsOnly(cause)) return undefined
  const boxed = toAbandonedDefect(cause)
  // Surface on stderr immediately as well: in Bun 1.3.14, if a subsequent suite/file
  // `afterEach` throws or hits hook timeout (skipping `onTestFinished`), or if this hook
  // itself was cut off by hook timeout before the finalizer threw, the defect stays visible.
  console.error(`[owned-deadline] abandoned finalizer defect: ${formatAbandonedDefect(boxed.value)}`)
  return boxed
}

function clearRunTimer(entry: OwnedRun): void {
  if (entry.timer === undefined) return
  clearTimeout(entry.timer)
  entry.timer = undefined
}

async function settleAbandonedRun(entry: OwnedRun, scope: OwnedTestScope): Promise<void> {
  if (entry.released) return
  entry.released = true
  clearRunTimer(entry)
  if (entry.settled && !entry.abandoned) {
    runs.delete(entry.key)
    return
  }
  entry.abandoned = true
  entry.controller.abort()
  const exit = await entry.exit
  runs.delete(entry.key)
  if (Exit.isFailure(exit)) {
    const boxed = reportAbandonedCause(exit.cause)
    if (boxed) {
      entry.hasDefect = true
      entry.defect = boxed.value
      scope.defects.push(boxed)
    }
  }
}

function performReleaseScope(scope: OwnedTestScope): Promise<void> {
  scope.closed = true
  if (activeScope === scope) activeScope = undefined
  const pending = scope.runs.filter((entry) => !entry.released)
  if (pending.length === 0) return Promise.resolve()
  for (const entry of pending) {
    clearRunTimer(entry)
    if (!entry.settled) {
      entry.abandoned = true
      entry.controller.abort()
    }
  }
  return Promise.all(pending.map((entry) => settleAbandonedRun(entry, scope))).then(() => undefined)
}

function releaseScope(scope: OwnedTestScope): Promise<void> {
  scope.releasePromise ??= performReleaseScope(scope)
  return scope.releasePromise
}

async function reportScope(scope: OwnedTestScope): Promise<void> {
  await releaseScope(scope)
  if (scope.reported) return
  scope.reported = true
  if (scope.defects.length > 0) {
    throw combineDefects(scope.defects).value
  }
}

/**
 * Used by top-level test wrappers (`testEffect` / `testEffectShared`) to flush an unclosed scope
 * if the previous test registered an async dynamic `afterEach` that threw and aborted hooks.
 */
export function takeActiveOwnedScope(): Promise<void> | undefined {
  if (!activeScope || activeScope.closed) return undefined
  return releaseScope(activeScope)
}

export function beginOwned<A>(start: () => Promise<A>): Promise<A> {
  const stale = takeActiveOwnedScope()
  return stale ? stale.then(start) : start()
}

/**
 * Standalone cancellable handle for a scoped Effect execution outside Bun's hook lifecycle.
 * Logs failure causes unconditionally, keeps `result` unsettled on abandonment so host timeouts
 * are not masked by interrupt rejections, and surfaces non-interrupt finalizer defects from
 * `cancel()` via `AggregateError` + immediate stderr logging.
 */
export function runScopedEffect<A, E>(scoped: Effect.Effect<A, E>): {
  readonly result: Promise<A>
  readonly cancel: () => Promise<void>
} {
  const controller = new AbortController()
  let settled = false
  let abandoned = false
  let cancelPromise: Promise<void> | undefined
  const exitPromise = Effect.runPromiseExit(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(scoped)
      if (Exit.isFailure(exit)) {
        for (const err of Cause.prettyErrors(exit.cause)) {
          yield* Effect.logError(err)
        }
      }
      return yield* exit
    }),
    { signal: controller.signal },
  )
  const result = exitPromise.then((exit) => {
    settled = true
    if (!Exit.isFailure(exit)) return exit.value
    if (abandoned) return new Promise<A>(() => {})
    throw Cause.squash(exit.cause)
  })
  const cancel = (): Promise<void> => {
    if (settled && !abandoned) return Promise.resolve()
    cancelPromise ??= (async () => {
      abandoned = true
      controller.abort()
      const exit = await exitPromise
      if (Exit.isFailure(exit)) {
        const boxed = reportAbandonedCause(exit.cause)
        if (boxed) throw boxed.value
      }
    })()
    return cancelPromise
  }
  return { result, cancel }
}

/**
 * Runs an Effect inside a serial Bun test with keyed per-run ownership across both explicit
 * deadlines and host/per-test Bun timeouts.
 *
 * - Registers `onTestFinished` synchronously at test start before mutating ownership state or
 *   launching the fiber (rejecting `test.concurrent` callers fast).
 * - Registers `afterEach` after synchronous fiber launch (and re-tops it on microtask while
 *   unsettled) so `releaseScope` runs before dynamic `afterEach` hooks registered in the test body.
 * - Unconditionally deletes each run's symbol key from `runs` as soon as `exitPromise` settles.
 * - Preserves `Cause.squash(exit.cause)` rethrow when `!entry.abandoned`, tracks abandoned
 *   defects via an explicit `hasDefect` / boxed channel (`undefined`-safe), and combines defects
 *   across overlapping runs in `onTestFinished`.
 */
export function runOwned<A, E>(execution: Effect.Effect<A, E>, deadline?: OwnedDeadline): Promise<A> {
  if (deadline) validateOwnedDeadline(deadline)
  const scope = activeScope && !activeScope.closed ? activeScope : createScope()
  onTestFinished(() => reportScope(scope))
  activeScope = scope

  const key = Symbol("testEffectRun")
  const controller = new AbortController()
  const entry: OwnedRun = {
    key,
    controller,
    timer: undefined,
    exit: Promise.resolve(Exit.void),
    settled: false,
    abandoned: false,
    released: false,
    hasDefect: false,
    defect: undefined,
  }
  runs.set(key, entry)
  scope.runs.push(entry)

  let exitPromise: Promise<Exit.Exit<A, E>>
  try {
    exitPromise = Effect.runPromiseExit(execution, { signal: controller.signal })
  } catch (error) {
    entry.settled = true
    entry.released = true
    runs.delete(key)
    throw error
  }
  entry.exit = exitPromise
  afterEach(() => releaseScope(scope))

  entry.timer = deadline ? setTimeout(() => controller.abort(), deadline.deadlineMs) : undefined

  const result = exitPromise.then((exit) => {
    clearRunTimer(entry)
    entry.settled = true
    runs.delete(key)
    if (!Exit.isFailure(exit)) return exit.value
    if (entry.abandoned) return new Promise<A>(() => {})
    throw Cause.squash(exit.cause)
  })

  queueMicrotask(() => {
    if (!scope.closed && !entry.settled) {
      afterEach(() => releaseScope(scope))
    }
  })

  return result
}
