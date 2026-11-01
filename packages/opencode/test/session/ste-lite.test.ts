import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { jsonSchema } from "ai"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigParse } from "../../src/config/parse"
import { LLMRequestPrep } from "@/session/llm/request"
import { SystemPrompt } from "@/session/system"
import DEFAULT_PROMPT from "../../src/session/prompt/default.txt"
import TRINITY_PROMPT from "../../src/session/prompt/trinity.txt"
import REVIEW_PROMPT from "../../src/agent/prompt/review.txt"
import type { Provider } from "@/provider/provider"

const MARKER = "Do not apply this style to deliverables"

const model = {
  id: "test/test-model",
  providerID: "test",
  api: {
    id: "test-model",
    url: "https://api.test.com",
    npm: "@ai-sdk/openai-compatible",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 8_192 },
  status: "active",
  options: {},
  headers: {},
} as Provider.Model

const prepare = (input?: { steLite?: boolean; prompt?: string; system?: string[] }) =>
  LLMRequestPrep.prepare({
    user: {
      id: "msg_user-test",
      sessionID: "ses_test",
      role: "user",
      time: { created: Date.now() },
      agent: "work",
      model: { providerID: "test", modelID: "test-model" },
    } as any,
    sessionID: "ses_test",
    model,
    agent: {
      name: "work",
      mode: "primary",
      options: {},
      permission: [],
      prompt: input?.prompt,
    } as any,
    system: input?.system ?? [],
    messages: [{ role: "user", content: "Hello" }],
    tools: {
      lookup: {
        description: "Look up a value",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
      },
    },
    provider: { id: "test", options: {} } as any,
    auth: undefined,
    plugin: {
      trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
      list: () => Effect.succeed([]),
      init: () => Effect.void,
    } as any,
    flags: { outputTokenMax: 32_000, client: "test" } as any,
    isWorkflow: false,
    steLite: input?.steLite,
  })

describe("ste-lite", () => {
  test("config accepts ste_lite", () => {
    expect(ConfigParse.schema(ConfigV1.Info, {}, "test").ste_lite).toBeUndefined()
    expect(ConfigParse.schema(ConfigV1.Info, { ste_lite: true }, "test").ste_lite).toBe(true)
    expect(ConfigParse.schema(ConfigV1.Info, { ste_lite: false }, "test").ste_lite).toBe(false)
  })

  test("chat style is on for user-facing replies and off for internal generations", () => {
    expect(SystemPrompt.chat({})).toBe(true)
    expect(SystemPrompt.chat({ config: false })).toBe(false)
    expect(SystemPrompt.chat({ hidden: true })).toBe(false)
    expect(SystemPrompt.chat({ small: true })).toBe(false)
    expect(SystemPrompt.chat({ format: "json_schema" })).toBe(false)
  })

  test("style fragment is empty unless explicitly enabled", () => {
    expect(SystemPrompt.style(true).join("\n")).toBe(SystemPrompt.STE_LITE)
    expect(SystemPrompt.style(false)).toEqual([])
  })

  test("provider prompts no longer use the four-line quota", () => {
    expect(DEFAULT_PROMPT).not.toContain("fewer than 4 lines")
    expect(TRINITY_PROMPT).not.toContain("fewer than 4 lines")
  })

  test("prepare injects STE-lite only when opted in", async () => {
    const unset = await Effect.runPromise(prepare())
    const custom = await Effect.runPromise(prepare({ steLite: true, prompt: "You are a reviewer." }))
    expect(unset.system.join("\n")).not.toContain(MARKER)
    expect(custom.system.join("\n")).toContain(MARKER)
    expect(custom.system.join("\n")).toContain("You are a reviewer.")
  })

  test("prepare omits STE-lite when disabled", async () => {
    const result = await Effect.runPromise(prepare({ steLite: false, prompt: "You are compaction." }))
    expect(result.system.join("\n")).not.toContain(MARKER)
    expect(result.system.join("\n")).toContain("You are compaction.")
  })
})

describe("efficient tool use and Review prompt", () => {
  test("request includes efficiency guidance for every effort with provider and Review prompts", async () => {
    for (const effort of ["fast", "medium", "thorough"]) {
      for (const prompt of [undefined, REVIEW_PROMPT]) {
        const result = await Effect.runPromise(prepare({ prompt, system: [`## Agent effort: ${effort}`] }))
        const system = result.system.join("\n")
        expect(system).toContain(`## Agent effort: ${effort}`)
        expect(system).toContain("Be fast, quick, and direct at every effort level")
        expect(system).toContain("Make useful independent tool calls in parallel")
        expect(system).toContain("make dependent calls sequentially")
        expect(system).toContain("include whole files or wider context when necessary")
        if (prompt) expect(system).toContain("Your final message is the report itself")
      }
    }
  })

  test("Review preserves its report contract and evaluates without taking over", () => {
    expect(REVIEW_PROMPT).toContain("Do not author new tests or scripts")
    expect(REVIEW_PROMPT).toContain("return findings to Code or Work for action")
    expect(REVIEW_PROMPT).toContain("Existing relevant tests, typechecks, lint")
    expect(REVIEW_PROMPT).toContain("task’s premise, completion, and instruction following")
    expect(REVIEW_PROMPT).toContain("read whole files when necessary")
    expect(REVIEW_PROMPT).toContain("do not invent a finding, approve without support, or omit the verdict")
    expect(REVIEW_PROMPT).toContain("Assessment: [Approved | Needs fixes]")
    expect(REVIEW_PROMPT).toContain('"assessment": "needs-fixes"')
    expect(REVIEW_PROMPT).toContain('"severity": "important"')
    expect(REVIEW_PROMPT).toContain("<silvercode-review>")
  })
})
