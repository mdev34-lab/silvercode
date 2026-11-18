import { beforeEach } from "bun:test"
import { phase } from "./abandoned-entry-barrier-phase"
import { releaseGate } from "./abandoned-entry-barrier-gate"

phase("preload-negative:body")
let testIndex = 0
beforeEach(() => {
  testIndex += 1
  phase(`preload-negative:beforeEach-${testIndex}`)
  if (testIndex === 2) setImmediate(releaseGate)
})
