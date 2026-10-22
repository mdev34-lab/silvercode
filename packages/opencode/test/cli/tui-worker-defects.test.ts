import { describe, expect, test } from "bun:test"
import { createDefectHandlers, type WorkerErrorReport } from "../../src/cli/tui/worker"

function setup(processWorker: boolean) {
  const reports: WorkerErrorReport[] = []
  const exits: number[] = []
  const handlers = createDefectHandlers({
    processWorker,
    report: (report) => reports.push(report),
    exit: (code) => exits.push(code),
  })
  return { handlers, reports, exits }
}

describe("worker defect handlers (#396)", () => {
  test("an unhandled rejection is reported, non-fatal, and never exits", async () => {
    const { handlers, reports, exits } = setup(true)
    handlers.onUnhandledRejection(new Error("listener blew up"))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(reports).toEqual([{ message: "listener blew up", stack: expect.any(String), fatal: false }])
    expect(exits).toEqual([])
  })

  test("a non-Error rejection is stringified", () => {
    const { handlers, reports } = setup(true)
    handlers.onUnhandledRejection("plain string failure")
    expect(reports[0]!.message).toBe("plain string failure")
    expect(reports[0]!.fatal).toBe(false)
  })

  test("an uncaught exception in a subprocess is reported fatal and exits 134 (crash class)", async () => {
    const { handlers, reports, exits } = setup(true)
    handlers.onUncaughtException(new Error("rpc handler threw"))
    expect(reports).toEqual([{ message: "rpc handler threw", stack: expect.any(String), fatal: true }])
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(exits).toEqual([134])
  })

  test("an uncaught exception in a thread worker reports but never exits the shared process", async () => {
    const { handlers, reports, exits } = setup(false)
    handlers.onUncaughtException(new Error("thread defect"))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(reports).toEqual([{ message: "thread defect", stack: expect.any(String), fatal: true }])
    expect(exits).toEqual([])
  })
})
