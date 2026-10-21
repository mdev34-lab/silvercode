/**
 * Owner-liveness watchdog for the detached process worker.
 *
 * The subprocess worker runs in its own process group (see worker-process.ts)
 * so terminal signals aimed at the UI cannot pause or kill in-flight work.
 * That also means the worker no longer dies alongside its owner when the
 * owner exits without running shutdown — SIGKILL, OOM, or a crash leaves the
 * worker running with nobody to serve. Two independent signals catch that:
 *
 * - the IPC channel to the owner closes the moment the owner process dies
 *   (`disconnect`), which is immediate and needs no cooperation from the
 *   owner;
 * - a periodic liveness probe of the owner PID covers runtimes without
 *   disconnect events. The owner passes its PID down at spawn because
 *   `process.ppid` is unreliable in a detached child: Bun may place the
 *   worker under an intermediate reaper, so ppid can read 1 from birth.
 *
 * A graceful suspend or stop of the UI fires neither signal — the owner
 * process stays alive — so in-flight work keeps running exactly as the
 * background-lifetime contract requires. Exported with injectable sources
 * for tests.
 */
export function watchOwnerProcess(input: {
  onOrphan: () => void
  subscribeDisconnect?: (handler: () => void) => () => void
  ownerAlive?: () => boolean
  interval?: number
}) {
  let fired = false
  // Declared before `fire` (not const-initialized after it): a subscriber
  // that invokes the handler synchronously during subscribe must not trip a
  // TDZ ReferenceError. Production subscribers are async, but the contract
  // allows injectable doubles that replay an already-disconnected state.
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const fire = () => {
    if (fired) return
    fired = true
    unsubscribe?.()
    if (timer !== undefined) clearInterval(timer)
    input.onOrphan()
  }
  unsubscribe = input.subscribeDisconnect?.(fire)
  const ownerAlive = input.ownerAlive
  timer = ownerAlive
    ? setInterval(() => {
        if (!ownerAlive()) fire()
      }, input.interval ?? 1000)
    : undefined
  timer?.unref?.()
  return () => {
    fired = true
    unsubscribe?.()
    if (timer !== undefined) clearInterval(timer)
  }
}

/**
 * Liveness probe for the owner PID. Only ESRCH ("no such process") counts as
 * death: EPERM (the owner exists but we may not signal it) or any other probe
 * error must not read as death, or a transient probe failure would orphan -
 * and kill - a worker whose owner is fine (#442).
 */
export function probeOwnerAlive(pid: number, kill: (pid: number, signal?: number) => void = process.kill.bind(process)) {
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== "ESRCH"
  }
}
