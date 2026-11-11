// Test-only diagnostic for Windows ConPTY codepage behavior.
// Runs in normal CI on Windows and is skipped on non-Windows.
// It intentionally does not apply any output decoder: every chunk is recorded as the backend delivered it.
// Diagnostic measurement only; not a product fix.
import { describe, expect, test } from "bun:test"
import { spawn as spawnProcess } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Opts, Proc } from "../../src/pty/pty"

const here = path.dirname(fileURLToPath(import.meta.url))
const helper = path.join(here, "native-codepage-probe-helper.ps1")
const fileName = "ação-日本.txt"
const fileText = "ação-日本 ok"
const CASE_GUARD_MS = 20_000
const TEST_BUDGET_MS = 30_000
const MAX_CAPTURE = 256 * 1024
const CLEANUP_BUDGET_MS = 5_000
const CLEANUP_SHUTDOWN_GRACE_MS = 1_000
const CLEANUP_DEATH_CONFIRM_MS = 1_000
const CLEANUP_PROBE_INTERVAL_MS = 50
const STARTUP_RESPONSE_LIMIT = 4
const DIAGNOSTIC_CAPTURE_LIMIT = 4096

const backends = ["node", "bun"] as const
const modes = ["baseline", "chcp", "setconsole"] as const

type Backend = (typeof backends)[number]
type Mode = (typeof modes)[number]
type CpStage = { stage: string; input: number; output: number }
type SetOutputCp = { requested: number; success: boolean; lastError: number }
type StartupGate = {
  startupBuffer: string
  startupMarkerSeen: boolean
  queryBuffer: string
  startupResponseCount: number
  startupResponsesExceeded: boolean
  startupQueryBufferOverflow: boolean
  parserDisabled: boolean
}
type Spawn = (file: string, args: string[], opts: Opts) => Promise<Proc>
type LoadedSpawn = { spawn: Spawn; close: () => void; runtimeVersion?: string; runtimeBun?: string | null }
type RuntimeProc = Proc & { bridgePid?: number; runtimeVersion?: string; runtimeBun?: string | null; bridgeOverflow?: boolean; stderrOverflow?: boolean; bridgeFailure?: boolean; bridgeError?: Error; ptyExitConfirmed?: boolean; cleanupFailed?: boolean; cleanupReason?: string | null; cleanupTransportError?: Error; bridgeExitCode?: number | null; bridgeSignal?: string | null; earlyDataCount?: number; earlyExitCount?: number; stderr?: string; writeAndWait?: (data: string, timeoutMs: number) => Promise<{ ok: boolean; message: string; timedOut: boolean }>; close?: () => Promise<void> }

const windowsTest = process.platform === "win32" ? test : test.skip

function argValue(name: string) {
  const args = process.argv.slice(2)
  const index = args.findIndex((arg) => arg === `--${name}`)
  if (index >= 0) return args[index + 1]
  const inline = args.find((arg) => arg.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : undefined
}

function powershellPath() {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) return "powershell.exe"
  const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  return existsSync(candidate) ? candidate : "powershell.exe"
}

// Pure bounded append used by the real bridge stderr handler so host-side tests can
// exercise the exact same capture semantics. Retains the newest `limit` characters and
// reports whether anything was dropped.
function appendBoundedCapture(buffer: string, chunk: string, limit: number) {
  const combined = buffer + chunk
  if (combined.length <= limit) return { buffer: combined, overflow: false }
  return { buffer: combined.slice(-limit), overflow: true }
}

// Bounded diagnostic for a bridge that never reported a spawn. The stderr capture is
// already bounded, and it is capped again here so the thrown error never carries an
// unbounded payload. Only the newest characters of the capture are retained, so the
// head of a longer stderr is dropped on purpose.
function bridgeFailureDiagnostic(input: {
  reason: string
  exitCode: number | null
  signal: string | null
  runtimeVersion: string | undefined
  stderr: string
}) {
  const stderrText = input.stderr.length > 0 ? input.stderr : "<empty>"
  const capped =
    stderrText.length > DIAGNOSTIC_CAPTURE_LIMIT ? stderrText.slice(-DIAGNOSTIC_CAPTURE_LIMIT) : stderrText
  return `${input.reason} (exitCode=${input.exitCode ?? "null"} signal=${input.signal ?? "null"} runtime=${input.runtimeVersion ?? "unknown"} stderr=${capped})`
}

// Pure exit-code normalization for PTY exit events. A missing or invalid exit code is
// never reported as a clean exit, and a signaled exit never reports exit code 0.
function normalizePtyExitCode(exitCode: unknown, signal: unknown) {
  const signaled = signal !== null && signal !== undefined && signal !== 0
  if (typeof exitCode === "number" && Number.isFinite(exitCode)) {
    if (exitCode === 0 && signaled) return 1
    return exitCode
  }
  return 1
}

// Bridge child factory for the node backend. Tests inject a real child process so the
// parent-side handlers under test are the production ones.
type BridgeChildFactory = (scriptPath: string) => ChildProcess

// Tree kill used by the startup failure path. Tests inject a recording wrapper around
// the real tree kill so they can observe which numeric pid the path targets.
type KillTree = (pid: number, remainingMs: number) => Promise<{ killed: boolean; tree: boolean }>

async function loadSpawn(backend: Backend, options?: { spawnBridgeChild?: BridgeChildFactory; killTree?: KillTree }): Promise<LoadedSpawn> {
  if (backend === "bun") {
    const mod = await import("../../src/pty/pty.bun.ts")
    return {
      spawn: async (file, args, opts) => mod.spawn(file, args, opts),
      close: () => {},
      runtimeVersion: process.version,
      runtimeBun: process.versions.bun ?? null,
    }
  }

  const sourcePath = path.resolve(here, "../../src/pty/pty.node.ts")
  const sourceUrl = pathToFileURL(sourcePath).href

  return {
    spawn: async (file, args, opts) => {
      const scriptPath = path.join(tmpdir(), `silvercode-node-pty-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`)
      const script = `process.stdout.write(JSON.stringify({ type: "runtime", runtimeVersion: process.version, runtimeBun: process.versions.bun ?? null }) + "\\n")
const { spawn: spawnPty } = await import(${JSON.stringify(sourceUrl)})

const proc = spawnPty(${JSON.stringify(file)}, ${JSON.stringify(args)}, ${JSON.stringify(opts)})
let stdinBuffer = ""

process.stdin.setEncoding("utf8")
process.stdin.on("error", (error) => {
  try { proc.kill() } catch {}
  try { process.stderr.write(String(error) + "\\n") } catch {}
  process.exit(1)
})
process.stdout.on("error", (error) => {
  try { proc.kill() } catch {}
  try { process.stderr.write(String(error) + "\\n") } catch {}
  process.exit(1)
})
process.stdin.on("data", (chunk) => {
  if (stdinBuffer.length + chunk.length > 262144) {
    try { proc.kill() } catch {}
    process.stderr.write("stdin buffer overflow\\n")
    process.exit(1)
  }
  stdinBuffer += chunk
  let index
  while ((index = stdinBuffer.indexOf("\\n")) >= 0) {
    const line = stdinBuffer.slice(0, index)
    stdinBuffer = stdinBuffer.slice(index + 1)
    if (!line.trim()) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.type === "write") {
      let ok = true
      let errorMessage = ""
      try { proc.write(message.data) } catch (error) { ok = false; errorMessage = String(error) }
      process.stdout.write(JSON.stringify({ type: "writeResult", requestId: message.requestId, ok, message: errorMessage }) + "\\n")
    } else if (message.type === "kill") {
      try { proc.kill(message.signal) } catch {}
    } else if (message.type === "shutdown") {
      try { proc.kill() } catch {}
      process.exit(0)
    }
  }
})

proc.onData((data) => {
  try {
    process.stdout.write(JSON.stringify({ type: "data", data }) + "\\n")
  } catch (error) {
    try { proc.kill() } catch {}
    process.stderr.write(String(error) + "\\n")
    process.exit(1)
  }
})
proc.onExit((event) => {
  process.stdout.write(JSON.stringify({ type: "exit", exitCode: event.exitCode ?? null, signal: event.signal ?? null }) + "\\n")
})
process.stdout.write(JSON.stringify({ type: "spawned", pid: proc.pid, runtimeVersion: process.version, runtimeBun: process.versions.bun ?? null }) + "\\n")
`
      writeFileSync(scriptPath, script)

      let child
      try {
        child = options?.spawnBridgeChild
          ? options.spawnBridgeChild(scriptPath)
          : spawnProcess("node", ["--experimental-strip-types", scriptPath], {
              stdio: ["pipe", "pipe", "pipe"],
            })
      } catch (error) {
        try { rmSync(scriptPath, { force: true }) } catch {}
        throw error
      }

      const queuedData: string[] = []
      let queuedDataChars = 0
      const queuedExit: { exitCode: number }[] = []
      const dataListeners = new Set<(chunk: string) => void>()
      const exitListeners = new Set<(event: { exitCode: number }) => void>()
      const pendingWrites = new Map<number, (result: { ok: boolean; message: string; timedOut: boolean }) => void>()
      let nextWriteId = 0
      let spawnedResolve: ((value: { pid: number; runtimeVersion: string; runtimeBun: string | null }) => void) | undefined
      let spawnedReject: ((error: Error) => void) | undefined
      const spawnedPromise = new Promise<{ pid: number; runtimeVersion: string; runtimeBun: string | null }>((resolve, reject) => {
        spawnedResolve = resolve
        spawnedReject = reject
      })
      let spawnedSettled = false
      let spawnedTimer: ReturnType<typeof setTimeout> | undefined
      let stdoutBuffer = ""
      let stderrBuffer = ""
      let stderrOverflow = false
      let bridgeOverflow = false
      let earlyDataOverflow = false
      let earlyExitOverflow = false
      let ptyExited = false
      let ptyExitConfirmed = false
      let cleanupStarted = false
      let cleanupTransportError: Error | undefined
      let bridgeError: Error | undefined
      let bridgeExited = false
      let closePromise: Promise<void> | undefined
      let bridgeExitNotified = false
      let bridgeFailure = false
      let bridgeExitCode: number | null = null
      let bridgeSignal: string | null = null
      let earlyDataCount = 0
      let earlyExitCount = 0
      // The bridge reports its runtime before it imports the PTY wrapper, so a bridge
      // that dies while loading it still names the runtime it died in.
      let bridgeRuntimeVersion: string | undefined
      const describeBridgeFailure = (reason: string, code: number | null, signal: string | null) =>
        bridgeFailureDiagnostic({
          reason,
          exitCode: code,
          signal,
          runtimeVersion: bridgeRuntimeVersion,
          stderr: stderrBuffer,
        })
      spawnedTimer = setTimeout(() => {
        if (!spawnedSettled) {
          spawnedSettled = true
          spawnedReject?.(
            new Error(describeBridgeFailure("node PTY bridge did not spawn in time", bridgeExitCode, bridgeSignal)),
          )
        }
      }, 5_000)

      const settleSpawned = (value: { pid: number; runtimeVersion: string; runtimeBun: string | null }) => {
        if (spawnedSettled) return
        spawnedSettled = true
        if (spawnedTimer) clearTimeout(spawnedTimer)
        spawnedResolve?.(value)
      }
      const rejectSpawned = (error: Error) => {
        if (spawnedSettled) return
        spawnedSettled = true
        if (spawnedTimer) clearTimeout(spawnedTimer)
        spawnedReject?.(error)
      }

      // The bridge is always spawned with explicit pipe stdio, so the streams must be
      // present. Narrow them once here and fail before any handler is attached when a
      // caller injects a child without pipes.
      const stdin = child.stdin
      const stdout = child.stdout
      const stderr = child.stderr
      if (!stdin || !stdout || !stderr) {
        try { child.kill() } catch {}
        throw new Error("node PTY bridge child is missing pipe streams")
      }

      stdout.setEncoding("utf8")
      stdout.on("data", (chunk: string) => {
        if (stdoutBuffer.length + chunk.length > MAX_CAPTURE) {
          bridgeOverflow = true
          stdoutBuffer = ""
        } else {
          stdoutBuffer += chunk
        }
        let index
        while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
          const line = stdoutBuffer.slice(0, index)
          stdoutBuffer = stdoutBuffer.slice(index + 1)
          if (!line.trim()) continue
          let message: any
          try { message = JSON.parse(line) } catch { continue }
          if (message.type === "runtime") {
            bridgeRuntimeVersion = message.runtimeVersion
          } else if (message.type === "spawned") {
            settleSpawned({ pid: message.pid, runtimeVersion: message.runtimeVersion, runtimeBun: message.runtimeBun })
          } else if (message.type === "data") {
            if (dataListeners.size > 0) {
              for (const listener of dataListeners) listener(message.data)
            } else {
              earlyDataCount += 1
              if (queuedDataChars + String(message.data).length > MAX_CAPTURE) {
                earlyDataOverflow = true
              } else {
                queuedData.push(message.data)
                queuedDataChars += String(message.data).length
              }
            }
          } else if (message.type === "exit") {
            if (ptyExited || bridgeExitNotified) {
              // duplicate PTY exit, or a late PTY exit arriving after the bridge-failure
              // fallback already notified listeners; ignore it so listeners observe
              // exactly one exit and no confirmed PTY exit is manufactured
            } else {
              ptyExited = true
              ptyExitConfirmed = true
              const event = { exitCode: normalizePtyExitCode(message.exitCode, message.signal), signal: message.signal ?? undefined }
              if (exitListeners.size > 0) {
                for (const listener of exitListeners) listener(event)
              } else {
                earlyExitCount += 1
                if (queuedExit.length >= 16) earlyExitOverflow = true
                else queuedExit.push(event)
              }
            }
          } else if (message.type === "writeResult") {
            const resolveWrite = pendingWrites.get(message.requestId)
            if (resolveWrite) {
              pendingWrites.delete(message.requestId)
              resolveWrite({ ok: message.ok, message: message.message, timedOut: false })
            }
          }
        }
      })

      stderr.setEncoding("utf8")
      stderr.on("data", (chunk: string) => {
        const appended = appendBoundedCapture(stderrBuffer, chunk, MAX_CAPTURE)
        stderrBuffer = appended.buffer
        if (appended.overflow) stderrOverflow = true
      })

      child.on("error", (error) => {
        bridgeFailure = true
        rejectSpawned(
          new Error(
            describeBridgeFailure(`node PTY bridge failed: ${error.message}`, bridgeExitCode, bridgeSignal),
            { cause: error },
          ),
        )
        for (const resolveWrite of pendingWrites.values()) resolveWrite({ ok: false, message: String(error), timedOut: false })
        pendingWrites.clear()
      })
      stdin.on("error", (error) => {
        if (cleanupStarted) {
          // The intentional cleanup can break the bridge stdin transport: that is a
          // cleanup event, not a measurement failure.
          cleanupTransportError = error
        } else {
          // A broken parent-side stdin means the bridge can no longer be driven. That is
          // a bridge failure even when the child process itself is still alive.
          bridgeFailure = true
          bridgeError = error
        }
        for (const resolveWrite of pendingWrites.values()) resolveWrite({ ok: false, message: String(error), timedOut: false })
        pendingWrites.clear()
      })
      let childClosed = false
      child.once("close", () => {
        childClosed = true
      })
      child.on("exit", (code, signal) => {
        bridgeExited = true
        bridgeExitCode = code
        bridgeSignal = signal ?? null
        if (!spawnedSettled) {
          // The bridge died before it reported a spawn. Its stderr is only complete once
          // the child's stdio has closed, so the rejection waits for that drain and the
          // diagnostic is built from the drained capture, not from the exit event.
          const reject = () =>
            rejectSpawned(new Error(describeBridgeFailure("node PTY bridge exited before spawn", code, signal ?? null)))
          if (childClosed) reject()
          else child.once("close", reject)
        }
        for (const resolveWrite of pendingWrites.values()) resolveWrite({ ok: false, message: "bridge exited", timedOut: false })
        pendingWrites.clear()
        if (!ptyExited && !bridgeExitNotified) {
          bridgeExitNotified = true
          bridgeFailure = true
          // The bridge died before a PTY exit was confirmed, so this is a bridge failure
          // exit and never a confirmed PTY exit: report a nonzero code and keep the raw
          // code and signal in bridgeExitCode/bridgeSignal.
          const event = { exitCode: typeof code === "number" && code !== 0 ? code : 1, signal: signal ?? undefined }
          if (exitListeners.size > 0) {
            for (const listener of exitListeners) listener(event)
          } else {
            earlyExitCount += 1
            if (queuedExit.length < 16) queuedExit.push(event)
            else earlyExitOverflow = true
          }
        }
      })

      let spawned
      try {
        spawned = await spawnedPromise
      } catch (error) {
        // Startup failure path: tree first, then the bridge itself.
        //
        // The numeric pid of the bridge child is targeted only while no exit or signal
        // has been observed for that ChildProcess: both `exitCode` and `signalCode` must
        // still be null. Once either is set, that number may already belong to an
        // unrelated process, so it is never targeted. The close-time drain widens exactly
        // that window, which is why the check is made here instead of relying on the pid
        // alone.
        //
        // This is the observed-exit contract of the ChildProcess, not an OS ownership
        // handle. It does not close the race between the OS reaping the process and the
        // exit event being delivered, and it cannot prove what happened to descendants
        // of a bridge that was already reaped. Those descendants stay unknown, and no
        // cleanup proof is claimed for them.
        //
        // This is the bridge child's own pid, not the copied `proc.pid` of the PTY child:
        // the two are unrelated values with unrelated lifetimes.
        const killTree = options?.killTree ?? killTreeAsync
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          await killTree(child.pid, CLEANUP_BUDGET_MS)
          try { child.kill() } catch {}
        }
        try { rmSync(scriptPath, { force: true }) } catch {}
        throw error
      }

      const cleanup = createBridgeCleanup({
        bridgePid: child.pid,
        ptyPid: spawned.pid,
        bridgeAlive: () => child.exitCode === null && child.signalCode === null,
        ptyExitConfirmed: () => ptyExitConfirmed,
        shutdown: () => { try { stdin.write(JSON.stringify({ type: "shutdown" }) + "\n") } catch {} },
        kill: () => { try { child.kill() } catch {} },
        join: (budgetMs) => joinChildClose(child, budgetMs),
        onStart: () => { cleanupStarted = true },
      })

      const proc: RuntimeProc = {
        pid: spawned.pid,
        bridgePid: child.pid,
        runtimeVersion: spawned.runtimeVersion,
        runtimeBun: spawned.runtimeBun,
        bridgeOverflow,
        get stderr() { return stderrBuffer },
        onData(listener) {
          dataListeners.add(listener)
          for (const chunk of queuedData.splice(0)) listener(chunk)
          queuedDataChars = 0
          return { dispose() { dataListeners.delete(listener) } }
        },
        onExit(listener) {
          exitListeners.add(listener)
          for (const event of queuedExit.splice(0)) listener(event)
          return { dispose() { exitListeners.delete(listener) } }
        },
        write(data) {
          try { stdin.write(JSON.stringify({ type: "write", requestId: 0, data }) + "\n") } catch {}
        },
        writeAndWait(data, timeoutMs) {
          return new Promise((resolve) => {
            if (pendingWrites.size >= 4) {
              resolve({ ok: false, message: "too many pending writes", timedOut: false })
              return
            }
            if (stdin.destroyed || stdin.writableEnded) {
              // The bridge is gone, so the ack can never arrive: fail fast rather than
              // waiting out the timeout.
              resolve({ ok: false, message: "bridge stdin closed", timedOut: false })
              return
            }
            const requestId = ++nextWriteId
            let settled = false
            const timer = setTimeout(() => {
              if (settled) return
              settled = true
              pendingWrites.delete(requestId)
              resolve({ ok: false, message: "write timeout", timedOut: true })
            }, timeoutMs)
            pendingWrites.set(requestId, (result) => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              pendingWrites.delete(requestId)
              resolve(result)
            })
            try {
              stdin.write(JSON.stringify({ type: "write", requestId, data }) + "\n")
            } catch (error) {
              if (settled) return
              settled = true
              clearTimeout(timer)
              pendingWrites.delete(requestId)
              resolve({ ok: false, message: String(error), timedOut: false })
            }
          })
        },
        resize() {},
        kill(signal) {
          try { stdin.write(JSON.stringify({ type: "kill", signal }) + "\n") } catch {}
        },
        close() {
          if (closePromise) return closePromise
          closePromise = cleanup.run().then(() => {
            try { rmSync(scriptPath, { force: true }) } catch {}
          })
          return closePromise
        },
      }

      // reflect overflow flags lazily
      Object.defineProperty(proc, "bridgeOverflow", { get() { return bridgeOverflow || earlyDataOverflow || earlyExitOverflow || stderrOverflow } })
      Object.defineProperty(proc, "stderrOverflow", { get() { return stderrOverflow } })
      Object.defineProperty(proc, "bridgeFailure", { get() { return bridgeFailure } })
      Object.defineProperty(proc, "bridgeError", { get() { return bridgeError } })
      Object.defineProperty(proc, "ptyExitConfirmed", { get() { return ptyExitConfirmed } })
      Object.defineProperty(proc, "cleanupFailed", { get() { return !cleanup.outcome().ok } })
      Object.defineProperty(proc, "cleanupReason", { get() { return cleanup.outcome().reason } })
      Object.defineProperty(proc, "cleanupTransportError", { get() { return cleanupTransportError } })
      Object.defineProperty(proc, "bridgeExitCode", { get() { return bridgeExitCode } })
      Object.defineProperty(proc, "bridgeSignal", { get() { return bridgeSignal } })
      Object.defineProperty(proc, "earlyDataCount", { get() { return earlyDataCount } })
      Object.defineProperty(proc, "earlyExitCount", { get() { return earlyExitCount } })

      return proc
    },
    close: () => {},
    runtimeVersion: "node",
    runtimeBun: null,
  }
}
function childEnv() {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value
  env.TERM = "xterm-256color"
  env.OPENCODE_TERMINAL = "1"
  env.LC_ALL = "C.UTF-8"
  env.LC_CTYPE = "C.UTF-8"
  env.LANG = "C.UTF-8"
  return env
}

// Async tree kill bounded by the remaining cleanup budget. The bridge process tree owns
// the PTY child, so the tree is terminated before the bridge is asked to quit. The
// result reports whether the pid was terminated and whether a real tree kill covered
// the descendants: on POSIX there is no tree kill, so the caller still has to kill the
// known PTY pid. It makes no claim about what the operating system reaped.
function killTreeAsync(pid: number, remainingMs: number) {
  return new Promise<{ killed: boolean; tree: boolean }>((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      resolve({ killed: false, tree: false })
      return
    }
    if (process.platform !== "win32") {
      try {
        process.kill(pid, "SIGKILL")
        resolve({ killed: true, tree: false })
      } catch {
        resolve({ killed: false, tree: false })
      }
      return
    }
    let child: ChildProcess
    try {
      child = spawnProcess("taskkill", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      })
    } catch {
      resolve({ killed: false, tree: false })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      resolve({ killed: false, tree: false })
    }, remainingMs)
    child.on("error", () => {
      clearTimeout(timer)
      resolve({ killed: false, tree: false })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ killed: code === 0, tree: code === 0 })
    })
  })
}

function joinChildClose(child: ChildProcess, budgetMs: number) {
  return new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true)
      return
    }
    const timer = setTimeout(() => resolve(false), budgetMs)
    child.once("close", () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

type Liveness = "alive" | "gone" | "unknown"

// The kill probe used for liveness checks: only the error code it raises carries any
// evidence about the pid.
type KillProbe = (pid: number, signal: 0) => unknown

// Strict liveness probe for a positive pid. Only ESRCH proves the pid is gone and only
// EPERM proves it is still there; every other error is unknown and a pid that is not a
// positive integer is unknown too. The probe never claims more than the error code
// supports, and it says nothing about what the operating system reaped.
function probeProcess(pid: number, kill: KillProbe = process.kill): Liveness {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown"
  try {
    kill(pid, 0)
    return "alive"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return "gone"
    if (code === "EPERM") return "alive"
    return "unknown"
  }
}

function throwingProbeKill(code: string): KillProbe {
  return () => {
    throw Object.assign(new Error(`probe failed with ${code}`), { code })
  }
}

type CleanupOutcome = { ok: boolean; reason: string | null }

// One bounded, idempotent cleanup for a bridge child and the PTY child it owns. The
// whole cleanup shares a single deadline: the tree kill runs first, then the bridge is
// asked to shut down, then the bridge is killed and the close is joined with whatever
// budget is left. Repeated calls return the same promise, so no path pays the deadline
// again. The cleanup fails closed when the PTY child termination cannot be confirmed.
function createBridgeCleanup(target: {
  bridgePid: number | undefined
  ptyPid: number | undefined
  bridgeAlive: () => boolean
  ptyExitConfirmed: () => boolean
  shutdown: () => void
  kill: () => void
  join: (budgetMs: number) => Promise<boolean>
  killTree?: (pid: number, remainingMs: number) => Promise<{ killed: boolean; tree: boolean }>
  probe?: (pid: number) => Liveness
  budgetMs?: number
  onStart?: () => void
}) {
  let cleanup: Promise<CleanupOutcome> | undefined
  let outcome: CleanupOutcome = { ok: true, reason: null }
  const run = () => {
    if (cleanup) return cleanup
    cleanup = (async () => {
      const deadline = Date.now() + (target.budgetMs ?? CLEANUP_BUDGET_MS)
      const remaining = () => Math.max(0, deadline - Date.now())
      const killTree = target.killTree ?? killTreeAsync
      const probe = target.probe ?? probeProcess
      // Confirm the actual death of a pid inside the shared cleanup budget: a kill that
      // was accepted only proves the signal was delivered.
      const confirmPtyGone = async (pid: number) => {
        const probeDeadline = Date.now() + Math.min(remaining(), CLEANUP_DEATH_CONFIRM_MS)
        for (;;) {
          const state = probe(pid)
          if (state === "gone") return true
          if (state === "unknown") return false
          const wait = Math.min(CLEANUP_PROBE_INTERVAL_MS, probeDeadline - Date.now())
          if (wait <= 0) return false
          await new Promise((resolve) => setTimeout(resolve, wait))
        }
      }
      const withinDeadline = async <T>(work: Promise<T>) => {
        const budgetMs = remaining()
        if (budgetMs <= 0) return null
        return new Promise<T | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), budgetMs)
          void work.then(
            (value) => {
              clearTimeout(timer)
              resolve(value)
            },
            () => {
              clearTimeout(timer)
              resolve(null)
            },
          )
        })
      }

      target.onStart?.()

      if (target.bridgePid === undefined && target.ptyPid === undefined) {
        outcome = { ok: false, reason: "unknown bridge and pty pids" }
        return outcome
      }

      // Tree first: the PTY child belongs to the bridge tree, so the tree is terminated
      // before the bridge is asked to quit. Each pid is killed at most once.
      let treeCovered = false
      let bridgeKilled = false
      if (target.bridgePid !== undefined && target.bridgeAlive()) {
        const result = await withinDeadline(killTree(target.bridgePid, remaining()))
        if (result) {
          treeCovered = result.tree
          bridgeKilled = result.killed
        }
      }
      if (!treeCovered && target.ptyPid !== undefined && target.ptyPid !== target.bridgePid) {
        await withinDeadline(killTree(target.ptyPid, remaining()))
      }

      // A shutdown message is only useful while the bridge is still alive and no kill
      // already took it down: writing to a dead bridge stdin would raise EPIPE and be
      // misreported as a measurement failure.
      if (!bridgeKilled && target.bridgeAlive()) {
        try { target.shutdown() } catch {}
      }

      let joined = await withinDeadline(target.join(Math.min(remaining(), CLEANUP_SHUTDOWN_GRACE_MS)))
      if (joined !== true) {
        try { target.kill() } catch {}
        joined = await withinDeadline(target.join(remaining()))
      }

      // Fail closed: without a confirmed PTY exit the PTY child has to be verifiably
      // gone. A kill that was accepted is not a proof of death, and a liveness probe only
      // proves it for a positive pid that answers ESRCH. The actual death is confirmed
      // by a bounded probe that shares the cleanup deadline; anything else is recorded
      // as not gone. A PTY pid of zero or a non-integer is unknown, not gone: the 217 CI
      // procPid case documents a zero pid, so it must never satisfy the cleanup on its
      // own.
      const ptyPid = target.ptyPid
      let ptyGone = target.ptyExitConfirmed() || treeCovered
      if (!ptyGone && typeof ptyPid === "number" && Number.isInteger(ptyPid) && ptyPid > 0) {
        ptyGone = await confirmPtyGone(ptyPid)
      }

      if (!ptyGone) {
        outcome = { ok: false, reason: "pty child termination not confirmed" }
        return outcome
      }
      if (joined !== true || remaining() <= 0) {
        outcome = { ok: false, reason: "cleanup deadline exceeded" }
        return outcome
      }
      outcome = { ok: true, reason: null }
      return outcome
    })()
    return cleanup
  }
  return { run, outcome: () => outcome }
}
function parseJsonLines(output: string, prefix: string) {
  const values: unknown[] = []
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(escaped + "\\s+(\\{.*?\\})", "g")
  for (const match of output.matchAll(re)) {
    try {
      values.push(JSON.parse(match[1]))
    } catch {}
  }
  return values
}

function parseCmdExits(output: string) {
  const values: Array<{ name: string; exitCode: number }> = []
  for (const match of output.matchAll(/PROBE_CMD_EXIT\s+(\S+)\s+(-?\d+)/g))
    values.push({ name: match[1], exitCode: Number(match[2]) })
  return values
}

function isCpStage(value: unknown): value is CpStage {
  if (typeof value !== "object" || value === null) return false
  const stage = (value as { stage?: unknown }).stage
  const input = (value as { input?: unknown }).input
  const output = (value as { output?: unknown }).output
  return (
    typeof stage === "string" &&
    typeof input === "number" &&
    Number.isFinite(input) &&
    input > 0 &&
    typeof output === "number" &&
    Number.isFinite(output) &&
    output > 0
  )
}

function parseCpStages(output: string) {
  return parseJsonLines(output, "PROBE_CP").filter(isCpStage)
}

function isSetOutputCp(value: unknown): value is SetOutputCp {
  if (typeof value !== "object" || value === null) return false
  const requested = (value as { requested?: unknown }).requested
  const success = (value as { success?: unknown }).success
  const lastError = (value as { lastError?: unknown }).lastError
  return (
    typeof requested === "number" &&
    Number.isFinite(requested) &&
    typeof success === "boolean" &&
    typeof lastError === "number" &&
    Number.isFinite(lastError)
  )
}

function parseSetOutputCp(output: string) {
  const value = parseJsonLines(output, "PROBE_SETCPOUTPUT")[0]
  return isSetOutputCp(value) ? value : null
}

function parseChcpExit(output: string) {
  const match = output.match(/PROBE_CHCP_EXIT\s+(-?\d+)/)
  return match ? Number(match[1]) : null
}

function section(output: string, name: string) {
  const start = output.indexOf("PROBE_CONTROL_START " + name)
  const end = output.indexOf("PROBE_CONTROL_END " + name)
  if (start < 0 || end < 0 || end <= start) return ""
  return output.slice(start, end + ("PROBE_CONTROL_END " + name).length)
}

const controlNames = [
  "legit-wide",
  "osc-title",
  "utf8-raw-bytes",
  "raw-cp437-full",
  "raw-cp437-split",
  "standalone-cp437",
  "legit-wide-eacute-full",
  "legit-wide-eacute-split",
]

function observations(output: string) {
  const sections = controlNames.map((name) => section(output, name))
  const starts = output.match(/PROBE_CONTROL_START/g)?.length ?? 0
  const ends = output.match(/PROBE_CONTROL_END/g)?.length ?? 0
  const legitWideFull = section(output, "legit-wide-eacute-full")
  const legitWideSplit = section(output, "legit-wide-eacute-split")
  return {
    wideLegitPresent: output.includes("PROBE_WIDE " + "\u251c\u00ba"),
    oscTitlePresent: output.includes("\u001b]0;" + "\u251c\u00ba" + "\u0007"),
    utf8BytesPresent: output.includes("PROBE_UTF8 a" + "\u00e7\u00e3" + "o-" + "\u65e5\u672c"),
    rawCp437Present: output.includes("PROBE_RAW_CP437"),
    legitWideEacuteFullPresent: legitWideFull.includes("PROBE_WIDE2 " + "\u00e9\u251c\u00ba"),
    legitWideEacuteSplitPresent: legitWideSplit.includes("PROBE_WIDE2 " + "\u00e9\u251c\u00ba"),
    legitWideEacuteSectionsRecorded: legitWideFull.length > 0 && legitWideSplit.length > 0,
    controlMarkersBalanced: starts > 0 && starts === ends,
    allControlSectionsPresent: sections.every((value) => value.length > 0),
    standaloneUnverified: output.includes("UNVERIFIED"),
    standaloneBeforeEndVerified: false,
    typeFileTextPresent: output.includes(fileText),
    dirFileNamePresent: output.includes(fileName),
    helperDone: output.includes("PROBE_DONE"),
  }
}

const DA1_RESPONSE = "\u001b[?1;2c"

function consumeDa1Queries(buffer: string): { responses: string[]; rest: string } {
  const responses: string[] = []
  let i = 0

  while (i < buffer.length) {
    const ch = buffer[i]
    if (ch !== "\u001b") {
      i += 1
      continue
    }
    if (i + 1 >= buffer.length) return { responses, rest: buffer.slice(i) }

    const next = buffer[i + 1]
    if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
      let end = -1
      if (next === "]") {
        const bell = buffer.indexOf("\u0007", i)
        const st = buffer.indexOf("\u001b\\", i)
        if (bell >= 0 && (st < 0 || bell < st)) end = bell + 1
        else if (st >= 0) end = st + 2
      } else {
        const st = buffer.indexOf("\u001b\\", i)
        if (st >= 0) end = st + 2
      }
      if (end < 0) return { responses, rest: buffer.slice(i) }
      i = end
      continue
    }
    if (next === "[") {
      let j = i + 2
      while (j < buffer.length && (buffer.charCodeAt(j) < 0x40 || buffer.charCodeAt(j) > 0x7e)) j++
      if (j >= buffer.length) return { responses, rest: buffer.slice(i) }
      const params = buffer.slice(i + 2, j)
      if (buffer[j] === "c" && (params === "" || params === "0")) responses.push(DA1_RESPONSE)
      i = j + 1
      continue
    }
    if ("()*+,-./".includes(next)) {
      if (i + 3 > buffer.length) return { responses, rest: buffer.slice(i) }
      i += 3
      continue
    }
    i += 2
  }

  return { responses, rest: "" }
}

function initialStartupGate(): StartupGate {
  return {
    startupBuffer: "",
    startupMarkerSeen: false,
    queryBuffer: "",
    startupResponseCount: 0,
    startupResponsesExceeded: false,
    startupQueryBufferOverflow: false,
    parserDisabled: false,
  }
}

function processStartupChunk(state: StartupGate, chunk: string): { state: StartupGate; responses: string[] } {
  const marker = "PROBE_STAGE helper-startup"
  const startupMarkerSeen = state.startupMarkerSeen || state.startupBuffer.includes(marker) || chunk.includes(marker) || (state.startupBuffer + chunk.slice(0, marker.length)).includes(marker)
  const startupBuffer = chunk.length >= 256
    ? chunk.slice(-256)
    : state.startupBuffer.length + chunk.length > 256
      ? (state.startupBuffer + chunk).slice(-256)
      : state.startupBuffer + chunk

  if (startupMarkerSeen || state.parserDisabled) {
    return {
      state: {
        startupBuffer,
        startupMarkerSeen,
        queryBuffer: "",
        startupResponseCount: state.startupResponseCount,
        startupResponsesExceeded: state.startupResponsesExceeded,
        startupQueryBufferOverflow: state.startupQueryBufferOverflow,
        parserDisabled: true,
      },
      responses: [],
    }
  }

  if (state.queryBuffer.length + chunk.length > MAX_CAPTURE) {
    return {
      state: {
        startupBuffer,
        startupMarkerSeen,
        queryBuffer: "",
        startupResponseCount: state.startupResponseCount,
        startupResponsesExceeded: state.startupResponsesExceeded,
        startupQueryBufferOverflow: true,
        parserDisabled: true,
      },
      responses: [],
    }
  }

  const consumed = consumeDa1Queries(state.queryBuffer + chunk)
  let startupResponseCount = state.startupResponseCount
  let startupResponsesExceeded = state.startupResponsesExceeded
  const responses: string[] = []
  for (const _response of consumed.responses) {
    startupResponseCount += 1
    if (startupResponseCount > STARTUP_RESPONSE_LIMIT) startupResponsesExceeded = true
    else responses.push(DA1_RESPONSE)
  }
  const startupQueryBufferOverflow = consumed.rest.length > 4096
  const queryBuffer = startupQueryBufferOverflow ? "" : consumed.rest
  const parserDisabled = startupResponsesExceeded || startupQueryBufferOverflow
  return {
    state: {
      startupBuffer,
      startupMarkerSeen,
      queryBuffer,
      startupResponseCount,
      startupResponsesExceeded,
      startupQueryBufferOverflow,
      parserDisabled,
    },
    responses,
  }
}

function createStartupWriteTracker() {
  const jobs = new Set<Promise<void>>()
  return {
    tryAdd(job: Promise<void>) {
      if (jobs.size >= 4) return false
      jobs.add(job)
      void job.finally(() => jobs.delete(job))
      return true
    },
    snapshot() {
      return [...jobs]
    },
    get size() {
      return jobs.size
    },
  }
}

// Shared wait for in-flight startup writes: the probe runner and its host-side test
// both go through this, so the test exercises the runner behavior instead of a copy.
async function awaitStartupWrites(tracker: ReturnType<typeof createStartupWriteTracker>, guard: Promise<unknown>) {
  await Promise.race([Promise.all(tracker.snapshot()).catch(() => {}), guard])
}

async function runCase(backend: Backend, mode: Mode) {
  let caseTimedOut = false
  let caseGuardTimer: ReturnType<typeof setTimeout> | undefined
  let resolveGuard: ((value: { timedOut: boolean; exitCode?: number }) => void) | undefined
  const guardPromise = new Promise<{ timedOut: boolean; exitCode?: number }>((resolve) => {
    resolveGuard = resolve
  })
  let proc: RuntimeProc | undefined
  let cleanedUp = false
  let exited = false
  let cleanupPromise: Promise<void> | undefined
  let dataSub: { dispose: () => void } | undefined
  let exitSub: { dispose: () => void } | undefined
  let workDir: string | undefined
  let resultsDir: string | undefined
  let exitDrainTimer: ReturnType<typeof setTimeout> | undefined
  const cleanupProc = () => {
    if (cleanupPromise) return cleanupPromise
    cleanedUp = true
    cleanupPromise = (async () => {
      if (!proc) return
      // `exited` can be set by the synthetic bridge-failure fallback exit, so it never
      // proves the bridge or the PTY child are gone. The joined cleanup owns the bridge
      // tree and the PTY pid, is tree-first, idempotent and bounded by one deadline.
      if (proc.close) {
        await proc.close()
        return
      }
      // Backends without a joined close still get the tree-first kill.
      await killTreeAsync(proc.pid, CLEANUP_BUDGET_MS)
      try { proc.kill() } catch {}
    })()
    return cleanupPromise
  }
  caseGuardTimer = setTimeout(() => {
    caseTimedOut = true
    cleanupProc()
    resolveGuard?.({ timedOut: true })
  }, CASE_GUARD_MS)

  const startedAt = new Date().toISOString()
  const started = Date.now()

  try {
    const loaded = await loadSpawn(backend)
    const spawn = loaded.spawn
    workDir = mkdtempSync(path.join(tmpdir(), `silvercode-native-codepage-${backend}-${mode}-`))
    resultsDir = mkdtempSync(path.join(tmpdir(), `silvercode-native-codepage-results-${backend}-${mode}-`))
    writeFileSync(path.join(workDir, fileName), `${fileText}\n`, "utf8")
    const args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helper,
      "-Mode",
      mode,
      "-WorkDir",
      workDir,
      "-FileName",
      fileName,
      "-FileText",
      fileText,
    ]
    const chunks: string[] = []
    const startupWriteTracker = createStartupWriteTracker()
    let captured = 0
    let truncated = false
    let startupGate = initialStartupGate()
    let startupWriteError: string | null = null
    let startupWriteTimedOut = false
    const spawnPromise = spawn(powershellPath(), args, {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd: workDir,
      env: childEnv(),
    })
    const spawnResult = await Promise.race([
      spawnPromise.then((value) => ({ kind: "spawned" as const, value })),
      guardPromise.then((value) => ({ kind: "timeout" as const, value })),
    ])
    if (spawnResult.kind === "timeout") {
      void spawnPromise.then((lateProc) => {
        const late = lateProc as RuntimeProc
        if (late.close) {
          void late.close().then(() => {}).catch(() => {})
          return
        }
        void killTreeAsync(late.pid, CLEANUP_BUDGET_MS).then(() => {
          try { late.kill() } catch {}
        })
      }).catch(() => {})
      throw new Error("case timed out during spawn")
    }
    proc = spawnResult.value as RuntimeProc
    dataSub = proc.onData((chunk) => {
      if (captured >= MAX_CAPTURE) {
        truncated = true
      } else {
        const remaining = MAX_CAPTURE - captured
        const kept = chunk.length > remaining ? chunk.slice(0, remaining) : chunk
        chunks.push(kept)
        captured += kept.length
        if (kept.length < chunk.length) truncated = true
      }
      const processed = processStartupChunk(startupGate, chunk)
      startupGate = processed.state
      if (processed.responses.length > 0) {
        if (startupWriteTracker.size >= 4) {
          startupWriteError = "too many startup write jobs"
          caseTimedOut = true
          cleanupProc()
          resolveGuard?.({ timedOut: true })
        } else {
          let jobPromise!: Promise<void>
    jobPromise = (async () => {
            try {
              for (const _response of processed.responses) {
                let writeResult = { ok: false, message: "", timedOut: false }
                const writeAndWait = proc!.writeAndWait
                if (typeof writeAndWait === "function") {
                  writeResult = await writeAndWait(DA1_RESPONSE, 250)
                } else {
                  try {
                    proc!.write(DA1_RESPONSE)
                    writeResult = { ok: true, message: "", timedOut: false }
                  } catch (error) {
                    writeResult = { ok: false, message: String(error), timedOut: false }
                  }
                }
                if (!writeResult.ok) {
                  startupWriteError = writeResult.message || "write failed"
                  caseTimedOut = true
                  cleanupProc()
                  resolveGuard?.({ timedOut: true })
                }
                if (writeResult.timedOut) {
                  startupWriteTimedOut = true
                  caseTimedOut = true
                  cleanupProc()
                  resolveGuard?.({ timedOut: true })
                }
              }
            } catch (error) {
              startupWriteError = String(error)
              caseTimedOut = true
              cleanupProc()
              resolveGuard?.({ timedOut: true })
            }
          })()
          startupWriteTracker.tryAdd(jobPromise)
        }
      }
    })
    const exitPromise = new Promise<{ timedOut: boolean; exitCode?: number }>((resolve, reject) => {
      try {
        exitSub = proc!.onExit((event) => {
          exited = true
          exitDrainTimer = setTimeout(() => resolve({ timedOut: false, exitCode: event.exitCode }), 100)
        })
      } catch (error) {
        reject(error)
      }
    })
    const finalExit = await Promise.race([exitPromise, guardPromise])
    // await inflight startup writes briefly
    await awaitStartupWrites(startupWriteTracker, guardPromise)
    if (finalExit.timedOut) cleanupProc()
    // Join the cleanup before the result is built so a cleanup failure is recorded
    // rather than hidden behind the case guard.
    await cleanupProc()
    const output = chunks.join("")
    const cpStages = parseCpStages(output)
    const setOutputCp = parseSetOutputCp(output)
    const chcpExit = parseChcpExit(output)
    const result = {
      backend,
      mode,
      platform: process.platform,
      runtime: process.version,
      bun: process.versions.bun ?? null,
      bridgeRuntime: proc?.runtimeVersion ?? null,
      bridgeBun: proc?.runtimeBun ?? null,
      bridgePid: proc?.bridgePid ?? null,
      bridgeOverflow: proc?.bridgeOverflow ?? false,
      stderrOverflow: proc?.stderrOverflow ?? false,
      bridgeFailure: proc?.bridgeFailure ?? false,
      bridgeError: proc?.bridgeError ? String(proc.bridgeError) : null,
      ptyExitConfirmed: proc?.ptyExitConfirmed ?? false,
      cleanupFailed: proc?.cleanupFailed ?? false,
      cleanupReason: proc?.cleanupReason ?? null,
      cleanupTransportError: proc?.cleanupTransportError ? String(proc.cleanupTransportError) : null,
      bridgeExitCode: proc?.bridgeExitCode ?? null,
      bridgeSignal: proc?.bridgeSignal ?? null,
      earlyDataCount: proc?.earlyDataCount ?? 0,
      earlyExitCount: proc?.earlyExitCount ?? 0,
      bridgeStderr: proc?.stderr ?? "",
      startedAt,
      durationMs: Date.now() - started,
      timedOut: finalExit.timedOut,
      exitCode: finalExit.exitCode ?? null,
      truncated,
      chunks,
      chunkLengths: chunks.map((chunk) => chunk.length),
      output,
      cpStages,
      setOutputCp: setOutputCp ?? null,
      chcpExit: chcpExit ?? null,
      cmdExits: parseCmdExits(output),
      observations: observations(output),
      startupMarkerSeen: startupGate.startupMarkerSeen,
      startupResponseCount: startupGate.startupResponseCount,
      startupResponsesExceeded: startupGate.startupResponsesExceeded,
      startupQueryBufferOverflow: startupGate.startupQueryBufferOverflow,
      startupParserDisabled: startupGate.parserDisabled,
      startupWriteError,
      startupWriteTimedOut,
    }
    const resultPath = path.join(resultsDir, `${backend}-${mode}.json`)
    writeFileSync(resultPath, JSON.stringify(result, null, 2))
    const diagnostic = {
      backend,
      mode,
      platform: result.platform,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      cpStages: result.cpStages,
      setOutputCp: result.setOutputCp,
      chcpExit: result.chcpExit,
      cmdExits: result.cmdExits,
      observations: result.observations,
      startupMarkerSeen: startupGate.startupMarkerSeen,
      startupResponseCount: startupGate.startupResponseCount,
      startupResponsesExceeded: startupGate.startupResponsesExceeded,
      startupQueryBufferOverflow: startupGate.startupQueryBufferOverflow,
      startupParserDisabled: startupGate.parserDisabled,
      startupWriteError,
      startupWriteTimedOut,
      procPid: proc?.pid ?? null,
      bridgePid: proc?.bridgePid ?? null,
      wrapperPid: proc?.pid ?? null,
      bridgeRuntime: proc?.runtimeVersion ?? null,
      bridgeBun: proc?.runtimeBun ?? null,
      bridgeOverflow: proc?.bridgeOverflow ?? false,
      stderrOverflow: proc?.stderrOverflow ?? false,
      bridgeFailure: proc?.bridgeFailure ?? false,
      bridgeError: proc?.bridgeError ? String(proc.bridgeError) : null,
      ptyExitConfirmed: proc?.ptyExitConfirmed ?? false,
      cleanupFailed: proc?.cleanupFailed ?? false,
      cleanupReason: proc?.cleanupReason ?? null,
      cleanupTransportError: proc?.cleanupTransportError ? String(proc.cleanupTransportError) : null,
      bridgeExitCode: proc?.bridgeExitCode ?? null,
      bridgeSignal: proc?.bridgeSignal ?? null,
      earlyDataCount: proc?.earlyDataCount ?? 0,
      earlyExitCount: proc?.earlyExitCount ?? 0,
      bridgeStderr: proc?.stderr ?? "",
      runnerPid: process.pid,
      outputBytes: result.output.length,
      chunkCount: result.chunks.length,
      chunkLengths: result.chunkLengths,
      chunks: result.chunks,
      output: result.output,
    }
    console.log(`[native-codepage-probe] ${backend}/${mode} ${JSON.stringify(diagnostic)}`)
    try {
      rmSync(resultsDir, { recursive: true, force: true })
    } catch {}
    return result
  } finally {
    if (caseGuardTimer) clearTimeout(caseGuardTimer)
    if (exitDrainTimer) clearTimeout(exitDrainTimer)
    dataSub?.dispose()
    exitSub?.dispose()
    try {
      await cleanupProc()
    } catch {}
    try {
      if (workDir) rmSync(workDir, { recursive: true, force: true })
    } catch {}
    try {
      if (resultsDir) rmSync(resultsDir, { recursive: true, force: true })
    } catch {}
  }
}

export {}

describe("810 native ConPTY codepage probe (Windows only)", () => {
  const selectedBackend = (argValue("backend") ?? process.env.PROBE_BACKEND) as Backend | undefined
  const selectedMode = (argValue("mode") ?? process.env.PROBE_MODE) as Mode | undefined
  for (const backend of backends) {
    if (selectedBackend && backend !== selectedBackend) continue
    for (const mode of modes) {
      if (selectedMode && mode !== selectedMode) continue
      windowsTest(
        `${backend} backend / ${mode} codepage mode`,
        async () => {
          const result = await runCase(backend, mode)
           // These are measurement preconditions, not claims that ConPTY output was repaired.
           expect(result.timedOut).toBe(false)
           expect(result.truncated).toBe(false)
           expect(result.exitCode).toBe(0)
           expect(result.observations.helperDone).toBe(true)
           expect(result.startupMarkerSeen).toBe(true)
           expect(result.startupResponsesExceeded).toBe(false)
           expect(result.startupResponseCount).toBeLessThanOrEqual(4)
           expect(result.startupQueryBufferOverflow).toBe(false)
           expect(result.startupParserDisabled).toBe(true)
           expect(result.startupWriteError).toBeNull()
           expect(result.startupWriteTimedOut).toBe(false)
           expect(result.bridgeOverflow).toBe(false)
           expect(result.bridgeFailure).toBe(false)
           // Only the node bridge owns a joined cleanup and a confirmed PTY exit: the bun
           // backend has neither, so neither is asserted here.
           if (backend === "node") {
             expect(result.cleanupFailed).toBe(false)
             expect(result.ptyExitConfirmed).toBe(true)
           }
           expect(result.output.includes("PROBE_DONE")).toBe(true)
           expect(result.observations.controlMarkersBalanced).toBe(true)
           expect(result.observations.allControlSectionsPresent).toBe(true)
           expect(result.observations.legitWideEacuteSectionsRecorded).toBe(true)
           expect(result.observations.legitWideEacuteFullPresent).toBe(true)
           expect(result.observations.legitWideEacuteSplitPresent).toBe(true)
           expect(result.observations.standaloneUnverified).toBe(true)
           expect(result.observations.standaloneBeforeEndVerified).toBe(false)
           expect(Array.isArray(result.cpStages)).toBe(true)
           expect(result.cpStages.length).toBeGreaterThanOrEqual(3)
           for (const stage of result.cpStages) {
             expect(typeof stage.stage).toBe("string")
             expect(Number.isFinite(stage.input)).toBe(true)
             expect(stage.input).toBeGreaterThan(0)
             expect(Number.isFinite(stage.output)).toBe(true)
             expect(stage.output).toBeGreaterThan(0)
           }
           expect(result.cmdExits).toContainEqual({ name: "type", exitCode: 0 })
           expect(result.cmdExits).toContainEqual({ name: "dir", exitCode: 0 })
           if (mode === "baseline") {
             expect(result.cpStages.map((stage) => stage.stage)).toEqual(["before", "baseline", "after-commands"])
           }
           if (mode === "chcp") {
             expect(result.chcpExit).toBe(0)
             expect(result.cpStages.map((stage) => stage.stage)).toEqual(["before", "after-chcp", "after-commands"])
             const afterChcp = result.cpStages.find((stage) => stage.stage === "after-chcp")
             expect(afterChcp?.input).toBe(65001)
             expect(afterChcp?.output).toBe(65001)
           }
           if (mode === "setconsole") {
             expect(result.setOutputCp?.success).toBe(true)
             expect(result.cpStages.map((stage) => stage.stage)).toEqual(["before", "after-setconsoleoutputcp", "after-commands"])
             const before = result.cpStages.find((stage) => stage.stage === "before")
             const after = result.cpStages.find((stage) => stage.stage === "after-setconsoleoutputcp")
             expect(after?.output).toBe(65001)
             expect(after?.input).toBe(before?.input)
           }
           expect(result.chunks.length).toBeGreaterThan(0)
        },
        TEST_BUDGET_MS,
      )
    }
  }
})


describe("native codepage probe startup handshake (host-side)", () => {
  test("responds to a DA1 query split at every position", () => {
    for (const query of ["\u001b[c", "\u001b[0c"]) {
      for (let split = 1; split < query.length; split++) {
        let buffer = ""
        const responses: string[] = []
        const first = consumeDa1Queries(buffer + query.slice(0, split))
        buffer = first.rest
        responses.push(...first.responses)
        const second = consumeDa1Queries(buffer + query.slice(split))
        buffer = second.rest
        responses.push(...second.responses)
        expect(responses).toHaveLength(1)
        expect(responses[0]).toBe(DA1_RESPONSE)
      }
    }
  })

  test("responds when every character is a separate chunk", () => {
    const query = "\u001b[0c"
    let buffer = ""
    const responses: string[] = []
    for (const char of query) {
      const consumed = consumeDa1Queries(buffer + char)
      buffer = consumed.rest
      responses.push(...consumed.responses)
    }
    expect(responses).toHaveLength(1)
    expect(responses[0]).toBe(DA1_RESPONSE)
  })

  test("does not respond to other CSI final bytes", () => {
    for (const input of ["\u001b[1c", "\u001b[?c", "\u001b[>c", "\u001b[2c"]) {
      expect(consumeDa1Queries(input).responses).toHaveLength(0)
    }
  })

  test("does not respond to OSC titles or synthetic probe controls", () => {
    const chunks = ["\u001b]0;title\u0007", "PROBE_WIDE \u251c\u00ba\r\n", "PROBE_RAW_CP437 full"]
    let buffer = ""
    const responses: string[] = []
    for (const chunk of chunks) {
      const consumed = consumeDa1Queries(buffer + chunk)
      buffer = consumed.rest
      responses.push(...consumed.responses)
    }
    expect(responses).toHaveLength(0)
  })

  test("ignores DA1-like text inside OSC, DCS, APC, PM, and SOS", () => {
    const cases = [
      "\u001b]0;title \u001b[c \u0007",
      "\u001b]2;\u001b[0c\u0007",
      "\u001bPq\u001b[c\u001b\\",
      "\u001b_\u001b[0c\u001b\\",
      "\u001b^\u001b[c\u001b\\",
      "\u001bX\u001b[0c\u001b\\",
    ]
    for (const input of cases) {
      expect(consumeDa1Queries(input).responses).toHaveLength(0)
    }
  })

  test("ignores a split OSC terminator followed by a real query", () => {
    let buffer = ""
    const responses: string[] = []
    const first = consumeDa1Queries(buffer + "\u001b]0;title \u001b[c ")
    buffer = first.rest
    responses.push(...first.responses)
    const second = consumeDa1Queries(buffer + "\u0007\u001b[c")
    buffer = second.rest
    responses.push(...second.responses)
    expect(responses).toHaveLength(1)
    expect(responses[0]).toBe(DA1_RESPONSE)
  })

  test("ignores a split OSC ST terminator followed by a real query", () => {
    let buffer = ""
    const responses: string[] = []
    const first = consumeDa1Queries(buffer + "\u001b]0;title \u001b[c \u001b")
    buffer = first.rest
    responses.push(...first.responses)
    const second = consumeDa1Queries(buffer + "\\\u001b[c")
    buffer = second.rest
    responses.push(...second.responses)
    expect(responses).toHaveLength(1)
    expect(responses[0]).toBe(DA1_RESPONSE)
  })

  test("ignores a split DCS ST terminator followed by a real query", () => {
    let buffer = ""
    const responses: string[] = []
    const first = consumeDa1Queries(buffer + "\u001bPq \u001b[c \u001b")
    buffer = first.rest
    responses.push(...first.responses)
    const second = consumeDa1Queries(buffer + "\\\u001b[c")
    buffer = second.rest
    responses.push(...second.responses)
    expect(responses).toHaveLength(1)
    expect(responses[0]).toBe(DA1_RESPONSE)
  })

  test("disables responder for a large chunk containing the startup marker", () => {
    const chunk = "x".repeat(1000) + "PROBE_STAGE helper-startup" + "\u001b[c"
    const processed = processStartupChunk(initialStartupGate(), chunk)
    expect(processed.responses).toHaveLength(0)
    expect(processed.state.startupMarkerSeen).toBe(true)
  })

  test("disables responder when the startup marker is split across chunks", () => {
    const first = processStartupChunk(initialStartupGate(), "x".repeat(300) + "PROBE_STAGE helper-")
    const second = processStartupChunk(first.state, "startup" + "\u001b[c")
    expect(first.state.startupMarkerSeen).toBe(false)
    expect(second.responses).toHaveLength(0)
    expect(second.state.startupMarkerSeen).toBe(true)
  })

  test("does not answer a DA-like query inside a large terminated OSC", () => {
    const input = "\u001b]0;" + "x".repeat(4090) + "\u001b[c" + "\u0007"
    const processed = processStartupChunk(initialStartupGate(), input)
    expect(processed.responses).toHaveLength(0)
    expect(processed.state.startupQueryBufferOverflow).toBe(false)
  })

  test("fails closed when an unterminated control buffer exceeds 4096 bytes", () => {
    const input = "\u001b]0;" + "x".repeat(4097)
    const processed = processStartupChunk(initialStartupGate(), input)
    expect(processed.responses).toHaveLength(0)
    expect(processed.state.startupQueryBufferOverflow).toBe(true)
  })


  test("stays disabled across repeated oversized unterminated controls", () => {
    for (const control of ["\u001b]0;", "\u001bP"]) {
      const chunks = [control + "x".repeat(5000)]
      for (let i = 0; i < 8; i++) chunks.push("\u001b[c" + "y".repeat(2 * 1024 * 1024))
      chunks.push("\u001b\\" + "\u001b[c")
      let state = initialStartupGate()
      const responses: string[] = []
      for (const chunk of chunks) {
        const processed = processStartupChunk(state, chunk)
        state = processed.state
        responses.push(...processed.responses)
        expect(state.startupBuffer.length).toBeLessThanOrEqual(256)
        expect(state.queryBuffer.length).toBeLessThanOrEqual(4096)
        expect(state.parserDisabled).toBe(true)
      }
      expect(state.startupQueryBufferOverflow).toBe(true)
      expect(responses).toHaveLength(0)
    }
  })


// Arena scratch control: the whole parent-write control runs under Node so the outer
// Bun pipe semantics never decide the outcome. The control spawns a Node grandchild,
// writes 16 MiB to its stdin and reports the asynchronous stream error as JSON.
const EPIPE_CONTROL_SCRIPT = `const { spawn } = require("node:child_process")

const grandchild = spawn(
  process.execPath,
  ["-e", "require('node:fs').closeSync(0); process.stdout.write('ready\\\\n'); setInterval(() => {}, 1000)"],
  { stdio: ["pipe", "pipe", "pipe"] },
)

let reported = false
let timer = null
const finish = (payload) => {
  if (reported) return
  reported = true
  if (timer) clearTimeout(timer)
  process.stdout.write(JSON.stringify(payload) + "\\n")
  try { grandchild.kill("SIGKILL") } catch {}
  const done = () => process.exit(0)
  if (grandchild.exitCode !== null || grandchild.signalCode !== null) done()
  else grandchild.once("close", done)
}

grandchild.stdin.on("error", (error) => {
  finish({
    epipe: true,
    code: error && error.code ? String(error.code) : null,
    message: String(error && error.message),
  })
})

grandchild.stdout.once("data", () => {
  try {
    grandchild.stdin.write("x".repeat(16 * 1024 * 1024))
  } catch (error) {
    finish({ epipe: false, code: "SYNC_THROW", message: String(error) })
  }
})

timer = setTimeout(() => {
  finish({ epipe: false, code: "NO_ERROR", message: "no asynchronous stream error inside the control budget" })
}, 4000)
`

function readControlReport(child: ChildProcess) {
  return new Promise<{ epipe: boolean; code: string | null; message: string }>((resolve) => {
    let buffer = ""
    let settled = false
    const settle = (value: { epipe: boolean; code: string | null; message: string }) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk
      const index = buffer.indexOf("\n")
      if (index < 0) return
      try {
        const parsed = JSON.parse(buffer.slice(0, index))
        settle({ epipe: parsed.epipe === true, code: parsed.code ?? null, message: String(parsed.message ?? "") })
      } catch (error) {
        settle({ epipe: false, code: "PARSE_ERROR", message: String(error) })
      }
    })
    child.on("close", () => settle({ epipe: false, code: "CONTROL_EXITED", message: "control exited without a report" }))
  })
}

describe("native codepage probe bridge cleanup (host-side)", () => {
  test("classifies a gone pid only from an ESRCH probe error", () => {
    expect(probeProcess(4242, throwingProbeKill("ESRCH"))).toBe("gone")
  })

  test("classifies a live pid from an EPERM probe error", () => {
    expect(probeProcess(4242, throwingProbeKill("EPERM"))).toBe("alive")
  })

  test("classifies every other probe error as unknown", () => {
    expect(probeProcess(4242, throwingProbeKill("EINVAL"))).toBe("unknown")
    expect(probeProcess(4242, throwingProbeKill("EIO"))).toBe("unknown")
  })

  test("classifies a successful probe as a live pid", () => {
    expect(probeProcess(4242, () => true)).toBe("alive")
  })

  test("never probes an invalid pid", () => {
    let called = false
    expect(
      probeProcess(0, () => {
        called = true
        return true
      }),
    ).toBe("unknown")
    expect(called).toBe(false)
  })

  test("observes a real child death with the tri-state liveness probe", async () => {
    const child = spawnProcess("node", ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    const pid = child.pid
    if (pid === undefined) throw new Error("child pid is unknown")
    expect(probeProcess(pid)).toBe("alive")
    const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()) })
    child.kill("SIGKILL")
    await exited
    // The pid is no longer running, so the probe must not report it alive. Whether it
    // reports gone or unknown depends on what the platform can answer for an exited
    // pid, and neither answer claims anything about OS reaping.
    expect(probeProcess(pid)).not.toBe("alive")
  }, 10000)

  test("fails closed when the bridge and pty pids are unknown", async () => {
    const cleanup = createBridgeCleanup({
      bridgePid: undefined,
      ptyPid: undefined,
      bridgeAlive: () => false,
      ptyExitConfirmed: () => false,
      shutdown: () => {},
      kill: () => {},
      join: async () => true,
    })
    const outcome = await cleanup.run()
    expect(outcome.ok).toBe(false)
    expect(String(outcome.reason)).toContain("unknown")
  })

  test("fails closed when an accepted kill still leaves the pty alive", async () => {
    // The kill was accepted, so the signal was delivered, but the death is not proven:
    // the cleanup must not treat an accepted signal as a gone pid.
    const cleanup = createBridgeCleanup({
      bridgePid: 4242,
      ptyPid: 4243,
      bridgeAlive: () => true,
      ptyExitConfirmed: () => false,
      killTree: async () => ({ killed: true, tree: false }),
      probe: () => "alive",
      shutdown: () => {},
      kill: () => {},
      join: async () => true,
    })
    const outcome = await cleanup.run()
    expect(outcome.ok).toBe(false)
    expect(String(outcome.reason)).toContain("pty child termination not confirmed")
  })

  test("fails closed when the liveness probe is unknown", async () => {
    const cleanup = createBridgeCleanup({
      bridgePid: 4242,
      ptyPid: 4243,
      bridgeAlive: () => true,
      ptyExitConfirmed: () => false,
      killTree: async () => ({ killed: true, tree: false }),
      probe: () => "unknown",
      shutdown: () => {},
      kill: () => {},
      join: async () => true,
    })
    const outcome = await cleanup.run()
    expect(outcome.ok).toBe(false)
    expect(String(outcome.reason)).toContain("pty child termination not confirmed")
  })

  test("passes only when the liveness probe proves the pid is gone", async () => {
    const cleanup = createBridgeCleanup({
      bridgePid: 4242,
      ptyPid: 4243,
      bridgeAlive: () => true,
      ptyExitConfirmed: () => false,
      killTree: async () => ({ killed: true, tree: false }),
      probe: () => "gone",
      shutdown: () => {},
      kill: () => {},
      join: async () => true,
    })
    const outcome = await cleanup.run()
    expect(outcome.ok).toBe(true)
    expect(outcome.reason).toBeNull()
  })

  test("passes when the pty exit was confirmed and the pid is already gone", async () => {
    const cleanup = createBridgeCleanup({
      bridgePid: 4242,
      ptyPid: 4243,
      bridgeAlive: () => false,
      ptyExitConfirmed: () => true,
      killTree: async () => ({ killed: false, tree: false }),
      probe: () => "gone",
      shutdown: () => {},
      kill: () => {},
      join: async () => true,
    })
    const outcome = await cleanup.run()
    expect(outcome.ok).toBe(true)
    expect(outcome.reason).toBeNull()
  })

  test("does not write to a bridge stdin that a tree kill already took down", async () => {
    let shutdownCalls = 0
    const cleanup = createBridgeCleanup({
      bridgePid: 4242,
      ptyPid: 4243,
      bridgeAlive: () => true,
      ptyExitConfirmed: () => true,
      killTree: async () => ({ killed: true, tree: true }),
      probe: () => "gone",
      shutdown: () => {
        shutdownCalls += 1
      },
      kill: () => {},
      join: async () => true,
    })
    const outcome = await cleanup.run()
    expect(outcome.ok).toBe(true)
    expect(shutdownCalls).toBe(0)
  })

  test("bounds the whole cleanup with one shared deadline", async () => {
    const cleanup = createBridgeCleanup({
      bridgePid: 4242,
      ptyPid: 4243,
      bridgeAlive: () => false,
      ptyExitConfirmed: () => true,
      budgetMs: 200,
      killTree: async () => ({ killed: true, tree: true }),
      probe: () => "gone",
      shutdown: () => {},
      kill: () => {},
      join: () => new Promise<boolean>(() => {}),
    })
    const started = Date.now()
    const outcome = await cleanup.run()
    const elapsed = Date.now() - started
    expect(outcome.ok).toBe(false)
    expect(elapsed).toBeLessThanOrEqual(2000)
  })

  test("fails closed when the bridge is gone and the pty pid is unknown", async () => {
    // The 217 CI procPid case documents a zero pid: an unknown pid must never satisfy
    // the cleanup on its own.
    const cleanup = createBridgeCleanup({
      bridgePid: undefined,
      ptyPid: 0,
      bridgeAlive: () => false,
      ptyExitConfirmed: () => false,
      killTree: async () => ({ killed: false, tree: false }),
      probe: () => "gone",
      shutdown: () => {},
      kill: () => {},
      join: async () => true,
    })
    const outcome = await cleanup.run()
    expect(outcome.ok).toBe(false)
    expect(String(outcome.reason)).toContain("pty child termination not confirmed")
  })

  test("passes with a confirmed pty exit even when the pty pid is unknown", async () => {
    const cleanup = createBridgeCleanup({
      bridgePid: undefined,
      ptyPid: 0,
      bridgeAlive: () => false,
      ptyExitConfirmed: () => true,
      killTree: async () => ({ killed: false, tree: false }),
      probe: () => "gone",
      shutdown: () => {},
      kill: () => {},
      join: async () => true,
    })
    const outcome = await cleanup.run()
    expect(outcome.ok).toBe(true)
    expect(outcome.reason).toBeNull()
  })

  test("runs the cleanup once for repeated calls", async () => {
    let killTreeCalls = 0
    const cleanup = createBridgeCleanup({
      bridgePid: 4242,
      ptyPid: 4243,
      bridgeAlive: () => false,
      ptyExitConfirmed: () => true,
      killTree: async () => {
        killTreeCalls += 1
        return { killed: false, tree: false }
      },
      probe: () => "gone",
      shutdown: () => {},
      kill: () => {},
      join: async () => true,
    })
    const first = cleanup.run()
    const second = cleanup.run()
    expect(second).toBe(first)
    const outcome = await first
    expect(outcome.ok).toBe(true)
    expect(killTreeCalls).toBe(1)
  })
})

describe("native codepage probe node runtime bridge (host-side)", () => {
  test("spawns through the actual Node runtime and captures output", async () => {
    const loaded = await loadSpawn("node")
    let proc!: RuntimeProc
    try {
      proc = await loaded.spawn("node", ["-e", "console.log('bridge-ok'); process.exit(0)"], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
      }) as RuntimeProc
      expect(proc!.runtimeBun).toBeNull()
      expect(typeof proc!.runtimeVersion).toBe("string")
      expect(proc!.bridgePid).toBeGreaterThan(0)
      expect(proc!.bridgeOverflow).toBe(false)
      const chunks: string[] = []
      let exitCode: number | null | undefined
      proc.onData((chunk) => chunks.push(chunk))
      proc.onExit((event) => {
        exitCode = event.exitCode
      })
      const deadline = Date.now() + 5000
      while (exitCode === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(chunks.join("")).toContain("bridge-ok")
      expect(exitCode).toBe(0)
    } finally {
      try { await (proc as RuntimeProc | undefined)?.close?.() } catch {}
      loaded.close()
    }
  }, 10000)

  test("queues early data and exit until listeners attach", async () => {
    const loaded = await loadSpawn("node")
    let proc!: RuntimeProc
    try {
      proc = await loaded.spawn("node", ["-e", "console.log('early-data'); process.exit(7)"], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
      }) as RuntimeProc
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(proc.earlyDataCount).toBeGreaterThan(0)
      expect(proc.earlyExitCount).toBeGreaterThan(0)
      const chunks: string[] = []
      let exitCode: number | undefined
      proc.onData((chunk) => chunks.push(chunk))
      proc.onExit((event) => {
        exitCode = event.exitCode
      })
      const deadline = Date.now() + 5000
      while (exitCode === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(chunks.join("")).toContain("early-data")
      expect(exitCode).toBe(7)
    } finally {
      try { await (proc as RuntimeProc | undefined)?.close?.() } catch {}
      loaded.close()
    }
  }, 10000)

  test("awaits inflight startup write jobs before dump", async () => {
    const tracker = createStartupWriteTracker()
    let done = false
    const job = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      done = true
    })()
    expect(tracker.tryAdd(job)).toBe(true)
    await awaitStartupWrites(tracker, new Promise((resolve) => setTimeout(resolve, 1000)))
    expect(done).toBe(true)
  })

  test("records a nonzero bridge exit as failure", async () => {
    const loaded = await loadSpawn("node")
    let proc!: RuntimeProc
    try {
      proc = await loaded.spawn("node", ["-e", "setInterval(() => {}, 1000)"], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
      }) as RuntimeProc
      const exits: number[] = []
      proc.onExit((event) => exits.push(event.exitCode))
      try { process.kill(proc.bridgePid!, "SIGKILL") } catch {}
      const deadline = Date.now() + 5000
      while (proc.bridgeFailure !== true && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(proc.bridgeFailure).toBe(true)
      expect(exits.length).toBe(1)
    } finally {
      try { await (proc as RuntimeProc | undefined)?.close?.() } catch {}
      loaded.close()
    }
  }, 10000)

  test("bounds stderr capture for an oversized chunk", () => {
    // The previous version wrote to the PTY child's stderr, which is PTY data rather than
    // bridge stderr, so it never exercised the bridge capture path. Drive the same helper
    // the real stderr handler uses instead.
    const oversized = "x".repeat(2 * MAX_CAPTURE)

    const single = appendBoundedCapture("", oversized, MAX_CAPTURE)
    expect(single.buffer.length).toBeLessThanOrEqual(MAX_CAPTURE)
    expect(single.overflow).toBe(true)

    let buffer = ""
    let overflow = false
    for (let i = 0; i < 8; i++) {
      const appended = appendBoundedCapture(buffer, oversized, MAX_CAPTURE)
      buffer = appended.buffer
      overflow = overflow || appended.overflow
    }
    expect(buffer.length).toBeLessThanOrEqual(MAX_CAPTURE)
    expect(overflow).toBe(true)
  })

  test("reports exactly one nonzero exit when the bridge dies while the PTY is alive", async () => {
    const loaded = await loadSpawn("node")
    let proc!: RuntimeProc
    try {
      proc = await loaded.spawn("node", ["-e", "setInterval(() => {}, 1000)"], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
      }) as RuntimeProc
      const exits: number[] = []
      proc.onExit((event) => exits.push(event.exitCode))
      try { process.kill(proc.bridgePid!, "SIGKILL") } catch {}
      const deadline = Date.now() + 5000
      while (exits.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(exits.length).toBe(1)
      expect(exits[0]).toBeGreaterThan(0)
      expect(proc.bridgeFailure).toBe(true)
      expect(proc.ptyExitConfirmed).toBe(false)
      const write = await proc.writeAndWait!("after-bridge-death", 1000)
      expect(write.ok).toBe(false)
      expect(write.timedOut).toBe(false)
      expect(write.message.length).toBeGreaterThan(0)
    } finally {
      try { await (proc as RuntimeProc | undefined)?.close?.() } catch {}
      loaded.close()
    }
  }, 10000)

  test("marks the bridge failed when the parent stdin stream errors", async () => {
    // The error is injected into the real bridge stdin stream, so the production
    // handler is the one under test: it must flag the bridge failure, remember the
    // error and settle the pending ack without a timeout.
    let injected: ChildProcess | undefined
    const loaded = await loadSpawn("node", {
      spawnBridgeChild: () => {
        const child = spawnProcess(
          "node",
          [
            "-e",
            "process.stdout.write(JSON.stringify({ type: 'spawned', pid: process.pid, runtimeVersion: process.version, runtimeBun: null }) + '\\n'); setInterval(() => {}, 1000)",
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        )
        // The hook must hand back a piped child: assert the pipes are present and fail
        // before the bridge attaches any handler otherwise.
        if (!child.stdin || !child.stdout || !child.stderr) {
          try { child.kill() } catch {}
          throw new Error("injected bridge child is missing pipe streams")
        }
        injected = child
        return child
      },
    })
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown) => {
      uncaught.push(error)
    }
    process.on("uncaughtException", onUncaught)
    let proc!: RuntimeProc
    try {
      proc = await loaded.spawn("node", ["-e", "process.exit(0)"], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
      }) as RuntimeProc
      const injectedStdin = injected?.stdin
      if (!injectedStdin) throw new Error("injected bridge child is missing its stdin pipe")
      const pending = proc.writeAndWait!("pending-ack", 5000)
      injectedStdin.emit("error", new Error("EPIPE: injected parent stdin failure"))
      const write = await pending
      expect(write.ok).toBe(false)
      expect(write.timedOut).toBe(false)
      expect(write.message).toContain("injected parent stdin failure")
      expect(proc.bridgeFailure).toBe(true)
      expect(String(proc.bridgeError)).toContain("injected parent stdin failure")
      expect(uncaught).toHaveLength(0)
    } finally {
      process.off("uncaughtException", onUncaught)
      try { await (proc as RuntimeProc | undefined)?.close?.() } catch {}
      loaded.close()
    }
  }, 10000)

  test("reports the bridge stderr, exit code, and runtime when the bridge exits before spawn", async () => {
    // A genuine Node bridge child that reports its runtime, writes to stderr, and exits
    // before it reports a spawn. The thrown error has to carry every piece the child
    // produced, so a real early failure is never reported as an empty stderr.
    const loaded = await loadSpawn("node", {
      spawnBridgeChild: () => {
        const child = spawnProcess(
          "node",
          [
            "-e",
            "process.stdout.write(JSON.stringify({ type: 'runtime', runtimeVersion: process.version, runtimeBun: null }) + '\\n'); process.stderr.write('bridge-boom-before-spawn\\n'); process.exit(3)",
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        )
        if (!child.stdin || !child.stdout || !child.stderr) {
          try { child.kill() } catch {}
          throw new Error("injected bridge child is missing pipe streams")
        }
        return child
      },
    })
    try {
      let thrown: unknown
      try {
        await loaded.spawn("node", ["-e", "process.exit(0)"], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
        })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      const message = String((thrown as Error).message)
      expect(message).toContain("node PTY bridge exited before spawn")
      expect(message).toContain("exitCode=3")
      expect(message).toContain("signal=null")
      expect(message).toMatch(/runtime=v\d+\.\d+\.\d+/)
      expect(message).toContain("stderr=bridge-boom-before-spawn")
    } finally {
      loaded.close()
    }
  }, 10000)

  test("collects the stderr a bridge grandchild writes after the bridge exited", async () => {
    // The bridge child exits while a grandchild still holds the inherited stderr pipe
    // and writes to it afterwards. The stderr is only complete at the close event, so
    // the thrown error has to carry the late diagnostic.
    const loaded = await loadSpawn("node", {
      spawnBridgeChild: () => {
        const child = spawnProcess(
          "node",
          [
            "-e",
            "const { spawn } = require('node:child_process'); process.stdout.write(JSON.stringify({ type: 'runtime', runtimeVersion: process.version, runtimeBun: null }) + '\\n'); const late = spawn(process.execPath, ['-e', \"setTimeout(() => { process.stderr.write('late-stderr-after-bridge-exit\\\\n'); process.exit(0) }, 400)\"], { stdio: ['ignore', 'ignore', 'inherit'] }); late.unref(); process.exit(4)",
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        )
        if (!child.stdin || !child.stdout || !child.stderr) {
          try { child.kill() } catch {}
          throw new Error("injected bridge child is missing pipe streams")
        }
        return child
      },
    })
    try {
      let thrown: unknown
      try {
        await loaded.spawn("node", ["-e", "process.exit(0)"], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
        })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      const message = String((thrown as Error).message)
      expect(message).toContain("node PTY bridge exited before spawn")
      expect(message).toContain("exitCode=4")
      expect(message).toContain("late-stderr-after-bridge-exit")
    } finally {
      loaded.close()
    }
  }, 10000)

  test("never tree-kills the numeric pid of an exited bridge child", async () => {
    // The bridge child exits before it reports a spawn, so the startup failure path runs
    // after the exit was already observed. The numeric pid can be reused at that point,
    // so it must never reach the tree kill. The injected tree kill only records: it
    // deliberately performs no kill, because a stale pid must never be signalled.
    const killTreeCalls: number[] = []
    let injectedPid = 0
    const loaded = await loadSpawn("node", {
      killTree: async (pid) => {
        killTreeCalls.push(pid)
        return { killed: false, tree: false }
      },
      spawnBridgeChild: () => {
        const child = spawnProcess("node", ["-e", "process.exit(3)"], {
          stdio: ["pipe", "pipe", "pipe"],
        })
        if (!child.stdin || !child.stdout || !child.stderr) {
          try { child.kill() } catch {}
          throw new Error("injected bridge child is missing pipe streams")
        }
        if (child.pid !== undefined) injectedPid = child.pid
        return child
      },
    })
    try {
      let thrown: unknown
      try {
        await loaded.spawn("node", ["-e", "process.exit(0)"], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
        })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      expect(String((thrown as Error).message)).toContain("node PTY bridge exited before spawn")
      expect(killTreeCalls).toEqual([])
      expect(injectedPid).toBeGreaterThan(0)
    } finally {
      loaded.close()
    }
  }, 15000)

  test("never tree-kills the numeric pid of a bridge child that exited on a signal", async () => {
    // The bridge child terminates itself with SIGTERM, so the exit is observed through
    // `signalCode` with a null `exitCode`. That is the other guard arm: an observed
    // signal must keep the numeric pid out of the tree kill just like an observed exit
    // code does.
    const killTreeCalls: number[] = []
    let injectedPid = 0
    let observed: { exitCode: number | null; signalCode: NodeJS.Signals | null } | undefined
    const loaded = await loadSpawn("node", {
      killTree: async (pid) => {
        killTreeCalls.push(pid)
        return { killed: false, tree: false }
      },
      spawnBridgeChild: () => {
        const child = spawnProcess("node", ["-e", "process.kill(process.pid, 'SIGTERM')"], {
          stdio: ["pipe", "pipe", "pipe"],
        })
        if (!child.stdin || !child.stdout || !child.stderr) {
          try { child.kill() } catch {}
          throw new Error("injected bridge child is missing pipe streams")
        }
        child.on("exit", (code, signal) => {
          observed = { exitCode: code, signalCode: signal }
        })
        if (child.pid !== undefined) injectedPid = child.pid
        return child
      },
    })
    try {
      let thrown: unknown
      try {
        await loaded.spawn("node", ["-e", "process.exit(0)"], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
        })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      expect(String((thrown as Error).message)).toContain("node PTY bridge exited before spawn")
      expect(injectedPid).toBeGreaterThan(0)
      expect(observed).toBeDefined()
      // The child was observed as exited before the startup failure path ran.
      expect(observed?.exitCode !== null || observed?.signalCode !== null).toBe(true)
      if (process.platform !== "win32") {
        // POSIX reports the SIGTERM through `signalCode` with a null `exitCode`, which is
        // the guard arm this control covers. Windows reports a terminated process through
        // the exit code instead.
        expect(observed?.signalCode).toBe("SIGTERM")
        expect(observed?.exitCode).toBeNull()
      } else {
        expect(observed?.exitCode).toBeGreaterThan(0)
      }
      expect(killTreeCalls).toEqual([])
    } finally {
      loaded.close()
    }
  }, 15000)

  test("tree-kills a live bridge child when the spawn deadline is exceeded", async () => {
    // The bridge child stays live and never reports a spawn, so the existing 5s startup
    // deadline ends the wait and the startup failure path still owns a live child: the
    // tree kill must run against that live pid.
    const killTreeCalls: number[] = []
    let injectedPid = 0
    let injected: ChildProcess | undefined
    const loaded = await loadSpawn("node", {
      killTree: async (pid, remainingMs) => {
        killTreeCalls.push(pid)
        return killTreeAsync(pid, remainingMs)
      },
      spawnBridgeChild: () => {
        const child = spawnProcess("node", ["-e", "setInterval(() => {}, 1000)"], {
          stdio: ["pipe", "pipe", "pipe"],
        })
        if (!child.stdin || !child.stdout || !child.stderr) {
          try { child.kill() } catch {}
          throw new Error("injected bridge child is missing pipe streams")
        }
        injected = child
        if (child.pid !== undefined) injectedPid = child.pid
        return child
      },
    })
    try {
      let thrown: unknown
      try {
        await loaded.spawn("node", ["-e", "process.exit(0)"], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
        })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      expect(String((thrown as Error).message)).toContain("node PTY bridge did not spawn in time")
      expect(injectedPid).toBeGreaterThan(0)
      expect(killTreeCalls).toEqual([injectedPid])
    } finally {
      try { injected?.kill() } catch {}
      loaded.close()
    }
  }, 15000)

  test("caps the bridge diagnostic to the newest stderr tail and reports empty fields", () => {
    const stderr = "HEAD-" + "x".repeat(DIAGNOSTIC_CAPTURE_LIMIT) + "TAIL-MARKER"
    const capped = bridgeFailureDiagnostic({
      reason: "node PTY bridge exited before spawn",
      exitCode: null,
      signal: null,
      runtimeVersion: undefined,
      stderr,
    })
    expect(capped).toContain("TAIL-MARKER")
    expect(capped).not.toContain("HEAD-")
    expect(capped).toContain("exitCode=null")
    expect(capped).toContain("signal=null")
    expect(capped).toContain("runtime=unknown")
    expect(capped.length).toBeLessThanOrEqual(DIAGNOSTIC_CAPTURE_LIMIT + 256)

    const empty = bridgeFailureDiagnostic({
      reason: "node PTY bridge did not spawn in time",
      exitCode: null,
      signal: null,
      runtimeVersion: undefined,
      stderr: "",
    })
    expect(empty).toContain("stderr=<empty>")
    expect(empty).toContain("runtime=unknown")
    expect(empty).toContain("exitCode=null")
    expect(empty).toContain("signal=null")
  })

  test("runs the asynchronous EPIPE control entirely under Node", async () => {
    // The whole parent-write control runs in a Node child so the Bun parent pipe
    // semantics never decide the outcome. The control spawns a Node grandchild,
    // writes 16 MiB to its stdin and reports the asynchronous stream error as JSON.
    const dir = mkdtempSync(path.join(tmpdir(), "silvercode-epipe-control-"))
    const scriptPath = path.join(dir, "control.cjs")
    writeFileSync(scriptPath, EPIPE_CONTROL_SCRIPT, "utf8")
    const child = spawnProcess("node", [scriptPath], { stdio: ["pipe", "pipe", "pipe"] })
    try {
      const report = await readControlReport(child)
      // The bounded report is logged and carried by the assertion, so a control that
      // fails on a platform shows the actual outcome instead of a bare false.
      console.log(`[native-codepage-probe] epipe-control ${JSON.stringify(report)}`)
      expect(report).toEqual({
        epipe: true,
        code: expect.stringContaining("EPIPE"),
        message: expect.any(String),
      })
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => { child.once("close", () => resolve()) })
      }
    } finally {
      try { child.kill() } catch {}
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }, 10000)

  test("tracks startup write jobs with a four-job cap", async () => {
    const tracker = createStartupWriteTracker()
    const jobs = [1, 2, 3, 4, 5].map(() => new Promise<void>((resolve) => setTimeout(resolve, 10)))
    expect(tracker.tryAdd(jobs[0])).toBe(true)
    expect(tracker.tryAdd(jobs[1])).toBe(true)
    expect(tracker.tryAdd(jobs[2])).toBe(true)
    expect(tracker.tryAdd(jobs[3])).toBe(true)
    expect(tracker.tryAdd(jobs[4])).toBe(false)
    await Promise.all(tracker.snapshot())
    expect(tracker.size).toBe(0)
  })

  test("constructs a file URL for the Node bridge source import", () => {
    const url = pathToFileURL(path.resolve(here, "../../src/pty/pty.node.ts")).href
    expect(url.startsWith("file:")).toBe(true)
  })

  test("reports write failure instead of ok when bridge exits", async () => {
    const loaded = await loadSpawn("node")
    let proc!: RuntimeProc
    try {
      proc = await loaded.spawn("node", ["-e", "setInterval(() => {}, 1000)"], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
      }) as RuntimeProc
      try { process.kill(proc.bridgePid!) } catch {}
      // The ack failure is driven by the bridge exit, not by a short timeout race: the
      // budget stays inside the host test budget and the write must still fail without
      // timing out.
      const result = await proc.writeAndWait!("never-acked", 5000)
      expect(result.ok).toBe(false)
      expect(result.timedOut).toBe(false)
    } finally {
      try { await (proc as RuntimeProc | undefined)?.close?.() } catch {}
      loaded.close()
    }
  }, 10000)
})

describe("native codepage probe startup contract (host-side)", () => {
  test("normal transition disables parser only after the startup marker", () => {
    const first = processStartupChunk(initialStartupGate(), "\u001b[c")
    const second = processStartupChunk(first.state, "PROBE_STAGE helper-startup")
    expect(first.state.startupMarkerSeen).toBe(false)
    expect(first.state.parserDisabled).toBe(false)
    expect(first.responses).toHaveLength(1)
    expect(second.state.startupMarkerSeen).toBe(true)
    expect(second.state.parserDisabled).toBe(true)
    expect(second.responses).toHaveLength(0)
  })

  test("failure transition disables parser without a startup marker", () => {
    const processed = processStartupChunk(initialStartupGate(), "\u001b]0;" + "x".repeat(5000))
    expect(processed.state.startupMarkerSeen).toBe(false)
    expect(processed.state.startupQueryBufferOverflow).toBe(true)
    expect(processed.state.parserDisabled).toBe(true)
    expect(processed.responses).toHaveLength(0)
  })
})

})
