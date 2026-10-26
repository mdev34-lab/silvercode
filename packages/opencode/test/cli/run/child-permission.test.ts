import { describe, expect } from "bun:test"
import { Duration, Effect, Option } from "effect"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"

// A permission request raised by a delegated child session must be answered by the headless run the same
// way as the root's, or the child waits forever.
// A permission request raised by a delegated child session must be answered by the headless run the same
// way as the root's, or the child waits forever.
// Responses are keyed on the session (its first user message) and on how many tool results it has seen, so
// each session gets its own script whatever the interleaving.
const flow = (llm: any, envFile: string) =>
  Effect.gen(function* () {
    const first = (body: any) => JSON.stringify((body.messages ?? []).find((m: any) => m.role === "user") ?? "")
    const tools = (body: any) => (body.messages ?? []).filter((m: any) => m.role === "tool").length
    const session = (text: string, seen: number) => (hit: any) => first(hit.body).includes(text) && tools(hit.body) === seen
    yield* llm.pushMatch((hit: any) => JSON.stringify(hit.body).includes("Generate a title"), reply().text("Update calc").stop())
    yield* llm.pushMatch(
      session("Implement validation in src/calc.ts", 0),
      reply().tool("task", { description: "plan", prompt: "Plan the edit", subagent_type: "think", background: false }),
    )
    yield* llm.pushMatch(
      session("Plan the edit", 0),
      reply().text("<silvercode-result>1. Edit calc.ts</silvercode-result>").tool("finish", { reason: "success", result: "planned" }).stop(),
    )
    yield* llm.pushMatch(
      session("Implement validation in src/calc.ts", 1),
      reply().tool("task", { description: "implement", prompt: "Implement the edit", subagent_type: "code", background: false }),
    )
    yield* llm.pushMatch(session("Implement the edit", 0), reply().tool("read", { filePath: envFile }))
    yield* llm.pushMatch(
      session("Implement the edit", 1),
      reply().text("<silvercode-result>Done</silvercode-result>").tool("finish", { reason: "success", result: "implemented" }).stop(),
    )
    yield* llm.pushMatch(
      session("Implement validation in src/calc.ts", 2),
      reply().text("ROOT_DONE").tool("finish", { reason: "success", result: "done" }).stop(),
    )
  })

type Outcome = { exited: boolean; seen: boolean; rejected: boolean }
const SECRET = "APP_MODE=demo_child_perm_marker"

describe("headless run child permission requests", () => {
  const exec = (extraArgs: string[]) => ({ llm, home, opencode }: any): Effect.Effect<Outcome, unknown, any> =>
    Effect.gen(function* () {
      const envFile = path.join(home, ".env")
      yield* Effect.promise(() => writeFile(envFile, SECRET + "\n"))
      yield* flow(llm, envFile)
      const config = JSON.stringify({
        ...testProviderConfig(llm.url),
        agent: { work: { finishTool: true }, think: { finishTool: true }, code: { finishTool: true } },
      })
      const run = yield* opencode.startRun("Implement validation in src/calc.ts", { extraArgs, env: { OPENCODE_CONFIG_CONTENT: config } })
      const exited = yield* run.result.pipe(Effect.timeoutOption(Duration.seconds(20)))
      const hits = (yield* llm.hits) as any[]
      if (Option.isNone(exited)) {
        run.interrupt()
        yield* run.result
      }
      const stderr = Option.isSome(exited) ? String((exited.value as { stderr?: string }).stderr ?? "") : ""
      return {
        exited: Option.isSome(exited),
        rejected: stderr.includes("permission requested: external_directory") && stderr.includes("auto-rejecting"),
        seen: hits.some((hit) => JSON.stringify(hit.body).includes(SECRET)) }
    })

  cliIt.live("under --yolo a foreground child's read is allowed once and its content is delivered", (ctx) =>
    Effect.gen(function* () {
      const out = yield* exec(["--yolo"])(ctx)
      expect(out).toEqual({ exited: true, seen: true, rejected: false })
    }), 60_000)

  cliIt.live("without --yolo a foreground child's request is rejected, its content is absent and the run exits", (ctx) =>
    Effect.gen(function* () {
      const out = yield* exec([])(ctx)
      expect(out).toEqual({ exited: true, seen: false, rejected: true })
    }), 60_000)
})
