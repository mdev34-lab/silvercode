import { expect, test } from "bun:test"
import { WorkFlow } from "../src/work-flow"

const user = { info: { role: "user", id: "request" }, parts: [] }
const task = (agent: string, terminal = "success", planned = false, status = "completed") => ({
  info: { role: "assistant" },
  parts: [
    {
      type: "tool",
      tool: "task",
      state: {
        status,
        metadata: {
          background: false,
          workFlow: { agent, terminal, planned, requestID: "request", parentID: "parent" },
        },
      },
    },
  ],
})
test("only current ordered successful Think and Code deliveries satisfy implementation", () => {
  expect(WorkFlow.state([user, task("code", "success", true), task("think")]).implemented).toBe(false)
  expect(WorkFlow.state([user, task("think"), task("code", "success", true)])).toEqual({
    planned: true,
    implemented: true,
    delegated: false,
    requestID: "request",
  })
  expect(WorkFlow.state([user, task("think"), task("code", "success", true), user])).toEqual({
    planned: false,
    implemented: false,
    delegated: false,
    requestID: "request",
  })
})
for (const terminal of ["cancelled", "failure", "waiting_for_subagent", "unknown"]) {
  test(`non-success Think cannot authorize Code: ${terminal}`, () => {
    expect(WorkFlow.state([user, task("think", terminal), task("code", "success", true)]).implemented).toBe(false)
  })
}
test("running deliveries and model-only task input are not proof", () => {
  expect(WorkFlow.state([user, task("think", "success", false, "running")]).planned).toBe(false)
  expect(
    WorkFlow.state([
      user,
      {
        parts: [
          {
            type: "tool",
            tool: "task",
            state: { status: "completed", input: { subagent_type: "think" }, output: "success" },
          },
        ],
      },
    ]).planned,
  ).toBe(false)
})

for (const text of [
  "Fix dispatch.py Python fuel and weights bugs",
  "Implement a new API endpoint",
  "Corrige o código do planejador",
  "Refactor software unit tests",
  "Debug Python starter files and fix the planning tool",
])
  test(`programming admission: ${text}`, () => expect(WorkFlow.classify("u", text).kind).toBe("programming"))
for (const text of [
  "Research hotels",
  "Write a PDF report using Python calculations",
  "Organize and rename these photos",
  "Faça uma apresentação",
  "Summarize this spreadsheet",
  'Explain the example "implement API" in an email',
])
  test(`nonprogramming admission: ${text}`, () => expect(WorkFlow.classify("u", text).kind).toBe("nonprogramming"))
for (const text of ["Fix this", "Make it work", "Update the project", "Olá"])
  test(`uncertain admission: ${text}`, () => expect(WorkFlow.classify("u", text).kind).toBe("uncertain"))

for (const text of [
  "Build a Python application that generates a report",
  "Implement a function that summarizes a spreadsheet",
  "Do not rewrite the code; fix the API bug and email me a report",
  "Fix this software bug; do not implement a new feature",
  "Please research and implement the code change",
  "Corrija o bug no código e gere um relatório",
  "Do not code the report manually; implement the API endpoint",
])
  test(`mixed programming cannot downgrade: ${text}`, () =>
    expect(WorkFlow.classify("u", text).kind).toBe("programming"))

for (const text of [
  "Implement API endpoint but do not change the tests; email report",
  "Fix dispatch.py and report results",
]) {
  test(`coding with negative or report suffix: ${text}`, () =>
    expect(WorkFlow.classify("u1", text).kind).toBe("programming"))
}

test("Portuguese negative constraint preserves positive implementation", () =>
  expect(WorkFlow.classify("u1", "Corrija o codigo sem alterar testes; gere relatorio").kind).toBe("programming"))

for (const text of [
  "Nao esqueca de corrigir o bug; gere um relatorio",
  "Email a report and do not forget to fix the API bug",
  "Do not implement code; write a report",
])
  test(`negated action cannot unlock execution: ${text}`, () =>
    expect(WorkFlow.classify("u1", text).kind).not.toBe("nonprogramming"))

test("truncated runtime delivery cannot satisfy either stage", () => {
  const plan = task("think")
  Object.assign(plan.parts[0].state.metadata, { truncated: true })
  expect(WorkFlow.state([user, plan, task("code", "success", true)], "parent").implemented).toBe(false)
  const implementation = task("code", "success", true)
  Object.assign(implementation.parts[0].state.metadata, { truncated: true })
  expect(WorkFlow.state([user, task("think"), implementation], "parent").implemented).toBe(false)
})
