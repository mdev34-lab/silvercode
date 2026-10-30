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
 * Windows-only: Job Objects have no counterpart elsewhere, and every other
 * platform is covered by the detached-worker watchdog tests instead.
 */

const fixture = (name: string) => fileURLToPath(new URL(`../fixture/${name}`, import.meta.url))

/**
 * One wall clock for the whole test. Every phase waits against this deadline,
 * so a wedged phase fails the test with a message instead of running into the
 * suite timeout. 25s leaves headroom under the package's 30s `--timeout` for
 * two cold `bun` starts (owner, worker) plus the grandchild on a loaded runner;
 * a healthy run finishes in a few seconds.
 */
const BUDGET_MS = 25_000

/** Poll interval for the OS-settling races below (process teardown, port release). */
const POLL_MS = 50

type Report = {
  workerPid: number
  workerPort: number
  grandchildPid: number
  grandchildPort: number
}

/**
 * The worker's identity line, `report:<worker pid>:<worker port>:<child pid>:
 * <child port>`. Parsed with a whole-string match so a malformed or partial
 * report is rejected instead of read as zeros.
 */
function parseReport(text: string): Report | undefined {
  const match = /^report:(\d+):(\d+):(\d+):(\d+)$/.exec(text)
  if (!match) return undefined
  const report = {
    workerPid: Number(match[1]),
    workerPort: Number(match[2]),
    grandchildPid: Number(match[3]),
    grandchildPort: Number(match[4]),
  }
  // The regex already pins four digit groups; this rejects an overflow that
  // Number() turned into something that is not a usable pid or port.
  return Object.values(report).every((value) => Number.isInteger(value) && value > 0) ? report : undefined
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
 */
function tasklistHasPid(pid: number) {
  const listing = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"]).stdout.toString()
  return listing.includes(`"${pid}"`)
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
    // Bounded: a filtered (not refused) port must not stall the phase.
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

/** Poll `condition` until it holds, or fail with `what` at the shared deadline. */
async function until(condition: () => boolean | Promise<boolean>, what: string, deadline: number) {
  const started = Date.now()
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`${what} (gave up after ${Date.now() - started}ms)`)
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

describe("Windows owner death (#442)", () => {
  test.skipIf(process.platform !== "win32")(
    "a force-killed owner takes the worker tree and its listening ports with it",
    async () => {
      const deadline = Date.now() + BUDGET_MS

      let resolveReport!: (report: Report) => void
      const reported = new Promise<Report>((resolve) => {
        resolveReport = resolve
      })

      // Every message the owner's `log` hook receives, i.e. every job
      // creation/assignment/FFI failure the production adopter reports. They
      // travel the same IPC channel as the report and are emitted before it,
      // so once the report lands this list is complete — no pipe draining, and
      // no dependence on the teardown this test is asserting.
      const ownerLog: string[] = []

      const owner = Bun.spawn([process.execPath, fixture("win-owner-death-owner.ts")], {
        env: {
          ...process.env,
          SILVERCODE_TEST_WORKER_TARGET: fixture("win-owner-death-worker.ts"),
          SILVERCODE_TEST_GRANDCHILD: fixture("win-owner-death-grandchild.ts"),
        },
        stderr: "inherit",
        ipc: (message) => {
          const text = String(message)
          if (text.startsWith("log:")) {
            ownerLog.push(text.slice("log:".length))
            return
          }
          const report = parseReport(text)
          if (report) resolveReport(report)
        },
      })

      // PIDs the cleanup below may have to reap, recorded as soon as they are
      // known so a failure in any later phase still leaves nothing behind.
      const spawned: number[] = []
      try {
        const report = await bounded(reported, "the worker never reported its identity", deadline)
        spawned.push(report.grandchildPid, report.workerPid)

        // The binding was really in place: the production adopter tags every
        // creation/assignment/FFI failure with "(#442)", so a clean log means
        // the worker was genuinely under the kill-on-close job and not merely
        // a process that happened to die.
        expect(ownerLog.join("\n")).not.toContain("(#442)")

        // TEMPORARY MUTATION CONTROL: this must FAIL on win32. It proves the
        // test body executes on the Windows runner and that its live PID
        // inspection is load-bearing, since the job log cannot be read from
        // the sandbox that prepared this branch. Reverted immediately after.
        expect(pidExists(report.grandchildPid)).toBe(false)

        // Negative control. "Gone afterwards" only means something if the tree
        // was observably alive and holding both ports immediately beforehand.
        expect(pidExists(report.workerPid)).toBe(true)
        expect(pidExists(report.grandchildPid)).toBe(true)
        expect(tasklistHasPid(report.workerPid)).toBe(true)
        expect(tasklistHasPid(report.grandchildPid)).toBe(true)
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
        expect(tasklistHasPid(report.workerPid)).toBe(false)
        expect(tasklistHasPid(report.grandchildPid)).toBe(false)

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
        expect(await canBind(report.workerPort)).toBe(true)
        expect(await canBind(report.grandchildPort)).toBe(true)
      } finally {
        // Never leave a live process on the runner, on the failure path either.
        // Only PIDs that are still alive are signalled: a dead PID may already
        // have been recycled by something else the runner needs.
        for (const pid of spawned) {
          try {
            if (pidExists(pid)) terminateProcess(pid, "leftover")
          } catch {}
        }
        try {
          owner.kill("SIGKILL")
        } catch {}
        await owner.exited.catch(() => undefined)
      }
    },
  )
})
