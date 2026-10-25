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

test("CLI-quoted single argument classifies the wrapped request", () => {
  {
    expect(WorkFlow.classify("r", '"fix the python API bug"').kind).toBe("programming")
    expect(WorkFlow.classify("r", '"Research the nested report"').kind).toBe("nonprogramming")
    expect(WorkFlow.classify("r", 'review "fix the python API bug" in my notes').kind).not.toBe("programming")
  }
})

test("software artifact requests are programming, incidental Python for a deliverable is not", () => {
  expect(WorkFlow.classify("r", "Create a Python script to save this attachment").kind).toBe("programming")
  expect(WorkFlow.classify("r", '"Create a Python script to save this attachment"').kind).toBe("programming")
  expect(WorkFlow.classify("r", "Escreva um script Python para o relatorio").kind).toBe("programming")
  expect(WorkFlow.classify("r", "Use Python to calculate totals and produce a PDF report").kind).toBe("nonprogramming")
  expect(WorkFlow.classify("r", "Write a report summary").kind).toBe("nonprogramming")
  expect(WorkFlow.classify("r", "Do not create a script; write a report").kind).not.toBe("programming")
})

test("office deliverables mentioning software words are not forced to Code", () => {
  for (const text of [
    "Create a report comparing mobile apps",
    "Write an email about library packages",
    "Faca um relatorio sobre aplicativos",
    "Create a report of class attendance",
    "Write a report about how to create a Python script",
  ])
    expect(WorkFlow.classify("r", text).kind).toBe("nonprogramming")
  expect(WorkFlow.classify("r", "Write a script for a presentation").kind).toBe("uncertain")
  expect(WorkFlow.classify("r", "Create a small bash script").kind).toBe("programming")
  expect(WorkFlow.classify("r", "Create a Python script to save this attachment").kind).toBe("programming")
})

test("a later independent artifact request survives an earlier about-clause", () => {
  for (const text of [
    "Write a report about mobile apps; create a Python script",
    "Write a report about mobile apps and create a Python script",
    "Escreva um relatorio sobre aplicativos e crie um script Python",
  ])
    expect(WorkFlow.classify("r", text).kind).toBe("programming")
  expect(WorkFlow.classify("r", "Write a report about how to create a Python script").kind).toBe("nonprogramming")
})

test("a negated artifact cannot combine with incidental positive language", () => {
  for (const text of [
    "Do not create a Python script; write a report using Python to calculate totals.",
    "Nao crie um script Python; escreva um relatorio usando Python para calcular totais.",
  ])
    expect(WorkFlow.classify("r", text).kind).toBe("nonprogramming")
  expect(WorkFlow.classify("r", "Write a report using Python to calculate totals").kind).toBe("nonprogramming")
})

test("explicit macro or VBA creation is programming, reports about macros are not", () => {
  for (const text of [
    "Create a VBA macro to generate a report",
    "Crie uma macro VBA para gerar um relatorio",
    "Create an Excel macro to generate a report",
  ])
    expect(WorkFlow.classify("r", text).kind).toBe("programming")
  for (const text of ["Create an Excel report", "Write a report about macros", "Faca um relatorio sobre macros"])
    expect(WorkFlow.classify("r", text).kind).toBe("nonprogramming")
})
const skill = (name: string, status = "completed", extra: Record<string, unknown> = {}) => ({
  info: { role: "assistant" },
  parts: [
    {
      type: "tool",
      tool: "skill",
      state: { status, metadata: { name, dir: "<built-in>", builtin: true, sessionID: "parent", ...extra } },
    },
  ],
})
test("a completed built-in deep-think load in this session and request satisfies planning for Code", () => {
  expect(WorkFlow.state([user, skill("deep-think"), task("code", "success", true)], "parent")).toEqual({
    planned: true,
    implemented: true,
    delegated: false,
    requestID: "request",
  })
})
test("other skills, running loads, earlier requests, shadowing disk skills and foreign sessions are not planning proof", () => {
  expect(WorkFlow.state([user, skill("alpha-skill")], "parent").planned).toBe(false)
  expect(WorkFlow.state([user, skill("deep-think", "running")], "parent").planned).toBe(false)
  expect(WorkFlow.state([user, skill("deep-think"), user], "parent").planned).toBe(false)
  expect(
    WorkFlow.state([user, skill("deep-think", "completed", { builtin: false, dir: "/repo/.opencode/skills/deep-think" })], "parent")
      .planned,
  ).toBe(false)
  expect(WorkFlow.state([user, skill("deep-think", "completed", { builtin: undefined })], "parent").planned).toBe(false)
  expect(WorkFlow.state([user, skill("deep-think", "completed", { sessionID: "other" })], "parent").planned).toBe(false)
  expect(WorkFlow.state([user, skill("deep-think", "completed", { sessionID: undefined })], "parent").planned).toBe(false)
})
