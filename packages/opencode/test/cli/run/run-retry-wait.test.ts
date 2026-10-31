import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { SessionRetry } from "../../../src/session/retry"
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
type Body = { model?: string; messages?: { role?: string; content?: unknown }[] }
type RequestHit = { url: URL; body: Record<string, unknown> }
const contentText = (content: unknown) => {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text ?? "") : ""))
      .join("\n")
  return content === undefined ? "" : JSON.stringify(content)
}
const childTaskPrompt = "Research CHILD_WAIT_INPUT"
const lastText = (body: Body) => {
  const content = body.messages?.at(-1)?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("\n")
  return ""
}
const lastUserText = (body: Body) => {
  const content = [...(body.messages ?? [])].reverse().find((message) => message.role === "user")?.content
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text ?? "") : ""))
      .join("\n")
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

const withCliOutputOnFailure = <A>(
  label: string,
  result: { exitCode: number; stdout: string; stderr: string; durationMs: number },
  assert: () => A,
  diagnostics: () => string,
): A => {
  try {
    return assert()
  } catch (error) {
    const tail = (value: string) => (value.length > 3000 ? `…${value.slice(-3000)}` : value)
    // eslint-disable-next-line no-console
    console.error(
      `[${label}] child exit=${result.exitCode} duration=${result.durationMs}ms\n` +
        `[${label}] child stdout tail:\n${tail(result.stdout) || "<empty>"}\n` +
        `[${label}] child stderr tail:\n${tail(result.stderr) || "<empty>"}\n` +
        `[${label}] mock request diagnostics:\n${diagnostics()}`,
    )
    throw error
  }
}

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
      // Retries may append assistant/tool messages after the stable first user turn.
      const opened = (body: Body, text: string) => lastUserText(body).includes(text)
      const followed = (body: Body, text: string) => body.messages?.at(-1)?.role === "tool" && JSON.stringify(body).includes(text)
      const childRequest = (hit: RequestHit) => {
        const body = hit.body as Body
        if (hit.url.pathname !== "/v1/chat/completions" || body.model !== "local-quota-test") return false
        const firstUser = body.messages?.find((message) => message.role === "user")
        return firstUser !== undefined && contentText(firstUser.content).startsWith(childTaskPrompt)
      }
      yield* llm.pushMatch((hit) => opened(hit.body as Body, "Research the child wait report"), reply().tool("task", {
        description: "child wait probe", prompt: childTaskPrompt, subagent_type: "general", background: true,
      }))
      yield* llm.pushMatch((hit) => followed(hit.body as Body, "child wait probe"), reply().tool("finish", {
        reason: "waiting_for_subagent", result: "Root awaits child",
      }))
      // Identify the child by the test-controlled task prompt, not by whichever
      // conversation happens to arrive when the 429 matcher is first selected.
      // The first user turn is stable across retries even as the transcript grows;
      // route/model plus this exact prompt prefix exclude root and auxiliary calls.
      yield* llm.pushMatch(childRequest,
        httpError(429, { error: { message: "Free usage limit reached CHILD_RAW_SECRET", type: "quota_exceeded", code: "FreeUsageLimitError" } }, { "retry-after": "12" }))
      // Reuse the recovery response only for that stable child identity, bounded
      // by the production retry cap.
      yield* llm.pushMatchRepeat(
        childRequest,
        reply().tool("finish", { reason: "success", result: envelope("child done") }).stop(),
        SessionRetry.RETRY_MAX_RETRIES,
      )
      yield* llm.pushMatch((hit) => lastText(hit.body as Body).includes("child done"),
        reply().text("ROOT_FINAL").tool("finish", { reason: "success", result: "done" }).stop())
      const result = yield* opencode.run("Research the child wait report", {
        timeoutMs: 50_000, extraArgs: ["--continue", "--dangerously-skip-permissions"], model: "opencode/local-quota-test", env, clockScale: 10,
      })
      // Retry policy unchanged: the child waits, retries and the run finishes.
      // Capture mock state before asserting so every failure below includes the
      // child process's stdout/stderr tails in the CI test output.
      const hits = yield* llm.hits
      const misses = yield* llm.misses
      const pending = yield* llm.pending
      const childRequestHits = hits.filter(childRequest)
      const requestDiagnostics = () => JSON.stringify({
        counts: {
          hits: hits.length,
          misses: misses.length,
          pending: pending,
          pendingDefinition: "queued one-shot responses only; bounded repeats are tracked separately",
          childRetryRequestHits: childRequestHits.length,
        },
        childRetryRequestFilter: {
          identity: "stable test-controlled content; no runtime conversation capture",
          conditions: [
            "route === /v1/chat/completions",
            "body.model === local-quota-test",
            `first role=user message content starts with ${JSON.stringify(childTaskPrompt)}`,
          ],
          stableKey: {
            route: "/v1/chat/completions",
            model: "local-quota-test",
            firstUserStartsWith: childTaskPrompt,
            systemPromptAndRequestMessageIdsAreNotPartOfThisFilter: true,
          },
        },
        misses: misses.map((miss, index) => ({
          miss: index + 1,
          route: miss.request.route,
          phase: miss.request.phase,
          model: miss.request.model,
          messageCount: miss.request.messageCount,
          finalRole: miss.request.finalRole,
          identifiers: miss.request.identifiers,
          actualKeyComponents: miss.request.keys,
          body: miss.body,
        })),
      }, null, 2)
      withCliOutputOnFailure("background child retry wait", result, () => {
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain("ROOT_FINAL")
        expect(result.stderr).toMatch(/subagent waiting about \d+s before retrying \(attempt 1\): free usage limit reached/)
        expect(result.stderr).not.toContain("CHILD_RAW_SECRET")
        expect(result.stderr).not.toContain("quota_exceeded")
        // Count the initial 429 plus retries, bounded by the unchanged production cap.
        // The repeated terminal response prevents extra attempts from falling through
        // to TestLLMServer's default "ok" stream under runner load.
        expect(childRequestHits.length).toBeGreaterThanOrEqual(2)
        expect(childRequestHits.length).toBeLessThanOrEqual(SessionRetry.RETRY_MAX_RETRIES + 1)
        expect(misses).toEqual([])
        expect(pending).toBe(0)
      }, requestDiagnostics)
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
