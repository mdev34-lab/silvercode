import { expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"

function finishConfig(url: string) {
  const config = testProviderConfig(url)
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      agent: { ...config.agent, work: { finishTool: true } },
    }),
  }
}

cliIt.live("headless finish does not repeat an already printed multi-paragraph answer", ({ llm, opencode }) =>
  Effect.gen(function* () {
    const answer = "First paragraph of the answer.\n\nSecond paragraph of the answer."
    yield* llm.push(reply().text(answer).tool("finish", { reason: "success", result: answer }).stop())

    const result = yield* opencode.run("Summarize the result", { env: finishConfig(llm.url) })

    opencode.expectExit(result, 0)
    expect(result.stdout).toBe(`${answer}\n`)
    expect(result.stderr).toContain("Task completed")
    expect(result.stderr).toContain("[effort ")
    expect(result.stderr).not.toContain("First paragraph of the answer.")
    expect(result.stderr).not.toContain("Second paragraph of the answer.")
    expect(yield* llm.misses).toEqual([])
    expect(yield* llm.pending).toBe(0)
  }),
)

cliIt.live("headless finish keeps new details after the repeated answer", ({ llm, opencode }) =>
  Effect.gen(function* () {
    const answer = "First paragraph.\n\nSecond paragraph."
    yield* llm.push(
      reply()
        .text(answer)
        .tool("finish", { reason: "success", result: `${answer}\n\nAdditional detail.` })
        .stop(),
    )

    const result = yield* opencode.run("Summarize the result", { env: finishConfig(llm.url) })

    opencode.expectExit(result, 0)
    expect(result.stdout).toBe(`${answer}\n`)
    expect(result.stderr).not.toContain("First paragraph.")
    expect(result.stderr).not.toContain("Second paragraph.")
    expect(result.stderr).toContain("Additional detail.")
    expect(result.stderr).toContain("[effort ")
    expect(yield* llm.misses).toEqual([])
    expect(yield* llm.pending).toBe(0)
  }),
)

cliIt.live("headless finish keeps a distinct result that shares an answer prefix", ({ llm, opencode }) =>
  Effect.gen(function* () {
    const answer = "First paragraph.\n\nSecond paragraph"
    const finishResult = `${answer}, with more detail.`
    yield* llm.push(reply().text(answer).tool("finish", { reason: "success", result: finishResult }).stop())

    const result = yield* opencode.run("Summarize the result", { env: finishConfig(llm.url) })

    opencode.expectExit(result, 0)
    expect(result.stdout).toBe(`${answer}\n`)
    expect(result.stderr).toContain(finishResult)
    expect(result.stderr).toContain("[effort ")
    expect(yield* llm.misses).toEqual([])
    expect(yield* llm.pending).toBe(0)
  }),
)

cliIt.live("JSON finish events retain the complete raw result", ({ llm, opencode }) =>
  Effect.gen(function* () {
    const answer = "First paragraph.\n\nSecond paragraph."
    yield* llm.push(reply().text(answer).tool("finish", { reason: "success", result: answer }).stop())

    const result = yield* opencode.run("Summarize the result", { format: "json", env: finishConfig(llm.url) })

    opencode.expectExit(result, 0)
    const events = opencode.parseJsonEvents(result.stdout)
    expect(events.map((event) => event.type)).toEqual(["step_start", "text", "tool_use", "step_finish"])
    expect(events[1]?.part).toEqual(expect.objectContaining({ type: "text", text: answer }))
    expect(events[2]?.part).toEqual(
      expect.objectContaining({
        type: "tool",
        tool: "finish",
        state: expect.objectContaining({
          status: "completed",
          input: expect.objectContaining({ result: answer }),
          output: expect.stringContaining(answer),
        }),
      }),
    )
    expect(yield* llm.misses).toEqual([])
    expect(yield* llm.pending).toBe(0)
  }),
)
