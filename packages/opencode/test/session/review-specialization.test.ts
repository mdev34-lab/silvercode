import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { LEGACY_REVIEW_AGENTS, REVIEW_AGENTS, resolveReviewer } from "../../src/agent/review-agents"
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
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "@/session/compaction"
import { SessionSummary } from "@/session/summary"
import { Instruction } from "@/session/instruction"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Skill } from "@/skill"
import { SystemPrompt } from "@/session/system"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
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
    startAuth: () => Effect.die("unexpected MCP auth in review-specialization tests"),
    authenticate: () => Effect.die("unexpected MCP auth in review-specialization tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in review-specialization tests"),
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

// Every parent used below is a primary agent with the finish tool disabled, so
// a text-only scripted reply ends the parent turn cleanly. The reviewers keep
// their finish tool: a reviewer that cannot call it can never end its turn.
const cfg = {
  agent: {
    work: { finishTool: false },
    code: { finishTool: false },
    // A primary with no review specialization. `plan` is the natural generic
    // parent, but plan mode gates the parent's own toolset and drives its own
    // exit, which confounds what this arm is measuring; `custom` is the same
    // routing arm with none of that. `plan` is covered on its own below, so
    // conceding it here would not leave the routing untested.
    custom: { finishTool: false, mode: "primary" as const },
    plan: { finishTool: false },
    // Waiting on a subagent is opt-in per agent (#173). The arms below assert the
    // blocking review handoff, including requests that name a retired specialist:
    // the legacy config keys alias to `review` too, so these three entries all
    // opt the same single reviewer in - kept as a live check of that aliasing.
    review: { background: false },
    "work-review": { background: false },
    "code-review": { background: false },
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

const useServerConfig = Effect.gen(function* () {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      ...cfg,
      provider: {
        ...cfg.provider,
        test: { ...cfg.provider.test, options: { ...cfg.provider.test.options, baseURL: llm.url } },
      },
    }),
  )
  return { dir, llm }
})

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string, agent: string) {
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

const bodyString = (hit: { body: unknown }) => JSON.stringify(hit.body)

const toolNames = (hit: { body: unknown }) =>
  ((hit.body as { tools?: { function?: { name?: string } }[] }).tools ?? [])
    .map((tool) => tool.function?.name ?? "")
    .toSorted()

// A reviewer's request carries that reviewer's own system prompt, headed by
// this section. No parent request does: the parent receives the subagent
// roster, and a roster entry is an agent `description`, not a prompt. Matching
// on prompt text rather than on the dispatched task text matters because the
// parent's later requests replay the task prompt from its own history.
const reviewerMatch = (hit: { body: unknown }) => bodyString(hit).includes("## Verify, Do Not Modify")

// The section a review prompt must carry: the report envelope the runtime
// extracts. Used to recognise a reviewer by what it is bound to deliver rather
// than by what it is called.
const REVIEW_PROMPT_MARKER = "## Final Report Envelope"

// The parent's own turns carry the user request. The review loop policy is only
// injected for the default primary agent, so it cannot identify the parent.
const parentMatch = (hit: { body: unknown }) => {
  const body = bodyString(hit)
  return body.includes(USER_REQUEST) && !reviewerMatch(hit)
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

const USER_REQUEST = "fix the off-by-one in the cache key and add a test"

const TASK_PROMPT = [
  "What was requested: fix the off-by-one in the cache key and add a test.",
  "What changed: src/cache.ts, src/cache.test.ts",
  "Boundary: uncommitted working tree, expected files src/cache.ts and src/cache.test.ts",
  "Diff: @@ -41,7 +41,7 @@ for (let i = 1; i <= entries.length; i++) {",
].join("\n")

// One deterministic dispatch + one reviewer run: the parent hands the unit to
// the reviewer named in `dispatch.subagent_type`, the reviewer's first finish
// carries no envelope (so the gate must reject it as recoverable feedback) and
// its retry delivers one.
const script = (dispatch: { subagent_type: string }) =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    yield* llm.pushMatch(
      parentMatch,
      reply().tool("task", {
        description: "Review cache fix",
        subagent_type: dispatch.subagent_type,
        background: false,
        prompt: TASK_PROMPT,
      }),
    )
    yield* llm.pushMatch(
      reviewerMatch,
      reply()
        .text("Needs fixes: one Important finding")
        .tool("finish", { reason: "success", result: "Needs fixes: one Important finding" }),
    )
    yield* llm.pushMatch(reviewerMatch, reply().tool("finish", { reason: "success", result: REPORT }))
    yield* llm.pushMatch(parentMatch, reply().text("Fixed the off-by-one in src/cache.ts."))
  })

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }

// Runs the full dispatch → reviewer → report chain and returns the parent tool
// part plus the reviewer session id, so callers can assert routing and gating
// against one another.
//
// `parentAgents` is the agent named by each user message, in order. Reviewer
// resolution no longer depends on the parent, but passing the parent keeps the
// dispatch context realistic for the gate and envelope assertions.
const runReview = Effect.fn("test.runReview")(function* (parentAgents: string | string[], subagentType: string) {
  const { llm } = yield* useServerConfig
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({
    title: "Pinned",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  yield* script({ subagent_type: subagentType })
  for (const agent of typeof parentAgents === "string" ? [parentAgents] : parentAgents)
    yield* user(chat.id, USER_REQUEST, agent)
  const result = yield* prompt.loop({ sessionID: chat.id })
  const hits = yield* llm.hits
  expect(result.info.role).toBe("assistant")

  const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
  const toolParts = msgs.flatMap((msg) => msg.parts).filter((part): part is SessionV1.ToolPart => part.type === "tool")
  const taskPart = toolParts.find((part) => part.tool === "task")
  if (!taskPart || taskPart.state.status !== "completed")
    expect(
      JSON.stringify(
        msgs.flatMap((msg) =>
          msg.parts.map((part) => (part.type === "tool" ? `${part.tool}:${part.state.status}` : part.type)),
        ),
      ),
    ).toBe("completed")
  const completed = taskPart as CompletedToolPart
  const child = yield* sessions.get(SessionID.make(completed.state.metadata!.sessionId as string))
  return {
    child,
    taskPart: completed,
    reviewerRequests: hits.filter(reviewerMatch),
    parentFollowUps: hits.filter(parentMatch),
  }
})

// The report gate is applied by agent name in three places, and a name missing
// from REVIEW_AGENTS completes a review without a verdict instead of failing
// loudly. Pin both directions, and identify a reviewer by the report contract
// its prompt carries rather than by its name: a name filter would match
// `preview` and miss a future reviewer not called "*-review", so it would
// neither prove the set is complete nor prove the roster is honest.
it.instance(
  "REVIEW_AGENTS covers every registered reviewer",
  () =>
    Effect.gen(function* () {
      const agent = yield* AgentSvc.Service
      const registered = yield* agent.list()
      const names = registered.map((item) => item.name)

      // Every gated name is a real agent, so the gate can never name a reviewer
      // the registry cannot dispatch.
      for (const name of REVIEW_AGENTS) expect(names).toContain(name)
      // And no other agent carries a reviewer prompt, so joining the roster
      // requires writing the reviewer, not just listing the name.
      const carrying = registered
        .filter((item) => item.prompt?.includes(REVIEW_PROMPT_MARKER))
        .map((item) => item.name)
        .toSorted()
      expect(carrying).toEqual([...REVIEW_AGENTS].toSorted())
    }),
  10_000,
)

// The consolidation retired the specialist reviewers into aliases of the
// single `review` agent. Pin both resolution paths here, where the roster is
// already checked: a stored session row or config that still names a specialist
// must keep working, and it must land on an agent the report gate knows.
it.instance(
  "legacy specialist reviewer names resolve to the single reviewer",
  () =>
    Effect.gen(function* () {
      const agent = yield* AgentSvc.Service
      expect(LEGACY_REVIEW_AGENTS.size).toBeGreaterThan(0)
      for (const legacy of LEGACY_REVIEW_AGENTS) {
        // Dispatch resolution rewrites the name...
        expect(resolveReviewer(legacy)).toBe("review")
        // ...and lookup answers the same agent through the schema's legacy-id
        // table, so a config written against the specialist configures the
        // reviewer that actually runs.
        const resolved = yield* agent.get(legacy)
        expect(resolved?.name).toBe("review")
        expect(REVIEW_AGENTS.has("review")).toBe(true)
      }
      // A non-reviewer name always passes through untouched.
      expect(resolveReviewer("general")).toBe("general")
    }),
  10_000,
)

// The consolidation merged the specialist prompts into one reviewer whose
// prompt is the union of the code and work checklists. Pin the union markers:
// code-review's integration/regression checklist and work-review's non-code
// domain must both survive, or the merge silently dropped a review standard.
it.instance(
  "the single reviewer's prompt is the union of the retired specialist prompts",
  () =>
    Effect.gen(function* () {
      const agent = yield* AgentSvc.Service
      const review = yield* agent.get("review")

      expect(review?.name).toBe("review")
      expect(review?.prompt?.includes(REVIEW_PROMPT_MARKER)).toBe(true)
      // code-review's contribution.
      expect(review?.prompt).toContain("Integration & regressions")
      // work-review's contribution: non-code units are in scope.
      expect(review?.prompt).toContain("mixed workspace work")
      expect(review?.prompt).toContain("configurations validate")
    }),
  10_000,
)

// #165 gave `review` plan-equivalent inspection permissions, including bash,
// with edit denial enforced at the permission seam. The single reviewer keeps
// that boundary, and reaching it through a retired specialist name must land
// on exactly the same ruleset.
it.instance(
  "the single reviewer keeps the #165 permission boundary, through legacy names too",
  () =>
    Effect.gen(function* () {
      const agent = yield* AgentSvc.Service
      const registry = yield* ToolRegistry.Service
      const generic = yield* agent.get("review")

      for (const name of ["review", ...LEGACY_REVIEW_AGENTS]) {
        const reviewer = yield* agent.get(name)
        expect(reviewer).toBeDefined()

        // Structural equivalence, not a re-listing of the same rules: the
        // resolved rulesets are compared, so a rule added to one reviewer and
        // not the other fails here.
        expect(reviewer?.permission).toEqual(generic?.permission)

        // Bash is the whole point of #165: a reviewer that cannot execute
        // cannot reproduce, typecheck, or run the tests it is asked to judge.
        expect(Permission.evaluate("bash", "*", reviewer!.permission).action).toBe("allow")
        expect(Permission.evaluate("edit", "*", reviewer!.permission).action).toBe("deny")
        expect(Permission.evaluate("task", "general", reviewer!.permission).action).toBe("deny")

        const ids = (yield* registry.tools({ providerID: ref.providerID, modelID: ref.modelID, agent: reviewer! })).map(
          (tool) => tool.id,
        )
        expect(ids).toContain("bash")
        expect(ids).toContain("finish")
        expect(ids).not.toContain("edit")
        expect(ids).not.toContain("write")
        expect(ids).not.toContain("apply_patch")
      }
    }),
  10_000,
)

// After the consolidation there is exactly one reviewer: every parent -
// specialist or not - dispatches `review`, and the review plan-equivalent
// toolset and envelope delivery behave identically for each.
for (const parent of ["work", "code", "custom", "plan"]) {
  it.instance(
    `review requested by ${parent} dispatches the single reviewer`,
    () =>
      Effect.gen(function* () {
        const { child, taskPart, reviewerRequests, parentFollowUps } = yield* runReview(parent, "review")

        expect(child.agent).toBe("review")
        expect(child.parentID).toBeDefined()
        // The reviewer that actually ran is the one the child session records,
        // and it ran with the plan-equivalent toolset #165 gave `review`.
        expect(reviewerRequests.length).toBeGreaterThan(0)
        expect(toolNames(reviewerRequests[0] as { body: unknown })).toContain("bash")
        expect(toolNames(reviewerRequests[0] as { body: unknown })).toContain("finish")

        // The verdict came back as the canonical envelope rather than as prose.
        expect(taskPart.state.output).toContain("Needs fixes")
        expect(taskPart.state.metadata?.review).toBeDefined()
        // ...and it reached the parent, which is what makes it usable.
        expect(parentFollowUps.map((hit) => bodyString(hit).includes("src/cache.ts:42"))).toContain(true)
      }),
    20_000,
  )
}

// The report gate, for the single reviewer reached directly and through each
// retired specialist name. Without the gate the first, envelope-less finish
// would complete the review with no verdict, so the child transcript must
// record a rejected finish followed by the accepted one.
for (const reviewer of ["review", ...LEGACY_REVIEW_AGENTS]) {
  it.instance(
    `review requested as ${reviewer} cannot complete without a report envelope`,
    () =>
      Effect.gen(function* () {
        const { child, taskPart } = yield* runReview("custom", reviewer)

        const childMessages = yield* MessageV2.filterCompactedEffect(child.id)
        const finishParts = childMessages
          .flatMap((msg) => msg.parts)
          .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "finish")
        // Without the gate the first, envelope-less finish would have completed
        // the review with no verdict at all.
        expect(finishParts.map((part) => part.state.status)).toEqual(["error", "completed"])
        if (finishParts[0]?.state.status === "error")
          expect(finishParts[0].state.error).toContain("Review finish rejected")

        // The gate ran under the resolved single reviewer, and the accepted
        // report was extracted into the parent's envelope and result metadata.
        expect(child.agent).toBe("review")
        expect(taskPart.state.status).toBe("completed")
        expect(taskPart.state.output).toContain("Needs fixes")
        expect(taskPart.state.metadata?.review).toBeDefined()
      }),
    20_000,
  )
}
