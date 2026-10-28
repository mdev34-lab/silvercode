// Opt-in trace for delayed registry-fetch aborts (#560).
//
// The core suite runs every test file in one Bun process, in the order Bun
// discovers them (directory traversal, not sorted - measured on the pinned
// 1.3.14), and Bun reports an unhandled rejection against whichever test is
// running when it lands (with the origin's code frame printed above it).
// Registry work aborted by an install fiber that was interrupted after its
// owning test finished therefore surfaces as `AbortError` / `FETCH_ABORTED`
// under an unrelated test - the npm-config registry assertion in #560, which
// cannot fetch at all (@npmcli/config only reads env, argv and .npmrc files).
// What the log never shows is which code aborted the signal, so this trace
// prints that: the creation stack (which install owned the fetch) and the
// abort() stack (who cancelled it).
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
// - While tracing, the traced abort() adds its own frame to stacks of code that
//   runs inside abort listeners. Run with the flag only to diagnose.

const flag = "OPENCODE_TRACE_TEST_ABORTS"

interface Owner {
  id: number
  started: number
  site: string
}

export function traceAborts() {
  if (!process.env[flag]) return
  const NativeAbortController = globalThis.AbortController
  let created = 0

  // A Proxy keeps the native constructor, prototype and instanceof chain intact:
  // only the instances gain a traced abort(), so opt-in cannot change how
  // registry code observes cancellation.
  globalThis.AbortController = new Proxy(NativeAbortController, {
    construct(target, args) {
      const controller = Reflect.construct(target, args) as AbortController
      const owner: Owner = { id: ++created, started: performance.now(), site: site() }
      const abort = controller.abort.bind(controller)
      Object.defineProperty(controller, "abort", {
        configurable: true,
        value: (reason?: unknown) => {
          if (!controller.signal.aborted) {
            const elapsed = Math.round(performance.now() - owner.started)
            console.error(
              `[abort-trace] abort #${owner.id} ${elapsed}ms after creation at ${owner.site}; aborted at ${site()}`,
            )
          }
          abort(reason)
        },
      })
      return controller
    },
  })
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
