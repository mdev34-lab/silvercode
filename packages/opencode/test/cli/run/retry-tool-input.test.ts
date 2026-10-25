import { expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { reply, raw } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"

cliIt.live("finish recovers after a provider error interrupts tool arguments", ({ llm, opencode }) =>
  Effect.gen(function* () {
    yield* llm.pushMatch((hit) => Boolean((hit.body as { tools?: unknown[] }).tools?.length), raw({ chunks: [
      { id: "partial-retry", object: "chat.completion.chunk", created: 1, model: "retry-local", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "abandoned-arguments", type: "function", function: { name: "read", arguments: '{"filePath":' } }] }, finish_reason: null }] },
      { error: { type: "server_error", code: "server_error", message: "temporary server error" } },
    ] }))
    yield* llm.pushMatch((hit) => Boolean((hit.body as { tools?: unknown[] }).tools?.length), reply().text("RETRY_FINISH_RECOVERED").tool("finish", { reason: "success", result: "Recovered" }).stop())
    const result = yield* opencode.run("recover argument stream", {
      model: "opencode/retry-local", env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...testProviderConfig(llm.url), provider: { opencode: {
        npm: "@ai-sdk/openai-compatible", options: { baseURL: llm.url, apiKey: "public" },
        models: { "retry-local": { name: "retry local", limit: { context: 128000, output: 4096 }, cost: { input: 0, output: 0 } } },
      } }, agent: { work: { finishTool: true } } }) },
      format: "json", timeoutMs: 15_000,
    })
    opencode.expectExit(result, 0)
    expect(result.stdout).toContain("RETRY_FINISH_RECOVERED")
    expect(result.stdout).not.toContain("Tool execution aborted")
    const inputs = (yield* llm.inputs) as { tools?: unknown[] }[]
    expect(inputs.filter((body) => body.tools?.length).length).toBe(2)
    expect(yield* llm.pending).toBe(0)
    expect(yield* llm.misses).toEqual([])
  }), 30_000)

cliIt.live("text-only retry does not report an abandoned draft as an executed tool failure", ({ llm, opencode }) =>
  Effect.gen(function* () {
    yield* llm.pushMatch((hit) => Boolean((hit.body as { tools?: unknown[] }).tools?.length), raw({ chunks: [
      { id: "partial-retry", object: "chat.completion.chunk", created: 1, model: "retry-local", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "abandoned-arguments", type: "function", function: { name: "read", arguments: '{"filePath":' } }] }, finish_reason: null }] },
      { error: { type: "server_error", code: "server_error", message: "temporary server error" } },
    ] }))
    yield* llm.pushMatch((hit) => Boolean((hit.body as { tools?: unknown[] }).tools?.length), reply().text("RETRY_FINISH_RECOVERED").stop())
    const result = yield* opencode.run("recover argument stream", {
      model: "opencode/retry-local", env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...testProviderConfig(llm.url), provider: { opencode: {
        npm: "@ai-sdk/openai-compatible", options: { baseURL: llm.url, apiKey: "public" },
        models: { "retry-local": { name: "retry local", limit: { context: 128000, output: 4096 }, cost: { input: 0, output: 0 } } },
      } }, agent: { work: { finishTool: false } } }) },
      format: "json", timeoutMs: 15_000,
    })
    opencode.expectExit(result, 0)
    expect(result.stdout).toContain("RETRY_FINISH_RECOVERED")
    expect(result.stdout).not.toContain("Tool execution aborted")
    const inputs = (yield* llm.inputs) as { tools?: unknown[] }[]
    expect(inputs.filter((body) => body.tools?.length).length).toBe(2)
    expect(yield* llm.pending).toBe(0)
    expect(yield* llm.misses).toEqual([])
  }), 30_000)
