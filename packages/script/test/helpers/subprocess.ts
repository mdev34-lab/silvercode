import { readdir, rm } from "node:fs/promises"
import path from "node:path"

/**
 * Subprocess diagnostics for the script test suite (issue #286).
 *
 * A Windows CI run cascaded 23 release-fixture failures. The first was a
 * `git clone` that returned exit 128 at release-flow.test.ts:214 behind an
 * assertion that never printed the clone's stderr; later fixtures failed
 * `git init --quiet --bare` with *empty* captured stderr. Neither log line
 * recorded enough to tell a genuine Git error apart from the ways a Windows
 * child can die without writing anything:
 *
 *   - a signal kill, where Bun reports `exitCode: null` and a `signalCode`;
 *   - a host process-startup fault, reported as a negative NTSTATUS exit code
 *     (for example -1073741502 == 0xC0000142 STATUS_DLL_INIT_FAILED, seen in
 *     the same failing job's annotation), where the child never runs. Other
 *     NTSTATUS codes (access violation, heap corruption) are runtime faults that
 *     happen after the program started and may still have written output;
 *   - a spawn error (ENOENT/EACCES), where `Bun.spawn*` throws and there is no
 *     subprocess at all.
 *
 * Every helper here captures the exact exit code, signal, spawn error, pid and
 * stdout/stderr for one subprocess and renders all of it on failure, so a
 * recurrence names its own cause instead of showing a bare `128` or a blank
 * `... failed:`. The `signature:` line is stable across failures so a cascade
 * can be correlated at a glance. Identical signatures only group failures of the
 * same class (exit code, signal, spawn error, output emptiness); they point to a
 * common failure class worth investigating and do not prove a shared root cause.
 *
 * These helpers never retry, never relax an assertion and never change a
 * timeout. A non-zero exit, a signal or a spawn error still fails the test; the
 * only difference is that the failure now carries evidence.
 */

/** Why an executable could not be spawned at all (the child never ran). */
export type SpawnError = { message: string; code?: string }

/** One subprocess result, normalized across the sync, async and spawn-error paths. */
export type SubprocessRecord = {
  cmd: string[]
  cwd?: string
  /**
   * Exit status. `null` means the child reported none — on the sync path this
   * happens when a signal terminated it.
   */
  exitCode: number | null
  /** Terminating signal name, when the child was killed by one. */
  signalCode: string | null
  /** Set when the executable could not be spawned (ENOENT/EACCES); there was no child. */
  spawnError: SpawnError | null
  stdout: string
  stderr: string
  /** Child pid, or `null` when no process was created. */
  pid: number | null
  exitedDueToTimeout: boolean
  exitedDueToMaxBuffer: boolean
  /** True only for a clean success: spawned, not signalled, exit code 0. */
  ok: boolean
}

/** Windows NTSTATUS exit codes (negative as signed ints) with a name for the log. */
const NTSTATUS: Record<number, string> = {
  0xc0000005: "STATUS_ACCESS_VIOLATION",
  0xc0000008: "STATUS_INVALID_HANDLE",
  0xc0000017: "STATUS_NO_MEMORY",
  0xc0000135: "STATUS_DLL_NOT_FOUND",
  0xc0000139: "STATUS_ENTRYPOINT_NOT_FOUND",
  0xc000013a: "STATUS_CONTROL_C_EXIT",
  0xc0000142: "STATUS_DLL_INIT_FAILED",
  0xc0000145: "STATUS_DLL_INIT_FAILED_LOGOFF",
  0xc0000374: "STATUS_HEAP_CORRUPTION",
  0xc0000409: "STATUS_STACK_BUFFER_OVERRUN",
}

/**
 * NTSTATUS codes where the OS failed the child before it executed the program,
 * so empty stderr is expected. Runtime faults (access violation, heap
 * corruption, stack overrun) and a console Ctrl+C exit happen after the program
 * started and are deliberately excluded.
 */
const STARTUP_FAULTS = new Set([0xc0000135, 0xc0000139, 0xc0000142, 0xc0000145])

/** Runs a command synchronously and records every diagnostic field. */
export function runSync(cmd: string[], opts: { cwd?: string } = {}): SubprocessRecord {
  const started = {
    cmd,
    cwd: opts.cwd,
    stdout: "",
    stderr: "",
    pid: null,
    exitedDueToTimeout: false,
    exitedDueToMaxBuffer: false,
  }
  let proc
  try {
    proc = Bun.spawnSync(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" })
  } catch (error) {
    // Bun.spawnSync throws instead of returning when the executable cannot be
    // spawned (ENOENT/EACCES). That is a distinct failure mode from a non-zero
    // exit and is recorded as a spawn error so the empty stderr is explained.
    return finish({ ...started, exitCode: null, signalCode: null, spawnError: spawnErrorOf(error) })
  }
  return finish({
    ...started,
    // Declared `number`, but the runtime value is `null` when a signal killed the child.
    exitCode: (proc.exitCode as number | null) ?? null,
    signalCode: proc.signalCode ?? null,
    spawnError: null,
    stdout: textOf(proc.stdout),
    stderr: textOf(proc.stderr),
    pid: proc.pid ?? null,
    exitedDueToTimeout: proc.exitedDueToTimeout ?? false,
    exitedDueToMaxBuffer: proc.exitedDueToMaxBuffer ?? false,
  })
}

/**
 * Runs a command asynchronously and records every diagnostic field.
 *
 * `exitCode` is the awaited `exited` status, exactly the value the fixtures
 * asserted on before. Verified on Bun 1.3.14: a terminating signal resolves
 * `exited` to 128+signo (SIGTERM gives 143) and the signal name is also reported
 * in `signalCode`. The async `Subprocess` has no `exitedDueToTimeout` or
 * `exitedDueToMaxBuffer` fields (only `spawnSync` results do), so both stay
 * `false` here.
 */
export async function runAsync(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<SubprocessRecord> {
  const started = {
    cmd,
    cwd: opts.cwd,
    stdout: "",
    stderr: "",
    pid: null,
    exitedDueToTimeout: false,
    exitedDueToMaxBuffer: false,
  }
  let proc
  try {
    proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdout: "pipe", stderr: "pipe" })
  } catch (error) {
    return finish({ ...started, exitCode: null, signalCode: null, spawnError: spawnErrorOf(error) })
  }
  const [stdout, stderr, exited] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return finish({
    ...started,
    exitCode: exited,
    signalCode: proc.signalCode ?? null,
    spawnError: null,
    stdout,
    stderr,
    pid: proc.pid ?? null,
  })
}

/** Runs `git` and returns trimmed stdout, throwing full diagnostics on any non-clean result. */
export function git(cwd: string, ...args: string[]): string {
  const record = runSync(["git", ...args], { cwd })
  expectSubprocessOk(record, `git ${args.join(" ")} failed`)
  return record.stdout.trim()
}

/**
 * Asserts a subprocess exited cleanly and, when it did not, fails with the
 * complete diagnostic. The pass/fail condition is unchanged from a bare
 * `expect(exitCode).toBe(0)` — a clean exit 0 — it just carries evidence.
 */
export function expectSubprocessOk(record: SubprocessRecord, context?: string): void {
  if (record.ok) return
  throw new Error(`${context ? `${context}\n` : ""}subprocess did not exit cleanly\n${describeSubprocess(record)}`)
}

/**
 * Removes a fixture directory, proving the cause if removal fails.
 *
 * On Windows an open handle to a git object or pack file makes `rm` fail with
 * EBUSY/EPERM and leaves the tree behind; trees that accumulate across fixtures
 * are a plausible shared cause for later spawn faults. This records the exact
 * fs error and what is still on disk rather than guessing. It never rethrows:
 * cleanup runs in a `finally`, and throwing here would mask the assertion that
 * actually failed in the test body. Instead the failure is recorded and
 * surfaced by `assertNoCleanupFailures()`, which test files call from an
 * `afterEach` hook so a leaked fixture fails the test without hiding the body's
 * own error.
 */
export async function removeFixture(dir: string, remove: typeof rm = rm): Promise<void> {
  try {
    await remove(dir, { recursive: true, force: true })
  } catch (error) {
    const remaining = await inspectRemaining(dir)
    const message = `[fixture-cleanup] failed to remove ${dir}\n${describeError(error)}\nremaining entries:\n${remaining}`
    console.error(message)
    cleanupFailures.push(message)
  }
}

const cleanupFailures: string[] = []

/** Throws (and clears) any fixture cleanup failures recorded since the last call. */
export function assertNoCleanupFailures(): void {
  if (cleanupFailures.length === 0) return
  const message = cleanupFailures.join("\n\n")
  cleanupFailures.length = 0
  throw new Error(`fixture cleanup failed; a leaked fixture can cascade into later tests\n${message}`)
}

/** Renders one subprocess record as a complete, greppable diagnostic block. */
export function describeSubprocess(record: SubprocessRecord): string {
  const lines = [
    `command: ${record.cmd.join(" ")}`,
    `cwd: ${record.cwd ?? "<inherited>"}`,
    `exit code: ${formatExitCode(record.exitCode)}`,
    `signal: ${record.signalCode ?? "<none>"}`,
    `spawn error: ${record.spawnError ? `${record.spawnError.code ? `${record.spawnError.code} ` : ""}${record.spawnError.message}` : "<none>"}`,
    `pid: ${record.pid ?? "<none; no process was created>"}`,
  ]
  if (record.exitedDueToTimeout) lines.push("note: exited due to timeout")
  if (record.exitedDueToMaxBuffer) lines.push("note: exited due to max buffer (output truncated)")
  lines.push(`signature: ${signature(record)}`)
  lines.push(`diagnosis: ${classify(record)}`)
  lines.push("--- stdout ---", record.stdout === "" ? "<empty>" : cap(record.stdout))
  lines.push("--- stderr ---", record.stderr === "" ? "<empty>" : cap(record.stderr))
  return lines.join("\n")
}

function finish(fields: Omit<SubprocessRecord, "ok">): SubprocessRecord {
  return { ...fields, ok: fields.spawnError === null && fields.signalCode === null && fields.exitCode === 0 }
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString()
  return String(value)
}

function spawnErrorOf(error: unknown): SpawnError {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code ? { message: error.message, code } : { message: error.message }
  }
  return { message: String(error) }
}

function formatExitCode(exitCode: number | null): string {
  if (exitCode === null) return "null (no exit status; the child was terminated by a signal or never reported one)"
  const unsigned = exitCode >>> 0
  const hex = `0x${unsigned.toString(16).padStart(8, "0")}`
  const name = NTSTATUS[unsigned]
  if (name !== undefined) return `${exitCode} (${hex} ${name})`
  if (unsigned >= 0xc0000000)
    return `${exitCode} (${hex}, a Windows NTSTATUS failure code; the child failed at the OS level)`
  return `${exitCode}`
}

/** A stable one-line fingerprint so repeated failures can be correlated across a cascade. */
function signature(record: SubprocessRecord): string {
  const exit = record.exitCode === null ? "null" : String(record.exitCode >>> 0)
  const spawn = record.spawnError ? (record.spawnError.code ?? "error") : "none"
  return [
    `exit=${exit}`,
    `signal=${record.signalCode ?? "none"}`,
    `spawn=${spawn}`,
    `pid=${record.pid === null ? "none" : "yes"}`,
    `stdoutEmpty=${record.stdout.length === 0}`,
    `stderrEmpty=${record.stderr.length === 0}`,
  ].join(" ")
}

/**
 * Names the cause class of a failure so the log states it instead of leaving it
 * to be guessed. The order matters: a spawn error and a host-level NTSTATUS or
 * signal fault all produce empty stderr because the program never ran, and must
 * not be mistaken for a Git error (which writes `fatal:` to stderr).
 */
function classify(record: SubprocessRecord): string {
  if (record.spawnError !== null) {
    return `the executable could not be spawned (${record.spawnError.code ?? "error"}); the child never ran, so empty output is expected. This is a PATH/permissions/host fault, not a git error.`
  }
  const unsigned = record.exitCode === null ? null : record.exitCode >>> 0
  if (unsigned !== null && STARTUP_FAULTS.has(unsigned)) {
    return `the child failed at the Windows OS level (${formatExitCode(record.exitCode)}) and never executed the program; empty stderr is expected. This is a host/runner process-startup fault, not a git error.`
  }
  if (unsigned === 0xc000013a) {
    return `the child exited with STATUS_CONTROL_C_EXIT (${formatExitCode(record.exitCode)}); the program was running and was interrupted (console Ctrl+C), which is not a process-startup fault.`
  }
  if (unsigned !== null && unsigned >= 0xc0000000) {
    return `the child exited with a Windows NTSTATUS failure code (${formatExitCode(record.exitCode)}); this is a fault in or around the running program (it may have started), so stderr may be incomplete. Not necessarily a startup fault.`
  }
  if (record.signalCode !== null) {
    return `the child was killed by ${record.signalCode} before it reported an exit status; a killed process may write nothing, so empty stderr is expected and is not a git error.`
  }
  if (record.exitCode !== 0 && record.stderr.trim() === "" && record.stdout.trim() === "") {
    return `the child exited ${record.exitCode} but wrote nothing to stdout or stderr; git prints "fatal:" to stderr on a real error, so a silent non-zero exit is inconclusive: it may be a host/process fault, but a git-level failure cannot be ruled out.`
  }
  if (record.exitCode !== 0) {
    return `the child exited ${record.exitCode} and reported on stderr; this is a program-level failure (git prints the reason in the stderr block above).`
  }
  return "clean exit."
}

function cap(text: string): string {
  if (text.length <= 4000) return text
  return `${text.slice(0, 4000)}\n... [truncated ${text.length - 4000} more chars]`
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const err = error as NodeJS.ErrnoException
    const parts = [`message: ${err.message}`]
    if (err.code) parts.push(`code: ${err.code}`)
    if (err.syscall) parts.push(`syscall: ${err.syscall}`)
    if (err.path) parts.push(`path: ${err.path}`)
    if (err.errno !== undefined) parts.push(`errno: ${err.errno}`)
    return parts.join("\n")
  }
  return `message: ${String(error)}`
}

/** Best-effort listing of what survived a failed `rm`, flagging git lock/temp files. */
async function inspectRemaining(dir: string): Promise<string> {
  const limit = 200
  const found: string[] = []
  const locks: string[] = []
  const walk = async (current: string, depth: number): Promise<void> => {
    if (found.length >= limit || depth > 6) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      // An unreadable subtree is itself evidence of the fault; skip it.
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      const full = path.join(current, entry.name)
      const rel = path.relative(dir, full)
      found.push(entry.isDirectory() ? `${rel}/` : rel)
      if (/\.lock$|\.tmp$/.test(entry.name)) locks.push(rel)
      if (entry.isDirectory()) await walk(full, depth + 1)
    }
  }
  await walk(dir, 0)
  const head = found.length === 0 ? "(directory is gone; rm threw after removing everything)" : found.join("\n")
  const more = found.length >= limit ? `\n... (listing capped at ${limit} entries)` : ""
  const lockNote =
    locks.length > 0
      ? `\ngit lock/temp files present (an interrupted or still-open git operation): ${locks.join(", ")}`
      : ""
  return `${head}${more}${lockNote}`
}
