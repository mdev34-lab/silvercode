import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Model } from "@opencode-ai/llm"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Config } from "@opencode-ai/core/config"
import { ConfigContext } from "@opencode-ai/core/config/context"
import { SessionContextReduction } from "@opencode-ai/core/session/context-reduction"
import { SessionMessage } from "@opencode-ai/core/session/message"

const created = DateTime.makeUnsafe(0)
const time = { created }
const model = { id: ModelV2.ID.make("model"), providerID: Provider.ID.make("provider") }

const windowModel = (context: number, output = 0) =>
  Model.make({
    id: "context-reduction",
    provider: "test",
    route: OpenAIChat.route.with({ limits: { context, output } }),
  })

const user = (text: string) =>
  SessionMessage.User.make({ id: SessionMessage.ID.create(), type: "user", text, files: [], agents: [], time })

const assistant = (content: SessionMessage.AssistantContent[]) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: "work",
    model,
    content,
    time,
  })

const text = (value: string): SessionMessage.AssistantText =>
  SessionMessage.AssistantText.make({ type: "text", id: "text-" + value.length, text: value })

const completed = (id: string, name: string, input: Record<string, unknown>, output: string) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id,
    name,
    state: {
      status: "completed",
      input,
      structured: {},
      content: [{ type: "text", text: output }],
    },
    time,
  })

const failed = (id: string, name: string, input: Record<string, unknown>) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id,
    name,
    state: {
      status: "error",
      input,
      structured: {},
      content: [],
      error: { type: "unknown", message: "boom" },
    },
    time,
  })

const policy = (overrides: Partial<SessionContextReduction.Policy> = {}): SessionContextReduction.Policy =>
  SessionContextReduction.policy([
    new Config.Document({ type: "document", info: new Config.Info({ context: contextConfig(overrides) }) }),
  ])

const contextConfig = (overrides: Partial<SessionContextReduction.Policy>) => {
  const reduction =
    overrides.enabled === undefined && overrides.threshold === undefined && overrides.errorTurns === undefined
      ? undefined
      : new ConfigContext.Reduction({
          enabled: overrides.enabled,
          threshold: overrides.threshold,
          error_turns: overrides.errorTurns,
        })
  const protection = overrides.protection
    ? new ConfigContext.Protection({
        recent_turns: overrides.protection.recentTurns,
        tools: [...overrides.protection.tools],
        files: [...overrides.protection.files],
      })
    : undefined
  return new ConfigContext.Info({ reduction, protection })
}

const reduce = (input: {
  messages: readonly SessionMessage.Message[]
  model?: ReturnType<typeof windowModel>
  policy?: SessionContextReduction.Policy
  envelope?: SessionContextReduction.Envelope
}) =>
  SessionContextReduction.reduce({
    messages: input.messages,
    envelope: input.envelope ?? {},
    model: input.model ?? windowModel(200_000),
    policy: input.policy ?? policy(),
  })

const outputText = (message: SessionMessage.Message) => {
  if (message.type !== "assistant") return []
  return message.content.flatMap((part) =>
    part.type === "tool" && part.state.status === "completed"
      ? part.state.content.flatMap((item) => (item.type === "text" ? [item.text] : []))
      : [],
  )
}

const big = (label: string, size = 4_000) => `${label} ${"x".repeat(size)}`

describe("SessionContextReduction", () => {
  test("sends canonical history untouched when the request fits the usable window", () => {
    const messages = [user("hello"), assistant([text("hi")])]
    const result = reduce({ messages, model: windowModel(200_000) })
    expect(result.messages).toBe(messages)
    expect(result.report.outcome).toBe("untouched")
    expect(result.report.reclaimedTokens).toBe(0)
  })

  test("reports as sent when the model declares no usable window", () => {
    const messages = [user(big("question")), assistant([text(big("answer"))])]
    const result = reduce({ messages, model: Model.make({ id: "unknown", provider: "test", route: OpenAIChat.route }) })
    expect(result.messages).toBe(messages)
    expect(result.report.outcome).toBe("untouched")
    expect(result.report.reclaimedTokens).toBe(0)
    expect(result.report.limit).toBeUndefined()
    expect(result.report.utilization).toBe(0)
  })

  test("counts the prompt envelope the runner declares against the same window", () => {
    const messages = [user("hello"), assistant([text("hi")])]
    const result = reduce({
      messages,
      model: windowModel(100_000),
      envelope: { system: big("system", 500_000), tools: [{ name: "read" }] },
    })
    expect(result.report.overheadTokens).toBeGreaterThan(70_000)
    // The conversation is only protected content, so the envelope alone cannot be reduced away.
    expect(result.messages).toBe(messages)
    expect(result.report.outcome).toBe("exhausted")
  })

  test("prunes superseded duplicate outputs and keeps the newest one verbatim", () => {
    const messages = [
      user("read it twice"),
      assistant([completed("call-1", "read", { file: "/a.ts" }, big("first"))]),
      user("again"),
      assistant([completed("call-2", "read", { file: "/a.ts" }, big("second"))]),
      user("and once more"),
      assistant([text("done")]),
    ]
    const result = reduce({
      messages,
      model: windowModel(2_000),
      policy: policy({ protection: { recentTurns: 1, tools: [], files: [] } }),
    })
    expect(result.report.outcome).toBe("reduced")
    expect(outputText(result.messages[1])).toEqual([SessionContextReduction.DUPLICATE_MARKER])
    expect(outputText(result.messages[3])[0]).toContain("second")
    expect(result.report.reclaimedTokens).toBeGreaterThan(0)
  })

  test("never deduplicates tools whose result depends on external state", () => {
    const messages = [
      user("run it twice"),
      assistant([completed("call-1", "bash", { command: "ls" }, big("first"))]),
      user("again"),
      assistant([completed("call-2", "bash", { command: "ls" }, big("second"))]),
      user("thanks"),
      assistant([text("done")]),
    ]
    const result = reduce({
      messages,
      model: windowModel(2_000),
      policy: policy({ protection: { recentTurns: 1, tools: [], files: [] } }),
    })
    expect(outputText(result.messages[1])).not.toContain(SessionContextReduction.DUPLICATE_MARKER)
    expect(outputText(result.messages[3])[0]).toContain("second")
  })

  test("purges the input of a stale failed call but keeps its error", () => {
    const messages = [
      user("try it"),
      assistant([failed("call-1", "bash", { command: big("script", 8_000) })]),
      user("next"),
      assistant([text("ok")]),
      user("next"),
      assistant([text("ok")]),
    ]
    const result = reduce({
      messages,
      model: windowModel(2_000),
      policy: policy({ errorTurns: 1, protection: { recentTurns: 1, tools: [], files: [] } }),
    })
    const part = result.messages[1]
    expect(part.type).toBe("assistant")
    const tool = part.type === "assistant" ? part.content[0] : undefined
    expect(tool?.type === "tool" && tool.state.status === "error" && tool.state.input).toEqual({
      purged: SessionContextReduction.PURGED_INPUT_MARKER,
    })
  })

  test("truncates an oversized stale output to its head and tail", () => {
    const messages = [
      user("read the file"),
      assistant([completed("call-1", "read", { file: "/big.ts" }, big("head", 6_000) + big("tail", 6_000))]),
      user("next"),
      assistant([text("ok")]),
      user("next"),
      assistant([text("ok")]),
    ]
    const result = reduce({
      messages,
      model: windowModel(2_000),
      policy: policy({ protection: { recentTurns: 1, tools: [], files: [] } }),
    })
    const output = outputText(result.messages[1])[0]
    expect(output).toContain(SessionContextReduction.TRUNCATED_MARKER)
    expect(output.length).toBeLessThan(1_000)
  })

  test("drops the oldest unprotected messages when content rungs cannot reach the threshold", () => {
    const messages = [
      user(big("old question")),
      assistant([text(big("old answer"))]),
      user("recent question"),
      assistant([text("recent answer")]),
      user("latest question"),
      assistant([text("latest answer")]),
    ]
    const result = reduce({
      messages,
      model: windowModel(2_000),
      policy: policy({ protection: { recentTurns: 1, tools: [], files: [] } }),
    })
    expect(result.report.outcome).toBe("reduced")
    expect(result.messages.length).toBeLessThan(messages.length)
    // The newest user input and the newest assistant turn always survive.
    expect(result.messages.at(-2)?.type).toBe("user")
    expect(result.messages.at(-1)?.type).toBe("assistant")
  })

  test("exhausts rather than pruning protected content", () => {
    const messages = [
      user(big("question")),
      assistant([completed("call-1", "write", { file: "/a.ts" }, big("written"))]),
      user("latest"),
      assistant([text(big("answer"))]),
    ]
    const result = reduce({
      messages,
      model: windowModel(3_000),
      policy: policy({ protection: { recentTurns: 4, tools: [], files: [] } }),
    })
    expect(result.report.outcome).toBe("exhausted")
    expect(result.messages).toBe(messages)
  })

  test("keeps protected tools and file-pattern matches intact", () => {
    const messages = [
      user("patch it"),
      assistant([completed("call-1", "apply_patch", { file: "/a.ts" }, big("patched"))]),
      user("read it"),
      assistant([completed("call-2", "read", { file: "/secrets/a.ts" }, big("secret"))]),
      user("next"),
      assistant([text("ok")]),
    ]
    const result = reduce({
      messages,
      model: windowModel(3_000),
      policy: policy({ protection: { recentTurns: 0, tools: [], files: ["**/secrets/**"] } }),
    })
    expect(outputText(result.messages[1])[0]).toContain("patched")
    expect(outputText(result.messages[3])[0]).toContain("secret")
  })

  test("is deterministic: the same history and policy always produce the same projection", () => {
    const history = [
      user("read it"),
      assistant([completed("call-1", "read", { file: "/a.ts" }, big("first"))]),
      user("again"),
      assistant([completed("call-2", "read", { file: "/a.ts" }, big("second"))]),
      user("next"),
      assistant([text("ok")]),
    ]
    const options = {
      model: windowModel(2_000),
      policy: policy({ protection: { recentTurns: 1, tools: [], files: [] } }),
    }
    const first = reduce({ messages: history, ...options })
    const second = reduce({ messages: history, ...options })
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages))
    expect(second.report).toEqual(first.report)
  })

  test("does not modify canonical history", () => {
    const messages = [
      user("read it"),
      assistant([completed("call-1", "read", { file: "/a.ts" }, big("first"))]),
      user("again"),
      assistant([completed("call-2", "read", { file: "/a.ts" }, big("second"))]),
      user("next"),
      assistant([text("ok")]),
    ]
    const snapshot = JSON.stringify(messages)
    reduce({
      messages,
      model: windowModel(2_000),
      policy: policy({ protection: { recentTurns: 1, tools: [], files: [] } }),
    })
    expect(JSON.stringify(messages)).toBe(snapshot)
  })

  test("stays reduced as the session grows: a projection never comes back", () => {
    const base = [
      user("read it"),
      assistant([completed("call-1", "read", { file: "/a.ts" }, big("first"))]),
      user("again"),
      assistant([completed("call-2", "read", { file: "/a.ts" }, big("second"))]),
      user("next"),
      assistant([text("ok")]),
    ]
    const model = windowModel(2_000)
    const options = { model, policy: policy({ protection: { recentTurns: 1, tools: [], files: [] } }) }
    const before = reduce({ messages: base, ...options })
    const after = reduce({ messages: [...base, user("another"), assistant([text("sure")])], ...options })
    expect(outputText(before.messages[1])).toEqual([SessionContextReduction.DUPLICATE_MARKER])
    expect(outputText(after.messages[1])).toEqual([SessionContextReduction.DUPLICATE_MARKER])
  })

  test("uses the projection the request sends when measuring tool outputs", () => {
    // `result` is stored beside the provider-visible payload but never reaches a provider, so it
    // must not be priced into the budget.
    const oversized = completed("call-1", "read", { file: "/a.ts" }, "small output")
    const messages = [
      user("read it"),
      assistant([{ ...oversized, state: { ...oversized.state, result: { blob: "y".repeat(100_000) } } as typeof oversized.state }]),
      user("next"),
      assistant([text("ok")]),
    ]
    const result = reduce({ messages, model: windowModel(2_000) })
    expect(result.report.outcome).toBe("untouched")
  })
})

describe("SessionContextReduction.policy", () => {
  test("folds documents last-wins for scalars and accumulates protection", () => {
    const entries = [
      new Config.Document({
        type: "document",
        info: new Config.Info({
          context: new ConfigContext.Info({
            reduction: new ConfigContext.Reduction({ threshold: 0.5 }),
            protection: new ConfigContext.Protection({ tools: ["read"] }),
          }),
        }),
      }),
      new Config.Document({
        type: "document",
        info: new Config.Info({
          context: new ConfigContext.Info({
            reduction: new ConfigContext.Reduction({ threshold: 0.25 }),
            protection: new ConfigContext.Protection({ tools: ["glob"], files: ["**/*.md"] }),
          }),
        }),
      }),
    ]
    const folded = SessionContextReduction.policy(entries)
    expect(folded.threshold).toBe(0.25)
    expect(folded.protection.tools).toContain("read")
    expect(folded.protection.tools).toContain("glob")
    expect(folded.protection.tools).toContain("apply_patch")
    expect(folded.protection.files).toEqual(["**/*.md"])
  })

  test("defaults to enabled with a threshold that leaves response headroom", () => {
    expect(SessionContextReduction.policy([])).toMatchObject({ enabled: true, threshold: 0.8 })
  })

  test("can be disabled", () => {
    const messages = [user(big("question")), assistant([completed("call-1", "read", { file: "/a.ts" }, big("out"))])]
    const result = reduce({
      messages,
      model: windowModel(1_000),
      policy: policy({ enabled: false }),
    })
    expect(result.messages).toBe(messages)
    expect(result.report.outcome).toBe("untouched")
  })
})
