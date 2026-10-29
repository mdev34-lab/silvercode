import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { raw, reply } from "../../lib/llm-server"

type Body = { messages?: { role?: string; content?: unknown }[] }
const lastText = (body: Body) => {
  const content = body.messages?.at(-1)?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("\n")
  return ""
}
const envelope = (text: string) => `<silvercode-result>${text}</silvercode-result>`

// A bounded local investigation case for #555, not a claim to reproduce its
// original long-running multi-agent database or a live provider quota failure.
describe("continued nested session quota handling (#555)", () => {
  cliIt.live("surfaces a grandchild's pre-content quota rejection through the real Zen adapter", ({ llm, opencode }) =>
    Effect.gen(function* () {
      const env = {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: { opencode: {
            npm: "@ai-sdk/openai-compatible", options: { baseURL: llm.url, apiKey: "public" },
            models: { "local-quota-test": { name: "local quota test", limit: { context: 128000, output: 4096 }, cost: { input: 0, output: 0 } } },
          } },
          permission: { "*": "allow" }, subagent_depth: 2,
          agent: {
            work: { finishTool: true },
            general: { finishTool: true, permission: { task: "allow" } },
          },
        }),
      }
      yield* llm.push(reply().text("Initial session completed.").tool("finish", { reason: "success", result: "Initial done" }).stop())
      const first = yield* opencode.run("Research the initial session report", { model: "opencode/local-quota-test", env, timeoutMs: 20_000 })
      opencode.expectExit(first, 0)
      const opened = (body: Body, text: string) => body.messages?.at(-1)?.role === "user" && lastText(body).includes(text)
      const followed = (body: Body, text: string) => body.messages?.at(-1)?.role === "tool" && JSON.stringify(body).includes(text)
      yield* llm.pushMatch((hit) => opened(hit.body as Body, "Research the nested investigation report"), reply().tool("task", {
        description: "child quota investigation", prompt: "delegate quota grandchild", subagent_type: "general", background: true,
      }))
      yield* llm.pushMatch((hit) => opened(hit.body as Body, "delegate quota grandchild"), reply().tool("task", {
        description: "grandchild quota investigation", prompt: "grandchild quota input", subagent_type: "general", background: true,
      }))
      yield* llm.pushMatch((hit) => followed(hit.body as Body, "child quota investigation"), reply().tool("finish", {
        reason: "waiting_for_subagent", result: "Root awaits child",
      }))
      yield* llm.pushMatch((hit) => followed(hit.body as Body, "grandchild quota investigation"), reply().tool("finish", {
        reason: "waiting_for_subagent", result: envelope("Child awaits grandchild"),
      }))
      yield* llm.pushMatch((hit) => opened(hit.body as Body, "grandchild quota input"), raw({ chunks: [
        { error: { message: "Free usage limit reached LOCAL_NESTED_QUOTA", type: "quota_exceeded", code: "FreeUsageLimitError" } },
      ] }))
      // A wait refused because the grandchild already settled can still be
      // followed by the deferred <task state="error"> wake turn (#511). Keep
      // separate matchers for the optional refusal turn and the mandatory
      // quota-error delivery so every scheduling order finishes cleanly.
      let quotaDelivered!: () => void
      const quotaDeliveredGate = new Promise<void>((resolve) => {
        quotaDelivered = resolve
      })
      let guardRefused = false
      yield* llm.pushMatch(
        (hit) => {
          if (!lastText(hit.body as Body).includes("has no background subagents of its own")) return false
          guardRefused = true
          return true
        },
        reply().tool("finish", { reason: "failure", result: envelope("Child failed: LOCAL_CHILD_QUOTA") }).stop(),
      )
      yield* llm.pushMatch(
        (hit) => {
          if (!lastText(hit.body as Body).includes("LOCAL_NESTED_QUOTA")) return false
          quotaDelivered()
          return true
        },
        reply().tool("finish", { reason: "failure", result: envelope("Child failed: LOCAL_CHILD_QUOTA") }).stop(),
      )
      yield* llm.pushMatch(
        (hit) => lastText(hit.body as Body).includes("LOCAL_CHILD_QUOTA"),
        reply()
          .wait(quotaDeliveredGate)
          .text("LOCAL_ROOT_QUOTA_SURFACED")
          .tool("finish", { reason: "failure", result: "Nested provider quota surfaced" })
          .stop(),
      )
      const result = yield* opencode.run("Research the nested investigation report", {
        model: "opencode/local-quota-test", extraArgs: ["--continue", "--dangerously-skip-permissions"], env, timeoutMs: 25_000,
      })
      // A parent can handle a child failure and finish its own turn. The CLI's
      // declared-failure exit policy is separate from whether the quota error
      // reaches the parent, so assert the delivered error and bounded exit.
      expect(result.durationMs).toBeLessThan(25_000)
      expect(result.stdout + result.stderr).toContain("LOCAL_ROOT_QUOTA_SURFACED")
      const inputs = (yield* llm.inputs) as Body[]
      const quotaDelivery = inputs.map(lastText).find((text) => text.includes("LOCAL_NESTED_QUOTA"))
      expect(quotaDelivery).toContain('state="error"')
      expect(quotaDelivery).toContain("<task_error>")
      expect(yield* llm.misses).toEqual([])
      expect(yield* llm.pending).toBe(guardRefused ? 0 : 1)
    }), 60_000)
})
