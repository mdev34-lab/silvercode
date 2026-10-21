import path from "path"

export type WorkerExit = {
  code: number | null
  signal: string | number | null
}

type WorkerMessageTarget = {
  postMessage(data: string): void
  onmessage: ((event: MessageEvent<string>) => void) | null
  onclose: ((error: Error) => void) | null
}

type Subprocess = {
  readonly exitCode: number | null
  readonly signalCode: string | number | null
  readonly exited: Promise<number>
  send(message: string): void
  kill(signal?: string | number): void
  disconnect(): void
}

type SpawnOptions = {
  cwd?: string
  env?: Record<string, string>
  stdin?: "ignore"
  stdout?: "ignore" | "inherit"
  stderr?: "ignore" | "inherit"
  /** Run the worker in its own process group (POSIX only). */
  detached?: boolean
  ipc: (message: string) => void
}

type Spawn = (command: string[], options: SpawnOptions) => Subprocess

const CRASH_SIGNALS = new Set(["SIGABRT", "SIGBUS", "SIGFPE", "SIGILL", "SIGSEGV", "SIGSYS", "SIGTRAP"])
const CRASH_SIGNAL_NUMBERS = new Set([4, 5, 6, 7, 8, 11, 12])
const WINDOWS_CRASH_CODES = new Set([0xc0000005, 0xc000001d, 0xc0000094, 0xc0000409])
// abort() exits 134 where POSIX signals do not exist (Windows). It is the
// exit-code counterpart of SIGABRT and always means abnormal termination,
// so it classifies as a crash on every platform.
const ABORT_EXIT_CODE = 134
const MAX_RESTARTS = 3

function isCrash(signal: string | number | null, code: number | null) {
  if (typeof signal === "string") return CRASH_SIGNALS.has(signal)
  if (typeof signal === "number") return CRASH_SIGNAL_NUMBERS.has(signal)
  if (typeof code !== "number") return false
  if (code === ABORT_EXIT_CODE) return true
  return WINDOWS_CRASH_CODES.has(code >>> 0)
}

function describeExit(exit: WorkerExit) {
  return exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code ?? "unknown"}`
}

export interface WorkerProcessOptions {
  cwd?: string
  env?: Record<string, string>
  maxRestarts?: number
  /**
   * Spawn the worker in its own process group (POSIX only, ignored on
   * Windows). Terminal job-control signals — SIGTSTP from Ctrl+Z, SIGINT from
   * Ctrl+C, SIGHUP when the terminal closes — are delivered to the foreground
   * process group; a detached worker does not share it, so the UI can be
   * suspended or signalled without pausing or killing in-flight work. The
   * worker no longer dies from those signals either, so the owner must
   * terminate it explicitly (see `terminate`) and the worker watches its
   * parent's liveness to avoid outliving a dead owner.
   */
  detached?: boolean
  onRestart?: () => void | Promise<void>
  onExit?: (exit: WorkerExit) => void | Promise<void>
  log?: (message: string) => void
  spawn?: Spawn
  /** Thread-mode worker factory (tests). Defaults to the global Worker. */
  spawnWorker?: (target: string, init: { env?: Record<string, string> }) => ThreadWorkerLike
}

/**
 * Crash-restart contract for the isolated Bun worker:
 *
 * - The worker is a crash-only boundary. When the underlying process dies,
 *   `onclose` fires with the exit reason BEFORE any replacement is launched,
 *   and every in-flight call is rejected. Nothing is replayed: a call that
 *   was in flight during a crash has unknown effects, so the higher level
 *   must decide whether and how to retry.
 * - `onclose` therefore means "this transport died", not "the worker is
 *   gone for good" — a replacement follows automatically for crashes
 *   (bounded by `maxRestarts`), and `onRestart` re-establishes parent-side
 *   state (e.g. re-issuing the server listen) on the new process.
 * - Only crash-classified exits restart (see `isWorkerCrash`). Clean exits,
 *   shutdowns, and plain `exit code 1` terminate via `closed` instead.
 */
export interface WorkerProcess extends WorkerMessageTarget {
  readonly closed: Promise<WorkerExit>
  /**
   * Wait for the earliest crash-restart cycle whose outcome is still unknown
   * (or the next cycle to start when every known outcome already settled).
   * Resolves once the replacement is spawned and `onRestart` settles;
   * rejects if the restart hook fails.
   *
   * This is NOT a readiness signal: the replacement process may still be
   * initializing when this resolves. Wait for application-level readiness
   * (first message, successful RPC) separately.
   */
  waitForRestart(): Promise<void>
  terminate(): Promise<void>
  signal(signal: string | number): void
}

export function createWorkerProcess(target: string, options: WorkerProcessOptions = {}): WorkerProcess {
  const spawn = options.spawn ?? ((command, spawnOptions) => Bun.spawn(command, spawnOptions))
  const maxRestarts = options.maxRestarts ?? MAX_RESTARTS
  const log = options.log ?? console.error

  let current: Subprocess | undefined
  let stopping = false
  let terminal = false
  let restarts = 0
  type RestartWaiter = { resolve: () => void; reject: (error: Error) => void }
  type RestartCycle = { waiters: RestartWaiter[] }
  // Cycles whose restart hook has not settled yet, oldest first. A waiter
  // joins the earliest cycle whose outcome is still unknown at registration
  // time — or waits for the next cycle to start when every known outcome is
  // already settled. Either way a waiter registered before (or while)
  // triggering a crash always observes that crash's outcome, and overlapping
  // crashes fan their waiters out to the matching cycles.
  let openCycles: RestartCycle[] = []
  let queuedWaiters: RestartWaiter[] = []
  let resolveClosed!: (exit: WorkerExit) => void
  const closed = new Promise<WorkerExit>((resolve) => {
    resolveClosed = resolve
  })

  const transport = {} as WorkerProcess
  Object.defineProperties(transport, {
    closed: {
      enumerable: true,
      value: closed,
    },
  })
  transport.onmessage = null
  transport.onclose = null
  transport.waitForRestart = () => {
    const waiter = new Promise<void>((resolve, reject) => {
      const open = openCycles[0]
      if (open) open.waiters.push({ resolve, reject })
      else queuedWaiters.push({ resolve, reject })
    })
    // A fire-and-forget waiter must not surface as an unhandled rejection;
    // awaiting callers still observe the original settlement.
    waiter.catch(() => {})
    return waiter
  }
  transport.postMessage = (data) => {
    if (!current) throw new Error("Bun worker is not running")
    current.send(data)
  }
  transport.signal = (signal) => {
    current?.kill(signal)
  }
  transport.terminate = async () => {
    stopping = true
    const child = current
    child?.disconnect()
    child?.kill("SIGTERM")
    await child?.exited.catch(() => undefined)
  }

  const finish = (exit: WorkerExit) => {
    resolveClosed(exit)
    if (stopping) return
    void Promise.resolve()
      .then(() => options.onExit?.(exit))
      .catch((error) => {
        log(`[silvercode] worker exit hook failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  const launch = () => {
    current = spawn([process.execPath, target], {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
      detached: options.detached,
      ipc(message) {
        transport.onmessage?.({ data: message } as MessageEvent<string>)
      },
    })

    const child = current
    void child.exited.then((code) => {
      if (child !== current) return

      const exit: WorkerExit = {
        code: typeof code === "number" ? code : null,
        signal: child.signalCode,
      }
      const crash = !stopping && !terminal && isCrash(exit.signal, exit.code)
      transport.onclose?.(new Error(`Bun worker exited with ${describeExit(exit)}`))

      if (crash && restarts < maxRestarts) {
        restarts += 1
        log(`[silvercode] Bun worker crashed (${describeExit(exit)}); restarting (${restarts}/${maxRestarts})...`)
        const cycle: RestartCycle = { waiters: queuedWaiters }
        queuedWaiters = []
        openCycles.push(cycle)
        const settleCycle = (action: (waiter: RestartWaiter) => void) => {
          openCycles = openCycles.filter((open) => open !== cycle)
          for (const waiter of cycle.waiters) action(waiter)
        }
        launch()
        const replacement = current
        void Promise.resolve()
          .then(() => options.onRestart?.())
          .then(
            () => {
              settleCycle((waiter) => waiter.resolve())
            },
            (error) => {
              const failure = error instanceof Error ? error : new Error(String(error))
              settleCycle((waiter) => waiter.reject(failure))
              if (replacement !== current || terminal || stopping) return
              terminal = true
              log(`[silvercode] worker restart hook failed: ${failure.message}`)
              replacement?.disconnect()
              replacement?.kill("SIGTERM")
            },
          )
        return
      }

      finish(exit)
    })
  }

  launch()
  return transport
}

/**
 * Thread-worker transport for standalone compiled executables.
 *
 * A compiled Bun binary always runs its main entrypoint, so it cannot spawn an
 * embedded entrypoint as a separate process (Bun resolves neither argv nor
 * `Bun.spawn` against the embedded module table). Bun's `Worker` constructor
 * does resolve embedded entrypoints, which is how the TUI backend is launched
 * here. The thread shares the parent process, so there is nothing to restart
 * on failure: report the exit and let the caller observe it like any other
 * dead backend.
 */
type ThreadWorkerLike = {
  postMessage(data: string): void
  terminate(): void | Promise<void>
  onmessage: ((event: MessageEvent<string>) => void) | null
  onerror: ((event: unknown) => void) | null
}

export function createThreadWorker(target: string, options: WorkerProcessOptions = {}): WorkerProcess {
  const spawnWorker =
    options.spawnWorker ?? ((t: string, init: { env?: Record<string, string> }) => new Worker(t, init) as unknown as ThreadWorkerLike)
  const worker = spawnWorker(target, {
    env: options.env,
  })
  const log = options.log ?? console.error

  let resolveClosed!: (exit: WorkerExit) => void
  const closed = new Promise<WorkerExit>((resolve) => {
    resolveClosed = resolve
  })
  // terminate() settles closed itself: a clean thread shutdown never fires
  // onerror, so resolving closed only there used to hang it forever and leak
  // the onExit hook (#401). onerror now covers abnormal ends only, once.
  let finished = false
  const finish = (exit: WorkerExit) => {
    if (finished) return
    finished = true
    resolveClosed(exit)
    void Promise.resolve()
      .then(() => options.onExit?.(exit))
      .catch((error) => {
        log(`[silvercode] worker exit hook failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  const transport = {} as WorkerProcess
  Object.defineProperties(transport, {
    closed: {
      enumerable: true,
      value: closed,
    },
  })
  transport.postMessage = (data) => {
    worker.postMessage(data)
  }
  // A thread shares the owner's process: there is no signal channel, only
  // terminate(). Explicit no-op so the WorkerProcess contract holds.
  transport.signal = () => {}
  transport.terminate = async () => {
    // Bun's Worker.terminate resolves after the thread finishes flushing;
    // awaiting it keeps in-flight RPC emits from being cut off (#401).
    await worker.terminate()
    finish({ code: 0, signal: null })
  }
  transport.waitForRestart = () => Promise.resolve()

  worker.onmessage = (evt) => {
    transport.onmessage?.({ data: evt.data as string } as MessageEvent<string>)
  }
  worker.onerror = (event) => {
    const message = event instanceof MessageEvent ? String(event.data ?? "unknown worker error") : "unknown worker error"
    transport.onclose?.(new Error(`Bun worker exited with error: ${message}`))
    finish({ code: 1, signal: null })
  }
  return transport
}

export function createTuiWorker(target: string, options: WorkerProcessOptions = {}): WorkerProcess {
  // A compiled standalone binary always runs its main entrypoint, so it can
  // only host the worker as a thread (Bun resolves `Worker` entrypoints from
  // the embedded module table). Under `bun dev`/`bun run` the child is instead
  // a subprocess so crashes can be contained and restarted.
  const compiled = path.basename(process.execPath).replace(/\.exe$/, "") !== "bun"
  const env = {
    ...options.env,
    // Explicit marker so worker.ts knows it is the TUI worker in BOTH modes
    // (see worker.ts): bootstrap gating cannot use `import.meta.main`, a
    // compiled binary's thread runs its secondary entrypoint with it false.
    // A thread worker must also not receive the process-message RPC mode
    // (`Rpc.listenProcess`) — there is no `process.send` in a thread, so
    // worker.ts picks the thread transport from that absence.
    SILVERCODE_TUI_WORKER: "1",
    // Owner PID for the worker's liveness watchdog: a detached child cannot
    // trust `process.ppid` (Bun may parent it under an intermediate reaper),
    // so the owner passes its identity down explicitly. See owner-watch.ts.
    SILVERCODE_TUI_WORKER_OWNER_PID: String(process.pid),
  }
  if (compiled) {
    return createThreadWorker(target, { ...options, env })
  }
  // A suspended UI must not pause in-flight work: keep the worker out of the
  // terminal's foreground process group so job-control signals (Ctrl+Z's
  // SIGTSTP, terminal close's SIGHUP, Ctrl+C's SIGINT) reach only the UI.
  // Windows has no process-group job control — the console delivers Ctrl+C to
  // every attached process and `terminal.suspend` is win32-disabled — so the
  // existing console semantics stay untouched there.
  return createWorkerProcess(target, { ...options, env, detached: process.platform !== "win32" })
}

export function isWorkerCrash(signal: string | number | null, code: number | null) {
  return isCrash(signal, code)
}
