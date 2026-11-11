// Test-only diagnostic for Windows ConPTY codepage behavior.
// Runs in normal CI on Windows and is skipped on non-Windows.
// It intentionally does not apply any output decoder: every chunk is recorded as the backend delivered it.
// Diagnostic measurement only; not a product fix.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { spawn as spawnProcess } from "node:child_process"
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
const STARTUP_RESPONSE_LIMIT = 4

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
type RuntimeProc = Proc & { bridgePid?: number; runtimeVersion?: string; runtimeBun?: string | null; bridgeOverflow?: boolean; stderr?: string; writeAndWait?: (data: string, timeoutMs: number) => Promise<{ ok: boolean; message: string; timedOut: boolean }>; close?: () => void }

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

async function loadSpawn(backend: Backend): Promise<LoadedSpawn> {
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
      const script = `import { spawn as spawnPty } from ${JSON.stringify(sourceUrl)}

const proc = spawnPty(${JSON.stringify(file)}, ${JSON.stringify(args)}, ${JSON.stringify(opts)})
let stdinBuffer = ""

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  if (stdinBuffer.length + chunk.length > 262144) {
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
      process.exit(0)
    }
  }
})

proc.onData((data) => {
  process.stdout.write(JSON.stringify({ type: "data", data }) + "\\n")
})
proc.onExit((event) => {
  process.stdout.write(JSON.stringify({ type: "exit", exitCode: event.exitCode ?? 0 }) + "\\n")
})
process.stdout.write(JSON.stringify({ type: "spawned", pid: proc.pid, runtimeVersion: process.version, runtimeBun: process.versions.bun ?? null }) + "\\n")
`
      writeFileSync(scriptPath, script)

      let child
      try {
        child = spawnProcess("node", ["--experimental-strip-types", scriptPath], {
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
      spawnedTimer = setTimeout(() => {
        if (!spawnedSettled) {
          spawnedSettled = true
          spawnedReject?.(new Error("node PTY bridge did not spawn in time"))
        }
      }, 5_000)
      let stdoutBuffer = ""
      let stderrBuffer = ""
      let bridgeOverflow = false
      let earlyDataOverflow = false
      let earlyExitOverflow = false
      let ptyExited = false
      let bridgeExited = false

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

      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
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
          if (message.type === "spawned") {
            settleSpawned({ pid: message.pid, runtimeVersion: message.runtimeVersion, runtimeBun: message.runtimeBun })
          } else if (message.type === "data") {
            if (dataListeners.size > 0) {
              for (const listener of dataListeners) listener(message.data)
            } else {
              if (queuedDataChars + String(message.data).length > MAX_CAPTURE) {
                earlyDataOverflow = true
              } else {
                queuedData.push(message.data)
                queuedDataChars += String(message.data).length
              }
            }
          } else if (message.type === "exit") {
            ptyExited = true
            const event = { exitCode: message.exitCode }
            if (exitListeners.size > 0) {
              for (const listener of exitListeners) listener(event)
            } else {
              if (queuedExit.length >= 16) earlyExitOverflow = true
              else queuedExit.push(event)
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

      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk: string) => {
        if (stderrBuffer.length + chunk.length > MAX_CAPTURE) {
          stderrBuffer = stderrBuffer.slice(-(MAX_CAPTURE - chunk.length)) + chunk
        } else {
          stderrBuffer += chunk
        }
      })

      child.on("error", (error) => {
        rejectSpawned(error)
        for (const resolveWrite of pendingWrites.values()) resolveWrite({ ok: false, message: String(error), timedOut: false })
        pendingWrites.clear()
      })
      child.on("exit", (code) => {
        bridgeExited = true
        if (!spawnedSettled) {
          rejectSpawned(new Error(`node PTY bridge exited before spawn with code ${code}`))
        }
        if (!ptyExited) {
          ptyExited = true
          const event = { exitCode: code ?? 0 }
          if (exitListeners.size > 0) {
            for (const listener of exitListeners) listener(event)
          } else {
            if (queuedExit.length < 16) queuedExit.push(event)
            else earlyExitOverflow = true
          }
        }
        for (const resolveWrite of pendingWrites.values()) resolveWrite({ ok: false, message: "bridge exited", timedOut: false })
        pendingWrites.clear()
      })

      let spawned
      try {
        spawned = await spawnedPromise
      } catch (error) {
        try { killTree({ pid: child.pid, kill() { child.kill() }, onData() { return { dispose() {} } }, onExit() { return { dispose() {} } }, write() {}, resize() {} } as unknown as Proc) } catch {}
        try { child.kill() } catch {}
        try { rmSync(scriptPath, { force: true }) } catch {}
        throw error
      }

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
          try { child.stdin.write(JSON.stringify({ type: "write", requestId: 0, data }) + "\n") } catch {}
        },
        writeAndWait(data, timeoutMs) {
          return new Promise((resolve) => {
            if (pendingWrites.size >= 4) {
              resolve({ ok: false, message: "too many pending writes", timedOut: false })
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
              child.stdin.write(JSON.stringify({ type: "write", requestId, data }) + "\n")
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
          try { child.stdin.write(JSON.stringify({ type: "kill", signal }) + "\n") } catch {}
        },
        close() {
          try { child.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n") } catch {}
          try { child.kill() } catch {}
          try { rmSync(scriptPath, { force: true }) } catch {}
        },
      }

      // reflect overflow flags lazily
      Object.defineProperty(proc, "bridgeOverflow", { get() { return bridgeOverflow || earlyDataOverflow || earlyExitOverflow } })

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

function killTree(proc: Proc) {
  const bridgePid = (proc as RuntimeProc).bridgePid
  const pid = typeof bridgePid === "number" && bridgePid > 0 ? bridgePid : proc.pid
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    try {
      proc.kill()
    } catch {}
    return
  }
  try {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 5_000,
    })
  } catch {}
  try {
    proc.kill()
  } catch {}
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
  let dataSub: { dispose: () => void } | undefined
  let exitSub: { dispose: () => void } | undefined
  let workDir: string | undefined
  let resultsDir: string | undefined
  const cleanupProc = () => {
    if (cleanedUp) return
    cleanedUp = true
    if (proc && !exited) killTree(proc)
    try {
      proc?.kill()
    } catch {}
    try {
      void proc?.close?.()
    } catch {}
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
    const startupWriteJobs = new Set<Promise<void>>()
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
        try { killTree(lateProc) } catch {}
        try { lateProc.kill() } catch {}
        try { (lateProc as RuntimeProc).close?.() } catch {}
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
        if (startupWriteJobs.size >= 4) {
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
            } finally {
              startupWriteJobs.delete(jobPromise)
            }
          })()
          startupWriteJobs.add(jobPromise)
        }
      }
    })
    const exitPromise = new Promise<{ timedOut: boolean; exitCode?: number }>((resolve, reject) => {
      try {
        exitSub = proc!.onExit((event) => {
          exited = true
          setTimeout(() => resolve({ timedOut: false, exitCode: event.exitCode }), 100)
        })
      } catch (error) {
        reject(error)
      }
    })
    const finalExit = await Promise.race([exitPromise, guardPromise])
    // await inflight startup writes briefly
    await Promise.race([
      Promise.all([...startupWriteJobs]).catch(() => {}),
      guardPromise,
    ])
    if (finalExit.timedOut) cleanupProc()
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
    dataSub?.dispose()
    exitSub?.dispose()
    cleanupProc()
    try {
      await proc?.close?.()
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
    const jobs = new Set<Promise<void>>()
    let done = false
    const job = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      done = true
    })()
    jobs.add(job)
    await Promise.race([
      Promise.all([...jobs]).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ])
    expect(done).toBe(true)
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
      const result = await proc.writeAndWait!("never-acked", 50)
      expect(result.ok).toBe(false)
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
