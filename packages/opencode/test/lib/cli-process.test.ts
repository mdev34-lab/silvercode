import { describe, expect } from "bun:test"
import { AppProcess } from "@opencode-ai/core/process"
import { Effect } from "effect"
import { withCliFixture } from "./cli-process"
import { it } from "./effect"

describe("CLI fixture spawn failure diagnostics", () => {
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
