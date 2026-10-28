import { afterAll, expect, test } from "bun:test"
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { unguardedCmdCommand, windowsCmdCommand } from "./fixture/cmd-option-candidate"

// Diagnostic only: compare identical user lines through Node's `shell: cmd` option. The candidate is
// test-only, not enabled in either tool. No equality is assumed: every result reports raw stdout/stderr
// bytes and exit status. A spawn error, signal, or timeout fails rather than being reported as a result.
const winOnly = process.platform === "win32" ? test : test.skip
const CHILD_TIMEOUT_MS = 10_000

const environment = (changes: Record<string, string | undefined>) => {
  const keys = new Set(Object.keys(changes).map((key) => key.toLowerCase()))
  return Object.fromEntries([
    ...Object.entries(process.env).filter(([key]) => !keys.has(key.toLowerCase())),
    ...Object.entries(changes).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ])
}

const describeOutput = (out: SpawnSyncReturns<Buffer>) => ({
  status: out.status,
  signal: out.signal,
  error: out.error?.message ?? null,
  stdoutHex: (out.stdout ?? Buffer.alloc(0)).toString("hex"),
  stdoutUtf8: (out.stdout ?? Buffer.alloc(0)).toString("utf8"),
  stderrHex: (out.stderr ?? Buffer.alloc(0)).toString("hex"),
  stderrUtf8: (out.stderr ?? Buffer.alloc(0)).toString("utf8"),
})

type Output = ReturnType<typeof describeOutput>
const notices: string[] = []
const flushNotices = () => {
  if (notices.length === 0) return
  // Turbo prefixes log lines, so use the runner's prefix-tolerant annotation form. Batch two cases
  // per notice because the runner records at most ten notices per step. Full JSON stays in the log.
  console.log(`##[notice]cmd qualification: ${notices.join(" | ")}`)
  notices.length = 0
}
afterAll(flushNotices)

const report = (name: string, result: Record<string, unknown> & { baseline: Output; candidate: Output }) => {
  const text = JSON.stringify({ case: name, ...result }, null, 2)
  console.log(`cmd-qualification ${text}`)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### cmd qualification: ${name}\n\n\`\`\`json\n${text}\n\`\`\`\n\n`)
  if (process.env.CI) {
    const compact = ({ status, signal, error, stdoutHex, stderrHex }: Output) => ({
      status,
      signal,
      error,
      stdoutHex,
      stderrHex,
    })
    notices.push(
      JSON.stringify({
        case: name,
        shell: result.shell,
        environmentChanges: result.environmentChanges,
        baseline: compact(result.baseline),
        candidate: compact(result.candidate),
      }),
    )
    if (notices.length === 2) flushNotices()
  }
}

const fixture = () => {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir
  expect(root).toBeDefined()
  expect(root).toMatch(/^[A-Za-z]:\\[^\s"%&^|<>!()]*$/)
  expect(existsSync(`${root}\\System32\\chcp.com`)).toBe(true)
  const shell = process.env.COMSPEC || `${root}\\System32\\cmd.exe`
  expect(existsSync(shell)).toBe(true)
  const dir = mkdtempSync(path.join(tmpdir(), "cmd-qualification-"))
  writeFileSync(path.join(dir, "ação-日本.txt"), "")
  return { root: root!, shell, dir }
}

const compare = (
  name: string,
  line: string,
  options: {
    env?: Record<string, string | undefined>
    setup?: (shell: string) => string
    candidate?: (line: string, root: string) => string
    alternateCmd?: boolean
  } = {},
) => {
  const { root, shell, dir } = fixture()
  try {
    const wow = `${root}\\SysWOW64\\cmd.exe`
    const alternate =
      path.win32.normalize(shell).toLowerCase() === path.win32.normalize(wow).toLowerCase()
        ? `${root}\\System32\\cmd.exe`
        : wow
    if (options.alternateCmd) {
      expect(existsSync(alternate)).toBe(true)
      expect(path.win32.normalize(alternate).toLowerCase()).not.toBe(path.win32.normalize(shell).toLowerCase())
    }
    const changes = { ...options.env, ...(options.alternateCmd ? { COMSPEC: alternate } : {}) }
    const env = environment(changes)
    const setup = options.setup?.(shell) ?? ""
    const nestedLine = (options.candidate ?? unguardedCmdCommand)(line, root)
    const spawnOptions = {
      cwd: dir,
      shell,
      env,
      windowsHide: true,
      timeout: CHILD_TIMEOUT_MS,
      killSignal: "SIGKILL" as const,
    }
    // This is the same spawnSync(line, { shell: cmd }) route as #678, with identical options on each side.
    const baseline = spawnSync(setup + line, spawnOptions)
    const nested = spawnSync(setup + nestedLine, spawnOptions)
    const base = describeOutput(baseline)
    const wrapped = describeOutput(nested)
    report(name, {
      shell,
      environmentChanges: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value ?? null])),
      setup,
      userLine: line,
      candidateLine: nestedLine,
      guardedCandidateWouldWrap: windowsCmdCommand(shell, line, "win32", env) !== line,
      baseline: base,
      candidate: wrapped,
      comparison: {
        stdoutBytesEqual: base.stdoutHex === wrapped.stdoutHex,
        stderrBytesEqual: base.stderrHex === wrapped.stderrHex,
        statusEqual: base.status === wrapped.status,
      },
    })
    for (const out of [baseline, nested]) {
      expect(out.error).toBeUndefined()
      expect(out.signal).toBeNull()
      expect(out.status).not.toBeNull()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

winOnly("qualification: the reported quoted ampersand line", () =>
  compare("quoted ampersand and conditional", 'echo "a & b" && echo DONE'),
)

winOnly("qualification: cmd dir bytes and exit", () => compare("dir filename and exit", "dir /b *.txt & exit /b 7"))

winOnly("qualification: percent expansion containing another variable", () =>
  compare("nested percent expansion", "echo %CP_PROBE_VAR%", {
    env: { CP_PROBE_VAR: "%CP_PROBE_OTHER%", CP_PROBE_OTHER: "SECOND_PASS" },
  }),
)

winOnly("qualification: interactive FOR variable", () => compare("FOR variable", "for %G in (one two) do @echo [%G]"))

winOnly("qualification: CALL plus nested variables", () =>
  compare("CALL reparse", "call echo %CP_PROBE_VAR%", {
    env: { CP_PROBE_VAR: "%CP_PROBE_MID%", CP_PROBE_MID: "%CP_PROBE_FINAL%", CP_PROBE_FINAL: "FINAL_VALUE" },
  }),
)

winOnly("qualification: delayed expansion explicitly enabled in the user line", () =>
  compare("delayed expansion", "setlocal EnableDelayedExpansion & echo !CP_PROBE_VAR!", {
    env: { CP_PROBE_VAR: "LEFT!CP_PROBE_OTHER!RIGHT", CP_PROBE_OTHER: "MIDDLE" },
  }),
)

winOnly("qualification: COMSPEC points to a different cmd", () =>
  compare("COMSPEC alternate cmd", "echo alternate & exit /b 7", { alternateCmd: true }),
)

winOnly("qualification: COMSPEC points to a different executable", () => {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir
  const other = `${root}\\System32\\where.exe`
  expect(existsSync(other)).toBe(true)
  compare("COMSPEC non-cmd", "echo alternate & exit /b 7", { env: { COMSPEC: other } })
})

winOnly("qualification: COMSPEC omitted from the child environment", () =>
  compare("COMSPEC absent", "if defined COMSPEC (echo COMSPEC=present) else (echo COMSPEC=absent) & exit /b 7", {
    env: { COMSPEC: undefined },
  }),
)

const setErrorlevel = (shell: string) => `"${shell}" /d /c exit /b 3 & `
const readErrorlevel = "if errorlevel 1 (echo LEVEL=HIGH) else (echo LEVEL=ZERO)"

winOnly("qualification: pre-existing ERRORLEVEL versus same-cmd chcp", () =>
  compare("ERRORLEVEL same cmd", readErrorlevel, {
    setup: setErrorlevel,
    candidate: (line, root) => `${root}\\System32\\chcp.com 65001>nul & ${line}`,
  }),
)

winOnly("qualification: pre-existing ERRORLEVEL versus nested cmd", () =>
  compare("ERRORLEVEL nested cmd", readErrorlevel, { setup: setErrorlevel }),
)
