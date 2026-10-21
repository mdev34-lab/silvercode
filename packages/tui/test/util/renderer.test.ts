import { expect, test } from "bun:test"
import { destroyRenderer } from "../../src/util/renderer"

test("clears the terminal title before destroying the renderer", () => {
  const calls: string[] = []
  destroyRenderer({
    isDestroyed: false,
    setTerminalTitle(title) {
      calls.push(`title:${title}`)
    },
    destroy() {
      calls.push("destroy")
    },
    closed: Promise.resolve(),
  })
  expect(calls).toEqual(["title:", "destroy"])
})

test("still clears the title after renderer destruction", () => {
  const calls: string[] = []
  destroyRenderer({
    isDestroyed: true,
    setTerminalTitle(title) {
      calls.push(`title:${title}`)
    },
    destroy() {
      calls.push("destroy")
    },
    closed: Promise.resolve(),
  })
  expect(calls).toEqual(["title:"])
})

test("returns the renderer's closed promise so callers can await teardown", async () => {
  let settle!: () => void
  const closed = new Promise<void>((resolve) => {
    settle = resolve
  })
  const pending = destroyRenderer({
    isDestroyed: false,
    setTerminalTitle() {},
    destroy() {},
    closed,
  })
  let done = false
  void pending.then(() => {
    done = true
  })
  await Bun.sleep(10)
  expect(done).toBe(false)
  settle()
  await pending
  expect(done).toBe(true)

  // An already-destroyed renderer resolves immediately.
  await destroyRenderer({ isDestroyed: true, setTerminalTitle() {}, destroy() {}, closed: Promise.resolve() })
})
