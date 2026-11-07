// Regression: PWD fixture-isolation. Asserts the CLI child's session.directory
// is the fixture home, not the ambient parent PWD inherited via extendEnv.
//
// TWO modes via conditional REGISTRATION (if/else, not skipIf):
//   OUTER (REGRESSION_INNER unset): spawns `bun test <this-file>` as an
//     isolated subprocess. cwd stays at opencode package root (preloads
//     resolve). Only PWD is varied (owned unique dir with spaces). No raw
//     kill timer — the inner self-terminates via Effect.timeoutOption before the
//     outer's 30s budget. Spawn is inside try so finally cleans up owned
//     tmp even if spawn throws.
//   INNER (REGRESSION_INNER=1): ACTUAL withCliFixture + production CLI +
//     canned llm.text + exact stdout/exit. Effect.timeoutOption (16s) wraps the
//     scoped fixture — on timeout the scope closes and finalizers run
//     (CLI child killed via appProc.run scoped kill, tmpdir removed), then
//     the test reports timed_out and fails. extractField throws on malformed
//     JSON (no silent acceptance). Does NOT set opts.env.PWD on inner CLI.
//
// Timeout hierarchy (no budget increase — production default 30s unchanged;
// 15s child timeout is a bounded diagnostic, canned success completes in
// ~4-5s so 15s is 3x typical):
//   CLI child:  15s (timeoutMs in opencode.run — bounded diagnostic)
//   Effect:     16s (Effect.timeoutOption — scope close + finalizers on interrupt)
//   inner test: 20s (bun:test — backstop, Effect fires first)
//   outer test: 30s (bun:test — final backstop, inner exits at ~16-17s max)
//
// Coverage: exercises the `spawn` path (via opencode.run). startRun/serve/
// acp have the same PWD fix (override order source-proven: ...opts?.env is
// last spread) but are NOT directly tested — bounded validation pending.
import { test, expect } from "bun:test"
import { Duration, Effect, Option } from "effect"
import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import { withCliFixture } from "../../lib/cli-process"

const INNER = process.env.REGRESSION_INNER === "1"

// Extract a key=value field from a production log line.
// Quoted values use JSON.stringify format — regex matches the JSON string
// body (handling \" and \\ via (?:[^"\\]|\\.)*), then JSON.parse unescapes.
// Throws on malformed JSON (no silent acceptance). Returns undefined if the
// field is not found. Boundary (?:^|\s) prevents matching inside longer keys.
function extractField(line: string, key: string): string | undefined {
  const quoted = line.match(new RegExp(`(?:^|\\s)${key}="((?:[^"\\\\]|\\\\.)*)"`))
  if (quoted) {
    return JSON.parse(`"${quoted[1]}"`) // throws on malformed JSON
  }
  const bare = line.match(new RegExp(`(?:^|\\s)${key}=([^"\\s]\\S*)`))
  return bare?.[1]
}

if (!INNER) {
  test(
    "PWD isolation: ambient PWD does not leak into fixture child session.directory",
    async () => {
      const opencodePkgDir = path.resolve(import.meta.dir, "../../..")
      const ownedBase = fs.mkdtempSync(path.join(os.tmpdir(), "oc-pwd-iso-"))
      const ambientDir = path.join(ownedBase, "dir with spaces")
      fs.mkdirSync(ambientDir, { recursive: true })

      let child: ReturnType<typeof Bun.spawn> | undefined
      try {
        // Capture in a const so Bun.spawn's `const Out`/`const Err` type
        // params narrow to the "pipe" literal — spawned.stdout/stderr are
        // then ReadableStream<Uint8Array> (not the
        // number|ReadableStream|undefined union of the general ReturnType,
        // which made `new Response(child.stdout)` fail TS2345). child
        // (general type) is retained for the finally cleanup only; spawned
        // (narrowed) feeds the real piped streams to Response. No cast: if
        // the options were not "pipe", tsc would reject the Response call,
        // surfacing the wrong configuration instead of hiding it.
        const spawned = Bun.spawn(
          [process.execPath, "test", import.meta.path],
          {
            env: { ...process.env, REGRESSION_INNER: "1", PWD: ambientDir },
            cwd: opencodePkgDir,
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        child = spawned
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(spawned.stdout).text(),
          new Response(spawned.stderr).text(),
          spawned.exited,
        ])

        // Parse inner diagnostic (printed by inner test before assertions)
        const diagMatch = stdout.match(/INNER_DIAGNOSTIC_START\n([\s\S]*?)\nINNER_DIAGNOSTIC_END/)
        let diag: { timed_out?: boolean; session_directory?: string; fixture_home?: string } = {}
        if (diagMatch) {
          try {
            diag = JSON.parse(diagMatch[1])
          } catch {
            // malformed diagnostic JSON — diag stays empty, assertions below fail
          }
        }

        console.log(`OUTER_AMBIENT_PWD=${ambientDir}`)
        console.log(`OUTER_CWD=${opencodePkgDir}`)
        console.log(`INNER_EXIT=${exitCode}`)
        console.log(`INNER_TIMED_OUT=${diag.timed_out ?? "unknown"}`)
        console.log(`INNER_SESSION_DIRECTORY=${diag.session_directory ?? "unknown"}`)
        console.log(`INNER_FIXTURE_HOME=${diag.fixture_home ?? "unknown"}`)
        console.log("INNER_STDOUT_START")
        console.log(stdout)
        console.log("INNER_STDOUT_END")
        console.log("INNER_STDERR_START")
        console.log(stderr)
        console.log("INNER_STDERR_END")

        // Assert inner did not time out and exited 0.
        expect(diag.timed_out).toBe(false)
        expect(exitCode).toBe(0)
      } finally {
        if (child) {
          if (child.exitCode === null) child.kill()
          try {
            await child.exited
          } catch {
            // ignore
          }
        }
        try {
          fs.rmSync(ownedBase, { recursive: true, force: true })
        } catch {
          // best-effort
        }
      }
    },
    30_000,
  )
} else {
  test(
    "inner: session.directory is fixture home, not ambient PWD",
    async () => {
      const ambientPwd = process.env.PWD
      const ambientCwd = process.cwd()

      // Effect.timeoutOption wraps the scoped fixture. On timeout (16s), the scope
      // closes and finalizers run (CLI child killed via appProc.run scoped
      // kill, tmpdir removed via addFinalizer), THEN the Effect resolves with
      // None. This ensures cleanup before the inner process exits — no
      // orphaned CLI grandchild. The inner test timeout (20s) is a backstop.
      const option = await Effect.runPromise(
        Effect.scoped(
          withCliFixture(({ llm, home, opencode }) =>
            Effect.gen(function* () {
              yield* llm.text("hello from the test llm")
              // timeoutMs 15s: bounded diagnostic (canned success ~4-5s,
              // 3x typical). Production default 30s unchanged.
              const result = yield* opencode.run("say hi", {
                printLogs: true,
                timeoutMs: 15_000,
              })
              return { result, home }
            }),
          ),
        ).pipe(Effect.timeoutOption(Duration.seconds(16))),
      )

      if (Option.isNone(option)) {
        // Timed out — scope closed, finalizers ran. Report and fail.
        console.log("INNER_DIAGNOSTIC_START")
        console.log(
          JSON.stringify({
            timed_out: true,
            ambient_pwd: ambientPwd ?? null,
            ambient_cwd: ambientCwd,
            error: "Effect timed out after 16s (scope closed, finalizers ran)",
          }),
        )
        console.log("INNER_DIAGNOSTIC_END")
        expect(false).toBe(true) // fail: timed out
        return
      }

      const { result: childResult, home } = option.value

      const childStderr = childResult.stderr
      const lines = childStderr.split("\n")
      const createdLine = lines.find((l) => l.includes("message=created id=ses_"))
      // extractField throws on malformed JSON — no silent acceptance
      const sessionDir = createdLine ? extractField(createdLine, "directory") : undefined
      const allDirs = lines
        .map((l) => extractField(l, "directory"))
        .filter((d): d is string => typeof d === "string")
      const allCwds = lines
        .map((l) => extractField(l, "cwd"))
        .filter((d): d is string => typeof d === "string")

      console.log("INNER_DIAGNOSTIC_START")
      console.log(
        JSON.stringify(
          {
            timed_out: false,
            ambient_pwd: ambientPwd ?? null,
            ambient_cwd: ambientCwd,
            fixture_home: home,
            child_exit_code: childResult.exitCode,
            child_stdout: childResult.stdout,
            child_duration_ms: childResult.durationMs,
            child_stderr: childStderr,
            session_directory: sessionDir ?? null,
            all_directory_entries: allDirs,
            all_cwd_entries: allCwds,
          },
          null,
          2,
        ),
      )
      console.log("INNER_DIAGNOSTIC_END")

      // Canonicalize via real filesystem identity (fs.realpathSync.native).
      // On Windows, os.tmpdir()/TEMP may yield an 8.3 short name (e.g.
      // C:\Users\RUNNER~1\AppData\Local\Temp\oc-cli-XXX) while the CLI child
      // resolves the long name (e.g. C:\Users\runneradmin\... for the SAME
      // directory). realpathSync.native resolves both to one canonical path
      // (GetFinalPathNameByHandle on Windows, realpath(2) on POSIX), so a
      // string mismatch that is the SAME directory does not falsely fail,
      // while a TRULY different directory stays different. No lowercasing,
      // string-substitution, equality removal, or platform skip. The
      // diagnostic JSON above keeps RAW values (so the 8.3/long pair is
      // visible for debugging); only the assertions below use canonical
      // identity. If a path does not exist (would indicate a real config
      // error), fall back to the raw string so the assertion still runs and
      // surfaces the diff rather than hiding it.
      const canonical = (p: string | undefined): string | undefined => {
        if (p === undefined) return undefined
        try {
          return fs.realpathSync.native(p)
        } catch {
          return p
        }
      }
      const canonicalHome = canonical(home)
      const canonicalSessionDir = canonical(sessionDir)
      const canonicalAmbientPwd = canonical(ambientPwd)
      const canonicalAllDirs = allDirs.map(canonical)
      const canonicalAllCwds = allCwds.map(canonical)

      expect(childResult.exitCode).toBe(0)
      expect(childResult.stdout).toBe("hello from the test llm\n")
      expect(sessionDir).toBeDefined()
      expect(canonicalSessionDir).toBe(canonicalHome)
      expect(canonicalSessionDir).not.toBe(canonicalAmbientPwd)
      for (const d of canonicalAllDirs) {
        expect(d).not.toBe(canonicalAmbientPwd)
      }
      for (const c of canonicalAllCwds) {
        expect(c).not.toBe(canonicalAmbientPwd)
      }
    },
    20_000,
  )
}
