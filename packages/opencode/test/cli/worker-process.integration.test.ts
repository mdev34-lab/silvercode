import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { fileURLToPath } from "url"
import { createTuiWorker, createWorkerProcess } from "../../src/cli/tui/worker-process"
import { Rpc } from "../../src/util/rpc"

const workerSource = `
process.on("message", (message) => {
  if (message === "ping") process.send?.("pong")
  // Exit code 134 is the crash classification on every platform (the
  // SIGABRT exit-code counterpart). process.abort() would raise SIGABRT
  // instead, and a signal death goes through the host's core-dump path,
  // which can stall the process for tens of seconds on a loaded CI runner
  // and starve the test's restart budget (#468). A plain exit(134) is
  // immediate and classifies identically.
  if (message === "crash") process.exit(134)
})
setTimeout(() => process.send?.("ready"), 50)
setInterval(() => {}, 1000)
`

const rpcWorkerSource = `
process.on("message", (message) => {
  if (message === "crash") {
    process.exit(134)
    return
  }
  let parsed
  try {
    parsed = JSON.parse(message)
  } catch {
    return
  }
  if (parsed?.type !== "rpc.request" || parsed.id === undefined) return
  // "hang" never replies: used to strand a call across a crash.
  if (parsed.method === "hang") return
  if (parsed.method === "work") {
    process.send?.(JSON.stringify({ type: "rpc.result", id: parsed.id, result: "done" }))
  }
})
setTimeout(() => process.send?.("ready"), 50)
setInterval(() => {}, 1000)
`

// Bounds an await that has no internal deadline: under CI starvation a
// missed settlement must fail fast with a clear message, not hang the test
// to the runner timeout (#468).
async function bounded<T>(promise: Promise<T>, what: string, ms = 15000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(what)), ms)),
  ])
}

async function waitForCount(messages: string[], text: string, count: number, what: string) {
  const deadline = Date.now() + 5000
  for (;;) {
    if (messages.filter((message) => message === text).length >= count) return
    if (Date.now() > deadline) throw new Error(`${what} (saw ${messages.length} messages)`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("TUI worker process integration", () => {
  test("communicates over real Bun IPC and reconnects after a crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "silvercode-worker-"))
    const target = join(dir, "worker.ts")
    await Bun.write(target, workerSource)

    const messages: string[] = []
    const worker = createWorkerProcess(target, {
      onRestart: () => {},
      log: () => {},
      // Headroom above the one intentional crash: a stray boot crash under
      // CI starvation must not exhaust the budget and leave waitForRestart
      // queued forever (#468).
      maxRestarts: 5,
    })
    worker.onmessage = (event) => messages.push(event.data)

    try {
      await waitForCount(messages, "ready", 1, "worker did not start")

      worker.postMessage("ping")
      await waitForCount(messages, "pong", 1, "worker did not reply")

      // Counts are delta-based: a stray early restart shifts the absolute
      // totals, so assert against the baseline observed just before the
      // intentional crash.
      const readyBefore = messages.filter((message) => message === "ready").length
      const pongBefore = messages.filter((message) => message === "pong").length
      worker.postMessage("crash")
      await bounded(worker.waitForRestart(), "restart never settled")
      // Restart completion is not readiness: the replacement announces
      // itself separately once it is actually usable.
      await waitForCount(messages, "ready", readyBefore + 1, "replacement worker never became ready")

      worker.postMessage("ping")
      await waitForCount(messages, "pong", pongBefore + 1, "replacement worker did not reply")

      expect(messages.filter((message) => message === "ready").length).toBeGreaterThanOrEqual(2)
    } finally {
      await worker.terminate()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects a stranded RPC across a crash and serves new calls after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "silvercode-worker-rpc-"))
    const target = join(dir, "worker.ts")
    await Bun.write(target, rpcWorkerSource)

    const worker = createWorkerProcess(target, {
      onRestart: () => {},
      log: () => {},
      maxRestarts: 5,
    })
    const client = Rpc.client<{ work(input: undefined): string; hang(input: undefined): string }>(worker)

    // A call issued while the replacement is still booting may be dropped;
    // retry with bounded attempts until the worker answers.
    async function callWorkSoon(): Promise<string> {
      const deadline = Date.now() + 5000
      for (;;) {
        const attempt = client.call("work", undefined)
        const settled = await Promise.race([
          attempt.then(
            (value) => ({ ok: true as const, value }),
            () => ({ ok: false as const }),
          ),
          new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), 200)),
        ])
        if (settled.ok) return settled.value
        if (Date.now() > deadline) throw new Error("replacement worker never answered")
      }
    }

    try {
      await expect(callWorkSoon()).resolves.toBe("done")

      const hanging = client.call("hang", undefined)
      let hangingSettled: string | undefined
      void hanging.then(
        () => {
          hangingSettled = "resolved"
        },
        () => {
          hangingSettled = "rejected"
        },
      )
      worker.postMessage("crash")
      const restarted = worker.waitForRestart()
      await bounded(
        (async () => {
          await expect(hanging).rejects.toThrow(/exited with/)
        })(),
        "stranded call never rejected",
      )
      expect(hangingSettled).toBe("rejected")
      await bounded(restarted, "restart never settled")

      await expect(callWorkSoon()).resolves.toBe("done")
    } finally {
      await worker.terminate()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("spawns the TUI worker in its own process group on POSIX", async () => {
    if (process.platform === "win32") return
    const dir = await mkdtemp(join(tmpdir(), "silvercode-worker-pgid-"))
    const target = join(dir, "worker.ts")
    await Bun.write(target, `setTimeout(() => process.send?.("ready"), 50)\nsetInterval(() => {}, 1000)\n`)

    const messages: string[] = []
    const worker = createTuiWorker(target, { log: () => {} })
    worker.onmessage = (event) => messages.push(event.data)

    try {
      await waitForCount(messages, "ready", 1, "worker did not start")
      // The transport does not expose the child PID, so read the group of
      // every bun process and assert none of them shares this test's group.
      const own = Number.parseInt(Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)]).stdout.toString().trim(), 10)
      const listing = Bun.spawnSync(["ps", "-ax", "-o", "pgid=,command="]).stdout.toString()
      const workerGroups = listing
        .split("\n")
        .filter((line) => line.includes(target))
        .map((line) => Number.parseInt(line.trim(), 10))
      expect(workerGroups.length).toBeGreaterThan(0)
      expect(workerGroups.every((pgid) => Number.isFinite(pgid) && pgid !== own)).toBe(true)
    } finally {
      await worker.terminate()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a detached worker keeps running while its parent process group is stopped", async () => {
    if (process.platform === "win32") return
    const dir = await mkdtemp(join(tmpdir(), "silvercode-worker-suspend-"))
    const target = join(dir, "worker.ts")
    const log = join(dir, "ticks.log")
    await Bun.write(
      target,
      `import { watchOwnerProcess } from ${JSON.stringify(new URL("../../src/cli/tui/owner-watch.ts", import.meta.url).pathname)}
const log = ${JSON.stringify(log)}
const note = (message) => require("fs").appendFileSync(log, message + "\\n")
// Exit when the owner dies so the test never leaks this process.
process.on("disconnect", () => process.exit(0))
process.on("message", (message) => {
  // The stand-in owner reports its PID once up; the worker watches it with
  // the real production watchdog so a spurious orphan during the owner's
  // suspension would end the ticks (and fail the assertions below).
  if (typeof message === "string" && message.startsWith("ownerpid=")) {
    const ownerPID = Number(message.slice("ownerpid=".length))
    watchOwnerProcess({
      ownerAlive: () => {
        try {
          process.kill(ownerPID, 0)
          return true
        } catch {
          return false
        }
      },
      interval: 50,
      onOrphan() {
        note("orphaned")
        process.exit(1)
      },
    })
  }
})
setTimeout(() => process.send?.("ready"), 50)
setInterval(() => note("tick " + Date.now()), 50)
`,
    )

    // A stand-in owner hosts the worker: stopping this test's own process
    // would prove nothing about process groups (kill(pid) never hits the
    // group) and can wedge the runner if the resume path fails. The owner
    // is spawned detached so it leads its own group; the production worker
    // is detached too, so it must NOT join that group. On a revert of the
    // worker's detached flag it would join, get stopped with the owner, and
    // the tick assertions below would fail.
    const owner = join(dir, "owner.ts")
    await Bun.write(
      owner,
      `import { createTuiWorker } from ${JSON.stringify(new URL("../../src/cli/tui/worker-process.ts", import.meta.url).pathname)}
const w = createTuiWorker(${JSON.stringify(target)}, { log: () => {} })
w.onmessage = (event) => {
  if (event.data === "ready") {
    w.postMessage("ownerpid=" + process.pid)
    process.send?.("owner.ready")
  }
}
setInterval(() => {}, 1000)
`,
    )

    let ownerReady!: () => void
    const ready = new Promise<void>((resolve) => {
      ownerReady = resolve
    })
    const ownerProcess = Bun.spawn([process.execPath, owner], {
      ipc: () => ownerReady(),
      stderr: "inherit",
      detached: true,
    })
    // Independent resumer, armed before the stop and owned by the runner's
    // group (which is never stopped): the suspension window is bounded even
    // if every other resume path fails.
    const resumer = Bun.spawn(
      [
        process.execPath,
        "-e",
        `setTimeout(() => { try { process.kill(${-ownerProcess.pid}, "SIGCONT") } catch {} }, 500)`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    )
    try {
      await ready
      await new Promise((resolve) => setTimeout(resolve, 200))
      const before = countLines(await Bun.file(log).text())

      // SIGSTOP stands in for Ctrl+Z here: SIGTSTP is ignored when inherited,
      // while SIGSTOP cannot be. Stopping the owner's whole group must not
      // reach the detached worker, so ticks keep landing during the stop.
      const stoppedAt = Date.now()
      process.kill(-ownerProcess.pid, "SIGSTOP")
      await new Promise((resolve) => setTimeout(resolve, 800))
      const windowEnd = Date.now()

      const ticks = (await Bun.file(log).text())
        .split("\n")
        .filter((line) => line.startsWith("tick "))
        .map((line) => Number(line.slice(5)))
      expect(ticks.length).toBeGreaterThan(before)
      const whileStopped = ticks.filter((at) => at >= stoppedAt && at <= windowEnd)
      expect(whileStopped.length).toBeGreaterThanOrEqual(3)
      // The production watchdog must stay quiet while the owner is merely
      // stopped: a spurious orphan would exit the worker and end the ticks.
      expect(await Bun.file(log).text()).not.toContain("orphaned")
    } finally {
      try {
        process.kill(-ownerProcess.pid, "SIGCONT")
      } catch {}
      ownerProcess.kill("SIGKILL")
      await resumer.exited
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a detached worker shuts itself down when its owner dies without shutdown", async () => {
    if (process.platform === "win32") return
    const dir = await mkdtemp(join(tmpdir(), "silvercode-worker-orphan-"))
    const target = join(dir, "worker.ts")
    const log = join(dir, "worker.log")
    await Bun.write(
      target,
      `import { watchOwnerProcess } from ${JSON.stringify(new URL("../../src/cli/tui/owner-watch.ts", import.meta.url).pathname)}
const log = ${JSON.stringify(log)}
const note = (message) => require("fs").appendFileSync(log, message + "\\n")
note("start pid=" + process.pid + " ppid=" + process.ppid)
// Mirrors worker.ts: IPC disconnect is the primary owner-death signal.
watchOwnerProcess({
  subscribeDisconnect: (handler) => {
    process.on("disconnect", handler)
    return () => process.off("disconnect", handler)
  },
  interval: 50,
  onOrphan() {
    note("orphaned")
    process.exit(0)
  },
})
setTimeout(() => process.send?.("ready"), 50)
setInterval(() => {}, 1000)
`,
    )

    const owner = join(dir, "owner.ts")
    await Bun.write(
      owner,
      `import { createTuiWorker } from ${JSON.stringify(new URL("../../src/cli/tui/worker-process.ts", import.meta.url).pathname)}
createTuiWorker(${JSON.stringify(target)}, { log: () => {} })
process.send?.("owner.ready")
setInterval(() => {}, 1000)
`,
    )

    let ownerReady!: () => void
    const ready = new Promise<void>((resolve) => {
      ownerReady = resolve
    })
    const ownerProcess = Bun.spawn([process.execPath, owner], {
      ipc: () => ownerReady(),
      stderr: "inherit",
    })
    try {
      await ready
      // Kill the owner the way the OOM killer does: no shutdown RPC runs.
      ownerProcess.kill("SIGKILL")
      await ownerProcess.exited
      await waitForFileText(log, "orphaned", 10_000)
      expect(await Bun.file(log).text()).toContain("orphaned")
    } finally {
      ownerProcess.kill("SIGKILL")
      // The worker is detached, so killing the owner does not reap it. On
      // the pass path it orphans itself out; on the failure path it would
      // otherwise idle forever holding the deleted temp dir.
      const started = (await Bun.file(log).text()).match(/^start pid=(\d+)/m)
      if (started) {
        try {
          process.kill(Number(started[1]), "SIGKILL")
        } catch {}
      }
      await rm(dir, { recursive: true, force: true })
    }
  })

  // #442: Windows has no detached process groups, and the worker's own owner
  // watchdog never observes a hard-killed owner there (#480). The owner-side
  // guarantee is the OS: the worker is assigned to a kill-on-close job object,
  // so the owner's death takes it down. The worker script installs no
  // watchdog, so nothing except the job can end it.
  test("a Windows job object kills the worker when its owner is hard-killed (#442)", async () => {
    if (process.platform !== "win32") return
    const dir = await mkdtemp(join(tmpdir(), "silvercode-worker-job-"))
    const target = join(dir, "worker.ts")
    await Bun.write(target, `process.send?.("pid=" + process.pid)\nsetInterval(() => {}, 1000)\n`)

    const owner = join(dir, "owner.ts")
    await Bun.write(
      owner,
      `import { createTuiWorker } from ${JSON.stringify(fileURLToPath(new URL("../../src/cli/tui/worker-process.ts", import.meta.url)))}
const worker = createTuiWorker(${JSON.stringify(target)}, { log: () => {} })
worker.onmessage = (event) => {
  if (typeof event.data === "string" && event.data.startsWith("pid=")) process.send?.(event.data)
}
setInterval(() => {}, 1000)
`,
    )

    let reportPid!: (pid: number) => void
    const reported = new Promise<number>((resolve) => {
      reportPid = resolve
    })
    const ownerProcess = Bun.spawn([process.execPath, owner], {
      ipc: (message) => {
        const text = String(message)
        if (text.startsWith("pid=")) reportPid(Number(text.slice("pid=".length)))
      },
      stderr: "inherit",
    })
    const pid = await bounded(reported, "worker never reported its PID", 20000)
    try {
      expect(pid).toBeGreaterThan(0)
      expect(windowsPidAlive(pid)).toBe(true)
      // Kill the owner the way TerminateProcess or the OOM killer does: no
      // shutdown RPC, no signal handling, no cooperation.
      ownerProcess.kill("SIGKILL")
      await ownerProcess.exited
      await waitForWindowsPidGone(pid, 15000)
    } finally {
      ownerProcess.kill("SIGKILL")
      // On the pass path the worker is already gone; on the failure path this
      // keeps a broken build from leaking a process on CI.
      Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"])
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function countLines(text: string) {
  return text.split("\n").filter((line) => line !== "").length
}

async function waitForFileText(path: string, needle: string, timeout: number) {
  const deadline = Date.now() + timeout
  for (;;) {
    const text = await Bun.file(path).text().catch(() => "")
    if (text.includes(needle)) return text
    if (Date.now() > deadline) throw new Error(`${needle} never appeared in ${path} (saw ${text.length} bytes)`)
    await Bun.sleep(25)
  }
}

function windowsPidAlive(pid: number) {
  // tasklist is the authority here: the signal-0 probe is exactly what #480
  // showed is unreliable for a hard-killed owner on Windows.
  const listing = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"]).stdout.toString()
  return listing.includes(`"${pid}"`)
}

async function waitForWindowsPidGone(pid: number, timeout: number) {
  const deadline = Date.now() + timeout
  while (windowsPidAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`worker ${pid} survived its hard-killed owner (#442)`)
    await Bun.sleep(100)
  }
}
