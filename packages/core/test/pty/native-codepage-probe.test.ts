// Test-only diagnostic for Windows ConPTY codepage behavior.
// Runs in normal CI on Windows and is skipped on non-Windows.
// It intentionally does not apply any output decoder: every chunk is recorded as the backend delivered it.
// Diagnostic measurement only; not a product fix.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const helper = path.join(here, "native-codepage-probe-helper.ps1")
const fileName = "ação-日本.txt"
const fileText = "ação-日本 ok"
const CASE_GUARD_MS = 20_000
const TEST_BUDGET_MS = 30_000
const MAX_CAPTURE = 256 * 1024

const backends = ["node", "bun"] as const
const modes = ["baseline", "chcp", "setconsole"] as const

type Backend = (typeof backends)[number]
type Mode = (typeof modes)[number]
type CpStage = { stage: string; input: number; output: number }
type SetOutputCp = { requested: number; success: boolean; lastError: number }
type Proc = {
  pid: number
  onData: (listener: (chunk: string) => void) => { dispose: () => void }
  onExit: (listener: (event: { exitCode: number }) => void) => { dispose: () => void }
  kill: () => void
}
type Spawn = (file: string, args: string[], opts: Record<string, unknown>) => Proc

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

async function loadSpawn(backend: Backend): Promise<Spawn> {
  if (backend === "node") {
    const mod = await import("../../src/pty/pty.node.ts")
    return mod.spawn as Spawn
  }
    const mod = await import("../../src/pty/pty.bun.ts")
  return mod.spawn as Spawn
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
  try {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/t", "/f"], {
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

async function runCase(backend: Backend, mode: Mode) {
  const spawn = await loadSpawn(backend)
  const workDir = mkdtempSync(path.join(tmpdir(), `silvercode-native-codepage-${backend}-${mode}-`))
  const resultsDir = mkdtempSync(path.join(tmpdir(), `silvercode-native-codepage-results-${backend}-${mode}-`))
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
  let captured = 0
  let truncated = false
  let exited = false
  let cleanedUp = false
  let proc: Proc | undefined
  let dataSub: { dispose: () => void } | undefined
  let exitSub: { dispose: () => void } | undefined
  const startedAt = new Date().toISOString()
  const started = Date.now()

  const cleanupProc = () => {
    if (cleanedUp) return
    cleanedUp = true
    if (proc && !exited) killTree(proc)
    try {
      proc?.kill()
    } catch {}
  }

  try {
    proc = spawn(powershellPath(), args, {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd: workDir,
      env: childEnv(),
    })
    dataSub = proc.onData((chunk) => {
      if (captured >= MAX_CAPTURE) {
        truncated = true
        return
      }
      const remaining = MAX_CAPTURE - captured
      const kept = chunk.length > remaining ? chunk.slice(0, remaining) : chunk
      chunks.push(kept)
      captured += kept.length
      if (kept.length < chunk.length) truncated = true
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const exitPromise = new Promise<{ timedOut: boolean; exitCode?: number }>((resolve, reject) => {
      timer = setTimeout(() => resolve({ timedOut: true }), CASE_GUARD_MS)
      try {
        exitSub = proc!.onExit((event) => {
          exited = true
          if (timer) clearTimeout(timer)
          setTimeout(() => resolve({ timedOut: false, exitCode: event.exitCode }), 100)
        })
      } catch (error) {
        if (timer) clearTimeout(timer)
        reject(error)
      }
    })
    let exit: { timedOut: boolean; exitCode?: number }
    try {
      exit = await exitPromise
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (exit.timedOut) cleanupProc()
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
      startedAt,
      durationMs: Date.now() - started,
      timedOut: exit.timedOut,
      exitCode: exit.exitCode ?? null,
      truncated,
      chunks,
      chunkLengths: chunks.map((chunk) => chunk.length),
      output,
      cpStages,
      setOutputCp: setOutputCp ?? null,
      chcpExit: chcpExit ?? null,
      cmdExits: parseCmdExits(output),
      observations: observations(output),
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
    dataSub?.dispose()
    exitSub?.dispose()
    cleanupProc()
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {}
    try {
      rmSync(resultsDir, { recursive: true, force: true })
    } catch {}
  }
}

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
