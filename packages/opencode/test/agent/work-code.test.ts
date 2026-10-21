import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { BackgroundJob } from "@/background/job"

const baseNodes = [
  Agent.node,
  BackgroundJob.node,
  EventV2Bridge.node,
  Config.node,
  CrossSpawnSpawner.node,
  Session.node,
  SessionProjector.node,
  SessionRunState.node,
  SessionStatus.node,
  Truncate.node,
  ToolRegistry.node,
  Database.node,
  RuntimeFlags.node,
  Ripgrep.node,
] as const

const defaultLayer = LayerNode.compile(LayerNode.group([...baseNodes]))

const lspLayer = LayerNode.compile(LayerNode.group([...baseNodes]), [
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalLspTool: true })],
])

const it = testEffect(defaultLayer)
const itLsp = testEffect(lspLayer)

afterEach(async () => {
  await disposeAllInstances()
})

describe("Work/Code agent split", () => {
  it.instance("work resolves to Work agent", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const work = yield* agent.get("work")
      expect(work).toBeDefined()
      expect(work?.name).toBe("work")
      expect(work?.mode).toBe("primary")
    }),
  )

  it.instance("code resolves to Code agent", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const code = yield* agent.get("code")
      expect(code).toBeDefined()
      expect(code?.name).toBe("code")
      expect(code?.mode).toBe("all")
      expect(code?.prompt).toContain("You cannot delegate tasks to Work or to Code itself")
      expect(code?.prompt).not.toContain("delegate general filesystem or document tasks to Work")
    }),
  )

  it.instance("work can delegate to code through real delegation path", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const work = yield* agent.get("work")
      expect(work).toBeDefined()
      const action = Permission.evaluate("task", "code", work!.permission).action
      expect(action).toBe("allow")

      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        agent: work!,
      })
      const taskTool = tools.find((t) => t.id === "task")
      expect(taskTool).toBeDefined()
      expect(taskTool?.description).toContain("- code:")
    }),
  )

  it.instance("work cannot delegate to itself, and plan is advertised for delegation", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const work = yield* agent.get("work")
      expect(work).toBeDefined()
      expect(Permission.evaluate("task", "work", work!.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "plan", work!.permission).action).toBe("allow")
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        agent: work!,
      })
      const taskTool = tools.find((t) => t.id === "task")
      expect(taskTool).toBeDefined()
      expect(taskTool?.description).not.toContain("- work:")
      expect(taskTool?.description).toContain("- plan:")
    }),
  )

  it.instance("code cannot delegate to work", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const code = yield* agent.get("code")
      expect(code).toBeDefined()
      const action = Permission.evaluate("task", "work", code!.permission).action
      expect(action).toBe("deny")

      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        agent: code!,
      })
      const taskTool = tools.find((t) => t.id === "task")
      expect(taskTool).toBeDefined()
      expect(taskTool?.description).not.toContain("- work:")
      expect(taskTool?.description).toContain("- plan:")
    }),
  )

  it.instance("code receives LSP tools, work does not (permission)", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const work = yield* agent.get("work")
      const code = yield* agent.get("code")
      expect(work).toBeDefined()
      expect(code).toBeDefined()

      expect(Permission.evaluate("lsp", "*", work!.permission).action).toBe("deny")
      expect(Permission.evaluate("lsp", "*", code!.permission).action).toBe("allow")

      const workDisabled = Permission.disabled(["lsp"], work!.permission)
      const codeDisabled = Permission.disabled(["lsp"], code!.permission)
      expect(workDisabled.has("lsp")).toBe(true)
      expect(codeDisabled.has("lsp")).toBe(false)
    }),
  )

  itLsp.instance("work receives LSP tool denied, code receives it when flag enabled", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const work = yield* agent.get("work")
      const code = yield* agent.get("code")
      const registry = yield* ToolRegistry.Service
      const workTools = yield* registry.tools({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        agent: work!,
      })
      const codeTools = yield* registry.tools({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        agent: code!,
      })
      const workHasLsp = workTools.some((t) => t.id === "lsp")
      const codeHasLsp = codeTools.some((t) => t.id === "lsp")
      expect(workHasLsp).toBe(false)
      expect(codeHasLsp).toBe(true)
    }),
  )

  it.instance("session permission denies hide matching built-in tools", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const work = yield* agent.get("work")
      expect(work).toBeDefined()

      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        agent: work!,
        permission: [{ permission: "bash", pattern: "*", action: "deny" }],
      })
      const ids = tools.map((tool) => tool.id)

      expect(ids).not.toContain("bash")
      expect(ids).toContain("finish")
    }),
  )

  it.instance("permission-denied tools are hidden while finish remains available", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      // Plan mode keeps edit visible for its plan files (path-scoped allow), so a
      // blanket-deny agent is what exercises the hidden-tool boundary.
      const readOnly = yield* agent.get("explore")
      expect(readOnly).toBeDefined()

      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        agent: readOnly!,
      })
      const ids = tools.map((tool) => tool.id)

      expect(ids).not.toContain("edit")
      expect(ids).not.toContain("write")
      expect(ids).not.toContain("apply_patch")
      expect(ids).toContain("finish")
    }),
  )

  it.instance("existing agents and delegation behavior unchanged", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const plan = yield* agent.get("plan")
      const explore = yield* agent.get("explore")
      const general = yield* agent.get("general")
      const review = yield* agent.get("review")

      expect(plan).toBeDefined()
      expect(explore).toBeDefined()
      expect(general).toBeDefined()
      expect(review).toBeDefined()

      expect(Permission.evaluate("task", "general", plan!.permission).action).toBe("deny")
      expect(explore?.mode).toBe("subagent")
      expect(Permission.evaluate("task", "*", explore!.permission).action).toBe("deny")
    }),
  )
})
