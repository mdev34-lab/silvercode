import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Global } from "@opencode-ai/core/global"
import { Permission } from "../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { Truncate } from "../../src/tool/truncate"

const agentLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(agentLayer())

// Helper to evaluate permission for a tool with wildcard pattern
function evalPerm(agent: Agent.Info | undefined, permission: string): PermissionV1.Action | undefined {
  if (!agent) return undefined
  return Permission.evaluate(permission, "*", agent.permission).action
}

function load<A>(fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Agent.Service.use(fn)
}

const expectDefaultAgentError = Effect.fn("AgentTest.expectDefaultAgentError")(function* (message: string) {
  const exit = yield* load((svc) => svc.defaultAgent()).pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(message)
})

afterEach(async () => {
  await disposeAllInstances()
})

it.instance("returns default native agents when no config", () =>
  Effect.gen(function* () {
    const agents = yield* load((svc) => svc.list())
    const names = agents.map((a) => a.name)
    expect(names).toContain("work")
    expect(names).toContain("code")
    expect(names).toContain("plan")
    expect(names).toContain("general")
    expect(names).toContain("explore")
    expect(names).toContain("review")
    expect(names).toContain("compaction")
    expect(names).toContain("title")
    expect(names).toContain("summary")
  }),
)

it.instance("work agent has correct default properties", () =>
  Effect.gen(function* () {
    const work = yield* load((svc) => svc.get("work"))
    expect(work).toBeDefined()
    expect(work?.mode).toBe("primary")
    expect(work?.native).toBe(true)
    expect(work?.color).toBe("#FFFFFF")
    expect(evalPerm(work, "edit")).toBe("allow")
    expect(evalPerm(work, "bash")).toBe("allow")
  }),
)

it.instance("plan agent denies edits except .opencode/plans/*", () =>
  Effect.gen(function* () {
    const plan = yield* load((svc) => svc.get("plan"))
    expect(plan).toBeDefined()
    // Wildcard is denied
    expect(evalPerm(plan, "edit")).toBe("deny")
    // But specific path is allowed
    expect(Permission.evaluate("edit", ".opencode/plans/foo.md", plan!.permission).action).toBe("allow")
  }),
)

it.instance("code agent cannot delegate to work or itself", () =>
  Effect.gen(function* () {
    const code = yield* load((svc) => svc.get("code"))
    expect(code).toBeDefined()
    expect(Permission.evaluate("task", "work", code!.permission).action).toBe("deny")
    expect(Permission.evaluate("task", "code", code!.permission).action).toBe("deny")
    expect(Permission.evaluate("task", "plan", code!.permission).action).toBe("allow")
  }),
)

it.instance("plan agent is a mixed-mode delegation target", () =>
  Effect.gen(function* () {
    const plan = yield* load((svc) => svc.get("plan"))
    expect(plan).toBeDefined()
    // mode "all": usable as a primary session agent AND delegable via the task tool
    expect(plan!.mode).toBe("all")
    const work = yield* load((svc) => svc.get("work"))
    expect(Permission.evaluate("task", "plan", work!.permission).action).toBe("allow")
  }),
)

it.instance("plan agent denies the general subagent by default", () =>
  Effect.gen(function* () {
    const plan = yield* load((svc) => svc.get("plan"))
    expect(plan).toBeDefined()
    expect(Permission.evaluate("task", "general", plan!.permission).action).toBe("deny")
    expect(Permission.evaluate("task", "explore", plan!.permission).action).toBe("allow")
    expect(Permission.evaluate("task", "custom", plan!.permission).action).toBe("allow")
  }),
)

it.instance(
  "user permission can allow the general subagent from plan mode",
  () =>
    Effect.gen(function* () {
      const plan = yield* load((svc) => svc.get("plan"))
      expect(plan).toBeDefined()
      expect(Permission.evaluate("task", "general", plan!.permission).action).toBe("allow")
    }),
  {
    config: {
      permission: {
        task: {
          general: "allow",
        },
      },
    },
  },
)

it.instance("explore agent denies edit and write", () =>
  Effect.gen(function* () {
    const explore = yield* load((svc) => svc.get("explore"))
    expect(explore).toBeDefined()
    expect(explore?.mode).toBe("subagent")
    expect(evalPerm(explore, "edit")).toBe("deny")
    expect(evalPerm(explore, "write")).toBe("deny")
    expect(evalPerm(explore, "todowrite")).toBe("deny")
  }),
)

it.instance("explore agent is read-only by default", () =>
  Effect.gen(function* () {
    const explore = yield* load((svc) => svc.get("explore"))
    expect(explore).toBeDefined()
    expect(explore?.mode).toBe("subagent")
    expect(evalPerm(explore, "bash")).toBe("deny")
    expect(evalPerm(explore, "websearch")).toBe("deny")
    expect(evalPerm(explore, "write")).toBe("deny")
    expect(evalPerm(explore, "edit")).toBe("deny")
    expect(evalPerm(explore, "task")).toBe("deny")
    expect(evalPerm(explore, "todowrite")).toBe("deny")

    expect(evalPerm(explore, "read")).toBe("allow")
    expect(evalPerm(explore, "grep")).toBe("allow")
    expect(evalPerm(explore, "glob")).toBe("allow")
    expect(evalPerm(explore, "list")).toBe("allow")
    expect(evalPerm(explore, "webfetch")).toBe("allow")
  }),
)

it.instance("explore agent asks for external directories and allows whitelisted external paths", () =>
  Effect.gen(function* () {
    const explore = yield* load((svc) => svc.get("explore"))
    expect(explore).toBeDefined()
    expect(Permission.evaluate("external_directory", "/some/other/path", explore!.permission).action).toBe("ask")
    expect(Permission.evaluate("external_directory", Truncate.GLOB, explore!.permission).action).toBe("allow")
    expect(
      Permission.evaluate("external_directory", path.join(Global.Path.tmp, "agent-work"), explore!.permission).action,
    ).toBe("allow")
  }),
)

it.instance("review shares plan inspection permissions but denies all edits", () =>
  Effect.gen(function* () {
    const plan = yield* load((svc) => svc.get("plan"))
    const review = yield* load((svc) => svc.get("review"))
    expect(plan).toBeDefined()
    expect(review).toBeDefined()
    if (!plan || !review) return
    expect(review.mode).toBe("subagent")
    expect(review.native).toBe(true)
    expect(review.prompt).toContain("Do not edit")
    // Inspection capabilities are shared with Plan.
    for (const tool of ["read", "grep", "glob", "list", "webfetch", "bash", "question", "todowrite"]) {
      expect(evalPerm(review, tool)).toBe(evalPerm(plan, tool))
    }
    // Pinned absolutes: bash is available, edits stay denied.
    expect(evalPerm(plan, "bash")).toBe("allow")
    expect(evalPerm(review, "bash")).toBe("allow")
    expect(evalPerm(review, "edit")).toBe("deny")
    expect(Permission.disabled(["bash"], review.permission)).toEqual(new Set())
    // Review denies edits on every path, so it fully hides edit/write/apply_patch;
    // Plan retains plan-path edit exceptions and hides none of them.
    expect(Permission.disabled(["edit", "write", "apply_patch", "bash", "task"], review.permission)).toEqual(
      new Set(["edit", "write", "apply_patch"]),
    )
    expect(Permission.disabled(["edit", "write", "apply_patch", "bash", "task"], plan.permission)).toEqual(new Set())
    // Denials outside the shared allowance hold for both.
    expect(Permission.evaluate("task", "general", review.permission).action).toBe("deny")
    expect(Permission.evaluate("task", "explore", review.permission).action).toBe("allow")
    // Regression: Review must deny edits on EVERY path — it must not inherit
    // Plan's plan-path edit exceptions, since review.txt forbids any file mutation.
    expect(Permission.evaluate("edit", ".opencode/plans/review.md", review.permission).action).toBe("deny")
    expect(Permission.evaluate("edit", "packages/opencode/src/index.ts", review.permission).action).toBe("deny")
    // Plan's edit exceptions remain intact (unchanged by this fix).
    expect(Permission.evaluate("edit", ".opencode/plans/foo.md", plan.permission).action).toBe("allow")
  }),
)

it.instance(
  "reference config does not create subagents",
  () =>
    Effect.gen(function* () {
      const agents = yield* load((svc) => svc.list())
      const names = agents.map((agent) => agent.name)
      expect(names).not.toContain("effect")
      expect(names).not.toContain("effectFull")
      expect(names).not.toContain("localdocs")
      expect(names).not.toContain("localdocsFull")
    }),
  {
    config: {
      references: {
        effect: "github.com/effect/effect-smol",
        effectFull: {
          repository: "Effect-TS/effect",
          branch: "main",
        },
        localdocs: "../docs",
        localdocsFull: {
          path: "../local-docs",
        },
      },
    },
  },
)

it.instance("general agent denies todo tools", () =>
  Effect.gen(function* () {
    const general = yield* load((svc) => svc.get("general"))
    expect(general).toBeDefined()
    expect(general?.mode).toBe("subagent")
    expect(general?.hidden).toBeUndefined()
    expect(evalPerm(general, "todowrite")).toBe("deny")
  }),
)

it.instance("compaction agent denies all permissions", () =>
  Effect.gen(function* () {
    const compaction = yield* load((svc) => svc.get("compaction"))
    expect(compaction).toBeDefined()
    expect(compaction?.hidden).toBe(true)
    expect(evalPerm(compaction, "bash")).toBe("deny")
    expect(evalPerm(compaction, "edit")).toBe("deny")
    expect(evalPerm(compaction, "read")).toBe("deny")
  }),
)

it.instance(
  "custom agent from config creates new agent",
  () =>
    Effect.gen(function* () {
      const custom = yield* load((svc) => svc.get("my_custom_agent"))
      expect(custom).toBeDefined()
      expect(String(custom?.model?.providerID)).toBe("openai")
      expect(String(custom?.model?.modelID)).toBe("gpt-4")
      expect(custom?.description).toBe("My custom agent")
      expect(custom?.temperature).toBe(0.5)
      expect(custom?.topP).toBe(0.9)
      expect(custom?.native).toBe(false)
      expect(custom?.mode).toBe("all")
    }),
  {
    config: {
      agent: {
        my_custom_agent: {
          model: "openai/gpt-4",
          description: "My custom agent",
          temperature: 0.5,
          top_p: 0.9,
        },
      },
    },
  },
)

it.instance(
  "custom agent config overrides native agent properties",
  () =>
    Effect.gen(function* () {
      const work = yield* load((svc) => svc.get("work"))
      expect(work).toBeDefined()
      expect(String(work?.model?.providerID)).toBe("anthropic")
      expect(String(work?.model?.modelID)).toBe("claude-3")
      expect(work?.description).toBe("Custom work agent")
      expect(work?.temperature).toBe(0.7)
      expect(work?.color).toBe("#FF0000")
      expect(work?.native).toBe(true)
    }),
  {
    config: {
      agent: {
        work: {
          model: "anthropic/claude-3",
          description: "Custom work agent",
          temperature: 0.7,
          color: "#FF0000",
        },
      },
    },
  },
)

it.instance(
  "agent disable removes agent from list",
  () =>
    Effect.gen(function* () {
      const explore = yield* load((svc) => svc.get("explore"))
      expect(explore).toBeUndefined()
      const agents = yield* load((svc) => svc.list())
      const names = agents.map((a) => a.name)
      expect(names).not.toContain("explore")
    }),
  {
    config: {
      agent: {
        explore: { disable: true },
      },
    },
  },
)

it.instance(
  "agent permission config merges with defaults",
  () =>
    Effect.gen(function* () {
      const work = yield* load((svc) => svc.get("work"))
      expect(work).toBeDefined()
      // Specific pattern is denied
      expect(Permission.evaluate("bash", "rm -rf *", work!.permission).action).toBe("deny")
      // Edit still allowed
      expect(evalPerm(work, "edit")).toBe("allow")
    }),
  {
    config: {
      agent: {
        work: {
          permission: {
            bash: {
              "rm -rf *": "deny",
            },
          },
        },
      },
    },
  },
)

it.instance(
  "global permission config applies to all agents",
  () =>
    Effect.gen(function* () {
      const work = yield* load((svc) => svc.get("work"))
      expect(work).toBeDefined()
      expect(evalPerm(work, "bash")).toBe("deny")
    }),
  {
    config: {
      permission: {
        bash: "deny",
      },
    },
  },
)

it.instance(
  "agent steps/maxSteps config sets steps property",
  () =>
    Effect.gen(function* () {
      const work = yield* load((svc) => svc.get("work"))
      const plan = yield* load((svc) => svc.get("plan"))
      expect(work?.steps).toBe(50)
      expect(plan?.steps).toBe(100)
    }),
  {
    config: {
      agent: {
        work: { steps: 50 },
        plan: { maxSteps: 100 },
      },
    },
  },
)

it.instance(
  "agent mode can be overridden",
  () =>
    Effect.gen(function* () {
      const explore = yield* load((svc) => svc.get("explore"))
      expect(explore?.mode).toBe("primary")
    }),
  {
    config: {
      agent: {
        explore: { mode: "primary" },
      },
    },
  },
)

it.instance(
  "agent name can be overridden",
  () =>
    Effect.gen(function* () {
      const work = yield* load((svc) => svc.get("work"))
      expect(work?.name).toBe("Builder")
    }),
  {
    config: {
      agent: {
        work: { name: "Builder" },
      },
    },
  },
)

it.instance(
  "agent prompt can be set from config",
  () =>
    Effect.gen(function* () {
      const work = yield* load((svc) => svc.get("work"))
      expect(work?.prompt).toBe("Custom system prompt")
    }),
  {
    config: {
      agent: {
        work: { prompt: "Custom system prompt" },
      },
    },
  },
)

it.instance(
  "unknown agent properties are placed into options",
  () =>
    Effect.gen(function* () {
      const work = yield* load((svc) => svc.get("work"))
      expect(work?.options.random_property).toBe("hello")
      expect(work?.options.another_random).toBe(123)
    }),
  {
    config: {
      agent: {
        work: {
          random_property: "hello",
          another_random: 123,
        },
      },
    },
  },
)

it.instance(
  "agent options merge correctly",
  () =>
    Effect.gen(function* () {
      const work = yield* load((svc) => svc.get("work"))
      expect(work?.options.custom_option).toBe(true)
      expect(work?.options.another_option).toBe("value")
    }),
  {
    config: {
      agent: {
        work: {
          options: {
            custom_option: true,
            another_option: "value",
          },
        },
      },
    },
  },
)

it.instance(
  "multiple custom agents can be defined",
  () =>
    Effect.gen(function* () {
      const agentA = yield* load((svc) => svc.get("agent_a"))
      const agentB = yield* load((svc) => svc.get("agent_b"))
      expect(agentA?.description).toBe("Agent A")
      expect(agentA?.mode).toBe("subagent")
      expect(agentB?.description).toBe("Agent B")
      expect(agentB?.mode).toBe("primary")
    }),
  {
    config: {
      agent: {
        agent_a: {
          description: "Agent A",
          mode: "subagent",
        },
        agent_b: {
          description: "Agent B",
          mode: "primary",
        },
      },
    },
  },
)

it.instance(
  "Agent.list keeps the default agent first and sorts the rest by name",
  () =>
    Effect.gen(function* () {
      const names = (yield* load((svc) => svc.list())).map((a) => a.name)
      expect(names[0]).toBe("plan")
      expect(names.slice(1)).toEqual(names.slice(1).toSorted((a, b) => a.localeCompare(b)))
    }),
  {
    config: {
      default_agent: "plan",
      agent: {
        zebra: {
          description: "Zebra",
          mode: "subagent",
        },
        alpha: {
          description: "Alpha",
          mode: "subagent",
        },
      },
    },
  },
)

it.instance("Agent.get returns undefined for non-existent agent", () =>
  Effect.gen(function* () {
    const nonExistent = yield* load((svc) => svc.get("does_not_exist"))
    expect(nonExistent).toBeUndefined()
  }),
)

it.instance("default permission includes doom_loop and external_directory as ask", () =>
  Effect.gen(function* () {
    const work = yield* load((svc) => svc.get("work"))
    expect(evalPerm(work, "doom_loop")).toBe("ask")
    expect(evalPerm(work, "external_directory")).toBe("ask")
  }),
)

it.instance("webfetch is allowed by default", () =>
  Effect.gen(function* () {
    const work = yield* load((svc) => svc.get("work"))
    expect(evalPerm(work, "webfetch")).toBe("allow")
  }),
)

it.instance(
  "legacy tools config converts to permissions",
  () =>
    Effect.gen(function* () {
      const work = yield* load((svc) => svc.get("work"))
      expect(evalPerm(work, "bash")).toBe("deny")
      expect(evalPerm(work, "read")).toBe("deny")
    }),
  {
    config: {
      agent: {
        work: {
          tools: {
            bash: false,
            read: false,
          },
        },
      },
    },
  },
)

it.instance(
  "legacy tools config maps write/edit/patch to edit permission",
  () =>
    Effect.gen(function* () {
      const work = yield* load((svc) => svc.get("work"))
      expect(evalPerm(work, "edit")).toBe("deny")
    }),
  {
    config: {
      agent: {
        work: {
          tools: {
            write: false,
          },
        },
      },
    },
  },
)

it.instance(
  "Truncate.GLOB is allowed even when user denies external_directory globally",
  () =>
    Effect.gen(function* () {
      const work = yield* load((svc) => svc.get("work"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, work!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, work!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", work!.permission).action).toBe("deny")
    }),
  {
    config: {
      permission: {
        external_directory: "deny",
      },
    },
  },
)

it.instance("global tmp directory children are allowed for external_directory", () =>
  Effect.gen(function* () {
    const work = yield* load((svc) => svc.get("work"))
    expect(
      Permission.evaluate("external_directory", path.join(Global.Path.tmp, "scratch"), work!.permission).action,
    ).toBe("allow")
    expect(Permission.evaluate("external_directory", "/some/other/path", work!.permission).action).toBe("ask")
  }),
)

it.instance(
  "Truncate.GLOB is allowed even when user denies external_directory per-agent",
  () =>
    Effect.gen(function* () {
      const work = yield* load((svc) => svc.get("work"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, work!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, work!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", work!.permission).action).toBe("deny")
    }),
  {
    config: {
      agent: {
        work: {
          permission: {
            external_directory: "deny",
          },
        },
      },
    },
  },
)

it.instance(
  "explicit Truncate.GLOB deny is respected",
  () =>
    Effect.gen(function* () {
      const work = yield* load((svc) => svc.get("work"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, work!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", Truncate.DIR, work!.permission).action).toBe("deny")
    }),
  {
    config: {
      permission: {
        external_directory: {
          "*": "deny",
          [Truncate.GLOB]: "deny",
        },
      },
    },
  },
)

it.instance(
  "skill directories are allowed for external_directory",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const skillDir = path.join(test.directory, ".opencode", "skill", "perm-skill")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: perm-skill
description: Permission skill.
---

# Permission Skill
`,
        ),
      )

      const home = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = test.directory
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.OPENCODE_TEST_HOME = home
        }),
      )

      const work = yield* load((svc) => svc.get("work"))
      const target = path.join(skillDir, "reference", "notes.md")
      expect(Permission.evaluate("external_directory", target, work!.permission).action).toBe("allow")
    }),
  { git: true },
)

it.instance(
  "project reference directories are allowed for external_directory",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const work = yield* load((svc) => svc.get("work"))
      const target = path.resolve(test.directory, "../docs/reference/notes.md")
      expect(Permission.evaluate("external_directory", target, work!.permission).action).toBe("allow")
    }),
  {
    git: true,
    config: {
      references: {
        docs: "../docs",
      },
    },
  },
)

it.instance("defaultAgent returns work when no default_agent config", () =>
  Effect.gen(function* () {
    const agent = yield* load((svc) => svc.defaultAgent())
    expect(agent).toBe("work")
  }),
)

it.instance("defaultInfo returns resolved work agent when no default_agent config", () =>
  Effect.gen(function* () {
    const agent = yield* load((svc) => svc.defaultInfo())
    expect(agent.name).toBe("work")
    expect(agent.mode).toBe("primary")
  }),
)

it.instance(
  "defaultAgent respects default_agent config set to plan",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      expect(agent).toBe("plan")
    }),
  {
    config: {
      default_agent: "plan",
    },
  },
)

it.instance(
  "defaultAgent respects default_agent config set to custom agent with mode all",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      expect(agent).toBe("my_custom")
    }),
  {
    config: {
      default_agent: "my_custom",
      agent: {
        my_custom: {
          description: "My custom agent",
        },
      },
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to subagent",
  () => expectDefaultAgentError('default agent "explore" is a subagent'),
  {
    config: {
      default_agent: "explore",
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to hidden agent",
  () => expectDefaultAgentError('default agent "compaction" is hidden'),
  {
    config: {
      default_agent: "compaction",
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to non-existent agent",
  () => expectDefaultAgentError('default agent "does_not_exist" not found'),
  {
    config: {
      default_agent: "does_not_exist",
    },
  },
)

it.instance(
  "defaultAgent prefers plan when work is disabled and code remains enabled",
  () =>
    Effect.gen(function* () {
      const plan = yield* load((svc) => svc.get("plan"))
      const code = yield* load((svc) => svc.get("code"))
      expect(plan?.mode).toBe("all")
      expect(code?.mode).toBe("all")
      expect(yield* load((svc) => svc.defaultAgent())).toBe("plan")
    }),
  {
    config: {
      agent: {
        work: { disable: true },
      },
    },
  },
)

it.instance(
  "defaultAgent returns plan when work is disabled and default_agent not set",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      // work is disabled, so it should return plan (next primary agent)
      expect(agent).toBe("plan")
    }),
  {
    config: {
      agent: {
        work: { disable: true },
      },
    },
  },
)

it.instance(
  "defaultAgent throws when all primary agents are disabled",
  () => expectDefaultAgentError("no primary visible agent found"),
  {
    config: {
      agent: {
        work: { disable: true },
        plan: { disable: true },
        code: { disable: true },
      },
    },
  },
)

// --- Backwards compatibility -------------------------------------------------
// `build` is the pre-rename id of `work`. It is a config/API identifier, not
// just a label, so configs and clients written before the rename must keep
// working for at least one transition phase.

it.instance("resolves the legacy `build` id onto the work agent", () =>
  Effect.gen(function* () {
    const legacy = yield* load((svc) => svc.get("build"))
    expect(legacy?.name).toBe("work")
  }),
)

it.instance(
  "applies a legacy `agent.build` config block to the work agent",
  () =>
    Effect.gen(function* () {
      const work = yield* load((svc) => svc.get("work"))
      expect(work?.description).toBe("Configured before the rename")
      expect(work?.temperature).toBe(0.4)
    }),
  {
    config: {
      agent: {
        build: {
          description: "Configured before the rename",
          temperature: 0.4,
        },
      },
    },
  },
)

it.instance(
  "honours `default_agent: build` from an existing config",
  () =>
    Effect.gen(function* () {
      expect(yield* load((svc) => svc.defaultAgent())).toBe("work")
      expect((yield* load((svc) => svc.defaultInfo())).name).toBe("work")
    }),
  {
    config: {
      default_agent: "build",
    },
  },
)

it.instance(
  "disables the work agent through a legacy `agent.build` block",
  () =>
    Effect.gen(function* () {
      const names = (yield* load((svc) => svc.list())).map((a) => a.name)
      expect(names).not.toContain("work")
      expect(yield* load((svc) => svc.defaultAgent())).toBe("plan")
    }),
  {
    config: {
      agent: {
        build: { disable: true },
      },
    },
  },
)

// NOTE: a config block keyed `build` always configures `work`, exactly as it
// configured the builtin `build` agent before the rename. Defining a brand new
// agent under the legacy id is therefore not possible while the alias exists.
