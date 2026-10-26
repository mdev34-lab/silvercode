import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

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
  cliIt.live("fails fast with the provider message when the retry delay is far too long", ({ llm, opencode }) =>
    Effect.gen(function* () {
      const env = config(llm.url)
      yield* llm.text("initial session response")
      const first = yield* opencode.run("initial request", { timeoutMs: 20_000, model: "opencode/local-quota-test", env })
      expect(first.exitCode).toBe(0)
      yield* llm.error(429, quota, { "retry-after": "3600" })
      const result = yield* opencode.run("quota rejection", {
        timeoutMs: 20_000, extraArgs: ["--continue"], model: "opencode/local-quota-test", env,
      })
      expect(result.exitCode).toBe(1)
      expect(result.durationMs).toBeLessThan(15_000)
      expect(result.stderr).toContain("Free usage")
      expect(result.stderr).toContain("not waiting")
    }), 60_000)

  cliIt.live("still waits through a short provider retry delay", ({ llm, opencode }) =>
    Effect.gen(function* () {
      const env = config(llm.url)
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
      expect(result.stderr).not.toContain("not waiting")
    }), 60_000)

  cliIt.live("keeps waiting on a long retry-after that is not a free-tier quota", ({ llm, opencode }) =>
    Effect.gen(function* () {
      const env = config(llm.url)
      yield* llm.text("initial session response")
      const first = yield* opencode.run("initial request", { timeoutMs: 20_000, model: "opencode/local-quota-test", env })
      expect(first.exitCode).toBe(0)
      yield* llm.error(429, { error: { message: "Too many requests, try again later", type: "rate_limit_error" } }, { "retry-after": "3600" })
      const result = yield* opencode.run("rate limited", {
        timeoutMs: 8_000, extraArgs: ["--continue"], model: "opencode/local-quota-test", env,
      })
      // Still inside the provider's requested wait when the harness stops it: not aborted by run.
      expect(result.exitCode).not.toBe(1)
      expect(result.stderr).not.toContain("not waiting")
    }), 60_000)
})
