import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { watchOwnerProcess } from "@/cli/tui/owner-watch"
import { Rpc } from "@/util/rpc"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"

// Surface worker defects instead of swallowing them (#396): every
// unhandledRejection/uncaughtException is logged and emitted to the main
// thread, which shows it as a TUI toast instead of letting an RPC hang look
// like a freeze. An uncaughtException in the subprocess also exits abnormally
// so the supervisor's crash-restart engages (see createDefectHandlers).
export type WorkerErrorReport = { message: string; stack?: string; fatal: boolean }

function toWorkerErrorReport(error: unknown, fatal: boolean): WorkerErrorReport {
  const err = error instanceof Error ? error : new Error(String(error))
  return { message: err.message || "unknown error", stack: err.stack, fatal }
}

export function createDefectHandlers(deps: {
  processWorker: boolean
  report: (report: WorkerErrorReport, done: () => void) => void
  exit: (code: number) => void
}) {
  let exited = false
  const exitOnce = (code: number) => {
    if (exited) return
    exited = true
    deps.exit(code)
  }
  return {
    onUnhandledRejection(error: unknown) {
      deps.report(toWorkerErrorReport(error, false), () => {})
    },
    onUncaughtException(error: Error) {
      const report = toWorkerErrorReport(error, true)
      // Only a subprocess can crash-restart; a thread worker shares the UI
      // process and must not exit it. 134 is the exit-code counterpart of
      // SIGABRT and classifies as a crash on every platform (isCrash in
      // worker-process.ts). Exit only after the report's flush ack so the
      // parent reliably receives the final worker.error before we die; the
      // fallback timer covers a dead IPC channel, where the ack never comes.
      if (!deps.processWorker) {
        deps.report(report, () => {})
        return
      }
      const fallback = setTimeout(() => exitOnce(134), 5000)
      deps.report(report, () => {
        clearTimeout(fallback)
        exitOnce(134)
      })
    },
  }
}

// Subscribe to global events and forward them via RPC
const onGlobalEvent = (event: Parameters<typeof GlobalBus.emitEvent>[0]) => {
  if (processWorker) {
    Rpc.emitProcess("global.event", event)
  } else {
    Rpc.emit("global.event", event)
  }
}

// Whether this module talks to its parent over process IPC (spawned as a
// child process) or over thread messaging (Bun Worker in a compiled binary,
// which has no `process.send`).
const processWorker = typeof process.send === "function"

// Whether this module is running as the TUI worker host rather than being
// imported as a library. Gated on the explicit launch marker (set by both
// spawn modes in worker-process.ts) or the child-process fallback for
// environments that spawn worker.ts directly. `import.meta.main` is NOT a
// reliable signal: a compiled Bun binary runs every secondary entrypoint
// (the thread worker) with `import.meta.main === false`.
const isTuiWorker = resolveIsTuiWorker(process.env, processWorker)

// Report a defect over the worker's RPC channel. `done` fires only when the
// report was actually flushed to the parent: on a failed process.send ack the
// callback carries an error and done stays uncalled, so a caller waiting on
// the ack (the crash-exit path) falls through to its fallback timer instead
// of exiting early as if the report had been delivered. Exported for tests.
export function createRpcReporter(deps: {
  processWorker: boolean
  emitProcess: (event: string, data: unknown, cb?: (error: Error | null) => void) => void
  emit: (event: string, data: unknown) => void
}) {
  return (report: WorkerErrorReport, done: () => void) => {
    console.error(
      `[silvercode-worker] ${report.fatal ? "uncaughtException" : "unhandledRejection"}: ${report.message}\n${report.stack ?? ""}`,
    )
    if (deps.processWorker) {
      deps.emitProcess("worker.error", report, (err) => {
        if (!err) done()
      })
    } else {
      deps.emit("worker.error", report)
      done()
    }
  }
}

const defectHandlers = createDefectHandlers({
  processWorker,
  report: createRpcReporter({
    processWorker,
    emitProcess: Rpc.emitProcess,
    emit: Rpc.emit,
  }),
  exit: (code) => process.exit(code),
})
const onUnhandledRejection = defectHandlers.onUnhandledRejection
const onUncaughtException = defectHandlers.onUncaughtException

// Worker identity and transport selection are independent concerns (see
// `processWorker` above). Exporting the identity decision keeps the gating
// contract testable without touching the process transport.
export function resolveIsTuiWorker(env: NodeJS.ProcessEnv, hasProcessSend: boolean) {
  return env["SILVERCODE_TUI_WORKER"] === "1" || hasProcessSend
}

// Signal-0 probe: the only portable liveness check that does not depend on
// `process.ppid`, which a detached Bun child cannot trust (see owner-watch.ts).
function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let server: Awaited<ReturnType<typeof Server.listen>> | undefined
let stopRpcListener: (() => void) | undefined

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async reload() {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    stopRpcListener?.()
    stopRpcListener = undefined
    GlobalBus.off("event", onGlobalEvent)
    await InstanceRuntime.disposeAllInstances()
    if (server) {
      await server.stop(true)
      server = undefined
    }
    process.off("unhandledRejection", onUnhandledRejection)
    process.off("uncaughtException", onUncaughtException)
  },
}

if (isTuiWorker) {
  Heap.start()
  process.on("unhandledRejection", onUnhandledRejection)
  process.on("uncaughtException", onUncaughtException)
  GlobalBus.on("event", onGlobalEvent)

  if (processWorker) {
    stopRpcListener = Rpc.listenProcess(rpc)
    // Only a subprocess can outlive the UI, and only POSIX spawns it detached
    // (see worker-process.ts). A thread worker shares the process, so it
    // always exits with the UI.
    if (process.platform !== "win32") {
      const ownerPID = Number.parseInt(process.env["SILVERCODE_TUI_WORKER_OWNER_PID"] ?? "", 10)
      watchOwnerProcess({
        subscribeDisconnect: (handler) => {
          process.on("disconnect", handler)
          return () => {
            process.off("disconnect", handler)
          }
        },
        ownerAlive: Number.isFinite(ownerPID) && ownerPID > 0 ? () => processAlive(ownerPID) : undefined,
        onOrphan() {
          // A hard exit bounds the graceful path so a hung dispose cannot
          // leave the orphan alive anyway.
          const force = setTimeout(() => process.exit(0), 5000)
          force.unref?.()
          // .then with two branches, not .finally: a shutdown that failed
          // must not exit 0 and look graceful to a supervisor.
          void rpc.shutdown().then(
            () => process.exit(0),
            () => process.exit(1),
          )
        },
      })
    }
  } else {
    stopRpcListener = Rpc.listen(rpc)
    // Bootstrap beacon (#398): a thread worker's identity rests entirely on
    // SILVERCODE_TUI_WORKER surviving into the thread's env, which Bun's
    // Worker env option does not guarantee. Emitting ready proves to the
    // parent that the RPC listener registered; the parent fails fast with a
    // clear error when no message ever arrives instead of hanging on the
    // first RPC call.
    Rpc.emit("worker.ready", {})
  }
}
