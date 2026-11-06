import { describe, expect, onTestFinished } from "bun:test"
import fs from "fs/promises"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Exit, Fiber, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(AppProcess.node))

const NODE = process.execPath
const cmd = (...args: string[]) => ChildProcess.make(NODE, args)

const waitForFile = (file: string) =>
  Effect.promise(async () => {
    while (true) {
      try {
        return await fs.readFile(file, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
    }
  })

const readPid = (file: string, timeout = 5_000) =>
  Effect.promise(async () => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        const value = await fs.readFile(file, "utf8")
        if (value) return Number(value)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`Process did not write its pid to ${file}`)
  })

describe("AppProcess", () => {
  describe("run", () => {
    it.effect(
      "captures stdout and exit code zero",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.stdout.write('hi\\n')"))
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("hi\n")
        expect(result.stdoutTruncated).toBe(false)
        expect(result.stderrTruncated).toBe(false)
      }),
    )

    it.effect(
      "captures stdout and stderr in emission order",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const script = [
          'process.stdout.write("out 1\\n")',
          'setTimeout(() => process.stderr.write("err 1\\n"), 10)',
          'setTimeout(() => process.stdout.write("out 2\\n"), 20)',
        ].join(";")
        const result = yield* svc.run(cmd("-e", script), { combineOutput: true })
        expect(result.output?.toString("utf8")).toBe("out 1\nerr 1\nout 2\n")
        expect(result.stdout.toString("utf8")).toBe("")
        expect(result.stderr.toString("utf8")).toBe("")
      }),
    )

    it.effect(
      "non-zero exit returns RunResult; caller can require success",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.exit(1)"))
        expect(result.exitCode).toBe(1)
      }),
    )

    it.effect(
      "requireSuccess fails on non-zero exit",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const exit = yield* Effect.exit(
          svc.run(cmd("-e", "process.exit(1)")).pipe(Effect.flatMap(AppProcess.requireSuccess)),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const reason = exit.cause.reasons[0]
          if (reason && reason._tag === "Fail") {
            expect(reason.error).toBeInstanceOf(AppProcess.AppProcessError)
            expect((reason.error as AppProcess.AppProcessError).exitCode).toBe(1)
            expect((reason.error as AppProcess.AppProcessError).message).toContain("Command failed (exit 1)")
          } else {
            throw new Error("expected fail reason")
          }
        }
      }),
    )

    it.effect(
      "requireSuccess succeeds on exit 0",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.exit(0)")).pipe(Effect.flatMap(AppProcess.requireSuccess))
        expect(result.exitCode).toBe(0)
      }),
    )

    it.effect(
      "requireExitIn allowlists multiple exit codes",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const requireZeroOrOne = AppProcess.requireExitIn([0, 1])
        const okZero = yield* svc.run(cmd("-e", "process.exit(0)")).pipe(Effect.flatMap(requireZeroOrOne))
        expect(okZero.exitCode).toBe(0)
        const okOne = yield* svc.run(cmd("-e", "process.exit(1)")).pipe(Effect.flatMap(requireZeroOrOne))
        expect(okOne.exitCode).toBe(1)
        const exit = yield* Effect.exit(svc.run(cmd("-e", "process.exit(2)")).pipe(Effect.flatMap(requireZeroOrOne)))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const reason = exit.cause.reasons[0]
          if (reason && reason._tag === "Fail") {
            expect(reason.error).toBeInstanceOf(AppProcess.AppProcessError)
            expect((reason.error as AppProcess.AppProcessError).exitCode).toBe(2)
          }
        }
      }),
    )

    it.effect(
      "truncates stdout when maxOutputBytes is set",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.stdout.write('0123456789')"), { maxOutputBytes: 5 })
        expect(result.exitCode).toBe(0)
        expect(result.stdoutTruncated).toBe(true)
        expect(result.stderrTruncated).toBe(false)
        expect(result.stdout.length).toBe(5)
        expect(result.stdout.toString("utf8")).toBe("01234")
      }),
    )

    it.effect(
      "truncates stderr when maxErrorBytes is set",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.stderr.write('0123456789')"), { maxErrorBytes: 5 })
        expect(result.exitCode).toBe(0)
        expect(result.stdoutTruncated).toBe(false)
        expect(result.stderrTruncated).toBe(true)
        expect(result.stderr.length).toBe(5)
        expect(result.stderr.toString("utf8")).toBe("01234")
      }),
    )

    it.effect(
      "result includes command description",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.stdout.write('hi')"))
        expect(result.command).toBe(`${NODE} -e process.stdout.write('hi')`)
      }),
    )

    it.live(
      "returns promptly when a command leaves a detached child holding stdio open",
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const svc = yield* AppProcess.Service
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(tmpdir(), "opencode-process-detached-"))),
          (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
        )
        const pidFile = path.join(directory, "daemon.pid")

        // Spawn a long-lived detached child that inherits stdio (keeps the shell's
        // stdout pipe write end open), record its pid, print output, then exit.
        const code = [
          'const cp = require("node:child_process")',
          'const fs = require("node:fs")',
          'const daemon = cp.spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "inherit" })',
          "daemon.unref()",
          "fs.writeFileSync(process.argv[1], String(daemon.pid))",
          'process.stdout.write("started")',
          "process.exit(0)",
        ].join("\n")

        const start = Date.now()
        const result = yield* svc.run(cmd("-e", code, pidFile), { combineOutput: true })
        const elapsed = Date.now() - start

        // Reap the detached daemon so it does not leak and the inherited pipe closes.
        const pid = yield* readPid(pidFile)
        yield* Effect.sync(() => {
          try {
            process.kill(pid, "SIGKILL")
          } catch {}
        })

        expect(result.exitCode).toBe(0)
        expect(result.output?.toString("utf8")).toContain("started")
        // Returned on process exit (plus a bounded quiet window), not by waiting for
        // the daemon's inherited pipe (which never closes) or the run timeout.
        expect(elapsed).toBeLessThan(10_000)
      }),
      20_000,
    )

    it.live(
      "returns promptly for a normal command without the post-exit idle delay",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const start = Date.now()
        const result = yield* svc.run(cmd("-e", "process.stdout.write('hi')"), { combineOutput: true })
        const elapsed = Date.now() - start
        expect(result.exitCode).toBe(0)
        expect(result.output?.toString("utf8")).toBe("hi")
        // A normal command closes its pipe right after exiting, so the 500ms
        // quiet window must never be entered: it returns on stream close, not on
        // the idle timer.
        expect(elapsed).toBeLessThan(400)
      }),
    )

    if (process.platform !== "win32") {
      // Extends the #672 timeout diagnostic for both cleanup tests. Keep the
      // passing path to timestamps and in-memory bookkeeping only.
      const diagnosticDirectory = (prefix: string) =>
        Effect.promise(async () => {
          const directory = await fs.mkdtemp(path.join(tmpdir(), prefix))
          const ready = path.join(directory, "ready")
          const settled = path.join(directory, "settled")
          const started = Date.now()
          let stage = "spawn"
          let stageStarted = started
          let pid = "unknown"
          let readyObserved = false
          let settledObserved = false
          let completed = false
          let failedStage: string | undefined
          const events: string[] = []
          const mark = (next: string) => {
            const now = Date.now()
            events.push(
              `${stage}: +${stageStarted - started}ms to +${now - started}ms (${now - stageStarted}ms); ready=${readyObserved ? "previously observed" : "unknown"} settled=${settledObserved ? "previously observed" : "unknown"}; exitCode/signal=unavailable`,
            )
            stage = next
            stageStarted = now
          }
          onTestFinished(() => {
            if (completed) return
            const now = Date.now()
            let state = "unavailable"
            if (/^\d+$/.test(pid) && process.platform === "linux") {
              try {
                const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
                state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "unavailable"
              } catch {
                state = "not observable in /proc"
              }
            }
            console.error(
              `[process-cleanup] started=${new Date(started).toISOString()}\n${events.join("\n")}\n${stage}: +${stageStarted - started}ms to +${now - started}ms (${now - stageStarted}ms, incomplete or failed)${failedStage ? `; use failed at ${failedStage}` : ""}; pid=${pid} processState=${state} exitCode/signal=unavailable ready=${existsSync(ready)} settled=${existsSync(settled)} (test-finished snapshot; timeout cleanup may already have changed child and files)`,
            )
          })
          return {
            directory,
            ready,
            settled,
            mark,
            setPid: (value: string) => {
              pid = value
              readyObserved = true
            },
            observeSettled: () => {
              settledObserved = true
            },
            beginCleanup: (success: boolean) => {
              if (!success) failedStage = stage
              mark("directory cleanup (fs.rm)")
            },
            finishCleanup: (success: boolean) => {
              mark("finished")
              completed = success
            },
          }
        })

      it.live(
        "timeout cleans up the scoped child process",
        Effect.acquireUseRelease(
          diagnosticDirectory("opencode-process-timeout-"),
          ({ ready, settled, mark, setPid, observeSettled }) => {
            const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(settled)},'settled');process.exit(0)});setInterval(()=>{},60000)`
            return Effect.gen(function* () {
              const svc = yield* AppProcess.Service
              mark("run with timeout")
              const exit = yield* Effect.exit(svc.run(cmd("-e", script), { timeout: "250 millis" }))
              mark("timeout result assertion")
              expect(Exit.isFailure(exit)).toBe(true)
              mark("readiness wait")
              const pid = yield* waitForFile(ready)
              setPid(pid)
              mark("readiness assertion")
              expect(pid).toMatch(/^\d+$/)
              mark("settled wait")
              const result = yield* waitForFile(settled)
              observeSettled()
              mark("settled assertion")
              expect(result).toBe("settled")
              mark("use complete")
            })
          },
          ({ directory, beginCleanup, finishCleanup }, exit) =>
            Effect.promise(async () => {
              const success = Exit.isSuccess(exit)
              beginCleanup(success)
              await fs.rm(directory, { recursive: true, force: true })
              finishCleanup(success)
            }),
        ),
        5_000,
      )

      it.live(
        "fiber interruption cleans up the scoped child process after readiness",
        Effect.acquireUseRelease(
          diagnosticDirectory("opencode-process-interrupt-"),
          ({ ready, settled, mark, setPid, observeSettled }) => {
            const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(settled)},'settled');process.exit(0)});setInterval(()=>{},60000)`
            return Effect.gen(function* () {
              const svc = yield* AppProcess.Service
              const fiber = yield* svc.run(cmd("-e", script)).pipe(Effect.forkChild)
              mark("readiness wait")
              const pid = yield* waitForFile(ready)
              setPid(pid)
              mark("readiness assertion")
              expect(pid).toMatch(/^\d+$/)
              mark("interrupt")
              yield* Fiber.interrupt(fiber)
              mark("settled wait")
              const result = yield* waitForFile(settled)
              observeSettled()
              mark("settled assertion")
              expect(result).toBe("settled")
              mark("use complete")
            })
          },
          ({ directory, beginCleanup, finishCleanup }, exit) =>
            Effect.promise(async () => {
              const success = Exit.isSuccess(exit)
              beginCleanup(success)
              await fs.rm(directory, { recursive: true, force: true })
              finishCleanup(success)
            }),
        ),
        5_000,
      )
    }
  })

  describe("inherited platform methods", () => {
    it.effect(
      "string returns stdout as string",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const out = yield* svc.string(cmd("-e", "process.stdout.write('hi\\n')"))
        expect(out).toBe("hi\n")
      }),
    )

    it.effect(
      "lines returns the platform's array of lines",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const out = yield* svc.lines(cmd("-e", "process.stdout.write('a\\nb\\n')"))
        expect(Array.from(out)).toEqual(["a", "b"])
      }),
    )
  })

  describe("run with stdin option", () => {
    const echoStdin = "process.stdin.on('data', c => process.stdout.write(c))"

    it.effect(
      "feeds a string to stdin and returns it on stdout",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", echoStdin), { stdin: "hello" })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("hello")
      }),
    )

    it.effect(
      "feeds a Uint8Array to stdin",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const bytes = new TextEncoder().encode("bytes")
        const result = yield* svc.run(cmd("-e", echoStdin), { stdin: bytes })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("bytes")
      }),
    )

    it.effect(
      "feeds a Stream of Uint8Array chunks to stdin",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const enc = new TextEncoder()
        const stream = Stream.fromIterable([enc.encode("one"), enc.encode("-two"), enc.encode("-three")])
        const result = yield* svc.run(cmd("-e", echoStdin), { stdin: stream })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("one-two-three")
      }),
    )

    it.effect(
      "completes correctly with empty input",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", echoStdin), { stdin: "" })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("")
      }),
    )

    it.effect(
      "carries existing Command options like env",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const script =
          "process.stdout.write(process.env.FEED + ':'); process.stdin.on('data', c => process.stdout.write(c))"
        const command = ChildProcess.make(NODE, ["-e", script], { env: { FEED: "envset" }, extendEnv: true })
        const result = yield* svc.run(command, { stdin: "payload" })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("envset:payload")
      }),
    )

    it.effect(
      "carries existing Command options like cwd",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const dir = realpathSync(tmpdir())
        const script =
          "process.stdout.write(process.cwd() + '|'); process.stdin.on('data', c => process.stdout.write(c))"
        const command = ChildProcess.make(NODE, ["-e", script], { cwd: dir })
        const result = yield* svc.run(command, { stdin: "ok" })
        expect(result.exitCode).toBe(0)
        const [cwd, stdin] = result.stdout.toString("utf8").split("|")
        expect(realpathSync(cwd)).toBe(dir)
        expect(stdin).toBe("ok")
      }),
    )
  })

  describe("runStream", () => {
    it.live(
      "emits lines incrementally and ends cleanly on exit 0",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc
          .runStream(cmd("-e", "console.log('one'); console.log('two'); console.log('three')"))
          .pipe(Stream.runCollect)
        expect(Array.from(result)).toEqual(["one", "two", "three"])
      }),
    )

    it.live(
      "okExitCodes determines whether a non-zero exit fails the stream",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const allowed = yield* svc
          .runStream(cmd("-e", "console.log('only'); process.exit(1)"), { okExitCodes: [0, 1] })
          .pipe(Stream.runCollect)
        expect(Array.from(allowed)).toEqual(["only"])
        const exit = yield* Effect.exit(
          svc
            .runStream(cmd("-e", "console.log('a'); process.exit(2)"), { okExitCodes: [0, 1] })
            .pipe(Stream.runCollect),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const reason = exit.cause.reasons[0]
          if (reason && reason._tag === "Fail") {
            expect(reason.error).toBeInstanceOf(AppProcess.AppProcessError)
          }
        }
      }),
    )

    it.live(
      "without okExitCodes, never fails on exit code",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.runStream(cmd("-e", "console.log('only'); process.exit(7)")).pipe(Stream.runCollect)
        expect(Array.from(result)).toEqual(["only"])
      }),
    )

    it.live(
      "AbortSignal interrupts the stream",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const controller = new AbortController()
        controller.abort()
        const exit = yield* Effect.exit(
          svc
            .runStream(cmd("-e", "setInterval(() => {}, 60_000)"), { signal: controller.signal })
            .pipe(Stream.runCollect),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  describe("spawn (inherited)", () => {
    it.live(
      "returns the platform ChildProcessHandle for advanced use",
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* AppProcess.Service
          const handle = yield* svc.spawn(cmd("-e", "setInterval(() => {}, 1_000)"))
          expect(yield* handle.isRunning).toBe(true)
          yield* handle.kill()
        }),
      ),
    )
  })
})
