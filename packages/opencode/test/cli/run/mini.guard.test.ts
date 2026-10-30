// `--mini` runs the split-footer runtime in this process and boots it through
// `runMini`, which returns before the full TUI's own guard install in
// `tui.ts`. Windows Ctrl+C has to stay stdin input for the whole mini runtime,
// so the guard must be installed by the mini entry point before that runtime
// boots and removed when it finishes (#441).
//
// The installer is spied here instead of driving a real console: a Ctrl+C
// console event cannot be raised from a test process, and the guard itself is
// covered by packages/tui/test/terminal-win32.test.ts.
import { afterEach, expect, mock, test } from "bun:test"

const events: string[] = []
let installed = 0
let unguarded = 0
let installFailure: Error | undefined

mock.module("@opencode-ai/tui/terminal-win32", () => ({
  win32InstallCtrlCGuard: () => {
    if (installFailure) throw installFailure
    installed++
    events.push("guard:install")
    return () => {
      unguarded++
      events.push("guard:teardown")
    }
  },
  win32DisableProcessedInput: () => {},
  win32FlushInputBuffer: () => {},
}))

const { RunCommand, runMini } = await import("@/cli/cmd/run")

const original = RunCommand.handler

afterEach(() => {
  RunCommand.handler = original
  events.length = 0
  installed = 0
  unguarded = 0
  installFailure = undefined
})

function runtime(handler: (args: Record<string, unknown>) => Promise<void> | void) {
  RunCommand.handler = handler as unknown as typeof RunCommand.handler
}

test("mini installs the Ctrl+C guard before the runtime boots and removes it after (#441)", async () => {
  let seen: Record<string, unknown> | undefined
  runtime((args) => {
    events.push("runtime")
    seen = args
  })

  await runMini({ prompt: "hello" })

  // The guard has to be in place before anything can toggle raw mode, so the
  // install must come first and the teardown only after the runtime resolves.
  expect(events).toEqual(["guard:install", "runtime", "guard:teardown"])
  expect(installed).toBe(1)
  expect(unguarded).toBe(1)
  // runMini is the only path allowed to hand the runnable a mini runtime.
  expect(seen?.mini).toBe(true)
  expect(seen?._).toEqual(["mini"])
})

test("mini removes the guard when the runtime throws", async () => {
  const failure = new Error("mini boot failed")
  runtime(async () => {
    events.push("runtime")
    throw failure
  })

  await expect(runMini({})).rejects.toBe(failure)

  expect(events).toEqual(["guard:install", "runtime", "guard:teardown"])
  expect(unguarded).toBe(1)
})

test("mini does not boot the runtime when the guard cannot be installed", async () => {
  const failure = new Error("guard install failed")
  installFailure = failure
  runtime(() => {
    events.push("runtime")
  })

  await expect(runMini({})).rejects.toBe(failure)

  expect(events).toEqual([])
  expect(installed).toBe(0)
  expect(unguarded).toBe(0)
})
