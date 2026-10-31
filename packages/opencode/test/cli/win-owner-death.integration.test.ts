import { describe, expect, test } from "bun:test"
import { dlopen } from "bun:ffi"
import net from "node:net"
import { fileURLToPath } from "node:url"

/**
 * Real Windows owner-death proof for the subprocess TUI worker (#442).
 *
 * #561 added the kill-on-close Job Object and #568 hardened its failure
 * reporting; both were covered by unit tests driving a fake `WindowsJobApi`,
 * plus one integration test that only watched a worker PID. What stayed
 * unproven was the actual OS behaviour the issue is about, so this file
 * exercises it end to end on a real Windows runner:
 *
 *   test process --spawn--> owner (real `createTuiWorker`, real kernel32 job)
 *                             └── worker (holds a listening port)
 *                                   └── grandchild (holds another one)
 *
 * The owner is ended with `TerminateProcess` — the same call Task Manager's
 * "End task", the OOM killer and a crash produce — and the test then requires,
 * from live OS queries rather than from any test double:
 *
 *   - the worker PID and the grandchild PID no longer exist (OpenProcess,
 *     cross-checked against the process list via tasklist);
 *   - both ports stop accepting connections and can be bound again.
 *
 * Neither the kill nor the job binding is mocked. The worker tree installs no
 * owner watchdog and no exit path, so the Job Object is the only mechanism that
 * can end it, and the test asserts the production adopter logged no job failure
 * — a worker that died for some other reason cannot read as coverage.
 *
 * Every wait draws on one shared deadline, and each subprocess and probe
 * operation carries its own bound, so the budget is a wall-clock cap rather
 * than a retry cap: a slow or wedged probe fails the test instead of quietly
 * succeeding past it. The identities of the spawned tree arrive incrementally,
 * so the cleanup reaps whatever was created even when startup never finished.
 *
 * Windows-only: Job Objects have no counterpart elsewhere, and every other
 * platform is covered by the detached-worker watchdog tests instead.
 */

const fixture = (name: string) => fileURLToPath(new URL(`../fixture/${name}`, import.meta.url))

/**
 * One wall clock for the whole test, and a hard one: every wait and every
 * subprocess or probe operation below is bounded by it, so it caps wall time
 * rather than retries.
 *
 * Worst case is this budget plus one in-flight probe (at most the 2s socket
 * timeout below) plus the cleanup budget: 40 + 2 + 5 = 47s, inside this test's
 * own `TEST_TIMEOUT_MS`. The package's `--timeout` is left untouched; only this
 * test's per-test timeout is raised, because a healthy run needs seconds but a
 * loaded Windows runner needs room for three cold `bun` starts (owner, worker,
 * grandchild) and four `tasklist` calls.
 */
const BUDGET_MS = 40_000

/** Cleanup runs after the budget may be spent, so it gets its own hard cap. */
const CLEANUP_BUDGET_MS = 5_000

/** Cap on one `tasklist` invocation, so a wedged probe cannot outlive the budget. */
const TASKLIST_TIMEOUT_MS = 15_000

/** This test's own timeout: the budget, one in-flight probe, and cleanup. */
const TEST_TIMEOUT_MS = 50_000

/**
 * Budget for the stall test's identity wait. The whole budget is always
 * consumed, because `ready` is suppressed and the promise never settles. It has
 * to be generous enough for the owner, worker and grandchild to genuinely start
 * before the bound fires: if startup is slower than this, the anti-vacuous-pass
 * assertions below fail loudly rather than reporting a stall that never
 * happened.
 */
const STALL_BUDGET_MS = 40_000

/**
 * Fresh budget for the probes that run after the identity wait. That wait ends
 * by consuming `STALL_BUDGET_MS`, so the original deadline is already in the
 * past at that point and must not be reused: `tasklistHasPid` would clamp a
 * negative remainder to a 1ms allowance and throw, and `bounded` would clamp it
 * to 0ms and reject before the owner had time to die.
 */
const STALL_PROBE_MS = 15_000

/** Fresh budget for the post-kill verification phase, same reasoning. */
const STALL_VERIFY_MS = 20_000

/**
 * Timeout for the stall test only. Worst case is the identity wait plus every
 * phase that follows it, each on its own fresh budget:
 * 40_000 + 15_000 + 20_000 + CLEANUP_BUDGET_MS (5_000) = 80_000, with margin
 * left over. Nothing in this file changes the package default
 * (`--timeout 30000` in `packages/opencode/package.json`).
 */
const STALL_TEST_TIMEOUT_MS = 90_000

/** Poll interval for the OS-settling races below (process teardown, port release). */
const POLL_MS = 50

type Report = {
  workerPid: number
  workerPort: number
  grandchildPid: number
  grandchildPort: number
}

/**
 * One line of the worker's identity protocol, sent the moment that identity
 * exists rather than in a single line once the tree is fully up:
 *
 *   worker:<pid>:<port>  this worker and the port it holds
 *   child:<pid>          the grandchild, read off the spawn handle
 *   child-port:<port>    the port the grandchild holds
 *   ready                every identity above has been delivered
 *
 * Whole-string matches, so a malformed or partial line is ignored instead of
 * being read as zeros.
 */
type Identity =
  | { kind: "worker"; workerPid: number; workerPort: number }
  | { kind: "child"; grandchildPid: number }
  | { kind: "child-port"; grandchildPort: number }
  | { kind: "ready" }

function parseIdentity(text: string): Identity | undefined {
  const worker = /^worker:(\d+):(\d+)$/.exec(text)
  if (worker) return { kind: "worker", workerPid: Number(worker[1]), workerPort: Number(worker[2]) }
  const childPort = /^child-port:(\d+)$/.exec(text)
  if (childPort) return { kind: "child-port", grandchildPort: Number(childPort[1]) }
  const child = /^child:(\d+)$/.exec(text)
  if (child) return { kind: "child", grandchildPid: Number(child[1]) }
  if (text === "ready") return { kind: "ready" }
  return undefined
}

/**
 * Assemble the identities once `ready` has arrived. A `ready` that comes
 * without a usable field is a broken protocol, not a zero to assert on.
 */
function completeReport(seen: Partial<Report>): Report {
  const report = {
    workerPid: seen.workerPid ?? 0,
    workerPort: seen.workerPort ?? 0,
    grandchildPid: seen.grandchildPid ?? 0,
    grandchildPort: seen.grandchildPort ?? 0,
  }
  const missing = Object.entries(report)
    .filter(([, value]) => !Number.isInteger(value) || value <= 0)
    .map(([field]) => field)
  if (missing.length > 0) {
    throw new Error(`the worker sent "ready" without a usable ${missing.join(", ")} (saw ${JSON.stringify(seen)})`)
  }
  return report
}

const ERROR_INVALID_PARAMETER = 87
const PROCESS_TERMINATE = 0x0001
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/** The kernel32 calls this test needs, kept structural like win-job.ts does. */
type Kernel32 = {
  OpenProcess(desiredAccess: number, inheritHandle: number, pid: number): unknown
  TerminateProcess(handle: unknown, exitCode: number): number
  CloseHandle(handle: unknown): number
  GetLastError(): number
}

let kernel32: Kernel32 | undefined

/** kernel32.dll only loads on Windows; every caller here is win32-gated. */
function win32Api(): Kernel32 {
  kernel32 ??= dlopen("kernel32.dll", {
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
    TerminateProcess: { args: ["ptr", "u32"], returns: "i32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  }).symbols as unknown as Kernel32
  return kernel32
}

function isNullHandle(handle: unknown) {
  return handle === null || handle === undefined || handle === 0 || handle === 0n
}

/**
 * Live PID existence check. `OpenProcess` fails with ERROR_INVALID_PARAMETER
 * when no process holds that PID; any other failure (ERROR_ACCESS_DENIED
 * included) means a process IS there and we are merely not allowed to query it,
 * which must never read as "gone".
 */
function pidExists(pid: number): boolean {
  const api = win32Api()
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (isNullHandle(handle)) return api.GetLastError() !== ERROR_INVALID_PARAMETER
  api.CloseHandle(handle)
  return true
}

/**
 * The force kill the issue describes: `TerminateProcess` on exactly one PID.
 * No `/T` tree walk, no console control event, no shutdown RPC — nothing in
 * this call can be what ends the worker tree.
 */
function terminateProcess(pid: number, what: string) {
  const api = win32Api()
  const handle = api.OpenProcess(PROCESS_TERMINATE, 0, pid)
  if (isNullHandle(handle)) {
    throw new Error(`OpenProcess(PROCESS_TERMINATE, ${what} ${pid}) failed (error ${api.GetLastError()})`)
  }
  try {
    if (api.TerminateProcess(handle, 1) === 0) {
      throw new Error(`TerminateProcess(${what} ${pid}) failed (error ${api.GetLastError()})`)
    }
  } finally {
    api.CloseHandle(handle)
  }
}

/**
 * A second, independent look at the same question: the process list itself
 * (`tasklist /FI "PID eq N"`). Slower than OpenProcess, so it is used as a
 * confirmation rather than in the polling loop.
 *
 * Bounded by the remaining budget, and a probe that runs out of it throws:
 * reading a wedged `tasklist` as "no such PID" would assert the very thing
 * under test.
 */
function tasklistHasPid(pid: number, deadline: number) {
  const result = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
    timeout: Math.max(1, Math.min(TASKLIST_TIMEOUT_MS, deadline - Date.now())),
  })
  if (result.exitedDueToTimeout) {
    throw new Error(`tasklist did not answer for PID ${pid} within the remaining budget`)
  }
  return result.stdout.toString().includes(`"${pid}"`)
}

/** Is something still accepting connections on this port? A dead port refuses. */
function acceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    // Bounded: a filtered (not refused) port must not stall the phase. This is
    // also the "one in-flight probe" term in the budget arithmetic above.
    socket.setTimeout(2000, () => done(false))
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
    socket.connect(port, "127.0.0.1")
  })
}

/** Can a brand-new listener take this port over? True only once it is released. */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => {
      // Wait for the probe's own handle to close before answering, so the next
      // probe is not competing with it.
      server.close(() => resolve(true))
    })
  })
}

/**
 * Poll `condition` until it holds, or fail with `what` at the shared deadline.
 * Expiry is checked on both sides of the condition: one that only answers past
 * the deadline must fail rather than quietly succeed, otherwise the budget
 * bounds retries instead of wall time.
 */
async function until(condition: () => boolean | Promise<boolean>, what: string, deadline: number) {
  const started = Date.now()
  const expire = () => {
    if (Date.now() >= deadline) throw new Error(`${what} (gave up after ${Date.now() - started}ms)`)
  }
  for (;;) {
    expire()
    const settled = await condition()
    expire()
    if (settled) return
    await Bun.sleep(POLL_MS)
  }
}

/** Bound a promise that has no deadline of its own, so a miss fails fast. */
async function bounded<T>(promise: Promise<T>, what: string, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(what)), Math.max(0, deadline - Date.now()))
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Narrow a captured identity field for the type checker, failing loudly if it
 * never arrived. The stall test cannot use `completeReport` - the tree is
 * deliberately incomplete, `grandchildPort` must stay `undefined` - so the
 * narrowing has to be explicit rather than a whole-report check.
 */
function requireDefined<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} was never captured`)
  return value
}

/**
 * IPC handler shared by both tests: folds every identity message into `seen`
 * and `spawned` in arrival order and forwards `log:` lines. One handler rather
 * than two copies, so the tests cannot drift on the property under review.
 */
function identityIpc(seen: Partial<Report>, spawned: number[], ownerLog: string[], onReady: () => void) {
  return (message: string | Buffer) => {
    const text = String(message)
    if (text.startsWith("log:")) {
      ownerLog.push(text.slice("log:".length))
      return
    }
    const identity = parseIdentity(text)
    if (!identity) return
    if (identity.kind === "ready") {
      onReady()
      return
    }
    if (identity.kind === "worker") {
      seen.workerPid = identity.workerPid
      seen.workerPort = identity.workerPort
      spawned.push(identity.workerPid)
      return
    }
    if (identity.kind === "child") {
      seen.grandchildPid = identity.grandchildPid
      spawned.push(identity.grandchildPid)
      return
    }
    seen.grandchildPort = identity.grandchildPort
  }
}

/**
 * Kill anything still alive and wait, bounded, for the owner to exit. Runs on
 * the stall test's success path and from both tests' `finally`, so a failure
 * can never leave a live process on the runner. Identities arrive as they are
 * created, so this covers a tree that never finished starting - the case where
 * a broken job leaves the most behind. Only PIDs that are still alive are
 * signalled: a dead PID may already have been recycled by something else the
 * runner needs. A missed bound is swallowed - cleanup must not replace the
 * failure the test actually threw.
 */
async function reapTree(spawned: number[], owner: Bun.Subprocess, budgetMs: number): Promise<void> {
  const cleanupDeadline = Date.now() + budgetMs
  for (const pid of spawned) {
    try {
      if (pidExists(pid)) terminateProcess(pid, "leftover")
    } catch {}
  }
  try {
    owner.kill("SIGKILL")
  } catch {}
  await bounded(owner.exited, "cleanup: the owner never exited", cleanupDeadline).catch(() => undefined)
}

describe("Windows owner death (#442)", () => {
  test.skipIf(process.platform !== "win32")(
    "a force-killed owner takes the worker tree and its listening ports with it",
    async () => {
      const deadline = Date.now() + BUDGET_MS

      // Every message the owner's `log` hook receives, i.e. every job
      // creation/assignment/FFI failure the production adopter reports. They
      // travel the same IPC channel as the identities and are emitted before
      // them, so once `ready` lands this list is complete — no pipe draining,
      // and no dependence on the teardown this test is asserting.
      const ownerLog: string[] = []

      // Identities and reaping targets, declared before the spawn so the IPC
      // handler can fill them and the cleanup can read them no matter where
      // startup stopped.
      const seen: Partial<Report> = {}
      const spawned: number[] = []
      let resolveReady!: () => void
      const treeReady = new Promise<void>((resolve) => {
        resolveReady = resolve
      })

      const owner = Bun.spawn([process.execPath, fixture("win-owner-death-owner.ts")], {
        env: {
          ...process.env,
          SILVERCODE_TEST_WORKER_TARGET: fixture("win-owner-death-worker.ts"),
          SILVERCODE_TEST_GRANDCHILD: fixture("win-owner-death-grandchild.ts"),
        },
        stderr: "inherit",
        ipc: identityIpc(seen, spawned, ownerLog, resolveReady),
      })

      try {
        await bounded(treeReady, "the worker never reported its identity", deadline)
        const report = completeReport(seen)

        // The binding was really in place: the production adopter tags every
        // creation/assignment/FFI failure with "(#442)", so a clean log means
        // the worker was genuinely under the kill-on-close job and not merely
        // a process that happened to die.
        expect(ownerLog.join("\n")).not.toContain("(#442)")

        // Negative control. "Gone afterwards" only means something if the tree
        // was observably alive and holding both ports immediately beforehand.
        expect(pidExists(report.workerPid)).toBe(true)
        expect(pidExists(report.grandchildPid)).toBe(true)
        expect(tasklistHasPid(report.workerPid, deadline)).toBe(true)
        expect(tasklistHasPid(report.grandchildPid, deadline)).toBe(true)
        expect(await acceptsConnections(report.workerPort)).toBe(true)
        expect(await acceptsConnections(report.grandchildPort)).toBe(true)

        // The force kill: one PID, no cooperation, no tree walk.
        terminateProcess(owner.pid, "owner")
        await bounded(owner.exited, "the owner never exited after TerminateProcess", deadline)

        const survived = (what: string, pid: number) =>
          `${what} ${pid} outlived its force-killed owner (#442)\nowner log:\n${ownerLog.join("\n") || "(empty)"}`
        await until(() => !pidExists(report.workerPid), survived("worker", report.workerPid), deadline)
        await until(() => !pidExists(report.grandchildPid), survived("worker child", report.grandchildPid), deadline)
        // Same conclusion from the process list, not just from OpenProcess.
        expect(tasklistHasPid(report.workerPid, deadline)).toBe(false)
        expect(tasklistHasPid(report.grandchildPid, deadline)).toBe(false)

        const held = (what: string, port: number) =>
          `${what} port ${port} is still held after the owner was force-killed (#442)\nowner log:\n${ownerLog.join("\n") || "(empty)"}`
        await until(
          async () => !(await acceptsConnections(report.workerPort)),
          held("worker", report.workerPort),
          deadline,
        )
        await until(
          async () => !(await acceptsConnections(report.grandchildPort)),
          held("worker child", report.grandchildPort),
          deadline,
        )
        // Released, not merely refused: a fresh listener can take both over.
        // The probe has no deadline of its own, so it is bounded like the rest.
        expect(
          await bounded(
            canBind(report.workerPort),
            `worker port ${report.workerPort} bind probe never answered`,
            deadline,
          ),
        ).toBe(true)
        expect(
          await bounded(
            canBind(report.grandchildPort),
            `worker child port ${report.grandchildPort} bind probe never answered`,
            deadline,
          ),
        ).toBe(true)
      } finally {
        await reapTree(spawned, owner, CLEANUP_BUDGET_MS)
      }
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(process.platform !== "win32")(
    "a tree that never finishes starting times out and still leaves nothing behind",
    async () => {
      const deadline = Date.now() + STALL_BUDGET_MS
      const ownerLog: string[] = []
      const seen: Partial<Report> = {}
      const spawned: number[] = []
      let resolveReady!: () => void
      // Set only from the IPC `ready` branch, never from the promise executor:
      // an executor runs synchronously at construction, so flagging readiness
      // there would make it true before the owner had even spawned.
      let readyArrived = false
      const treeReady = new Promise<void>((resolve) => {
        resolveReady = resolve
      })

      const owner = Bun.spawn([process.execPath, fixture("win-owner-death-owner.ts")], {
        env: {
          ...process.env,
          SILVERCODE_TEST_WORKER_TARGET: fixture("win-owner-death-worker.ts"),
          SILVERCODE_TEST_GRANDCHILD: fixture("win-owner-death-grandchild.ts"),
          // The grandchild binds its port and stays alive but never writes its
          // `ready` line, so neither `child-port` nor `ready` reaches this test.
          SILVERCODE_TEST_GRANDCHILD_SILENT: "1",
        },
        stderr: "inherit",
        ipc: identityIpc(seen, spawned, ownerLog, () => {
          readyArrived = true
          resolveReady()
        }),
      })

      try {
        // The bounded failure path under test. `ready` is suppressed by the
        // fixture, so this must reject at the deadline instead of hanging or
        // resolving.
        await expect(bounded(treeReady, "the worker never reported its identity", deadline)).rejects.toThrow(
          "the worker never reported its identity",
        )
        expect(readyArrived).toBe(false)

        // Anti-vacuous-pass guards. The bound must have fired because the tree
        // reached the stall and stopped reporting, not because startup was too
        // slow to report anything. Incremental capture is what makes this
        // knowable at all: under the old `ready`-carries-everything protocol
        // `seen` would be empty here and nothing could be asserted.
        expect(seen.workerPid).toBeGreaterThan(0)
        expect(seen.grandchildPid).toBeGreaterThan(0)
        // `child-port` is exactly the message that never arrives.
        expect(seen.grandchildPort).toBeUndefined()

        // `expect` does not narrow, so take the captured values once here and
        // use these locals below. `completeReport` is deliberately not called:
        // it would reject the missing `grandchildPort`, which is the point.
        const workerPid = requireDefined(seen.workerPid, "worker pid")
        const workerPort = requireDefined(seen.workerPort, "worker port")
        const grandchildPid = requireDefined(seen.grandchildPid, "grandchild pid")
        // Both identities arrived, and in creation order.
        expect(spawned).toEqual([workerPid, grandchildPid])

        // Every phase from here on runs on a FRESH deadline. The identity wait
        // above consumed `STALL_BUDGET_MS` by design, so reusing `deadline`
        // would hand `tasklistHasPid` a 1ms allowance (it clamps a negative
        // remainder to 1) and `bounded` a 0ms one, failing both spuriously.
        const probeDeadline = Date.now() + STALL_PROBE_MS

        // The stall is in the fixture, not in the job: adoption still
        // succeeded, so what follows exercises owner-death cleanup on a
        // half-built tree rather than on one that failed to bind at all.
        expect(ownerLog.join("\n")).not.toContain("(#442)")

        // Pre-kill liveness, so "gone afterwards" means something.
        expect(pidExists(workerPid)).toBe(true)
        expect(pidExists(grandchildPid)).toBe(true)
        expect(tasklistHasPid(workerPid, probeDeadline)).toBe(true)
        expect(tasklistHasPid(grandchildPid, probeDeadline)).toBe(true)
        expect(await acceptsConnections(workerPort)).toBe(true)

        // Owner death must still take the half-built tree down.
        terminateProcess(owner.pid, "owner")
        await bounded(owner.exited, "the owner never exited after TerminateProcess", probeDeadline)

        const verifyDeadline = Date.now() + STALL_VERIFY_MS
        // `until` throws on a missed bound, so the bare await is the assertion.
        await until(() => !pidExists(workerPid), `worker pid ${workerPid} still exists`, verifyDeadline)
        await until(() => !pidExists(grandchildPid), `grandchild pid ${grandchildPid} still exists`, verifyDeadline)
        // Second, independent look at the same two PIDs.
        expect(tasklistHasPid(workerPid, verifyDeadline)).toBe(false)
        expect(tasklistHasPid(grandchildPid, verifyDeadline)).toBe(false)

        // The worker's port is known, so its release is probed directly. The
        // grandchild's port is unknowable here (`child-port` is the message
        // that never arrives), so its release rests on its PID ceasing to
        // exist above - a dead process holds no port.
        await until(
          async () => !(await acceptsConnections(workerPort)),
          "worker still accepts connections on its port",
          verifyDeadline,
        )
        expect(await bounded(canBind(workerPort), "worker port bind probe never answered", verifyDeadline)).toBe(true)

        // Last statement in `try`: the survivor check is an assertion of this
        // test, not teardown. The `finally` below is a safety net only, so it
        // can never mask the failure that actually threw.
        await reapTree(spawned, owner, CLEANUP_BUDGET_MS)
        expect(spawned.filter((pid) => pidExists(pid))).toEqual([])
      } finally {
        await reapTree(spawned, owner, CLEANUP_BUDGET_MS)
      }
    },
    STALL_TEST_TIMEOUT_MS,
  )
})
