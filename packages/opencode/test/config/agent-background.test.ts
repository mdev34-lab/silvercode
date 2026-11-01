import { describe, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { Config } from "@/config/config"
import { ConfigParse } from "@/config/parse"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Config.node, AgentSvc.node])))

describe("config agent background", () => {
  it.instance(
    "only built-in reviewers opt into foreground by default",
    () =>
      Effect.gen(function* () {
        const agent = yield* AgentSvc.Service
        for (const name of ["review", "work-review", "code-review"]) {
          expect((yield* agent.get(name)).background).toBe(false)
        }
        for (const name of ["general", "explore", "custom"]) {
          expect((yield* agent.get(name)).background).toBeUndefined()
        }
      }),
    { config: { agent: { custom: { mode: "subagent" } } } },
  )

  it.instance(
    "agent.<name>.background is read from project config onto the agent",
    () =>
      Effect.gen(function* () {
        const agent = yield* AgentSvc.Service
        // Opted into synchronous execution: a delegation to `review` waits for the
        // result unless the caller asks for background execution.
        expect((yield* agent.get("review"))?.background).toBe(false)
        // Unset means the background default, and one agent's opt-in does not
        // reach another.
        expect((yield* agent.get("general"))?.background).toBeUndefined()
        expect((yield* agent.get("explore"))?.background).toBe(true)
      }),
    {
      git: true,
      config: {
        agent: {
          review: { mode: "subagent", background: false },
          explore: { mode: "subagent", background: true },
        },
      },
    },
  )

  // The opt-in is read from `Agent.Info`, but it is declared on the shared agent
  // config schema, which several loaders feed: `opencode.json`, an agent markdown
  // file's frontmatter, and config blocks keyed by the pre-rename `build` id. A
  // field that only reaches the runtime through one of them is a field users will
  // write in the wrong place, so these arms pin the two loaders the task tool
  // depends on but does not implement.
  it.instance("background is read from an agent markdown file's frontmatter", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        Bun.write(
          path.join(test.directory, ".opencode", "agent", "strict-reviewer.md"),
          `---\nmode: subagent\nbackground: false\n---\nReview strictly.`,
        ),
      )

      const agent = yield* AgentSvc.Service
      expect((yield* agent.get("strict-reviewer"))?.background).toBe(false)
    }),
  )

  it.instance(
    "background written under the legacy `build` id lands on the canonical agent",
    () =>
      Effect.gen(function* () {
        const agent = yield* AgentSvc.Service
        // `Agent.state` canonicalizes the config key before applying it and
        // `Agent.get` resolves a legacy lookup the same way, so a pre-rename block
        // still gates the agent that runs. The task tool reads both the resolved and
        // the requested name through `Agent.get`, which is what makes an alias reach
        // the execution-mode decision instead of configuring nothing.
        expect((yield* agent.get("work"))?.background).toBe(false)
        expect((yield* agent.get("build"))?.background).toBe(false)
      }),
    { config: { agent: { build: { background: false } } } },
  )

  test("background is a known agent key, not an option passthrough", () => {
    const decode = Schema.decodeUnknownSync(ConfigAgentV1.Info)
    expect(decode({ background: false }).background).toBe(false)
    expect(decode({ background: true }).background).toBe(true)
    expect(decode({}).background).toBeUndefined()
    // Unknown fields are silently routed into `options`, which the V1-to-V2
    // migration forwards into the provider request body. `background` configures
    // the runtime instead, so it must not take that path.
    expect(decode({ background: false }).options).not.toHaveProperty("background")
    expect(decode({ custom: 1 }).options).toHaveProperty("custom")
  })

  test("an invalid background value fails the config file", () => {
    const parsed = Schema.decodeUnknownExit(ConfigV1.Info)({ agent: { review: { background: "sometimes" } } })
    expect(Exit.isFailure(parsed)).toBe(true)
    // Same convention as every other typed config field: a wrong type is a config
    // error naming the offending path, not a value that is quietly ignored.
    expect(() =>
      ConfigParse.schema(ConfigV1.Info, { agent: { review: { background: "sometimes" } } }, "config.json"),
    ).toThrow()
  })
})
