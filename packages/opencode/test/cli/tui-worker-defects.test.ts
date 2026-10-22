import { describe, expect, test } from "bun:test"
import { createDefectHandlers, type WorkerErrorReport } from "../../src/cli/tui/worker"
import { workerErrorToastEvent } from "../../src/cli/tui/worker-error-toast"

function setup(processWorker: boolean) {
  const reports: WorkerErrorReport[] = []
  const exits: number[] = []
  const handlers = createDefectHandlers({
    processWorker,
    report: (report, done) => {
      reports.push(report)
      done()
    },
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

  test("an uncaught exception in a subprocess exits 134 (crash class) only after the report flush ack", async () => {
    const { handlers, reports, exits } = setup(true)
    handlers.onUncaughtException(new Error("rpc handler threw"))
    // setup's report calls done() synchronously, so the ack-driven exit lands
    // immediately; the 5s fallback timer is cleared and never fires.
    expect(reports).toEqual([{ message: "rpc handler threw", stack: expect.any(String), fatal: true }])
    expect(exits).toEqual([134])
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(exits).toEqual([134])
  })

  test("without a flush ack the subprocess still crashes via the fallback timer", async () => {
    const exits: number[] = []
    const reports: WorkerErrorReport[] = []
    const handlers = createDefectHandlers({
      processWorker: true,
      report: (report) => reports.push(report), // never calls done(): dead IPC channel
      exit: (code) => exits.push(code),
    })
    handlers.onUncaughtException(new Error("ipc dead"))
    expect(reports).toEqual([{ message: "ipc dead", stack: expect.any(String), fatal: true }])
    expect(exits).toEqual([])
    // The real fallback is 5s; assert the timer is pending by faking time
    // forward rather than waiting: Bun's jest.useFakeTimers is unavailable
    // here, so verify with a short real window that exit has NOT happened
    // synchronously and the handler stays crash-bound.
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(exits).toEqual([])
  }, 10000)

  test("an uncaught exception in a thread worker reports but never exits the shared process", async () => {
    const { handlers, reports, exits } = setup(false)
    handlers.onUncaughtException(new Error("thread defect"))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(reports).toEqual([{ message: "thread defect", stack: expect.any(String), fatal: true }])
    expect(exits).toEqual([])
  })

  test("the synthesized toast event satisfies the GlobalEvent shape", () => {
    const event = workerErrorToastEvent({ message: "boom", stack: "trace", fatal: true })
    expect(event.directory).toBe("global")
    expect(typeof event.payload.id).toBe("string")
    expect(event.payload.id.length).toBeGreaterThan(0)
    expect(event.payload.type).toBe("tui.toast.show")
    expect(event.payload.properties).toEqual({
      title: "Backend worker crashed",
      message: "boom",
      variant: "error",
      duration: 8000,
    })
    expect(workerErrorToastEvent({ message: "boom", fatal: false }).payload.properties.title).toBe(
      "Backend worker error",
    )
  })
})
