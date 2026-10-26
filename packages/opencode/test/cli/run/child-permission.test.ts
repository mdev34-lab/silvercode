import { describe, expect } from "bun:test"
import { Duration, Effect, Option } from "effect"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"

// A permission request raised by a delegated child session must be answered by the headless run the same
// way as the root's, or the child waits forever.
// A permission request raised by a delegated child session must be answered by the headless run the same
// way as the root's, or the child waits forever.
const flow = (llm: any, envFile: string) =>
  Effect.gen(function* () {
    yield* llm.pushMatch((hit: any) => JSON.stringify(hit.body).includes("Generate a title"), reply().text("Update calc").stop())
    yield* llm.push(
      reply().tool("task", { description: "plan", prompt: "Plan the edit", subagent_type: "think", background: false }),
      reply().tool("finish", { reason: "success", result: "<silvercode-result>1. Edit calc.ts</silvercode-result>" }),
      reply().tool("task", { description: "implement", prompt: "Implement the edit", subagent_type: "code", background: false }),
      reply().tool("read", { filePath: envFile }),
      reply().tool("finish", { reason: "success", result: "<silvercode-result>Done</silvercode-result>" }),
      reply().text("ROOT_DONE").tool("finish", { reason: "success", result: "done" }).stop(),
    )
  })

const SECRET = "APP_MODE=demo_child_perm_marker"

describe("headless run child permission requests", () => {
  const exec = (extraArgs: string[]) => ({ llm, home, opencode }: any) =>
    Effect.gen(function* () {
      const envFile = path.join(home, ".env")
      yield* Effect.promise(() => writeFile(envFile, SECRET + "\n"))
      yield* flow(llm, envFile)
      const run = yield* opencode.startRun("Implement validation in src/calc.ts", { extraArgs })
      const exited = yield* run.result.pipe(Effect.timeoutOption(Duration.seconds(20)))
      const hits = (yield* llm.hits) as any[]
      if (Option.isNone(exited)) {
        run.interrupt()
        yield* run.result
      }
      return { exited: Option.isSome(exited), seen: hits.some((hit) => JSON.stringify(hit.body).includes(SECRET)) }
    })

  cliIt.live("under --yolo a foreground child's read is allowed once and its content is delivered", (ctx) =>
    Effect.gen(function* () {
      const out = yield* exec(["--yolo"])(ctx)
      expect(out).toEqual({ exited: true, seen: true })
    }), 60_000)

  cliIt.live("without --yolo a foreground child's request is rejected, its content is absent and the run exits", (ctx) =>
    Effect.gen(function* () {
      const out = yield* exec([])(ctx)
      expect(out).toEqual({ exited: true, seen: false })
    }), 60_000)
})
