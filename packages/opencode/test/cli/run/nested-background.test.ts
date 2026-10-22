// End-to-end coverage for #222's headless criterion: `opencode run` must not
// exit while a descendant background job is still running.
//
// The scripted run: the main session launches a background subagent; that
// subagent launches a subagent of its own and yields for it; the grandchild
// holds its reply for a controlled delay before answering. A yield ends the
// child's turn, so the child's session goes idle while the grandchild keeps
// running - and with the idle event read as "the launched task resolved", the
// CLI exited there, killing the in-process server and the grandchild with it:
// the child was never resumed and the run's final answer never appeared. The
// hold is what makes the difference observable, so the run may only print the
// final answer after the grandchild's reply has landed.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { httpError, reply } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"

const HOLD_MS = 2_000
const ROOT_PROMPT = "start the nested work"
const CHILD_PROMPT = "look into the cache key path"
const GRANDCHILD_PROMPT = "do the nested work"
const GRANDCHILD_RESULT = "grandchild answer GRANDONLY_OK"
const CHILD_RESULT = "child answer CHILDONLY_OK"
const ROOT_ANSWER = "ROOT_FINAL_OK"

type Message = { role?: string; content?: unknown }
type Body = { messages?: Message[] }

const raw = (body: Body) => JSON.stringify(body)
const messages = (body: Body) => body.messages ?? []
const last = (body: Body) => messages(body)[messages(body).length - 1]
const lastText = (body: Body) => {
  const content = last(body)?.content
  return typeof content === "string" ? content : JSON.stringify(content ?? "")
}

// The prompt of a fresh turn arrives as the last message; a continuation after
// a tool call arrives as a tool result. Matching both the role and the text
// keeps one level's turns apart from the next: every level carries its own
// dispatch description in its transcript.
const opened = (body: Body, prompt: string) => last(body)?.role === "user" && lastText(body).includes(prompt)
const followed = (body: Body, description: string) => last(body)?.role === "tool" && raw(body).includes(description)

describe("opencode run with a subagent that yields for its own subagent", () => {
  cliIt.live(
    "stays alive until the descendant job finishes and still reports the child's final result",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        // Main session: launch the child in the background.
        yield* llm.pushMatch(
          (hit) => opened(hit.body as Body, ROOT_PROMPT),
          reply().tool("task", {
            description: "child dispatch",
            prompt: CHILD_PROMPT,
            subagent_type: "general",
            background: true,
          }),
        )
        // The child: launch a subagent of its own...
        yield* llm.pushMatch(
          (hit) => opened(hit.body as Body, CHILD_PROMPT),
          reply().tool("task", {
            description: "grandchild dispatch",
            prompt: GRANDCHILD_PROMPT,
            subagent_type: "general",
            background: true,
          }),
        )
        // ...and yield for it once the launch reports back. Answering this
        // leaves the child's turn, so the main session's own yield is held back
        // until the child is parked: the exit rule under test is about a session
        // that went idle while its own subagent still runs, and it must not be
        // left to which of the two yields happens to land first.
        let releaseRootYield: () => void = () => {}
        const rootYieldGate = new Promise<void>((resolve) => {
          releaseRootYield = resolve
        })
        yield* llm.pushMatch(
          (hit) => {
            if (!followed(hit.body as Body, "grandchild dispatch")) return false
            const release = setTimeout(releaseRootYield, 400)
            release.unref?.()
            return true
          },
          reply().tool("finish", { reason: "waiting_for_subagent", result: "child yields for the grandchild" }),
        )
        // The main session yields for the child it launched, once the child is
        // parked on the grandchild.
        yield* llm.pushMatch(
          (hit) => followed(hit.body as Body, "child dispatch"),
          reply()
            .wait(rootYieldGate)
            .tool("finish", { reason: "waiting_for_subagent", result: "main yields for the child" }),
        )
        // The grandchild answers only after the hold. If the run exited when the
        // yielded child went idle, this reply never lands.
        yield* llm.pushMatch(
          (hit) => opened(hit.body as Body, GRANDCHILD_PROMPT),
          reply()
            .wait(new Promise((resolve) => setTimeout(resolve, HOLD_MS)))
            .text(GRANDCHILD_RESULT)
            .tool("finish", { reason: "success", result: "grandchild done" }),
        )
        // The child resumes for its grandchild's report and delivers its own result.
        yield* llm.pushMatch(
          (hit) => lastText(hit.body as Body).includes("GRANDONLY_OK"),
          reply().tool("finish", { reason: "success", result: CHILD_RESULT }),
        )
        // The main session resumes for the child's final result.
        yield* llm.pushMatch(
          (hit) => lastText(hit.body as Body).includes("CHILDONLY_OK"),
          reply().text(ROOT_ANSWER).tool("finish", { reason: "success", result: "main done" }),
        )

        const result = yield* opencode.run(ROOT_PROMPT, {
          extraArgs: ["--dangerously-skip-permissions"],
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              // The child dispatches the grandchild, so this run needs a second
              // level and a subagent allowed to delegate.
              subagent_depth: 2,
              // The default test agents end turns without the finish tool, but
              // this flow *is* the finish protocol: a yield only ends a turn
              // while the finish gate is on. The child is also allowed to
              // delegate, which the default subagent rules deny.
              agent: {
                work: { finishTool: true },
                general: { finishTool: true, permission: { task: "allow" } },
                plan: { finishTool: true },
              },
            }),
          },
        })

        opencode.expectExit(result, 0)
        expect(result.stdout).toContain(ROOT_ANSWER)
        // Every scripted reply was pulled: no request fell through to the
        // catch-all, so the flow above is the flow that ran.
        expect(yield* llm.pending).toBe(0)

        const bodies = (yield* llm.inputs).map((body) => body as Body)
        // The grandchild's reply is what the child was resumed with - a
        // provisional delivery would have resumed it with no result at all.
        const resumedChild = bodies.filter((body) => lastText(body).includes("GRANDONLY_OK"))
        expect(resumedChild).toHaveLength(1)
        expect(lastText(resumedChild[0]!)).toContain('state="completed"')
        // The child's terminal result, not a yield, is what reached the parent.
        const resumedRoot = bodies.filter(
          (body) => lastText(body).includes("CHILDONLY_OK") && lastText(body).includes("<task id="),
        )
        expect(resumedRoot).toHaveLength(1)
        expect(lastText(resumedRoot[0]!)).toContain('state="completed"')
      }),
    180_000,
  )
})

// F1: the launcher finishes successfully instead of parking. Its grandchild
// already failed, so a dropped/deferred-only notification leaves a headless
// pending row forever. A successful exit within the harness deadline is the
// regression assertion, not a wall-clock performance threshold.
describe("opencode run with a report deferred during a successful child turn", () => {
  cliIt.live(
    "delivers the deferred report even when the child never parks",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        let rootWaiting!: () => void
        const rootGate = new Promise<void>((resolve) => {
          rootWaiting = resolve
        })
        let grandchildFailed!: () => void
        const failedGate = new Promise<void>((resolve) => {
          grandchildFailed = resolve
        })
        let reportDelivered!: () => void
        const deliveredGate = new Promise<void>((resolve) => {
          reportDelivered = resolve
        })

        yield* llm.pushMatch(
          (hit) => opened(hit.body as Body, ROOT_PROMPT),
          reply().tool("task", {
            description: "child dispatch",
            prompt: CHILD_PROMPT,
            subagent_type: "general",
            background: true,
          }),
        )
        yield* llm.pushMatch(
          (hit) => opened(hit.body as Body, CHILD_PROMPT),
          reply().tool("task", {
            description: "grandchild dispatch",
            prompt: GRANDCHILD_PROMPT,
            subagent_type: "general",
            background: true,
          }),
        )
        yield* llm.pushMatch(
          (hit) => {
            if (!followed(hit.body as Body, "child dispatch")) return false
            rootWaiting()
            return true
          },
          reply().tool("finish", { reason: "waiting_for_subagent", result: "root waits" }),
        )
        yield* llm.pushMatch(
          (hit) => {
            if (!opened(hit.body as Body, GRANDCHILD_PROMPT)) return false
            // Non-retryable failure, with a small drain window for the real
            // processor/job finalizers before the child calls the wait guard.
            setTimeout(grandchildFailed, 300).unref?.()
            return true
          },
          httpError(400, { error: { message: "FAST_GRANDCHILD_FAILURE", type: "invalid_request_error" } }),
        )
        yield* llm.pushMatch(
          (hit) => followed(hit.body as Body, "grandchild dispatch"),
          reply()
            .wait(Promise.all([rootGate, failedGate]))
            .tool("finish", { reason: "waiting_for_subagent", result: "check the wait guard" }),
        )
        // This refusal is evidence that the last grandchild has actually
        // settled. No fabricated finish and no assumed event interleaving.
        yield* llm.pushMatch(
          (hit) =>
            last(hit.body as Body)?.role === "tool" &&
            lastText(hit.body as Body).includes("has no background subagents of its own"),
          reply().tool("finish", { reason: "success", result: "CHILD_EARLY_DONE" }),
        )
        yield* llm.pushMatch(
          (hit) => {
            const body = hit.body as Body
            if (!lastText(body).includes("<task id=") || lastText(body).includes("CHILD_EARLY_DONE")) return false
            if (!raw(body).includes("grandchild dispatch")) return false
            reportDelivered()
            return true
          },
          reply().tool("finish", { reason: "success", result: "late report received" }),
        )
        yield* llm.pushMatch(
          (hit) => lastText(hit.body as Body).includes("CHILD_EARLY_DONE"),
          reply()
            .wait(deliveredGate)
            .text("ROOT_RECOVERED_DEFERRED_REPORT")
            .tool("finish", { reason: "success", result: "root done" }),
        )

        const result = yield* opencode.run(ROOT_PROMPT, {
          // The nested root->child->grandchild gate sequence needs more than
              // 15s of wall clock on the windows runner; the harness deadline
              // above is the regression bound, not this budget (#505).
              timeoutMs: 25_000,
          extraArgs: ["--dangerously-skip-permissions"],
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              subagent_depth: 2,
              agent: {
                work: { finishTool: true },
                general: { finishTool: true, permission: { task: "allow" } },
                plan: { finishTool: true },
              },
            }),
          },
        })
        // On a matcher miss the mock auto-replies without a finish tool and
        // the subprocess dies on the 3-nudge stop far from the cause; dump
        // the unmatched requests so the failing CI log names the miss (#511).
        if (result.exitCode !== 0) {
          const misses = yield* llm.misses
          console.error(
            `[llm-mock] ${misses.length} unmatched request(s):`,
            misses.map((miss) => miss.body).join("\n---\n"),
          )
        }
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("ROOT_RECOVERED_DEFERRED_REPORT")
        expect(yield* llm.pending).toBe(0)
      }),
    30_000,
  )
})
