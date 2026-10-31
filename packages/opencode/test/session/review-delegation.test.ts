import { scriptWorkStages, stageMatch } from "../fixture/work-flow"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in review-delegation tests"),
    authenticate: () => Effect.die("unexpected MCP auth in review-delegation tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in review-delegation tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

const root = LayerNode.compile(LayerNode.group([promptRoot, testLLMServerNode]), [
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, mcp],
  [RuntimeFlags.node, runtimeFlags],
])

const it = testEffect(root)

// Finish stays enabled for `review` so the subagent path exercised here matches
// production (subagents end their turn through the finish tool). The primary
// agents opt out so scripted text-only replies can end their turns; `custom`
// is a non-default primary agent used as the control arm for delegation.
const cfg = {
  agent: {
    work: { finishTool: false },
    general: { finishTool: false },
    plan: { finishTool: false },
    custom: { finishTool: false, mode: "primary" as const },
  },
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

const serverConfig = (agents: Record<string, object> = {}) =>
  Effect.gen(function* () {
    const { directory: dir } = yield* TestInstance
    const llm = yield* TestLLMServer
    const fs = yield* FSUtil.Service
    yield* fs.writeWithDirs(
      path.join(dir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        ...cfg,
        agent: { ...cfg.agent, ...agents },
        provider: {
          ...cfg.provider,
          test: { ...cfg.provider.test, options: { ...cfg.provider.test.options, baseURL: llm.url } },
        },
      }),
    )
    return { dir, llm }
  })

const useServerConfig = serverConfig()

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string, agent = "work") {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent,
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

// The Review Loop policy and effort block are a nudge that appears once the
// session has written files (the finish gate enforces the requirement either
// way). Seed an earlier turn whose completed edit declared a file write.
const seedPriorWrite = Effect.fn("test.seedPriorWrite")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  const earlier = yield* user(sessionID, "earlier request")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: earlier.id,
    sessionID,
    mode: "work",
    agent: "work",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "tool",
    callID: "call-seed-edit",
    tool: "edit",
    state: {
      status: "completed",
      input: {},
      output: "ok",
      title: "edit",
      metadata: { reviewLoop: { writesFiles: true } },
      time: { start: Date.now(), end: Date.now() },
    },
  } as SessionV1.ToolPart)
})

const bodyString = (hit: { body: unknown }) => JSON.stringify(hit.body)

const toolNames = (hit: { body: unknown }) =>
  ((hit.body as { tools?: { function?: { name?: string } }[] }).tools ?? [])
    .map((tool) => tool.function?.name ?? "")
    .toSorted()

// A reviewer's request carries that reviewer's own system prompt, headed by
// this section. A parent request never does: the parent receives the subagent
// roster, and a roster entry is an agent `description`, not a prompt. Matching
// on the heading rather than on one reviewer's own name is what keeps this
// file working now that the runtime routes `review` to a runtime-specific
// reviewer.
const reviewerMatch = (hit: { body: unknown }) => bodyString(hit).includes("## Verify, Do Not Modify")

// A primary-agent request that carries the delegation policy, and one that
// does not. Title requests are auto-answered by the test server and never
// reach these matchers.
const policyMatch = (hit: { body: unknown }) => {
  const body = bodyString(hit)
  return body.includes("## Review Loop") && !reviewerMatch(hit) && !stageMatch(hit)
}

const noPolicyMatch = (hit: { body: unknown }) => {
  const body = bodyString(hit)
  return body.includes("You are opencode") && !body.includes("## Review Loop")
}

// The reviewer's report, distinctive enough to trace into the parent's next
// model request. It ends with the machine-readable report envelope the task
// tool extracts as the canonical review result.
const REVIEW_REPORT = {
  version: 1,
  revision: "uncommitted",
  assessment: "needs-fixes",
  summary: "The cache lookup skips the first entry, so cached reads miss.",
  findings: [
    {
      severity: "important",
      title: "Off-by-one skips the first cache entry",
      file: "src/cache.ts",
      line: 42,
      detail: "The loop must start at 0.",
    },
  ],
}
const REPORT = [
  "### Spec Compliance",
  "- ❌ Issues found: cache key drops the tenant prefix (src/cache.ts:42)",
  "",
  "#### Important (Should Fix)",
  "- src/cache.ts:42: off-by-one skips the first cache entry; the loop must start at 0",
  "",
  "### Assessment",
  "**Ready to proceed?** Needs fixes",
  "",
  "<silvercode-review>",
  JSON.stringify(REVIEW_REPORT, null, 2),
  "</silvercode-review>",
].join("\n")

const TASK_PROMPT = [
  "What was requested: fix the off-by-one in the cache key and add a test.",
  "What changed: src/cache.ts, src/cache.test.ts",
  "Boundary: uncommitted working tree, expected files src/cache.ts and src/cache.test.ts",
  "Diff: @@ -41,7 +41,7 @@ for (let i = 1; i <= entries.length; i++) {",
].join("\n")

// A deterministic instruction-follower: it hands completed work to the review
// subagent exactly when its request tells it to, and otherwise falls back to
// the pre-fix behavior of reviewing its own diff. Scripting the decision this
// way is what makes the causal claim testable offline: the SAME script must
// delegate in one arm below and not in the other, with the presence of the
// delegation policy as the only difference. Together the two arms verify the
// chain instruction-in-request → tool call → dispatch → verdict → consumption.
const scriptPolicyFollowingModel = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  // Policy present: after finishing the unit, hand it to the reviewer
  // synchronously with the evidence the reviewer needs.
  yield* llm.pushMatch(
    policyMatch,
    reply().tool("task", {
      description: "Review cache fix",
      subagent_type: "review",
      background: false,
      prompt: TASK_PROMPT,
    }),
  )
  // The first reviewer response reaches the real finish tool with prose only —
  // no envelope anywhere in the reply, because the gate scans the message text
  // parts as well as the result. The gate must reject it as recoverable model
  // feedback and keep the review session alive for the model to retry.
  yield* llm.pushMatch(
    reviewerMatch,
    reply()
      .text("Needs fixes: one Important finding")
      .tool("finish", { reason: "success", result: "Needs fixes: one Important finding" }),
  )
  // Retry after the recoverable finish failure. This response supplies the
  // required envelope through the real finish call, so the review can complete.
  yield* llm.pushMatch(reviewerMatch, reply().tool("finish", { reason: "success", result: REPORT }))
  // Policy present, verdict received: consume it and fix the finding.
  yield* llm.pushMatch(policyMatch, reply().text("Fixed the off-by-one in src/cache.ts.").stop())
  // Policy absent (control arm): self-review, the old behavior.
  yield* llm.pushMatch(noPolicyMatch, reply().text("I re-read the diff and the tests pass — the fix looks correct.").stop())
})

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }

// Prompt-surface coverage only: the delegation policy text must reach the
// model on every turn of the default primary agent, and the task tool must
// describe the review handoff and list the review agent as proactive. This
// pins the instruction surface; the two policy-follower arms below are what
// connect it to behavior.
it.instance(
  "default primary request surfaces the review delegation policy and the task tool describes the handoff",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* seedPriorWrite(chat.id)
      yield* user(chat.id, "fix the off-by-one in the cache key")
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for the model request", "10 seconds")

      const hits = yield* llm.hits
      const parent = hits.find(policyMatch)
      expect(parent).toBeDefined()
      const body = bodyString(parent ?? { body: {} })

      // The trigger: units of work that changed files, the verification stage,
      // and explicit user review requests.
      expect(body).toContain("unit of work that changed files")
      expect(body).toContain("the required next step is review, not completion")
      expect(body).toContain("explicitly asks for a code review")

      // Review is expected before finishing file-writing work; without one the result is delivered
      // labelled UNREVIEWED, never approved.
      expect(body).toContain("Review is required before finishing file-writing work.")
      expect(body).toContain("`finish` delivers it labelled UNREVIEWED")
      expect(body).not.toContain("explicitly skip review")

      // The carve-out: trivial turns with no file changes must not be reviewed.
      expect(body).toContain("does not apply to turns with no file changes")

      // The handoff is synchronous so the verdict lands before completion is
      // claimed.
      expect(body).toContain("background: false")

      // Findings must be consumed, including reports that arrive late.
      expect(body).toContain("instruction to act, not an acknowledgment")
      expect(body).toContain("correct the record")

      // The task tool teaches the review handoff and lists the review agent in
      // its roster with proactive-use wording.
      expect(body).toContain("Review handoffs")
      expect(body).toContain("- review: Code reviewer")
      expect(body).toContain("Use this proactively, without being asked")

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  15_000,
)

// Activation: a fresh session does not carry the Review Loop policy; the
// request right after the first file write does (and keeps the effort block).
for (const [selected, ownerEffort, effort] of [
  ["medium", undefined, "medium"], ["ultra", undefined, "ultra"],
  [undefined, "ultra", "ultra"], ["medium", "ultra", "medium"],
  [undefined, "thorough", "medium"],
] as const) {
  it.instance(
    `review policy appears on the request after the session's first file write (${selected ?? "unset"}/${ownerEffort ?? "root"} -> ${effort})`,
    () =>
      Effect.gen(function* () {
        const { llm, dir } = yield* useServerConfig
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const owner = ownerEffort ? yield* sessions.create({ title: "owner", metadata: { agentEffort: ownerEffort } }) : undefined
        const chat = yield* sessions.create({
          title: "Pinned",
          ...(owner ? { parentID: owner.id } : {}),
          ...(selected ? { metadata: { agentEffort: selected } } : {}),
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        expect((yield* sessions.get(chat.id)).metadata?.agentEffort).toBe(selected)
        yield* llm.tool("write", { filePath: `${dir}/first-write.txt`, content: "hello" })
        yield* llm.hang
        yield* user(chat.id, "Write a report in first-write.txt")
        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* awaitWithTimeout(llm.wait(2), "timed out waiting for the post-write request", "10 seconds")

        const hits = (yield* llm.hits).filter((hit) => !reviewerMatch(hit) && bodyString(hit).includes("You are opencode"))
        expect(hits.length).toBeGreaterThanOrEqual(2)
        expect(bodyString(hits[0])).not.toContain("## Review Loop")
        expect(bodyString(hits[0])).not.toContain("## Agent effort")
        expect(bodyString(hits[1])).toContain("## Review Loop")
        expect(bodyString(hits[1])).toContain(`## Agent effort: ${effort}`)
        if (effort === "ultra") {
          expect(bodyString(hits[1])).toContain("up to 3 disjoint slices")
          expect(bodyString(hits[1])).toContain("origin verbatim")
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
    20_000,
  )
}

// Compaction can remove the write markers from the visible history; a
// compacted session keeps the policy on.
it.instance(
  "review policy stays on for a compacted session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const session = yield* Session.Service
      const compactionUser = yield* user(chat.id, "compact")
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: compactionUser.id,
        sessionID: chat.id,
        type: "compaction",
        auto: false,
      } as SessionV1.CompactionPart)
      const summary: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: compactionUser.id,
        sessionID: chat.id,
        mode: "compaction",
        agent: "compaction",
        summary: true,
        finish: "stop",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
      }
      yield* session.updateMessage(summary)
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: summary.id,
        sessionID: chat.id,
        type: "text",
        text: "Summary of earlier work.",
      })
      yield* llm.hang
      yield* user(chat.id, "continue")
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for the model request", "10 seconds")

      const hit = (yield* llm.hits).find((h) => !reviewerMatch(h) && bodyString(h).includes("You are opencode"))
      expect(bodyString(hit ?? { body: {} })).toContain("## Review Loop")

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  20_000,
)

// Provider prompts must route explicit review requests to the review subagent
// instead of telling the model to review the code itself.
it.effect("gpt provider prompt routes review requests through the review subagent", () =>
  Effect.sync(function* () {
    const model = {
      api: { id: "gpt-5.1-mini" },
      providerID: ProviderV2.ID.make("test"),
    } as Parameters<typeof SystemPrompt.provider>[0]
    const prompt = SystemPrompt.provider(model).join("\n")
    expect(prompt).toContain("dispatch the `review` subagent")
    expect(prompt).toContain("instead of reviewing the code yourself")
    expect(prompt).not.toContain("default to a code review mindset")
  }),
)

// Behavioral arm (policy present): the default primary agent's requests carry
// the delegation policy, so the scripted policy-follower dispatches `review`,
// the reviewer runs with its own review prompt (and no review loop of its
// own — no recursion), and its findings land in the parent's next model
// request next to the instructions for acting on them. If the policy stops
// being injected, the script's no-policy branch fires instead and this test
// fails — the delegation is decided by the request contents, not hardcoded.
it.instance(
  "policy-following model delegates review and consumes the findings (default primary)",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* serverConfig({plan:{finishTool:true},think:{finishTool:true},code:{finishTool:true}})
      yield* scriptWorkStages(policyMatch)
      yield* scriptPolicyFollowingModel

      yield* seedPriorWrite(chat.id)
      yield* user(chat.id, "Fix the software bug in the cache key and add a test")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const hits = yield* llm.hits
      const policyHits = hits.filter(policyMatch)
      const reviewHits = hits.filter(reviewerMatch)
      expect(reviewHits).toHaveLength(2)

      // The reviewer ran with its own prompt — and no review loop of its own,
      // so reviews cannot recurse. After the consolidation every parent
      // resolves `review` to the same single reviewer.
      const reviewBody = bodyString(reviewHits[0])
      expect(reviewBody).toContain("Senior Reviewer")
      expect(reviewBody).not.toContain("## Review Loop")
      expect(reviewBody).toContain("uncommitted working tree")

      // The reviewer gets the plan-equivalent toolset — including bash for
      // verification — and it still gets the finish tool: without it a
      // subagent can never end its turn, and the dispatch wedges in finish
      // nudges instead of returning a verdict. Edit denial is enforced at
      // the permission seam (agent tests), not the tool listing, exactly as
      // for plan sessions.
      const reviewTools = toolNames(reviewHits[0])
      expect(reviewTools).toContain("finish")
      expect(reviewTools).toContain("read")
      expect(reviewTools).toContain("bash")
      expect(reviewTools).toContain("task")

      // The script's delegation branch fired: a synchronous review-agent
      // child session exists for this parent.
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskPart = msgs
        .flatMap((msg) => msg.parts)
        .find((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task" && part.state.input.subagent_type === "review")
      expect(taskPart?.state.status).toBe("completed")
      const completed = taskPart as CompletedToolPart
      expect(completed.state.metadata?.background).not.toBe(true)
      expect(completed.state.output).toContain("Needs fixes")
      const childID = completed.state.metadata?.sessionId
      expect(typeof childID).toBe("string")
      const child = yield* sessions.get(SessionID.make(childID as string))
      expect(child.agent).toBe("review")
      expect(child.parentID).toBe(chat.id)

      // The real Review runner must record the rejected first finish and then
      // the successful retry. Without the finish gate, this sequence would
      // incorrectly appear as two successful completions and the regression
      // would not exercise recoverable tool feedback.
      const childMessages = yield* MessageV2.filterCompactedEffect(child.id)
      const finishParts = childMessages
        .flatMap((msg) => msg.parts)
        .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "finish")
      expect(finishParts).toHaveLength(2)
      expect(finishParts.map((part) => part.state.status)).toEqual(["error", "completed"])
      if (finishParts[0]?.state.status === "error") {
        expect(finishParts[0].state.error).toContain("Review finish rejected")
      }
      expect(finishParts[1]?.state.status).toBe("completed")

      // The findings were consumed: the parent's follow-up request contains
      // the report and the instructions to act on it.
      expect(policyHits).toHaveLength(4)
      const followUp = bodyString(policyHits[3])
      expect(followUp).toContain("Needs fixes")
      expect(followUp).toContain("src/cache.ts:42")
      expect(followUp).toContain("instruction to act, not an acknowledgment")
    }),
  20_000,
)

// Control arm (policy absent): same scripted model, non-default primary agent
// — the loop only injects the delegation policy for the default primary, so
// its requests do not carry it and the script must fall back to self-review.
// This is the counterfactual that keeps the arm above honest: identical
// script, the presence of the instruction is the only difference.
it.instance(
  "same model does not delegate when the delegation policy is absent (non-default primary)",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        agent: "custom",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* scriptPolicyFollowingModel

      yield* user(chat.id, "fix the off-by-one in the cache key and add a test", "custom")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const hits = yield* llm.hits

      // Manipulation check: this agent's request really did lack the policy.
      const noPolicyHits = hits.filter(noPolicyMatch)
      expect(noPolicyHits).toHaveLength(1)
      expect(bodyString(noPolicyHits[0])).not.toContain("## Review Loop")

      // ...so the same model that delegated above did not dispatch a reviewer.
      expect(hits.filter(policyMatch)).toHaveLength(0)
      expect(hits.filter(reviewerMatch)).toHaveLength(0)
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(msgs.flatMap((msg) => msg.parts).some((part) => part.type === "tool" || part.type === "subtask")).toBe(
        false,
      )
      expect(
        msgs.some((msg) =>
          msg.parts.some((part) => part.type === "text" && part.text.includes("I re-read the diff and the tests pass")),
        ),
      ).toBe(true)
    }),
  20_000,
)

// Trivial conversational turn: the carve-out reaches the model, nothing
// dispatches a reviewer (the scripted reply is text-only, matching what the
// carve-out asks for), and the turn completes normally without synthetic
// review injections.
it.instance(
  "trivial conversational turn completes without review delegation",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("Hello! What can I help you with?")
      yield* user(chat.id, "hi")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const hits = yield* llm.hits
      const parentHits = hits.filter(noPolicyMatch)
      expect(parentHits).toHaveLength(1)

      // Before any file write the Review Loop policy is not sent (no tokens
      // spent on it); the todo scope contract still is.
      const body = bodyString(parentHits[0] ?? { body: {} })
      expect(body).toContain("## Todo as scope contract")
      expect(body).not.toContain("## Review Loop")

      // Nothing dispatched a reviewer and no review nudge was injected: the
      // only parts are the user's greeting and the assistant's reply.
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const parts = msgs.flatMap((msg) => msg.parts)
      expect(parts.some((part) => part.type === "tool")).toBe(false)
      expect(parts.some((part) => part.type === "subtask")).toBe(false)
      expect(
        parts.filter(
          (part): part is SessionV1.TextPart => part.type === "text" && "synthetic" in part && part.synthetic === true,
        ),
      ).toHaveLength(0)
    }),
  15_000,
)

// No reviewer opt-in in these configs. Exercise the real model/tool pipeline,
// routing, report delivery, and approval.
for (const [parent, reviewer] of [
  ["work", "review"],
  ["code", "review"],
  ["custom", "review"],
]) {
  for (const effort of ["medium", "thorough"] as const) {
    it.instance(
      `default ${reviewer} delivers review before ${parent} finishes (${effort})`,
      () =>
        Effect.gen(function* () {
          const { dir, llm } = yield* serverConfig({ [parent]: { finishTool: true }, ...(parent === "work" ? {plan:{finishTool:true},think:{finishTool:true},code:{finishTool:true}} : {}) })
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const chat = yield* sessions.create({
            title: "Pinned",
            agent: parent,
            metadata: { agentEffort: effort },
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const parentMatch = (hit: { body: unknown }) => !reviewerMatch(hit) && (parent !== "work" || !stageMatch(hit))
          if (parent === "work") yield* scriptWorkStages(parentMatch,{filePath:path.join(dir,"result.txt"),content:"verified work"})
          else yield* llm.pushMatch(
            parentMatch,
            reply().tool("write", { filePath: path.join(dir, "result.txt"), content: "verified work" }),
          )
          yield* llm.pushMatch(
            parentMatch,
            reply().tool("task", { description: "Review file", subagent_type: "review", prompt: "Review result.txt" }),
          )
          const report = `<silvercode-review>\n${JSON.stringify({ ...REVIEW_REPORT, assessment: "approved", summary: "No findings.", findings: [] })}\n</silvercode-review>`
          yield* llm.pushMatch(reviewerMatch, reply().tool("finish", { reason: "success", result: report }))
          yield* llm.pushMatch(parentMatch, reply().tool("finish", { reason: "success", result: "reviewed work" }))
          yield* user(chat.id, parent === "work" ? "Implement software and write result.txt, then review it" : "write result.txt and review it", parent)
          yield* prompt.loop({ sessionID: chat.id })
          const history = yield* sessions.messages({ sessionID: chat.id })
          if(process.env.WORK_FLOW_CAPTURE && parent === "work") {
            const children=yield* sessions.children(chat.id)
            const childMessages:Record<string,unknown>={}
            for(const child of children) childMessages[child.id]=yield* sessions.messages({sessionID:child.id})
            yield* Effect.promise(()=>Bun.write(`/tmp/wf-runtime-success-${effort}.json`,JSON.stringify({session:chat,messages:history,children,childMessages})))
          }
          const tools = history
            .flatMap((message) => message.parts)
            .filter((part): part is SessionV1.ToolPart => part.type === "tool")
          if(parent === "work") {
            const implementation=tools.find(part=>part.tool === "task" && part.state.input.subagent_type === "code")
            expect(implementation?.state.status).toBe("completed")
            if(implementation?.state.status === "completed") {
              const childHistory=yield* sessions.messages({sessionID:SessionID.make(implementation.state.metadata.sessionId)})
              expect(childHistory.flatMap(message=>message.parts).find((part):part is SessionV1.ToolPart=>part.type === "tool" && part.tool === "write")?.state.status).toBe("completed")
            }
          } else expect(tools.find((part) => part.tool === "write")?.state.status).toBe("completed")
          const finishes = tools.filter((part) => part.tool === "finish")
          expect(finishes.map((part) => part.state.status)).toEqual(["completed"])
          const task = tools.find((part) => part.tool === "task" && part.state.input.subagent_type === "review")
          expect(task?.state.status).toBe("completed")
          if (task?.state.status !== "completed") return
          expect(task.state.metadata.background).toBe(false)
          const child = yield* sessions.get(SessionID.make(task.state.metadata.sessionId))
          expect(child.agent).toBe(reviewer)
          expect(task.state.metadata.review.report.assessment).toBe("approved")
          const last = finishes.at(-1)
          if (last?.state.status !== "completed") return
          expect(last.state.metadata.review).toMatchObject({
            effort,
            disposition: "reviewed",
            termination: "approved",
            reviews: 1,
          })
        }),
      20_000,
    )
  }
}
