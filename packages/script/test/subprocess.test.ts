import { mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import {
  assertNoCleanupFailures,
  describeSubprocess,
  expectSubprocessOk,
  git,
  removeFixture,
  runAsync,
  runSync,
  type SubprocessRecord,
} from "./helpers/subprocess"

/**
 * The diagnostic recorder must classify every way a subprocess can fail on a
 * contended Windows runner (#286): a genuine git error, a spawn error, a signal
 * kill and a host process-startup fault all look different, and three of them
 * produce empty stderr. The platform-specific classes are exercised with
 * synthetic records so the assertions are deterministic on Linux and Windows
 * alike; the portable classes use real `git` spawns.
 */

/** Builds a record with sane defaults so each case overrides only what it proves. */
const record = (over: Partial<SubprocessRecord> = {}): SubprocessRecord => ({
  cmd: ["git", "init", "--quiet", "--bare"],
  cwd: undefined,
  exitCode: 0,
  signalCode: null,
  spawnError: null,
  stdout: "",
  stderr: "",
  pid: 4242,
  exitedDueToTimeout: false,
  exitedDueToMaxBuffer: false,
  ok: true,
  ...over,
})

const signatureOf = (r: SubprocessRecord) =>
  describeSubprocess(r)
    .split("\n")
    .find((line) => line.startsWith("signature:")) ?? ""

describe("subprocess diagnostics", () => {
  // Real-spawn tests get an explicit 15s: a contended Windows runner logged
  // 10.2s for a single `git` spawn (#537), well past the 5s default. The
  // budget covers process startup only; assertions are unchanged.

  test("a clean exit is ok and reports exit code 0 with no signal or spawn error", () => {
    const result = runSync(["git", "--version"])
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.signalCode).toBeNull()
    expect(result.spawnError).toBeNull()
    expect(result.stdout).toContain("git version")
  }, 15_000)

  test("a genuine git error keeps its stderr and is diagnosed as program-level", () => {
    const result = runSync(["git", "not-a-real-git-subcommand-xyz"])
    expect(result.ok).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.trim()).not.toBe("")
    const described = describeSubprocess(result)
    expect(described).toContain("program-level failure")
    expect(described).toContain("not a git command")
  }, 15_000)

  test("a missing executable is a spawn error, so the child never ran", () => {
    const result = runSync(["silvercode-definitely-not-a-real-binary-xyz"])
    // Portable invariant: it is never a clean success, and the spawn failure is
    // captured (the exact errno string is platform-specific, so it is not pinned).
    expect(result.ok).toBe(false)
    expect(result.spawnError).not.toBeNull()
    expect(result.pid).toBeNull()
    expect(describeSubprocess(result)).toContain("could not be spawned")
  }, 15_000)

  test("the git() helper returns trimmed stdout and throws diagnostics on failure", () => {
    expect(git(process.cwd(), "--version")).toStartWith("git version")
    expect(() => git(process.cwd(), "not-a-real-git-subcommand-xyz")).toThrow("subprocess did not exit cleanly")
  }, 15_000)

  test("a signal kill reports the signal and explains the empty stderr", () => {
    const described = describeSubprocess(record({ exitCode: null, signalCode: "SIGKILL", ok: false }))
    expect(described).toContain("killed by SIGKILL")
    expect(described).toContain("signal: SIGKILL")
    expect(described).toContain("--- stderr ---\n<empty>")
  })

  test("a Windows host process-startup fault is decoded from its NTSTATUS exit code", () => {
    const described = describeSubprocess(record({ exitCode: -1073741502, ok: false }))
    expect(described).toContain("0xc0000142")
    expect(described).toContain("STATUS_DLL_INIT_FAILED")
    expect(described).toContain("host/runner process-startup fault")
  })

  test("a silent non-zero exit is distinguished from a git error that writes stderr", () => {
    const described = describeSubprocess(record({ exitCode: 128, ok: false }))
    expect(described).toContain("wrote nothing")
    expect(described).toContain("host/process fault")
  })

  test("the signature is stable across the same fault class so a cascade can be correlated", () => {
    const clone = record({
      cmd: ["git", "clone", "--branch", "v0.1.0"],
      cwd: "D:\\a",
      exitCode: -1073741502,
      ok: false,
    })
    const init = record({ cmd: ["git", "init", "--quiet", "--bare"], cwd: "D:\\b", exitCode: -1073741502, ok: false })
    expect(signatureOf(clone)).toBe(signatureOf(init))
    // A different class must NOT collide, or the correlation would be meaningless.
    const genuine = record({ exitCode: 128, stderr: "fatal: no such remote\n", ok: false })
    expect(signatureOf(genuine)).not.toBe(signatureOf(clone))
  })

  test("expectSubprocessOk passes a clean record and throws the diagnostic for a fault", () => {
    expect(() => expectSubprocessOk(record(), "clean")).not.toThrow()
    expect(() =>
      expectSubprocessOk(record({ exitCode: null, signalCode: "SIGTERM", ok: false }), "clone context"),
    ).toThrow("clone context")
  })

  test("the async runner captures the same fields and preserves the awaited exit code", async () => {
    const clean = await runAsync(["git", "--version"])
    expect(clean.ok).toBe(true)
    expect(clean.exitCode).toBe(0)
    expect(clean.stdout).toContain("git version")

    const failed = await runAsync(["git", "not-a-real-git-subcommand-xyz"])
    expect(failed.ok).toBe(false)
    expect(failed.exitCode).not.toBe(0)
    expect(failed.stderr).toContain("not a git command")

    const missing = await runAsync(["silvercode-definitely-not-a-real-binary-xyz"])
    expect(missing.ok).toBe(false)
    expect(missing.spawnError).not.toBeNull()
  }, 15_000)

  test("removeFixture deletes a fixture directory and tolerates one that is already gone", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "silvercode-subprocess-fixture-"))
    await Bun.write(path.join(dir, "seed.txt"), "seed\n")
    await removeFixture(dir)
    const stillThere = await stat(dir).then(
      () => true,
      () => false,
    )
    expect(stillThere).toBe(false)
    // force:true means a missing directory is not an error and must not throw.
    await expect(removeFixture(path.join(tmpdir(), "silvercode-subprocess-missing-xyz"))).resolves.toBeUndefined()
  })

  test("removeFixture records a cleanup failure and assertNoCleanupFailures surfaces it once", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "silvercode-subprocess-fixture-"))
    try {
      const busy = Object.assign(new Error("resource busy or locked"), { code: "EBUSY", syscall: "rmdir", path: dir })
      const originalError = console.error
      console.error = () => {}
      try {
        await removeFixture(dir, async () => {
          throw busy
        })
      } finally {
        console.error = originalError
      }
      expect(() => assertNoCleanupFailures()).toThrow("EBUSY")
      // The recorded failure is cleared once reported.
      expect(() => assertNoCleanupFailures()).not.toThrow()
    } finally {
      await removeFixture(dir)
      assertNoCleanupFailures()
    }
  })

  test("classify separates startup faults, runtime faults and Ctrl+C", () => {
    const text = (exitCode: number) => describeSubprocess(record({ exitCode, ok: false }))
    expect(text(-1073741502)).toContain("process-startup fault")
    expect(text(-1073741819)).not.toContain("never executed the program")
    expect(text(-1073741510)).toContain("not a process-startup fault")
    expect(describeSubprocess(record({ exitCode: 3, ok: false }))).toContain("inconclusive")
  })

  test("the async runner folds a signal kill into 128+signo and reports the signal", async () => {
    if (process.platform === "win32") return
    const killed = await runAsync(["sh", "-c", "kill -TERM $$"])
    expect(killed.ok).toBe(false)
    expect(killed.exitCode).toBe(143)
    expect(killed.signalCode).toBe("SIGTERM")
  })
})
