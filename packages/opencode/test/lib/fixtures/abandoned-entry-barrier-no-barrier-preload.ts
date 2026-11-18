import { beforeEach } from "bun:test"
import { releaseGate } from "./abandoned-entry-barrier-gate"

let testIndex = 0
beforeEach(() => {
  testIndex += 1
  if (testIndex === 2) setImmediate(releaseGate)
})
