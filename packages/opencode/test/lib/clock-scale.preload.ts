// Test-only accelerated clock for CLI subprocesses spawned by the harness
// (cli-process.ts). Injected with `bun run --preload` when a test opts in via
// SpawnOpts.clockScale — production code never reads this file or the env var.
//
// WHY (#555 / test-cost): a long provider retry wait must outlive run.ts's
// 10s notice threshold, so end-to-end retry tests used to sleep 11-12s of
// wall time per wait (~59s across run-retry-wait.test.ts alone). Setting
// OPENCODE_TEST_CLOCK_SCALE=N makes this process observe time running N times
// faster: Date.now and setTimeout/setInterval are scaled together against one
// anchor, so every deadline stays internally consistent — a delay of D
// milliseconds elapses after D/N real milliseconds while the clock still
// reports D milliseconds passed. Notices, thresholds and retry ordering are
// therefore exercised at the same values as production, only in less wall
// time. Tests that need genuine wall-clock behavior (e.g. one real long-retry
// end-to-end case in run-retry-wait.test.ts) simply omit clockScale.
//
// No-op unless OPENCODE_TEST_CLOCK_SCALE is present and greater than 1.
const scale = Number(process.env.OPENCODE_TEST_CLOCK_SCALE)

if (Number.isFinite(scale) && scale > 1) {
  const realNow = Date.now
  const realSetTimeout = globalThis.setTimeout
  const realSetInterval = globalThis.setInterval
  // Anchor at this process's start: virtual and real time coincide there, so
  // absolute timestamps (files, messages) don't jump; only the elapsed rate differs.
  const anchor = realNow()

  // Virtual time = anchor + real elapsed × scale.
  Date.now = () => anchor + (realNow() - anchor) * scale

  // A timer scheduled for D ms must fire when virtual time advanced by D,
  // i.e. after D/scale real ms — same invariant for intervals, so periodic
  // polls keep their virtual cadence. Sub-millisecond results are left for
  // the runtime to clamp, matching its usual behavior.
  globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
    typeof ms === "number" && Number.isFinite(ms) && ms > 0
      ? realSetTimeout(handler, ms / scale, ...args)
      : realSetTimeout(handler, ms, ...args)) as typeof setTimeout

  globalThis.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
    typeof ms === "number" && Number.isFinite(ms) && ms > 0
      ? realSetInterval(handler, ms / scale, ...args)
      : realSetInterval(handler, ms, ...args)) as typeof setInterval
}
