import { describe, expect, test } from "bun:test"
import path from "path"
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
import { subagentWorktreeEditCapability } from "../../src/agent/subagent-permissions"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"
import { Config } from "../../src/config/config"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

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

// A read-only reviewer whose name and description match the implementer
// heuristic but whose registry permission forbids edits must never be
// advertised as an implementer either: eligibility is capability-checked.
const engineerReviewer: Agent.Info = {
  name: "engineer-review",
  mode: "all",
  native: true,
  description: "Software engineer reviewer. Reads diffs and returns verdicts.",
  permission: Permission.fromConfig({ edit: { "*": "deny" } }),
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

// Prompt-time capability discovery probes edit capability against the real
// worktree path, so delegation tests run against a fixed fake instance.
const testInstance = {
  directory: "/test-instance-worktree",
  worktree: "/test-instance-worktree",
  project: {},
} as unknown as InstanceContext

const delegation = (prompt: SystemPrompt.Interface, agent: Agent.Info, ruleset?: PermissionV1.Ruleset) =>
  prompt.delegation(agent, ruleset).pipe(Effect.provideService(InstanceRef, testInstance))

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
        list: () => Effect.succeed([build, think, code, scout, engineerReviewer, hiddenPlanner]),
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

const itPrimaryTools = testEffect(
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
        list: () => Effect.succeed([build, think, code, scout, engineerReviewer, hiddenPlanner]),
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
    [
      Config.node,
      Layer.mock(Config.Service)({
        get: () => Effect.succeed({
          experimental: { primary_tools: ["edit"] },
        } as unknown as Effect.Success<ReturnType<Config.Interface["get"]>>),
      }),
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
      const output = (yield* delegation(prompt, build)) ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

      expect(output).toContain("`think`")
      expect(output).toContain("`code`")
      expect(output).toContain("Delegate by default")
      expect(output).toContain("once, at the start")
      expect(output).toContain("delegate each implementation step to `code`")
      expect(output).toContain("Direct work is the exception")
      expect(output).toContain("re-deriving or re-planning it at every tool call")
      expect(output).not.toContain("architect-planner")
      expect(output).not.toContain("`scout`")
      expect(output).not.toContain("engineer-review")
    }),
  )

  it.effect("delegation guidance is omitted for subagent callers", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* delegation(prompt, { ...build, name: "general", mode: "subagent" })

      expect(output).toBeUndefined()
    }),
  )

  it.effect("delegation guidance is kept for a primary caller that merely mentions planning", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const orchestrator: Agent.Info = {
        name: "orchestrator",
        mode: "primary",
        description: "Coordinates planning and delivery across the team.",
        permission: Permission.fromConfig({ "*": "allow" }),
        options: {},
      }
      const output = (yield* delegation(prompt, orchestrator)) ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

      expect(output).toContain("`think`")
      expect(output).toContain("`code`")
    }),
  )

  it.effect("delegation guidance is omitted for the planning agent itself", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* delegation(prompt, think)

      expect(output).toBeUndefined()
    }),
  )

  it.effect("delegation guidance still pushes implementer delegation when the planner is denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = (yield* delegation(prompt, { ...build, permission: Permission.fromConfig({ task: { think: "deny" } }) })) ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

      expect(output).toContain("`code`")
      expect(output).toContain("Delegate by default")
      expect(output).not.toContain("`think`")
    }),
  )

  it.effect("delegation guidance still pushes implementer delegation when the session ruleset denies the planner", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = (yield* delegation(prompt, build, Permission.fromConfig({ task: { think: "deny" } }) )) ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

      expect(output).toContain("`code`")
      expect(output).toContain("Delegate by default")
      expect(output).not.toContain("`think`")
    }),
  )

  it.effect("delegation guidance falls back to the planning nudge when the implementer is denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = (yield* delegation(prompt, { ...build, permission: Permission.fromConfig({ task: { code: "deny" } }) })) ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

      expect(output).toContain("`think`")
      expect(output).toContain("non-trivial implementation planning")
      expect(output).not.toContain("`code`")
    }),
  )

  it.effect("delegation guidance does not advertise an implementer the session ruleset forbids to edit", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      // The candidate's own rules allow edits, but the session ruleset denies
      // them: parent session denies propagate into the spawned child session
      // (deriveSubagentSessionPermission), so the child could not write and
      // advertising `code` as an implementer would promise a delegation that
      // fails. Planner guidance remains.
      const output = (yield* delegation(prompt, build, Permission.fromConfig({ edit: { "*": "deny" } }) )) ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

      expect(output).toContain("`think`")
      expect(output).toContain("non-trivial implementation planning")
      expect(output).not.toContain("`code`")
    }),
  )

  it.effect("delegation guidance is omitted when both planner and implementer are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* delegation(prompt, {
        ...build,
        permission: Permission.fromConfig({ task: { think: "deny", code: "deny" } }),
      })

      expect(output).toBeUndefined()
    }),
  )

  it.effect("delegation guidance drops the implementer when the session denies edits inside the worktree", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output =
        (yield* delegation(
          prompt,
          build,
          Permission.fromConfig({ edit: { [path.join(testInstance.worktree, "*")]: "deny" } }),
        )) ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

      expect(output).toContain("`think`")
      expect(output).not.toContain("`code`")
    }),
  )

  it.effect("delegation guidance keeps a nested-deny implementer but degrades the promise honestly", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      // A deny scoped below the worktree root (`worktree/src/**`) does not
      // match a root-level probe, yet the spawned child still cannot edit
      // there. The implementer remains advertised - it can write to the
      // permitted parts - but the guidance must not read as unrestricted
      // implementation.
      const output =
        (yield* delegation(
          prompt,
          build,
          Permission.fromConfig({ edit: { [path.join(testInstance.worktree, "src/**")]: "deny" } }),
        )) ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

      expect(output).toContain("`code`")
      expect(output).toContain("restrict subagent edits in parts of the worktree")
    }),
  )

  it.effect("delegation guidance degrades for a leading-wildcard deny that crosses separators", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      // `**/src/**` has no literal prefix to compare against the worktree,
      // but the matcher's `*` crosses `/`, so it still denies the child's
      // edits under every src subtree, including the worktree's.
      const output =
        (yield* delegation(
          prompt,
          build,
          Permission.fromConfig({ edit: { "**/src/**": "deny" } }),
        )) ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

      expect(output).toContain("`code`")
      expect(output).toContain("restrict subagent edits in parts of the worktree")
    }),
  )

  it.effect("delegation guidance ignores a deny rooted at a sibling directory of the worktree", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      // `/test-instance-worktree-other/src/**` shares a string prefix with
      // the worktree but not a path boundary; it must not read as a
      // restriction inside this worktree.
      const output =
        (yield* delegation(
          prompt,
          build,
          Permission.fromConfig({ edit: { "/test-instance-worktree-other/src/**": "deny" } }),
        )) ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

      expect(output).toContain("`code`")
      expect(output).not.toContain("restrict subagent edits in parts of the worktree")
    }),
  )

  it.effect("delegation guidance degrades when `?` lets a deny reach across the worktree boundary", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      // `?` matches any single character including `/`, so this deny covers
      // the worktree's src subtree even though its literal run is exactly
      // the worktree path with no `/` boundary in the pattern text.
      const output =
        (yield* delegation(
          prompt,
          build,
          Permission.fromConfig({ edit: { [testInstance.worktree + "?src/**"]: "deny" } }),
        )) ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

      expect(output).toContain("`code`")
      expect(output).toContain("restrict subagent edits in parts of the worktree")
    }),
  )

  test("worktree edit capability stays partial when a later allow narrows a worktree deny", () => {
    // Both rules live in the subagent's own ruleset, so both reach the
    // spawned child: it may edit `src/.ts` but no other .ts name under src.
    // A single synthesized candidate that lands on the allowed name must not
    // be read as proof that no denied paths remain.
    const scoped: Agent.Info = {
      ...code,
      permission: Permission.fromConfig({
        edit: {
          "/repo/src/*.ts": "deny",
          "/repo/src/.ts": "allow",
        },
      }),
    }
    expect(
      subagentWorktreeEditCapability({
        worktree: "/repo",
        subagent: scoped,
        parentSessionPermission: Permission.fromConfig({ "*": "allow" }),
      }),
    ).toBe("partial")
  })

  test("worktree edit capability treats a relative edit deny as reaching the worktree", () => {
    // Edit targets are worktree-relative, so `src/**` denies `src/file.ts`
    // even though the pattern's literal run shares no prefix with the
    // absolute worktree path.
    const scoped: Agent.Info = {
      ...code,
      permission: Permission.fromConfig({ edit: { "src/**": "deny" } }),
    }
    expect(
      subagentWorktreeEditCapability({
        worktree: "/repo",
        subagent: scoped,
        parentSessionPermission: Permission.fromConfig({ "*": "allow" }),
      }),
    ).toBe("partial")
  })

  test("worktree edit capability stays partial when a narrow allow follows a worktree-wide deny", () => {
    // The allow only covers the src subtree: every other worktree path is
    // still denied, so the capability is neither full nor denied.
    const scoped: Agent.Info = {
      ...code,
      permission: Permission.fromConfig({ edit: { "*": "deny", "/repo/src/**": "allow" } }),
    }
    expect(
      subagentWorktreeEditCapability({
        worktree: "/repo",
        subagent: scoped,
        parentSessionPermission: Permission.fromConfig({ "*": "allow" }),
      }),
    ).toBe("partial")
  })

  test("worktree edit capability is not denied by a rule covering only one path", () => {
    // One denied path cannot prove the whole worktree is uneditable; the
    // classification must degrade to the scoped note, not suppression. The
    // denied path here is exactly the one the old single-probe check
    // sampled, which used to flip the whole capability to "denied".
    const scoped: Agent.Info = {
      ...code,
      permission: Permission.fromConfig({ edit: { "/repo/opencode-worktree-probe": "deny" } }),
    }
    expect(
      subagentWorktreeEditCapability({
        worktree: "/repo",
        subagent: scoped,
        parentSessionPermission: Permission.fromConfig({ "*": "allow" }),
      }),
    ).toBe("partial")
  })

  test("worktree edit capability normalizes backslash separators the way the matcher does", () => {
    // Wildcard.match treats `\` as `/`, so a Windows-style deny still
    // restricts this worktree.
    const scoped: Agent.Info = {
      ...code,
      permission: Permission.fromConfig({ edit: { "\\repo\\src\\**": "deny" } }),
    }
    expect(
      subagentWorktreeEditCapability({
        worktree: "/repo",
        subagent: scoped,
        parentSessionPermission: Permission.fromConfig({ "*": "allow" }),
      }),
    ).toBe("partial")
  })

  test("worktree edit capability is denied when `?` absorbs the slash and the first descendant character", () => {
    // The matcher compiles `?` to a dotAll single character, so it crosses
    // `/`: `/repo/?*` matches every nonempty descendant of the worktree and
    // nothing editable remains. A textual-prefix coverage test misses this.
    const scoped: Agent.Info = {
      ...code,
      permission: Permission.fromConfig({ edit: { "/repo/?*": "deny" } }),
    }
    expect(
      subagentWorktreeEditCapability({
        worktree: "/repo",
        subagent: scoped,
        parentSessionPermission: Permission.fromConfig({ "*": "allow" }),
      }),
    ).toBe("denied")
  })

  test("worktree edit capability is denied when `?` lands inside the root span or on the slash", () => {
    for (const pattern of ["/rep?/*", "/repo?*"]) {
      const scoped: Agent.Info = {
        ...code,
        permission: Permission.fromConfig({ edit: { [pattern]: "deny" } }),
      }
      expect(
        subagentWorktreeEditCapability({
          worktree: "/repo",
          subagent: scoped,
          parentSessionPermission: Permission.fromConfig({ "*": "allow" }),
        }),
      ).toBe("denied")
    }
  })

  test("worktree edit capability stays partial when a `?` head leaves short descendants unmatched", () => {
    // `/repo/??` needs two characters below the root: a one-character name
    // like `/repo/a` never matches, so the tree is not covered.
    const scoped: Agent.Info = {
      ...code,
      permission: Permission.fromConfig({ edit: { "/repo/??*": "deny" } }),
    }
    expect(
      subagentWorktreeEditCapability({
        worktree: "/repo",
        subagent: scoped,
        parentSessionPermission: Permission.fromConfig({ "*": "allow" }),
      }),
    ).toBe("partial")
  })

  test("worktree edit capability stays partial when a literal follows the slash before the star", () => {
    // `/repo/a*` denies only children starting with `a`; every other name is
    // still editable.
    const scoped: Agent.Info = {
      ...code,
      permission: Permission.fromConfig({ edit: { "/repo/a*": "deny" } }),
    }
    expect(
      subagentWorktreeEditCapability({
        worktree: "/repo",
        subagent: scoped,
        parentSessionPermission: Permission.fromConfig({ "*": "allow" }),
      }),
    ).toBe("partial")
  })

  test("worktree edit capability treats a trailing-slash worktree like its root", () => {
    const scoped: Agent.Info = {
      ...code,
      permission: Permission.fromConfig({ edit: { "/repo/?*": "deny" } }),
    }
    expect(
      subagentWorktreeEditCapability({
        worktree: "/repo/",
        subagent: scoped,
        parentSessionPermission: Permission.fromConfig({ "*": "allow" }),
      }),
    ).toBe("denied")
  })

  test("worktree edit capability at the filesystem root", () => {
    const denied: Agent.Info = {
      ...code,
      permission: Permission.fromConfig({ edit: { "/?*": "deny" } }),
    }
    expect(
      subagentWorktreeEditCapability({
        worktree: "/",
        subagent: denied,
        parentSessionPermission: Permission.fromConfig({ "*": "allow" }),
      }),
    ).toBe("denied")
    const scoped: Agent.Info = {
      ...code,
      permission: Permission.fromConfig({ edit: { "/a*": "deny" } }),
    }
    expect(
      subagentWorktreeEditCapability({
        worktree: "/",
        subagent: scoped,
        parentSessionPermission: Permission.fromConfig({ "*": "allow" }),
      }),
    ).toBe("partial")
  })

  test.skipIf(process.platform === "win32")(
    "worktree edit capability is case-sensitive where the matcher is (posix)",
    () => {
      // `/REPO` never reaches `/repo` on a case-sensitive filesystem, so the
      // deny is ignored entirely and the capability stays full.
      const scoped: Agent.Info = {
        ...code,
        permission: Permission.fromConfig({ edit: { "/REPO/?*": "deny" } }),
      }
      expect(
        subagentWorktreeEditCapability({
          worktree: "/repo",
          subagent: scoped,
          parentSessionPermission: Permission.fromConfig({ "*": "allow" }),
        }),
      ).toBe("full")
    },
  )

  test.skipIf(process.platform !== "win32")(
    "worktree edit capability case-folds where the matcher does (win32)",
    () => {
      const scoped: Agent.Info = {
        ...code,
        permission: Permission.fromConfig({ edit: { "/REPO/?*": "deny" } }),
      }
      expect(
        subagentWorktreeEditCapability({
          worktree: "/repo",
          subagent: scoped,
          parentSessionPermission: Permission.fromConfig({ "*": "allow" }),
        }),
      ).toBe("denied")
    },
  )

  test("worktree edit capability is denied only by a worktree-wide deny with no reaching allow", () => {
    const scoped: Agent.Info = {
      ...code,
      permission: Permission.fromConfig({ edit: { "*": "deny" } }),
    }
    expect(
      subagentWorktreeEditCapability({
        worktree: "/repo",
        subagent: scoped,
        parentSessionPermission: Permission.fromConfig({ "*": "allow" }),
      }),
    ).toBe("denied")
  })

  it.effect("delegation guidance degrades for a relative worktree edit deny", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output =
        (yield* delegation(
          prompt,
          build,
          Permission.fromConfig({ edit: { "src/**": "deny" } }),
        )) ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

      expect(output).toContain("`code`")
      expect(output).toContain("restrict subagent edits in parts of the worktree")
    }),
  )

  itPrimaryTools.effect(
    "delegation guidance does not advertise an implementer the config's primary_tools forbid to edit",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt.Service
        const output =
          (yield* delegation(prompt, build)) ??
          (yield* Effect.fail(new NamedError.Unknown({ message: "missing delegation output" })))

        expect(output).toContain("`think`")
        expect(output).not.toContain("`code`")
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
