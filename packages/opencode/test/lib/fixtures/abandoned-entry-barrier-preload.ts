import { beforeEach } from "bun:test"
import { releaseGate } from "./abandoned-entry-barrier-gate"

await import("@opentui/solid/preload")

// Registered before the original preload so this hook runs first. By the second
// test Bun has cut off the cleanup hook but the real takeActiveOwnedScope barrier
// is still ahead. setImmediate opens the gate only after that barrier has begun
// observing the draining scope, so the entry join remains the real condition.
let testIndex = 0
beforeEach(() => {
  testIndex += 1
  if (testIndex === 2) setImmediate(releaseGate)
})

await import("../../preload")
