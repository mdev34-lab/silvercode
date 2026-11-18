import { describe, expect } from "bun:test"
import { AppProcess } from "@opencode-ai/core/process"
import { Effect, Fiber } from "effect"
import path from "node:path"
import { withCliFixture } from "./cli-process"
import { it } from "./effect"

describe("CLI fixture spawn failure diagnostics", () => {
  it.live(
    "retains real child output on timeout and joins after the child exits",
    () =>
      withCliFixture(({ home, opencode }) =>
        Effect.gen(function* () {
          const ready = Promise.withResolvers<number>()
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                async fetch(request) {
                  const pid = Number(await request.text())
                  if (request.method !== "POST" || !Number.isSafeInteger(pid) || pid <= 0)
                    return new Response("invalid readiness", { status: 400 })
                  ready.resolve(pid)
                  return new Response("ready")
                },
              }),
            ),
            (server) => Effect.sync(() => server.stop(true)),
          )
          const preload = path.join(home, "timeout-child.js")
          yield* Effect.promise(() =>
            Bun.write(
              preload,
              `await Promise.all([
  new Promise((resolve, reject) => process.stdout.write("stdout café\\n", (error) => error ? reject(error) : resolve())),
  new Promise((resolve, reject) => process.stderr.write("stderr marker", (error) => error ? reject(error) : resolve())),
]);
const response = await fetch(process.env.TIMEOUT_TEST_READY_URL, { method: "POST", body: String(process.pid) });
if (!response.ok) throw new Error("readiness rejected");
setInterval(() => {}, 60000);
await new Promise(() => {});
`,
            ),
          )
          const fiber = yield* opencode
            .spawn(["--help"], {
              timeoutMs: 20_000,
              preload,
              env: { TIMEOUT_TEST_READY_URL: `http://127.0.0.1:${server.port}/ready` },
            })
            .pipe(Effect.forkChild)
          const pid = yield* Effect.raceFirst(
            Effect.promise(() => ready.promise),
            Fiber.join(fiber).pipe(
              Effect.flatMap((result) => Effect.die(new Error(`child finished before readiness: ${result.stderr}`))),
            ),
          )
          expect(pid).toBeGreaterThan(0)
          expect(() => process.kill(pid, 0)).not.toThrow()
          const result = yield* Fiber.join(fiber)
          expect(result.exitCode).toBe(-1)
          expect(result.stdout).toBe("stdout café\n")
          expect(result.stderr).toBe("stderr marker\nError: Timed out\n")
          expect(result.stdoutTruncated).toBe(false)
          expect(result.stderrTruncated).toBe(false)
          expect(() => process.kill(pid, 0)).toThrow(/ESRCH/)
        }),
      ),
    60_000,
  )

  it.live("forwards partial output and truncation flags, with the timeout reason last", () => {
    const error = new AppProcess.AppProcessError({
      command: "bun test-command",
      cause: new Error("Timed out"),
      partialStdout: "stdout café\r\n",
      partialStderr: "stderr before timeout",
      partialStdoutTruncated: true,
      partialStderrTruncated: false,
    })
    let calls = 0
    return withCliFixture(
      ({ opencode }) =>
        Effect.gen(function* () {
          const result = yield* opencode.spawn(["test-command"])
          expect(calls).toBe(1)
          expect(result.exitCode).toBe(-1)
          expect(result.stdout).toBe("stdout café\n")
          expect(result.stderr).toBe("stderr before timeout\nError: Timed out\n")
          expect(result.stdoutTruncated).toBe(true)
          expect(result.stderrTruncated).toBe(false)
        }),
      { processRun: () => Effect.sync(() => calls++).pipe(Effect.andThen(Effect.fail(error))) },
    )
  })

  it.live("keeps an existing stderr newline and forwards stderr truncation", () =>
    withCliFixture(
      ({ opencode }) =>
        Effect.gen(function* () {
          const result = yield* opencode.spawn(["test-command"])
          expect(result.exitCode).toBe(-1)
          expect(result.stdout).toBe("out")
          expect(result.stderr).toBe("err\nError: Timed out\n")
          expect(result.stdoutTruncated).toBe(false)
          expect(result.stderrTruncated).toBe(true)
        }),
      {
        processRun: () =>
          Effect.fail(
            new AppProcess.AppProcessError({
              command: "bun",
              cause: new Error("Timed out"),
              partialStdout: "out",
              partialStderr: "err\n",
              partialStdoutTruncated: false,
              partialStderrTruncated: true,
            }),
          ),
      },
    ),
  )

  it.live("preserves the non-partial failure text and default flags", () =>
    withCliFixture(
      ({ opencode }) =>
        Effect.gen(function* () {
          const result = yield* opencode.spawn(["test-command"])
          expect(result.exitCode).toBe(-1)
          expect(result.stdout).toBe("")
          expect(result.stderr).toBe("Error: Timed out\n")
          expect(result.stdoutTruncated).toBe(false)
          expect(result.stderrTruncated).toBe(false)
        }),
      {
        processRun: () =>
          Effect.fail(new AppProcess.AppProcessError({ command: "bun", cause: new Error("Timed out") })),
      },
    ),
  )
})
