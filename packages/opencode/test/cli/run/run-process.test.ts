// Subprocess integration tests for `opencode run` (non-interactive mode).
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. See `test/lib/cli-process.ts` for the harness — each test uses
// `opencode.run(message, opts?)` to spawn `bun src/index.ts run ...` with
// `OPENCODE_CONFIG_CONTENT` providing the test provider config inline.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { SessionRetry } from "../../../src/session/retry"
import { cliIt } from "../../lib/cli-process"
import { raw, reply } from "../../lib/llm-server"

const isModelAttempt = (hit: { url: URL; body: Record<string, unknown> }) => {
  const route = hit.url.pathname
  const titleRequest = JSON.stringify(hit.body).includes("Generate a title for this conversation")
  return !titleRequest && (route === "/v1/chat/completions" || route === "/v1/responses")
}

describe("opencode run (non-interactive subprocess)", () => {
  cliIt.live(
    "Zen quota SSE rejection on a continued session exits nonzero",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("initial session response")
        const first = yield* opencode.run("initial request", {
          timeoutMs: 20_000,
          model: "opencode/local-quota-test",
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              agent: { work: { finishTool: false } },
              provider: {
                opencode: {
                  npm: "@ai-sdk/openai-compatible",
                  options: { baseURL: llm.url, apiKey: "public" },
                  models: {
                    "local-quota-test": {
                      name: "local quota test",
                      limit: { context: 128000, output: 4096 },
                      cost: { input: 0, output: 0 },
                    },
                  },
                },
              },
              permission: { "*": "allow" },
            }),
          },
        })
        expect(first.exitCode).toBe(0)
        expect(first.stdout).toContain("initial session response")
        const initialHits = yield* llm.hits
        expect(initialHits.filter(isModelAttempt)).toHaveLength(1)
        expect(yield* llm.misses).toEqual([])
        expect(yield* llm.pending).toBe(0)

        const continuationStart = initialHits.length
        let quotaResponses = 0
        // Arm the quota script only after the first session has completed. The title
        // request is handled separately by TestLLMServer; every non-title model request
        // after this point belongs to the continued-session phase, including retries.
        // Match that phase/attempt route rather than user-message position: continuation
        // retries may transform or append messages, but must not fall through to "ok".
        yield* llm.pushMatchRepeat(
          isModelAttempt,
          raw({
            chunks: [
              { error: { message: "Free usage limit reached", type: "quota_exceeded", code: "FreeUsageLimitError" } },
            ],
            onSend: () => quotaResponses++,
          }),
          SessionRetry.RETRY_MAX_RETRIES + 1,
        )
        const result = yield* opencode.run("quota rejection", {
          timeoutMs: 20_000,
          extraArgs: ["--continue"],
          model: "opencode/local-quota-test",
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              agent: { work: { finishTool: false } },
              provider: {
                opencode: {
                  npm: "@ai-sdk/openai-compatible",
                  options: { baseURL: llm.url, apiKey: "public" },
                  models: {
                    "local-quota-test": {
                      name: "local quota test",
                      limit: { context: 128000, output: 4096 },
                      cost: { input: 0, output: 0 },
                    },
                  },
                },
              },
              permission: { "*": "allow" },
            }),
          },
        })
        const continuationAttempts = (yield* llm.hits).slice(continuationStart).filter(isModelAttempt)
        expect(continuationAttempts.length).toBeGreaterThanOrEqual(1)
        expect(continuationAttempts.length).toBeLessThanOrEqual(SessionRetry.RETRY_MAX_RETRIES + 1)
        // Verify the script actually answered every model attempt in this phase; this
        // fails before the exit-code check if a request fell through to the success default.
        expect(quotaResponses).toBe(continuationAttempts.length)
        expect(yield* llm.misses).toEqual([])
        expect(yield* llm.pending).toBe(0)
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Free usage limit reached")
        expect(result.durationMs).toBeLessThan(20_000)
      }),
    30_000,
  )

  for (const status of [403, 429]) {
    cliIt.live(
      `Zen HTTP ${status} quota rejection on a continued session exits nonzero`,
      ({ llm, opencode }) =>
        Effect.gen(function* () {
          const env = {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              agent: { work: { finishTool: false } },
              provider: {
                opencode: {
                  npm: "@ai-sdk/openai-compatible",
                  options: { baseURL: llm.url, apiKey: "public" },
                  models: {
                    "local-quota-test": {
                      name: "local quota test",
                      limit: { context: 128000, output: 4096 },
                      cost: { input: 0, output: 0 },
                    },
                  },
                },
              },
              permission: { "*": "allow" },
            }),
          }
          yield* llm.text("initial session response")
          const first = yield* opencode.run("initial request", {
            timeoutMs: 20_000,
            model: "opencode/local-quota-test",
            env,
          })
          expect(first.exitCode).toBe(0)
          const before = (yield* llm.hits).length
          // Exercise HTTP failure before SSE headers, not an in-band error frame.
          // 429 follows the existing bounded retry policy. Short server-provided
          // retry delays keep this local test fast without changing that policy.
          const attempts = status === 429 ? 6 : 1
          for (let i = 0; i < attempts; i++)
            yield* llm.error(
              status,
              { error: { message: "Free usage limit reached", type: "quota_exceeded", code: "FreeUsageLimitError" } },
              { "retry-after-ms": "1" },
            )
          const result = yield* opencode.run("quota rejection", {
            timeoutMs: 20_000,
            extraArgs: ["--continue"],
            model: "opencode/local-quota-test",
            env,
          })
          expect(result.exitCode).not.toBe(0)
          expect(result.stderr).toContain("Free usage limit reached")
          expect(result.durationMs).toBeLessThan(20_000)
          const newHits = (yield* llm.hits).slice(before)
          const primary = newHits.filter(
            (hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"),
          )
          expect(primary.length).toBe(attempts)
          expect(yield* llm.misses).toEqual([])
          expect(yield* llm.pending).toBe(0)
        }),
      60_000,
    )
  }

  // Happy path: prompt completes, output reaches stdout, process exits 0.
  // If this fails, all the others likely will too — debug here first.
  cliIt.live(
    "exits 0 and writes the response to stdout on a successful prompt",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const result = yield* opencode.run("say hi")
        opencode.expectExit(result, 0)
        expect(result.stdout).toBe("hello from the test llm\n")
      }),
    60_000,
  )

  cliIt.live(
    "prints each completed text part in order around a tool continuation",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("  before tool  ").tool("bash", {
            command: "printf tool-output",
            description: "Print deterministic output",
          }),
        )
        yield* llm.text("  after tool  ")

        const result = yield* opencode.run("use a tool", {
          extraArgs: ["--dangerously-skip-permissions"],
        })

        opencode.expectExit(result, 0)
        expect(result.stdout).toBe("before tool\nafter tool\n")
      }),
    60_000,
  )

  cliIt.live(
    "prints reasoning before text only with --thinking",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.reason("  considering  ", { text: "  answer  " })
        const thinking = yield* opencode.run("think", { extraArgs: ["--thinking"] })
        opencode.expectExit(thinking, 0)
        expect(thinking.stdout).toBe("Thinking: considering\nanswer\n")

        yield* llm.reason("hidden", { text: "visible" })
        const plain = yield* opencode.run("think again")
        opencode.expectExit(plain, 0)
        expect(plain.stdout).toBe("visible\n")
      }),
    60_000,
  )

  // Regression for #27371: an unknown model used to hang the process forever
  // waiting on a session.status === idle event that never arrived. The fix
  // makes the SDK call surface an error promptly so the process exits nonzero.
  // We assert nonzero exit AND wall-clock under the harness timeout — a hang
  // would expire the timeout and produce a different (signal-killed) failure.
  cliIt.live(
    "exits nonzero promptly when the model is unknown (regression for #27371)",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.run("say hi", {
          model: "test/nonexistent-model",
          timeoutMs: 25_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(25_000)
      }),
    30_000,
  )

  // The test provider's in-band error frame is the shape the Zen adapter
  // emits for a stream cut before completion; it is a retriable stream
  // failure, not a fatal provider/session error.
  cliIt.live(
    "provider stream error retries, preserves partial output, and exits 0",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("partial response").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.cut("upstream provider exploded mid-stream")
        // The stream death is retried; the recovery reply completes the turn.
        yield* llm.text("recovered response")
        const result = yield* opencode.run("Generate a report with a midstream error", { timeoutMs: 30_000 })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe("partial response\nrecovered response\n")
        expect(result.stderr).not.toContain("upstream provider exploded mid-stream")
      }),
    60_000,
  )

  // --format json puts one JSON object per line on stdout for each emitted
  // event. Consumers (CI scripts, tooling) parse this stream. Asserts the
  // shape so a future event-emit change has to update this expectation.
  cliIt.live(
    "--format json emits parseable line-delimited JSON to stdout",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("structured output")
        const result = yield* opencode.run("say hi", { format: "json" })
        opencode.expectExit(result, 0)

        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.length).toBeGreaterThan(0)
        for (const evt of events) {
          expect(typeof evt.type).toBe("string")
          expect(typeof evt.sessionID).toBe("string")
        }
        expect(events.map((event) => event.type)).toEqual(["step_start", "text", "step_finish"])
        expect(events.map(({ timestamp: _, sessionID: __, ...event }) => event)).toEqual([
          { type: "step_start", part: expect.objectContaining({ type: "step-start" }) },
          {
            type: "text",
            part: expect.objectContaining({ type: "text", text: "structured output" }),
          },
          { type: "step_finish", part: expect.objectContaining({ type: "step-finish" }) },
        ])
        expect(result.stdout.endsWith("\n")).toBe(true)
        expect(
          result.stdout
            .split("\n")
            .slice(0, -1)
            .every((line) => line.length > 0),
        ).toBe(true)
      }),
    60_000,
  )

  cliIt.live(
    "--format json emits a pure error record for a rejected prompt request",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.run("use an unknown model", {
          model: "test/nonexistent-model",
          format: "json",
        })

        expect(result.exitCode).not.toBe(0)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.map((event) => event.type)).toEqual(["error"])
        expect(events[0]).toEqual({
          type: "error",
          timestamp: expect.any(Number),
          sessionID: expect.any(String),
          error: expect.any(Object),
        })
        expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(1)
      }),
    30_000,
  )

  cliIt.live(
    "--format json preserves reasoning, tool, and continuation ordering",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().reason("reasoning").text("before").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.text("after")

        const result = yield* opencode.run("Generate a report of json records", {
          format: "json",
          extraArgs: ["--thinking", "--dangerously-skip-permissions"],
        })

        expect(result.exitCode).toBe(0)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.map((event) => event.type)).toEqual([
          "step_start",
          "reasoning",
          "text",
          "tool_use",
          "step_finish",
          "step_start",
          "text",
          "step_finish",
        ])
        expect(events.find((event) => event.type === "reasoning")?.part).toEqual(
          expect.objectContaining({ type: "reasoning", text: "reasoning" }),
        )
        expect(events.find((event) => event.type === "tool_use")?.part).toEqual(
          expect.objectContaining({
            type: "tool",
            tool: "bash",
            state: expect.objectContaining({ status: "completed" }),
          }),
        )
        expect(
          result.stdout
            .split("\n")
            .slice(0, -1)
            .every((line) => line.startsWith("{")),
        ).toBe(true)
      }),
    60_000,
  )

  cliIt.live(
    "--format json records partial output for an unknown stream finish",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("partial json").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.cut("provider failed")
        // The in-band stream error is retried; the recovery reply completes the turn.
        yield* llm.text("recovered json")
        const result = yield* opencode.run("Generate a report after output", { format: "json" })

        const events = opencode.parseJsonEvents(result.stdout)
        expect(result.exitCode).toBe(0)
        expect(events.map((event) => event.type)).toEqual([
          "step_start",
          "text",
          "tool_use",
          "step_finish",
          "step_start",
          "step_start",
          "text",
          "step_finish",
        ])
        expect(events[1]?.part).toEqual(expect.objectContaining({ type: "text", text: "partial json" }))
        // The failed attempt emits its step_start and then dies on the
        // in-band error frame - no synthesized step-finish is recorded for it.
        expect(events[4]?.part).toEqual(expect.objectContaining({ type: "step-start" }))
        expect(events[6]?.part).toEqual(expect.objectContaining({ type: "text", text: "recovered json" }))
        expect(events.at(-1)?.part).toEqual(expect.objectContaining({ type: "step-finish", reason: "stop" }))
      }),
    60_000,
  )

  cliIt.live(
    "rejects requested permissions by default and allows them with the dangerous flag",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.tool("bash", { command: "rm -f denied-file", description: "Remove a test file" })
        yield* llm.text("continued after rejection")
        const denied = yield* opencode.run("Generate a report with permission", { permission: { bash: "ask" } })
        opencode.expectExit(denied, 0)
        expect(denied.stderr).toContain("permission requested: bash")
        expect(denied.stdout).toBe("")

        yield* llm.reset
        yield* llm.tool("bash", { command: "rm -f allowed-file", description: "Remove a test file" })
        yield* llm.text("continued after approval")
        const allowed = yield* opencode.run("Generate a report with permission", {
          permission: { bash: "ask" },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        opencode.expectExit(allowed, 0)
        expect(allowed.stderr).not.toContain("permission requested: bash")
        expect(allowed.stdout).toContain("continued after approval")

        yield* llm.reset
        yield* llm.tool("bash", { command: "touch explicitly-denied", description: "Create a denied marker" })
        yield* llm.text("continued after explicit denial")
        const explicitlyDenied = yield* opencode.run("Generate a report with denied permission", {
          permission: { bash: "deny" },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        opencode.expectExit(explicitlyDenied, 0)
        expect(explicitlyDenied.stdout).toContain("continued after explicit denial")
        expect(yield* Effect.promise(() => Bun.file(`${home}/explicitly-denied`).exists())).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "attach mode sends client-local file contents without a shared path",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const source = `${home}/client-only.txt`
        const sentinel = "client-only attachment sentinel"
        yield* Effect.promise(() => Bun.write(source, sentinel))
        yield* llm.text("attachment received")
        const server = yield* opencode.serve()

        const result = yield* opencode.run("read the attachment", {
          extraArgs: ["--attach", server.url, `--file=${source}`, "--"],
        })

        opencode.expectExit(result, 0)
        const input = JSON.stringify(yield* llm.inputs)
        expect(input).toContain(sentinel)
        expect(input).not.toContain(`file://${source}`)
      }),
    60_000,
  )

  cliIt.live(
    "attach mode rejects local directories before prompt admission",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.run("read the directory", {
          extraArgs: ["--attach", "http://127.0.0.1:1", `--file=${home}`, "--"],
        })

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Cannot attach local directory without a shared filesystem")
      }),
    30_000,
  )

  cliIt.live(
    "SIGINT interrupts an active non-interactive run without leaking the process",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.hang
        const run = yield* opencode.startRun("wait forever")
        yield* llm.wait(1)
        run.interrupt()
        const result = yield* run.result

        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(30_000)
      }),
    30_000,
  )

  cliIt.live(
    "skips background .opencode dependency installation in isolated CLI runs",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const toolDir = path.join(home, ".opencode", "tool")
        yield* Effect.promise(() => fs.mkdir(toolDir, { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(toolDir, "noop.ts"),
            'export default { description: "noop", args: {}, execute: async () => "ok" }\n',
          ),
        )
        yield* llm.text("isolated ok")

        const result = yield* opencode.run("check isolated config deps", {
          extraArgs: ["--dir", home],
          printLogs: true,
          timeoutMs: 25_000,
        })

        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("isolated ok")
        const installedPkg = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".opencode", "package.json")).exists(),
        )
        expect(installedPkg).toBe(false)
      }),
    60_000,
  )
})
