import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { httpError, reply } from "../../lib/llm-server"

// #555: a provider quota rejection that asks for a long retry delay must not
// leave a headless run silent until it is killed.
//
// Temporal coverage split: the FIRST case below stays on the REAL clock and
// genuinely sleeps out a 12s retry-after — the wall-clock end-to-end guarantee
// for long retry waits. The remaining cases set `clockScale` so the spawned
// CLI observes an accelerated clock (test/lib/clock-scale.preload.ts): every
// wait still exceeds the same 10s notice threshold and keeps its production
// delay values, ordering and recovery assertions — only the wall-clock cost
// shrinks (59s of explicit waits → 12s real + ~4.7s controlled).
type Body = { messages?: { role?: string; content?: unknown }[] }
const lastText = (body: Body) => {
  const content = body.messages?.at(-1)?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("\n")
  return ""
}
const envelope = (text: string) => `<silvercode-result>${text}</silvercode-result>`
const quota = { error: { message: "Free usage limit reached", type: "quota_exceeded", code: "FreeUsageLimitError" } }
const config = (url: string) => ({
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    agent: { work: { finishTool: false } },
    provider: {
      opencode: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: url, apiKey: "public" },
        models: { "local-quota-test": { name: "q", limit: { context: 128000, output: 4096 }, cost: { input: 0, output: 0 } } },
      },
    },
    permission: { "*": "allow" },
  }),
})

describe("headless run provider retry delay (#555)", () => {
  const setup = (llm: { url: string }) => config(llm.url)

  cliIt.live("announces a long provider retry wait and keeps the retry policy", ({ llm, opencode }) =>
    Effect.gen(function* () {
      const env = setup(llm)
      yield* llm.text("initial session response")
      const first = yield* opencode.run("initial request", { timeoutMs: 20_000, model: "opencode/local-quota-test", env })
      expect(first.exitCode).toBe(0)
      yield* llm.error(429, quota, { "retry-after": "12" })
      yield* llm.text("recovered after the long wait")
      const result = yield* opencode.run("quota rejection", {
        timeoutMs: 40_000, extraArgs: ["--continue"], model: "opencode/local-quota-test", env,
      })
      // The CLI keeps its retry policy: it waits out the delay and then succeeds.
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("recovered after the long wait")
      expect(result.stderr).toMatch(/waiting about \d+s before retrying \(attempt 1\)/)
      expect(result.stderr).toContain("free usage limit reached")
      expect(result.stderr).not.toContain("quota_exceeded")
    }), 60_000)

  cliIt.live("announces a long retry-after that is not a free-tier quota too", ({ llm, opencode }) =>
    Effect.gen(function* () {
      const env = setup(llm)
      yield* llm.text("initial session response")
      const first = yield* opencode.run("initial request", { timeoutMs: 20_000, model: "opencode/local-quota-test", env })
      expect(first.exitCode).toBe(0)
      yield* llm.error(429, { error: { message: "Too many requests, try again later", type: "rate_limit_error" } }, { "retry-after": "12" })
      yield* llm.text("recovered after the long wait")
      const result = yield* opencode.run("rate limited", {
        timeoutMs: 40_000, extraArgs: ["--continue"], model: "opencode/local-quota-test", env, clockScale: 10,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toMatch(/waiting about \d+s before retrying \(attempt 1\): retrying after a provider error/)
      expect(result.stderr).not.toContain("Too many requests")
    }), 60_000)

  cliIt.live("stays silent and still retries through a short provider delay", ({ llm, opencode }) =>
    Effect.gen(function* () {
      const env = setup(llm)
      yield* llm.text("initial session response")
      const first = yield* opencode.run("initial request", { timeoutMs: 20_000, model: "opencode/local-quota-test", env })
      expect(first.exitCode).toBe(0)
      yield* llm.error(429, quota, { "retry-after": "1" })
      yield* llm.text("recovered after retry")
      const result = yield* opencode.run("short retry", {
        timeoutMs: 20_000, extraArgs: ["--continue"], model: "opencode/local-quota-test", env, clockScale: 10,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("recovered after retry")
      expect(result.stderr).not.toContain("waiting about")
    }), 60_000)

  cliIt.live("announces each long wait of a multi-step run, not only the first", ({ llm, opencode }) =>
    Effect.gen(function* () {
      yield* llm.error(429, quota, { "retry-after": "11" })
      yield* llm.push(reply().text("first step").tool("bash", { command: "printf step", description: "First step" }))
      yield* llm.error(429, quota, { "retry-after": "11" })
      yield* llm.text("done after two waits")
      const result = yield* opencode.run("two long waits", { timeoutMs: 50_000, extraArgs: ["--dangerously-skip-permissions"], clockScale: 10 })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("done after two waits")
      expect(result.stderr.match(/waiting about \d+s before retrying \(attempt 1\)/g)?.length).toBe(2)
    }), 90_000)

  cliIt.live("announces a long retry wait of a background child session, without raw provider text", ({ llm, opencode }) =>
    Effect.gen(function* () {
      const env = {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: { opencode: {
            npm: "@ai-sdk/openai-compatible", options: { baseURL: llm.url, apiKey: "public" },
            models: { "local-quota-test": { name: "q", limit: { context: 128000, output: 4096 }, cost: { input: 0, output: 0 } } },
          } },
          permission: { "*": "allow" },
          agent: { work: { finishTool: true }, general: { finishTool: true, permission: { task: "allow" } } },
        }),
      }
      yield* llm.push(reply().text("init").tool("finish", { reason: "success", result: "ok" }).stop())
      const first = yield* opencode.run("Research the initial session report", { model: "opencode/local-quota-test", env, timeoutMs: 20_000 })
      expect(first.exitCode).toBe(0)
      const opened = (body: Body, text: string) => body.messages?.at(-1)?.role === "user" && lastText(body).includes(text)
      const followed = (body: Body, text: string) => body.messages?.at(-1)?.role === "tool" && JSON.stringify(body).includes(text)
      yield* llm.pushMatch((hit) => opened(hit.body as Body, "Research the child wait report"), reply().tool("task", {
        description: "child wait probe", prompt: "Research CHILD_WAIT_INPUT", subagent_type: "general", background: true,
      }))
      yield* llm.pushMatch((hit) => followed(hit.body as Body, "child wait probe"), reply().tool("finish", {
        reason: "waiting_for_subagent", result: "Root awaits child",
      }))
      yield* llm.pushMatch((hit) => opened(hit.body as Body, "CHILD_WAIT_INPUT"),
        httpError(429, { error: { message: "Free usage limit reached CHILD_RAW_SECRET", type: "quota_exceeded", code: "FreeUsageLimitError" } }, { "retry-after": "12" }))
      yield* llm.pushMatch((hit) => opened(hit.body as Body, "CHILD_WAIT_INPUT"),
        reply().tool("finish", { reason: "success", result: envelope("child done") }).stop())
      yield* llm.pushMatch((hit) => lastText(hit.body as Body).includes("child done"),
        reply().text("ROOT_FINAL").tool("finish", { reason: "success", result: "done" }).stop())
      const result = yield* opencode.run("Research the child wait report", {
        timeoutMs: 50_000, extraArgs: ["--continue", "--dangerously-skip-permissions"], model: "opencode/local-quota-test", env, clockScale: 10,
      })
      // Retry policy unchanged: the child waits, retries and the run finishes.
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("ROOT_FINAL")
      expect(result.stderr).toMatch(/subagent waiting about \d+s before retrying \(attempt 1\): free usage limit reached/)
      expect(result.stderr).not.toContain("CHILD_RAW_SECRET")
      expect(result.stderr).not.toContain("quota_exceeded")
      expect(yield* llm.misses).toEqual([])
      expect(yield* llm.pending).toBe(0)
    }), 90_000)

  cliIt.live("fails fast instead of hanging when Zen quota reset exceeds the headless retry window", ({ llm, opencode }) =>
    Effect.gen(function* () {
      const env = setup(llm)
      yield* llm.error(
        429,
        {
          type: "error",
          error: {
            type: "FreeUsageLimitError",
            message: "Free usage limit reached. Subscribe to OpenCode Go for higher limits.",
          },
          metadata: {},
        },
        { "retry-after": "42504" },
      )
      const result = yield* opencode.run("Reply with exactly: OK", {
        timeoutMs: 25_000,
        model: "opencode/local-quota-test",
        env,
      })
      expect(result.exitCode).toBeGreaterThan(0)
      expect(result.stderr).toContain("Free usage limit reached")
      expect(result.stderr).not.toContain("waiting about")
      expect(result.durationMs).toBeLessThan(25_000)
      const primary = (yield* llm.hits).filter(
        (hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"),
      )
      expect(primary).toHaveLength(1)
      expect(yield* llm.misses).toEqual([])
      expect(yield* llm.pending).toBe(0)
    }), 45_000)

  cliIt.live("emits a json error event and exits nonzero when quota reset exceeds the headless retry window", ({ llm, opencode }) =>
    Effect.gen(function* () {
      const env = setup(llm)
      yield* llm.error(
        429,
        {
          type: "error",
          error: {
            type: "FreeUsageLimitError",
            message: "Free usage limit reached. Subscribe to OpenCode Go for higher limits.",
          },
          metadata: {},
        },
        { "retry-after": "42504" },
      )
      const result = yield* opencode.run("Reply with exactly: OK", {
        timeoutMs: 25_000,
        format: "json",
        model: "opencode/local-quota-test",
        env,
      })
      expect(result.exitCode).toBeGreaterThan(0)
      const events = opencode.parseJsonEvents(result.stdout)
      expect(events).toEqual([
        expect.objectContaining({
          type: "error",
          error: expect.objectContaining({
            name: "APIError",
            data: expect.objectContaining({
              message: expect.stringContaining("Free usage limit reached"),
            }),
          }),
        }),
      ])
      expect(result.durationMs).toBeLessThan(25_000)
    }), 45_000)

  cliIt.live("surfaces a background child quota reset exceeding the headless retry window without hanging", ({ llm, opencode }) =>
    Effect.gen(function* () {
      const env = {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: { opencode: {
            npm: "@ai-sdk/openai-compatible", options: { baseURL: llm.url, apiKey: "public" },
            models: { "local-quota-test": { name: "q", limit: { context: 128000, output: 4096 }, cost: { input: 0, output: 0 } } },
          } },
          permission: { "*": "allow" },
          agent: { work: { finishTool: true }, general: { finishTool: true, permission: { task: "allow" } } },
        }),
      }
      const opened = (body: Body, text: string) => body.messages?.at(-1)?.role === "user" && lastText(body).includes(text)
      const followed = (body: Body, text: string) => body.messages?.at(-1)?.role === "tool" && JSON.stringify(body).includes(text)
      yield* llm.pushMatch((hit) => opened(hit.body as Body, "Research the child quota failure"), reply().tool("task", {
        description: "child quota probe", prompt: "Research CHILD_QUOTA_INPUT", subagent_type: "general", background: true,
      }))
      yield* llm.pushMatch((hit) => followed(hit.body as Body, "child quota probe"), reply().tool("finish", {
        reason: "waiting_for_subagent", result: "Root awaits child",
      }))
      yield* llm.pushMatch((hit) => opened(hit.body as Body, "CHILD_QUOTA_INPUT"),
        httpError(
          429,
          {
            type: "error",
            error: {
              type: "FreeUsageLimitError",
              message: "Free usage limit reached. Subscribe to OpenCode Go for higher limits.",
            },
            metadata: {},
          },
          { "retry-after": "42504" },
        ))
      yield* llm.pushMatch((hit) => lastText(hit.body as Body).includes("Free usage limit reached"),
        reply().text("CHILD_QUOTA_SURFACED").tool("finish", { reason: "failure", result: "child quota failed" }).stop())
      const result = yield* opencode.run("Research the child quota failure", {
        timeoutMs: 25_000, extraArgs: ["--dangerously-skip-permissions"], model: "opencode/local-quota-test", env,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("CHILD_QUOTA_SURFACED")
      expect(result.stderr).not.toContain("waiting about")
      expect(result.durationMs).toBeLessThan(25_000)
      expect(yield* llm.misses).toEqual([])
      expect(yield* llm.pending).toBe(0)
    }), 60_000)

  cliIt.live("propagates the headless retry window to an attached server run", ({ llm, opencode }) =>
    Effect.gen(function* () {
      const env = setup(llm)
      const server = yield* opencode.serve({ env })
      yield* llm.error(
        429,
        {
          type: "error",
          error: {
            type: "FreeUsageLimitError",
            message: "Free usage limit reached. Subscribe to OpenCode Go for higher limits.",
          },
          metadata: {},
        },
        { "retry-after": "42504" },
      )
      const result = yield* opencode.run("Reply with exactly: OK", {
        timeoutMs: 25_000,
        extraArgs: ["--attach", server.url],
        model: "opencode/local-quota-test",
        env,
      })
      expect(result.exitCode).toBeGreaterThan(0)
      expect(result.stderr).toContain("Free usage limit reached")
      expect(result.stderr).not.toContain("waiting about")
      expect(result.durationMs).toBeLessThan(25_000)
      const primary = (yield* llm.hits).filter(
        (hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"),
      )
      expect(primary).toHaveLength(1)
      expect(yield* llm.misses).toEqual([])
      expect(yield* llm.pending).toBe(0)

      yield* llm.reset
      yield* llm.error(429, quota, { "retry-after": "15" })
      const capped = yield* opencode.run("Reply with exactly: OK", {
        timeoutMs: 10_000,
        extraArgs: ["--attach", server.url],
        model: "opencode/local-quota-test",
        env: { ...env, OPENCODE_EXPERIMENTAL_RETRY_MAX_DELAY_MS: "50" },
      })
      expect(capped.exitCode).toBeGreaterThan(0)
      expect(capped.stderr).toContain("Free usage limit reached")
      expect(capped.durationMs).toBeLessThan(10_000)
    }), 60_000)

  cliIt.live("does not leak a headless retry flag into child processes spawned during run", ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeFile(
          path.join(home, "check-env.mjs"),
          'console.log(JSON.stringify(Object.keys(process.env).filter((k) => k.includes("HEADLESS"))))\n',
        ),
      )
      yield* llm.tool("bash", {
        command: "bun check-env.mjs",
        description: "Check child process environment",
      })
      yield* llm.text("env checked")
      const result = yield* opencode.run("check child env", {
        timeoutMs: 25_000,
        extraArgs: ["--dir", home],
        format: "json",
        permission: { bash: "allow" },
      })
      opencode.expectExit(result, 0)
      const events = opencode.parseJsonEvents(result.stdout)
      const toolEvent = events.find((event) => event.type === "tool_use") as
        | { part?: { state?: { output?: string } } }
        | undefined
      expect(toolEvent?.part?.state?.output?.trim()).toBe("[]")
    }), 60_000)
})
