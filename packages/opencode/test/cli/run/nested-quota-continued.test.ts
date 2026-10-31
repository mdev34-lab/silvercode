import { Database } from "bun:sqlite"
import { describe, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
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

function gate() {
  let resolve!: () => void
  const ready = new Promise<void>((r) => {
    resolve = r
  })
  return { ready, resolve }
}

function hasCompletedChildYield(dbFile: string): boolean {
  if (!fs.existsSync(dbFile)) return false
  let db: Database | undefined
  try {
    db = new Database(dbFile)
    const row = db
      .query(
        `SELECT 1 FROM part WHERE data LIKE '%Child awaits grandchild%' AND data LIKE '%"status":"completed"%' LIMIT 1`,
      )
      .get()
    return row !== null && row !== undefined
  } catch {
    return false
  } finally {
    try {
      db?.close()
    } catch {}
  }
}

// A bounded local investigation case for #555, not a claim to reproduce its
// original long-running multi-agent database or a live provider quota failure.
describe("continued nested session quota handling (#555)", () => {
  cliIt.live(
    "surfaces a grandchild's pre-content quota rejection through the real Zen adapter",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        const dbFile = path.join(home, "nested-quota.db")
        const env = {
          OPENCODE_DB: dbFile,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
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
            subagent_depth: 2,
            agent: {
              work: { finishTool: true },
              general: { finishTool: true, permission: { task: "allow" } },
            },
          }),
        }
        yield* llm.push(
          reply().text("Initial session completed.").tool("finish", { reason: "success", result: "Initial done" }).stop(),
        )
        const first = yield* opencode.run("Research the initial session report", {
          model: "opencode/local-quota-test",
          env,
          timeoutMs: 20_000,
        })
        console.error("probe child output:", JSON.stringify({ exitCode: first.exitCode, stdout: first.stdout, stderr: first.stderr }))
        opencode.expectExit(first, 0)

        const grandchildStarted = gate()
        const poll = { stopped: false }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            poll.stopped = true
          }),
        )
        const childParked = (async () => {
          await grandchildStarted.ready
          while (!poll.stopped) {
            if (hasCompletedChildYield(dbFile)) return
            await new Promise((r) => setTimeout(r, 20))
          }
        })()

        const opened = (body: Body, text: string) =>
          body.messages?.at(-1)?.role === "user" && lastText(body).includes(text)
        const followed = (body: Body, text: string) =>
          body.messages?.at(-1)?.role === "tool" && JSON.stringify(body).includes(text)

        yield* llm.pushMatch(
          (hit) => opened(hit.body as Body, "Research the nested investigation report"),
          reply().tool("task", {
            description: "child quota investigation",
            prompt: "delegate quota grandchild",
            subagent_type: "general",
            background: true,
          }),
        )
        yield* llm.pushMatch(
          (hit) => opened(hit.body as Body, "delegate quota grandchild"),
          reply().tool("task", {
            description: "grandchild quota investigation",
            prompt: "grandchild quota input",
            subagent_type: "general",
            background: true,
          }),
        )
        yield* llm.pushMatch(
          (hit) => followed(hit.body as Body, "child quota investigation"),
          reply().tool("finish", {
            reason: "waiting_for_subagent",
            result: "Root awaits child",
          }),
        )
        yield* llm.pushMatch(
          (hit) => followed(hit.body as Body, "grandchild quota investigation"),
          reply()
            .wait(grandchildStarted.ready)
            .tool("finish", {
              reason: "waiting_for_subagent",
              result: envelope("Child awaits grandchild"),
            }),
        )
        // Hold the grandchild's SSE error stream open until the child's
        // finish(waiting_for_subagent) tool part is persisted as completed,
        // ordering the flow deterministically without predicate side effects.
        yield* llm.pushMatch(
          (hit) => opened(hit.body as Body, "grandchild quota input"),
          raw({
            onSend: grandchildStarted.resolve,
            wait: childParked,
            tail: [
              {
                error: {
                  message: "Free usage limit reached LOCAL_NESTED_QUOTA",
                  type: "quota_exceeded",
                  code: "FreeUsageLimitError",
                },
              },
            ],
          }),
        )
        yield* llm.pushMatch(
          (hit) => lastText(hit.body as Body).includes("LOCAL_NESTED_QUOTA"),
          reply().tool("finish", { reason: "failure", result: envelope("Child failed: LOCAL_CHILD_QUOTA") }).stop(),
        )
        yield* llm.pushMatch(
          (hit) => lastText(hit.body as Body).includes("LOCAL_CHILD_QUOTA"),
          reply()
            .text("LOCAL_ROOT_QUOTA_SURFACED")
            .tool("finish", { reason: "failure", result: "Nested provider quota surfaced" })
            .stop(),
        )
        const result = yield* opencode.run("Research the nested investigation report", {
          model: "opencode/local-quota-test",
          extraArgs: ["--continue", "--dangerously-skip-permissions"],
          env,
          timeoutMs: 25_000,
        })
        // A parent can handle a child failure and finish its own turn. The CLI's
        // declared-failure exit policy is separate from whether the quota error
        // reaches the parent, so assert the delivered error and bounded exit.
        console.error("probe child output:", JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }))
        expect(result.durationMs).toBeLessThan(25_000)
        expect(result.stdout + result.stderr).toContain("LOCAL_ROOT_QUOTA_SURFACED")
        const inputs = (yield* llm.inputs) as Body[]
        const quotaDelivery = inputs.map(lastText).find((text) => text.includes("LOCAL_NESTED_QUOTA"))
        expect(quotaDelivery).toContain('state="error"')
        expect(quotaDelivery).toContain("<task_error>")
        expect(yield* llm.misses).toEqual([])
        expect(yield* llm.pending).toBe(0)
      }),
    60_000,
  )
})
