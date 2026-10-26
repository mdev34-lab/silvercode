import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Shell } from "@opencode-ai/core/shell"
import { Context, Effect, Layer } from "effect"
import os from "os"

import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"
import PROMPT_META from "./prompt/meta.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import PROMPT_STE_LITE from "./prompt/ste-lite.txt"
import type { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { subagentWorktreeEditCapability } from "@/agent/subagent-permissions"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Reference } from "@opencode-ai/core/reference"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

export const STE_LITE = PROMPT_STE_LITE

export function chat(input: { config?: boolean; hidden?: boolean; small?: boolean; format?: string }) {
  if (input.config === false) return false
  if (input.hidden === true) return false
  if (input.small === true) return false
  if (input.format === "json_schema") return false
  return true
}

export function style(enabled: boolean) {
  if (!enabled) return []
  return [PROMPT_STE_LITE]
}

export function provider(model: Provider.Model) {
  if (model.api.id.includes("muse")) {
    const name = model.api.id.includes("muse-glimmer") ? "Muse Glimmer" : "Muse Spark"
    return [PROMPT_META.replaceAll("{{MODEL_NAME}}", name)]
  }
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (
    model.api.id.toLowerCase().includes("kimi") ||
    ["kimi-for-coding", "moonshotai", "moonshotai-cn"].includes(model.providerID)
  )
    return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly mcp: (agent: Agent.Info, permission?: PermissionV1.Ruleset) => Effect.Effect<string | undefined>
  readonly delegation: (agent: Agent.Info, permission?: PermissionV1.Ruleset) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const agents = yield* Agent.Service
    const mcp = yield* MCP.Service
    const locations = yield* LocationServiceMap.Service
    const config = yield* Config.Service
    const global = yield* Global.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        const shell = Shell.name(Shell.acceptable((yield* config.get()).shell))
        const references = yield* Effect.gen(function* () {
          return (yield* (yield* Reference.Service).list()).filter((reference) => reference.description !== undefined)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Desktop directory: ${global.desktop ?? "unavailable (do not infer a path)"}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  OS: ${os.type()} ${os.release()}; Shell: ${shell}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
          references.length === 0
            ? undefined
            : [
                "Project references provide additional directories that can be accessed when relevant.",
                "<available_references>",
                ...references
                  .toSorted((a, b) => a.name.localeCompare(b.name))
                  .flatMap((reference) => [
                    "  <reference>",
                    `    <name>${reference.name}</name>`,
                    `    <path>${reference.path}</path>`,
                    ...(reference.description === undefined
                      ? []
                      : [`    <description>${reference.description}</description>`]),
                    "  </reference>",
                  ]),
                "</available_references>",
              ].join("\n"),
        ].filter((part): part is string => part !== undefined)
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),

      delegation: Effect.fn("SystemPrompt.delegation")(function* (
        agent: Agent.Info,
        permission?: PermissionV1.Ruleset,
      ) {
        // Only primary-style callers drive delegation; subagents execute.
        if (agent.mode === "subagent") return

        const ctx = yield* InstanceState.context
        const cfg = yield* config.get()

        const work = yield* agents.get("work")
        if (work?.native === true && agent === work)
          return [
            "Programming requests require completed Think planning before Code implementation, then a clean Review. Work cannot implement programming directly, including tiny edits.",
            "Non-programming work must not go to Code. At fast effort, medium-sized work may be manual; complex or thorough work goes to General; medium effort balances direct work and General delegation.",
            "When it is unclear whether a request changes software, carry on with the work (inspect, run commands, delegate to General); use the question tool only if the answer would change what you do. If it turns out to be programming, follow the Think, Code, Review workflow. Do not relabel programming to evade its workflow.",
            "Failed, cancelled or pending children are not successful stage completion. A pass budget cannot excuse reporting success with blocking findings.",
          ].join("\n")

        // Built from the live registry: any non-primary, non-hidden agent the
        // merged agent + session permission ruleset may delegate to. The
        // caller is filtered out only where the guidance is advertised, so
        // planner identity below can be resolved against the real registry.
        const ruleset = Permission.merge(agent.permission, permission ?? [])
        const eligible = (yield* agents.list()).filter(
          (item) =>
            item.mode !== "primary" &&
            item.hidden !== true &&
            Permission.evaluate("task", item.name, ruleset).action !== "deny",
        )
        // A planner plans; an implementer writes software for a living. Both
        // are identified from registry names and descriptions, never from
        // hardcoded agent names, so renames and custom agents keep working.
        // Read-only explorers and reviewers match neither pattern.
        const planners = eligible.filter((item) => /\bplan/i.test(item.name) || /\bplan/i.test(item.description ?? ""))
        // Capability check, not just a name match: a read-only candidate
        // (reviewer, auditor) that the registry forbids to edit can never
        // implement, whatever its description claims. Evaluated against the
        // ruleset the spawned child session would actually run under, probed
        // at real worktree paths, so session-level and worktree-scoped denies
        // suppress the promise; a deny scoped to a subtree keeps the
        // advertisement but marks it partial so the guidance stays accurate.
        const capability = new Map<string, "full" | "partial" | "denied">()
        const implementers = eligible.filter((item) => {
          if (planners.includes(item)) return false
          if (!/\bcode\b/i.test(item.name) && !/\bengineer/i.test(item.description ?? "")) return false
          const level = subagentWorktreeEditCapability({
            worktree: ctx.worktree,
            subagent: item,
            parentSessionPermission: permission ?? [],
            primaryTools: cfg.experimental?.primary_tools,
          })
          capability.set(item.name, level)
          return level !== "denied"
        })
        // The planning agent itself plans; its own prompt governs it. This is
        // an identity check against the discovered planners - only non-primary
        // agents are eligible above, so a primary agent that merely mentions
        // planning in its description can never lose the guidance here.
        if (planners.some((item) => item.name === agent.name)) return
        const delegatable = (list: Agent.Info[]) => list.filter((item) => item.name !== agent.name)
        const plannersToAdvertise = delegatable(planners)
        const implementersToAdvertise = delegatable(implementers)
        if (plannersToAdvertise.length === 0 && implementersToAdvertise.length === 0) return

        // Accurate guidance: when session rules restrict subagent edits to
        // only part of the worktree, the delegation promise must not read as
        // unrestricted implementation.
        const partial = implementersToAdvertise.some((item) => capability.get(item.name) === "partial")
        const scopeNote = partial
          ? "Session rules restrict subagent edits in parts of the worktree; scope delegated implementation steps to permitted paths."
          : undefined

        const names = (list: Agent.Info[]) => list.map((item) => `\`${item.name}\``).join(" or ")
        if (implementersToAdvertise.length === 0) {
          return [
            `When a request needs non-trivial implementation planning, delegate that planning to ${names(plannersToAdvertise)} once, at the start, with the task tool.`,
            "Then work the plan step by step, carrying it forward instead of re-deriving or re-planning it at every tool call.",
          ].join("\n")
        }
        if (plannersToAdvertise.length === 0) {
          return [
            `Delegate by default: you coordinate and ${names(implementersToAdvertise)} implements.`,
            `For anything beyond a small task, delegate each implementation step to ${names(implementersToAdvertise)} with the task tool.`,
            ...(scopeNote ? [scopeNote] : []),
            "Direct work is the exception, reserved for small tasks - a quick lookup, a tiny edit, a short answer.",
            "You stay responsible for the outcome: give each subagent complete context, then verify and integrate what it returns.",
          ].join("\n")
        }
        return [
          `Delegate by default: you coordinate, ${names(plannersToAdvertise)} plans, and ${names(implementersToAdvertise)} implements.`,
          `For anything beyond a small task, delegate planning to ${names(plannersToAdvertise)} once, at the start, with the task tool, then delegate each implementation step to ${names(implementersToAdvertise)}.`,
          ...(scopeNote ? [scopeNote] : []),
          "Direct work is the exception, reserved for small tasks - a quick lookup, a tiny edit, a short answer.",
          "You stay responsible for the outcome: give each subagent complete context, then verify and integrate what it returns instead of re-deriving or re-planning it at every tool call.",
        ].join("\n")
      }),

      mcp: Effect.fn("SystemPrompt.mcp")(function* (agent: Agent.Info, permission?: PermissionV1.Ruleset) {
        const ruleset = Permission.merge(agent.permission, permission ?? [])
        const instructions = (yield* mcp.instructions()).filter(
          (item) => item.tools.length === 0 || Permission.disabled(item.tools, ruleset).size < item.tools.length,
        )
        if (instructions.length === 0) return

        return [
          "<mcp_instructions>",
          ...instructions.flatMap((item) => [
            `  <server name="${item.name}">`,
            ...item.instructions.split("\n").map((line) => `    ${line}`),
            "  </server>",
          ]),
          "</mcp_instructions>",
        ].join("\n")
      }),
    })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Skill.node, MCP.node, Config.node, Global.node, Agent.node, locationServiceMapNode],
})

export * as SystemPrompt from "./system"
