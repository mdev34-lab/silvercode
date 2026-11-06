import { expect, test } from "bun:test"
import { ProcessPhaseTrace, processPhaseTrace } from "@opencode-ai/core/process-phase-trace"

test("process phase trace is command-local, redacted, and removable", () => {
  const secret = "private-path-argument-or-output"
  const command = { executable: secret }
  const other = { executable: secret }
  const trace = new ProcessPhaseTrace()
  trace.bind(command)
  expect(processPhaseTrace(command)).toBe(trace)
  expect(processPhaseTrace(other)).toBeUndefined()

  trace.mark("spawn-event")
  const report = trace.report()
  expect(report).toContain("spawn-event")
  expect(report).toContain("wallMs")
  expect(report).toContain("monoMs")
  expect(report).not.toContain(secret)

  trace.close()
  expect(processPhaseTrace(command)).toBeUndefined()
  // Stream listeners may retain the trace after close; it must not retain the command.
  expect(Reflect.get(trace, "command")).toBeUndefined()
  trace.mark("exit-event")
  expect(trace.report()).toBe(report)
})
