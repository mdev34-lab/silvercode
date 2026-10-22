import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import os from "os"
import { Global } from "@opencode-ai/core/global"
import { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"

const desktopDirectory = "C:\\Users\\Camila\\OneDrive - Contoso\\Área de Trabalho"
const shellFixture =
  process.platform === "win32"
    ? { configured: "powershell", expected: "powershell" }
    : { configured: "/bin/bash", expected: "bash" }

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "work",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const think: Agent.Info = {
  name: "think",
  mode: "all",
  native: true,
  description:
    "Planning specialist. Researches the codebase and the web, then drafts an implementation plan. Disallows all edit tools.",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const code: Agent.Info = {
  name: "code",
  mode: "all",
  native: true,
  description:
    "Software-engineering specialist. Runs in Git/project folders with LSP and repo-aware context.",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

// A read-only explorer mentions code in its description but must never be
// advertised as an implementer.
const scout: Agent.Info = {
  name: "scout",
  mode: "all",
  native: true,
  description: "Fast, read-only agent for finding files, searching code and answering codebase questions.",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

// A hidden planner must never be advertised in prompts.
const hiddenPlanner: Agent.Info = {
  name: "architect-planner",
  mode: "all",
  hidden: true,
  description: "Planning helper for internal use.",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  LayerNode.compile(SystemPrompt.node, [
    [Global.node, Global.layerWith({ desktop: desktopDirectory })],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        instructions: () =>
          Effect.succeed([
            {
              name: "guide-server",
              instructions: "Use lookup before mutate.",
              tools: [],
            },
            {
              name: "tool-server",
              instructions: "Prefer search before update.",
              tools: ["tool-server_search", "tool-server_update"],
            },
          ]),
      }),
    ],
    [
      Agent.node,
      Layer.mock(Agent.Service, {
        list: () => Effect.succeed([build, think, code, scout, hiddenPlanner]),
      }),
    ],
    [
      Skill.node,
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ],
  ]),
)

describe("session.system", () => {
  test("selects the Meta prompt for Muse Spark model IDs", () => {
    for (const id of ["meta/muse-spark-preview", "muse-spark-1.1", "muse-spark-1.2"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Spark,")
      expect(prompt).toContain("using Meta Muse Spark.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Meta prompt for Muse Glimmer model IDs", () => {
    for (const id of ["meta/muse-glimmer", "meta/muse-glimmer-30b", "muse-glimmer-30b"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Glimmer,")
      expect(prompt).toContain("using Meta Muse Glimmer.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("gpt prompt keeps the todo discipline concise and names no stale tool (#243)", () => {
    const prompt = SystemPrompt.provider({ api: { id: "gpt-5.2" } } as Provider.Model)[0]

    // `multi_tool_use.parallel` is not a tool either build exposes; parallel
    // calls are made by emitting independent calls in one response.
    expect(prompt).not.toContain("multi_tool_use.parallel")
    // The long todo section duplicated the scope contract and the todowrite
    // description. The concise form must keep the discipline itself: one
    // verifiable unit per todo, exactly one in progress, mark on verification.
    expect(prompt).toContain("One todo = one specific, coherent, independently verifiable unit")
    expect(prompt).toContain("keep exactly one `in_progress`")
    expect(prompt).toContain("Never batch completions, mark unverified or future work done")
    expect(prompt).not.toContain("Todo Planning and Execution Discipline")
    // Character length is only a regression guard against re-inflating the
    // always-loaded prompt, not a token count (see #243 for the tokenizer
    // measurement). The pre-reduction prompt was 11,695 characters.
    expect(prompt.length).toBeLessThan(10_750)
  })

  test("selects the Kimi prompt for official provider model IDs", () => {
    for (const providerID of ["kimi-for-coding", "moonshotai", "moonshotai-cn"]) {
      const prompt = SystemPrompt.provider({ providerID, api: { id: "k3" } } as Provider.Model)[0]
      expect(prompt).toContain("# Prompt and Tool Use")
    }
  })

  it.instance(
    "environment reports the configured shell and OS-resolved Desktop directory",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt.Service
        const output = (yield* prompt.environment({ providerID: "test", api: { id: "model" } } as Provider.Model))[0]

        expect(output.split("\n").filter((line) => line.includes("  OS:"))).toEqual([
          `  OS: ${os.type()} ${os.release()}; Shell: ${shellFixture.expected}`,
        ])
        expect(output).toContain(`  Desktop directory: ${desktopDirectory}`)
      }),
    { config: { shell: shellFixture.configured } },
  )

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )

  it.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("delegation guidance pushes planner and implementer delegation for primary callers", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = (yield* prompt.delegation(build)) ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

      expect(output).toContain("`think`")
      expect(output).toContain("`code`")
      expect(output).toContain("Delegate by default")
      expect(output).toContain("once, at the start")
      expect(output).toContain("delegate each implementation step to `code`")
      expect(output).toContain("Direct work is the exception")
      expect(output).toContain("re-deriving or re-planning it at every tool call")
      expect(output).not.toContain("architect-planner")
      expect(output).not.toContain("`scout`")
    }),
  )

  it.effect("delegation guidance is omitted for subagent callers", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.delegation({ ...build, name: "general", mode: "subagent" })

      expect(output).toBeUndefined()
    }),
  )

  it.effect("delegation guidance is omitted for the planning agent itself", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.delegation(think)

      expect(output).toBeUndefined()
    }),
  )

  it.effect("delegation guidance still pushes implementer delegation when the planner is denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = (yield* prompt.delegation({ ...build, permission: Permission.fromConfig({ task: { think: "deny" } }) })) ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

      expect(output).toContain("`code`")
      expect(output).toContain("Delegate by default")
      expect(output).not.toContain("`plan`")
    }),
  )

  it.effect("delegation guidance still pushes implementer delegation when the session ruleset denies the planner", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = (yield* prompt.delegation(build, Permission.fromConfig({ task: { think: "deny" } }) )) ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

      expect(output).toContain("`code`")
      expect(output).toContain("Delegate by default")
      expect(output).not.toContain("`think`")
    }),
  )

  it.effect("delegation guidance falls back to the planning nudge when the implementer is denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = (yield* prompt.delegation({ ...build, permission: Permission.fromConfig({ task: { code: "deny" } }) })) ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

      expect(output).toContain("`think`")
      expect(output).toContain("non-trivial implementation planning")
      expect(output).not.toContain("`code`")
    }),
  )

  it.effect("delegation guidance is omitted when both planner and implementer are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.delegation({
        ...build,
        permission: Permission.fromConfig({ task: { think: "deny", code: "deny" } }),
      })

      expect(output).toBeUndefined()
    }),
  )

  test("think prompt keeps the up-front plan output contract", async () => {
    const text = await Bun.file(
      new URL("../../src/agent/prompt/think.txt", import.meta.url),
    ).text()
    expect(text).toContain("overview")
    expect(text).toContain("numbered steps")
    expect(text).toContain("independently verifiable")
    expect(text).toContain("acceptance criteria")
  })
})
