import { Effect } from "effect"
import { reply, TestLLMServer } from "../lib/llm-server"

export const stageMatch = (hit: { body: unknown }) => {
  const body = JSON.stringify(hit.body)
  return (
    body.includes("You are Think, the planning specialist.") ||
    body.includes("You are Code, a software-engineering specialist.")
  )
}

/** Exercise real TaskTool planning/implementation before a pre-existing Review fixture. */
export const scriptWorkStages = (
  parent: (hit: { body: unknown }) => boolean,
  write?: { filePath: string; content: string },
) =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    yield* llm.pushMatch(
      (hit) => parent(hit) && !stageMatch(hit),
      reply().tool("task", {
        description: "Plan the requested software change",
        subagent_type: "think",
        prompt: "Plan the requested software change",
        background: false,
      }),
    )
    yield* llm.pushMatch(
      (hit) => JSON.stringify(hit.body).includes("You are Think, the planning specialist."),
      reply().tool("finish", {
        reason: "success",
        result:
          "<silvercode-result>Trace the cache boundary, implement the fix, then test the boundary.</silvercode-result>",
      }),
    )
    yield* llm.pushMatch(
      (hit) => parent(hit) && !stageMatch(hit),
      reply().tool("task", {
        description: "Implement the plan",
        subagent_type: "code",
        prompt: "Implement the successful plan and tests",
        background: false,
      }),
    )
    if (write)
      yield* llm.pushMatch(
        (hit) => JSON.stringify(hit.body).includes("You are Code, a software-engineering specialist."),
        reply().tool("write", write),
      )
    yield* llm.pushMatch(
      (hit) => JSON.stringify(hit.body).includes("You are Code, a software-engineering specialist."),
      reply().tool("finish", {
        reason: "success",
        result: "<silvercode-result>The requested implementation is delivered for Review.</silvercode-result>",
      }),
    )
  })
