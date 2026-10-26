import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"

// #555: a provider quota rejection that asks for a long retry delay must not
// leave a headless run silent until it is killed.
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
        timeoutMs: 40_000, extraArgs: ["--continue"], model: "opencode/local-quota-test", env,
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
        timeoutMs: 20_000, extraArgs: ["--continue"], model: "opencode/local-quota-test", env,
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
      const result = yield* opencode.run("two long waits", { timeoutMs: 50_000, extraArgs: ["--dangerously-skip-permissions"] })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("done after two waits")
      expect(result.stderr.match(/waiting about \d+s before retrying \(attempt 1\)/g)?.length).toBe(2)
    }), 90_000)
})
