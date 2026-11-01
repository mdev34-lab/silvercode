// Opt-in trace for delayed registry-fetch aborts (#560).
//
// In the #560 run the abort surfaced under test/npm-config.test.ts, which only
// reads env, argv and .npmrc files and cannot fetch. The stack ends in a
// promise-retry callback inside make-fetch-happen that issued a fetch with a
// signal that was already aborted. The log does not show who created that
// request or who aborted its signal, and no npm install test file appears
// before npm-config in that log, so the cause is NOT established. This trace
// prints the two missing facts: the creation site of each AbortController and
// the site that aborted it.
//
// Off unless OPENCODE_TRACE_TEST_ABORTS is set, so a normal run patches nothing
// and prints nothing: `OPENCODE_TRACE_TEST_ABORTS=1 bun test <file>`.
//
// Known gaps, so a quiet log is not over-read:
// - Bun stacks carry no async frames. A signal created after an await names the
//   install helper that created it, not the test that started that install, and
//   an abort() fired from a promise continuation reports `aborted at unknown`.
// - Only `new AbortController()` instances are traced; signals from
//   AbortSignal.timeout()/any() are native and stay untraced.
// - While tracing, the patched abort() adds its own frame to stacks of code that
//   runs inside abort listeners. Run with the flag only to diagnose.
// - It patches AbortController.prototype.abort for the process while on. The
//   original runs on every call, even if logging fails; restoreAborts() undoes it.

const flag = "OPENCODE_TRACE_TEST_ABORTS"
const state = Symbol.for("opencode.test.abort-trace")

interface Owner {
  id: number
  started: number
  site: string
}

interface Installed {
  restore: () => void
}

export function traceAborts() {
  if (!process.env[flag]) return
  const global = globalThis as unknown as Record<symbol, Installed | undefined>
  // Idempotent: a second call must not wrap the wrappers.
  if (global[state]) return
  const NativeAbortController = globalThis.AbortController
  const nativeAbort = NativeAbortController.prototype.abort
  const owners = new WeakMap<object, Owner>()
  let created = 0

  // Reflect.construct forwards new.target, so subclasses keep their own
  // prototype and instanceof chain; only the creation site is recorded.
  const Traced = new Proxy(NativeAbortController, {
    construct(target, args, newTarget) {
      const controller = Reflect.construct(target, args, newTarget) as AbortController
      try {
        owners.set(controller, { id: ++created, started: performance.now(), site: site() })
      } catch {
        // Tracing must never change how a controller is constructed.
      }
      return controller
    },
  })

  // The original abort always runs: a failure while logging is swallowed, and the
  // wrapper keeps the native name and length. Prototype-level, so the controller
  // has no extra own property and subclass overrides still reach it via super.
  const tracedAbort = function abort(this: AbortController, ...args: unknown[]) {
    try {
      const owner = owners.get(this)
      if (owner && !this.signal.aborted) {
        const elapsed = Math.round(performance.now() - owner.started)
        console.error(
          `[abort-trace] abort #${owner.id} ${elapsed}ms after creation at ${owner.site}; aborted at ${site()}`,
        )
      }
    } catch {
      // Logging is best effort.
    }
    return Reflect.apply(nativeAbort, this, args)
  }
  Object.defineProperty(tracedAbort, "length", { value: nativeAbort.length })

  NativeAbortController.prototype.abort = tracedAbort as typeof nativeAbort
  globalThis.AbortController = Traced
  global[state] = {
    restore() {
      NativeAbortController.prototype.abort = nativeAbort
      globalThis.AbortController = NativeAbortController
      global[state] = undefined
    },
  }
}

export function restoreAborts() {
  const global = globalThis as unknown as Record<symbol, Installed | undefined>
  global[state]?.restore()
}

// Nearest source frame outside this file: the module that created the signal, or
// the one that aborted it. Bun stack traces carry no async frames, so a signal
// created after an await names the install code, not the test that started it.
// Frames without a location (Bun prints `at unknown` for the proxy trap) are
// skipped rather than reported as the site.
function site() {
  const frames = (new Error().stack ?? "").split("\n").slice(1)
  const frame = frames.find((line) => /\d+:\d+\)?$/.test(line) && !line.includes("abort-trace.ts"))
  return frame?.trim().replace(/^at /, "") ?? "unknown"
}
