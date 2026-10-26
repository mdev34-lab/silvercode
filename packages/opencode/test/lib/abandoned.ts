// Effects started by testEffect that Bun may abandon on a host-level timeout (Bun does not
// expose the configured default, and a file can change it with setDefaultTimeout). The
// global afterEach in test/preload.ts interrupts and joins whatever is still running, so
// scoped finalizers finish before the next test starts (#609). Kept free of src imports so
// the preload can load it for every test file.
const inflight = new Set<{ controller: AbortController; settled: Promise<unknown> }>()

export function track(controller: AbortController, promise: Promise<unknown>) {
  const entry = { controller, settled: promise.then(() => undefined, () => undefined) }
  inflight.add(entry)
  void entry.settled.then(() => inflight.delete(entry))
}

/** Interrupt every tracked testEffect run still alive and wait for its finalizers. */
export async function settleAbandonedEffects() {
  const pending = [...inflight]
  for (const entry of pending) entry.controller.abort()
  await Promise.all(pending.map((entry) => entry.settled))
}
