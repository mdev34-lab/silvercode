import { expect, test } from "bun:test"
import { watchOwnerProcess } from "../../../src/cli/tui/owner-watch"

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("fires immediately when the IPC channel to the owner closes", () => {
  let orphans = 0
  let handler: (() => void) | undefined
  watchOwnerProcess({
    onOrphan: () => orphans++,
    subscribeDisconnect: (next) => {
      handler = next
      return () => {
        handler = undefined
      }
    },
  })
  const close = handler!
  close()
  close() // a duplicate close must not fire twice
  expect(orphans).toBe(1)
})

test("fires once via the PID probe when the owner dies without closing the channel", async () => {
  let orphans = 0
  let alive = true
  const stop = watchOwnerProcess({ onOrphan: () => orphans++, ownerAlive: () => alive, interval: 5 })
  await tick(30)
  expect(orphans).toBe(0) // a suspended or busy owner is still alive
  alive = false
  await tick(30)
  stop()
  expect(orphans).toBe(1)
})

test("stays quiet while the owner lives (UI suspended, work must continue)", async () => {
  let orphans = 0
  const stop = watchOwnerProcess({ onOrphan: () => orphans++, ownerAlive: () => true, interval: 5 })
  await tick(40)
  stop()
  expect(orphans).toBe(0)
})

test("dispose unsubscribes both signals without firing", async () => {
  let orphans = 0
  let handler: (() => void) | undefined
  let alive = true
  const stop = watchOwnerProcess({
    onOrphan: () => orphans++,
    subscribeDisconnect: (next) => {
      handler = next
      return () => {
        handler = undefined
      }
    },
    ownerAlive: () => alive,
    interval: 5,
  })
  stop()
  alive = false
  handler?.()
  await tick(30)
  expect(handler).toBeUndefined()
  expect(orphans).toBe(0)
})

test("a subscriber that fires synchronously during subscribe does not trip the TDZ", () => {
  let orphaned = 0
  const unwatch = watchOwnerProcess({
    onOrphan: () => orphaned++,
    // A double that replays an already-disconnected state calls the
    // handler before subscribeDisconnect returns.
    subscribeDisconnect: (handler) => {
      handler()
      return () => {}
    },
    ownerAlive: () => true,
    interval: 10,
  })
  expect(orphaned).toBe(1)
  unwatch()
  expect(orphaned).toBe(1)
})
