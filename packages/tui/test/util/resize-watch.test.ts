import { expect, mock, test } from "bun:test"
import { syncTerminalSize, watchTerminalResize } from "../../src/util/resize-watch"

// #439: Bun under ConPTY never delivers the SIGWINCH OpenTUI derives RESIZE
// from, so win32 polls the console size and synthesizes the renderer's resize
// path. ConPTY delivery itself cannot be exercised on linux; these tests pin
// the poll/dedup logic and the platform gate.

function fakeTarget(width = 80, height = 24) {
  const target = {
    terminalWidth: width,
    terminalHeight: height,
    isDestroyed: false,
    // Mirrors the renderer contract: terminalWidth/Height converge to the
    // requested geometry once the resize is applied.
    requestResize: mock((nextWidth: number, nextHeight: number) => {
      target.terminalWidth = nextWidth
      target.terminalHeight = nextHeight
    }),
  }
  return { target, requestResize: target.requestResize }
}

test("forwards a polled size change to the renderer's resize path", () => {
  const { target, requestResize } = fakeTarget()
  syncTerminalSize(target, { refreshSize: () => {}, getSize: () => ({ columns: 120, rows: 40 }) })
  expect(requestResize).toHaveBeenCalledTimes(1)
  expect(requestResize).toHaveBeenCalledWith(120, 40)
})

test("does not re-request while the polled size is unchanged", () => {
  const { target, requestResize } = fakeTarget(100, 30)
  syncTerminalSize(target, { refreshSize: () => {}, getSize: () => ({ columns: 100, rows: 30 }) })
  expect(requestResize).not.toHaveBeenCalled()
})

test("ignores missing or non-positive polled sizes", () => {
  const { target, requestResize } = fakeTarget()
  syncTerminalSize(target, { refreshSize: () => {}, getSize: () => ({ columns: 0, rows: 24 }) })
  syncTerminalSize(target, { refreshSize: () => {}, getSize: () => ({ columns: 80, rows: 0 }) })
  expect(requestResize).not.toHaveBeenCalled()
})

test("ignores a destroyed renderer", () => {
  const { target, requestResize } = fakeTarget()
  target.isDestroyed = true
  syncTerminalSize(target, { refreshSize: () => {}, getSize: () => ({ columns: 120, rows: 40 }) })
  expect(requestResize).not.toHaveBeenCalled()
})

test("refreshes the cached size before reading it", () => {
  const { target } = fakeTarget()
  const order: string[] = []
  syncTerminalSize(target, {
    refreshSize: () => order.push("refresh"),
    getSize: () => {
      order.push("get")
      return { columns: 90, rows: 30 }
    },
  })
  expect(order).toEqual(["refresh", "get"])
})

test("watchTerminalResize polls nothing outside win32", async () => {
  const { target, requestResize } = fakeTarget()
  const getSize = mock(() => ({ columns: 200, rows: 50 }))
  const stop = watchTerminalResize(target, { platform: "linux", intervalMs: 5, refreshSize: () => {}, getSize })
  try {
    await Bun.sleep(30)
    expect(getSize).not.toHaveBeenCalled()
    expect(requestResize).not.toHaveBeenCalled()
  } finally {
    stop()
  }
})

test("watchTerminalResize polls on win32, dedupes repeats, and stops when disposed", async () => {
  const { target, requestResize } = fakeTarget()
  const getSize = mock(() => ({ columns: 200, rows: 50 }))
  const stop = watchTerminalResize(target, { platform: "win32", intervalMs: 5, refreshSize: () => {}, getSize })
  try {
    // The first poll runs immediately; repeated identical polls stay deduped
    // against the renderer's current geometry.
    await Bun.sleep(40)
    expect(requestResize).toHaveBeenCalledTimes(1)
    expect(requestResize).toHaveBeenCalledWith(200, 50)
  } finally {
    stop()
  }
  const after = getSize.mock.calls.length
  await Bun.sleep(30)
  expect(getSize.mock.calls.length).toBe(after)
})
