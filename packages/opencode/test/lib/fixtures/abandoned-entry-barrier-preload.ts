import { beforeEach } from "bun:test"
import { phase } from "./abandoned-entry-barrier-phase"
import { releaseGate } from "./abandoned-entry-barrier-gate"

phase("preload-positive:body")
const solidPreload = import.meta.resolve("@opentui/solid/preload")
phase("preload-positive:solid-resolved")
await import(solidPreload)
phase("preload-positive:solid-imported")

// Registered before the original preload so this hook runs first. By the second
// test Bun has cut off the cleanup hook but the real takeActiveOwnedScope barrier
// is still ahead. setImmediate opens the gate only after that barrier has begun
// observing the draining scope, so the entry join remains the real condition.
let testIndex = 0
beforeEach(() => {
  testIndex += 1
  phase(`preload-positive:beforeEach-${testIndex}`)
  if (testIndex === 2) setImmediate(releaseGate)
})

phase("preload-positive:before-original")
await import("../../preload")
phase("preload-positive:original-imported")
