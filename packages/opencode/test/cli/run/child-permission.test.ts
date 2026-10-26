import { describe, expect } from "bun:test"
import { Duration, Effect, Option } from "effect"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"

// A permission request raised by a delegated child session must be answered by the headless run the same
// way as the root's, or the child waits forever.
describe("headless run child permission requests", () => {
  cliIt.live("a foreground child's permission request is answered under --yolo", ({ llm, home, opencode }) =>
    Effect.gen(function* () {
      const envFile = path.join(home, ".env")
      yield* Effect.promise(() => writeFile(envFile, "APP_MODE=demo\n"))
      yield* llm.pushMatch((hit) => JSON.stringify(hit.body).includes("Generate a title"), reply().text("Update calc").stop())
      yield* llm.push(
        reply().tool("task", { description: "plan", prompt: "Plan the edit", subagent_type: "think", background: false }),
        reply().tool("finish", { reason: "success", result: "<silvercode-result>1. Edit calc.ts</silvercode-result>" }),
        reply().tool("task", { description: "implement", prompt: "Implement the edit", subagent_type: "code", background: false }),
        reply().tool("read", { filePath: envFile }),
        reply().tool("finish", { reason: "success", result: "<silvercode-result>Done</silvercode-result>" }),
        reply().text("ROOT_DONE").tool("finish", { reason: "success", result: "done" }).stop(),
      )
      const run = yield* opencode.startRun("Implement validation in src/calc.ts", { extraArgs: ["--yolo"] })
      const exited = yield* run.result.pipe(Effect.timeoutOption(Duration.seconds(20)))
      const hits = (yield* llm.hits).length
      console.log("CHILDPERM", JSON.stringify({ exited: Option.isSome(exited), hits, stderr: Option.isSome(exited) ? exited.value.stderr.slice(-400) : "" }))
      if (Option.isNone(exited)) {
        run.interrupt()
        yield* run.result
      }
      expect(Option.isSome(exited)).toBe(true)
    }), 60_000)
})
