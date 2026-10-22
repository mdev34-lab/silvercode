import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Config } from "@/config/config"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Config.node, AgentSvc.node])))

it.instance(
  "agent color parsed from project config",
  () =>
    Effect.gen(function* () {
      const cfg = yield* Config.use.get()
      expect(cfg.agent?.["work"]?.color).toBe("#FFA500")
      expect(cfg.agent?.["plan"]?.color).toBe("primary")
    }),
  {
    git: true,
    config: {
      agent: {
        work: { color: "#FFA500" },
        plan: { color: "primary" },
      },
    },
  },
)

it.instance(
  "Agent.get includes color from config",
  () =>
    Effect.gen(function* () {
      const plan = yield* AgentSvc.use.get("plan")
      expect(plan?.color).toBe("#A855F7")
      const work = yield* AgentSvc.use.get("work")
      expect(work?.color).toBe("accent")
    }),
  {
    git: true,
    config: {
      agent: {
        plan: { color: "#A855F7" },
        work: { color: "accent" },
      },
    },
  },
)

it.instance(
  "think agent default color is lilac #A78BFA",
  () =>
    Effect.gen(function* () {
      const think = yield* AgentSvc.use.get("think")
      expect(think?.color).toBe("#A78BFA")
      // The legacy plan id resolves to the same default.
      const plan = yield* AgentSvc.use.get("plan")
      expect(plan?.color).toBe("#A78BFA")
    }),
  { git: true },
)
