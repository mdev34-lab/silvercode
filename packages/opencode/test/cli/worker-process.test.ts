import { describe, expect, test } from "bun:test"
import { createTuiWorker, createWorkerProcess, isWorkerCrash } from "../../src/cli/tui/worker-process"

type FakeProcess = {
  exitCode: number | null
  signalCode: string | null
  killed: boolean
  sent: string[]
  signals: (string | number)[]
  exited: Promise<number>
  send(message: string): void
  kill(signal: string): void
  disconnect(): void
  resolveExit(code: number, signal?: string): void
}

function fakeProcess(): FakeProcess {
  let resolveExit!: (code: number) => void
  return {
    exitCode: null,
    signalCode: null,
    killed: false,
    sent: [],
    signals: [],
    exited: new Promise((resolve) => {
      resolveExit = resolve
    }),
    send(message) {
      this.sent.push(message)
    },
    kill(signal) {
      this.killed = true
      this.signals.push(signal)
      this.resolveExit(0, signal)
    },
    disconnect() {},
    resolveExit(code, signal) {
      this.exitCode = code
      this.signalCode = signal ?? null
      resolveExit(code)
    },
  }
}

describe("TUI worker process", () => {
  test("restarts a crashed worker without replaying messages", async () => {
    const children: FakeProcess[] = []
    const spawn = () => {
      const child = fakeProcess()
      children.push(child)
      return child
    }

    const worker = createWorkerProcess("worker.ts", { spawn, log: () => {} })
    worker.postMessage(JSON.stringify({ type: "rpc.request", id: 1, method: "work" }))

    children[0].resolveExit(1, "SIGSEGV")
    await worker.waitForRestart()

    expect(children).toHaveLength(2)
    expect(children[0].sent).toHaveLength(1)
    expect(children[1].sent).toEqual([])
    await worker.terminate()
  })

  test("forwards parent signals to the current worker", async () => {
    const children: FakeProcess[] = []
    const spawn = () => {
      const child = fakeProcess()
      children.push(child)
      return child
    }

    const worker = createWorkerProcess("worker.ts", { spawn, log: () => {} })
    worker.signal("SIGINT")

    expect(children[0].signals).toEqual(["SIGINT"])
    children[0].resolveExit(0)
    await expect(worker.closed).resolves.toEqual({ code: 0, signal: null })
    await worker.terminate()
  })

  test("does not let a stale restart hook kill a newer worker", async () => {
    const children: FakeProcess[] = []
    const hooks: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
    const spawn = () => {
      const child = fakeProcess()
      children.push(child)
      return child
    }

    const worker = createWorkerProcess("worker.ts", {
      spawn,
      log: () => {},
      maxRestarts: 2,
      onRestart: () =>
        new Promise<void>((resolve, reject) => {
          hooks.push({ resolve, reject })
        }),
    })

    children[0].resolveExit(1, "SIGSEGV")
    const firstRestart = worker.waitForRestart()
    await new Promise((resolve) => setTimeout(resolve, 0))
    children[1].resolveExit(1, "SIGSEGV")
    await new Promise((resolve) => setTimeout(resolve, 0))

    hooks[0].reject(new Error("stale server restart failed"))
    await expect(firstRestart).rejects.toThrow("stale server restart failed")

    expect(children).toHaveLength(3)
    expect(children[2].killed).toBe(false)
    // Subscribe before completing the second hook: a waiter registered after
    // its cycle already settled would never fire.
    const secondRestart = worker.waitForRestart()
    hooks[1].resolve()
    await secondRestart
    await worker.terminate()
  })

  test("fails recovery when the restart hook fails", async () => {
    const children: FakeProcess[] = []
    const spawn = () => {
      const child = fakeProcess()
      children.push(child)
      return child
    }

    const worker = createWorkerProcess("worker.ts", {
      spawn,
      log: () => {},
      onRestart: async () => {
        throw new Error("server restart failed")
      },
    })

    children[0].resolveExit(1, "SIGSEGV")
    await expect(worker.waitForRestart()).rejects.toThrow("server restart failed")
    expect(children).toHaveLength(2)
    expect(children[1].killed).toBe(true)
    // The parent kills the replacement after the hook failure, so closed
    // carries that terminal SIGTERM exit rather than the original crash.
    await expect(worker.closed).resolves.toMatchObject({ code: 0, signal: "SIGTERM" })
    await worker.terminate()
  })

  test("returns the worker exit instead of restarting a clean shutdown", async () => {
    const children: FakeProcess[] = []
    const spawn = () => {
      const child = fakeProcess()
      children.push(child)
      return child
    }

    const worker = createWorkerProcess("worker.ts", { spawn, log: () => {}, maxRestarts: 2 })
    children[0].resolveExit(0)

    await expect(worker.closed).resolves.toEqual({ code: 0, signal: null })
    expect(children).toHaveLength(1)
  })

  test("only treats crash signals and known Windows crash codes as crashes", () => {
    expect(isWorkerCrash("SIGSEGV", null)).toBe(true)
    expect(isWorkerCrash("SIGTERM", null)).toBe(false)
    expect(isWorkerCrash(11, null)).toBe(true)
    expect(isWorkerCrash(15, null)).toBe(false)
    expect(isWorkerCrash(null, 0xc0000005)).toBe(true)
    expect(isWorkerCrash(null, 134)).toBe(true)
    expect(isWorkerCrash(null, 1)).toBe(false)
    expect(isWorkerCrash(null, 0)).toBe(false)
  })

  test("spawns the TUI worker detached on POSIX so job-control signals skip it", async () => {
    const options: { detached?: boolean }[] = []
    const children: FakeProcess[] = []
    const spawn = (_command: string[], spawnOptions: { detached?: boolean }) => {
      options.push(spawnOptions)
      const child = fakeProcess()
      children.push(child)
      return child
    }

    const worker = createTuiWorker("worker.ts", { spawn, log: () => {}, env: {} })

    expect(options[0].detached).toBe(process.platform !== "win32")
    children[0].resolveExit(0)
    await worker.closed
  })

  test("keeps the worker detached across crash restarts", async () => {
    const options: { detached?: boolean }[] = []
    const children: FakeProcess[] = []
    const spawn = (_command: string[], spawnOptions: { detached?: boolean }) => {
      options.push(spawnOptions)
      const child = fakeProcess()
      children.push(child)
      return child
    }

    const worker = createWorkerProcess("worker.ts", {
      spawn,
      log: () => {},
      detached: true,
      onRestart: () => {},
    })
    children[0].resolveExit(1, "SIGSEGV")
    await worker.waitForRestart()

    expect(options).toHaveLength(2)
    expect(options[1].detached).toBe(true)
    await worker.terminate()
  })
})
