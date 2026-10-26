import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { httpError, reply } from "../../lib/llm-server"

// #555: a provider quota rejection that asks for a long retry delay must not
// leave a headless run silent until it is killed.
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
        timeoutMs: 50_000, extraArgs: ["--continue", "--dangerously-skip-permissions"], model: "opencode/local-quota-test", env,
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
})
