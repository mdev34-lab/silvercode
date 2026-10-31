import { reviewLoopState } from "@opencode-ai/core/review-loop"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { expect, test } from "bun:test"
import { AgentEffort } from "@opencode-ai/schema/agent-effort"
import { EffortPolicy } from "@opencode-ai/core/effort-policy"

test("ultra extends the closed schema and preserves the two existing switches", () => {
  expect(AgentEffort.levels).toEqual(["fast", "medium", "thorough", "ultra"])
  for (const [level, passes, gate] of [
    ["fast", 0, "minimal"],
    ["medium", 2, "standard"],
    ["thorough", undefined, "full"],
    ["ultra", undefined, "full"],
  ] as const) {
    expect(AgentEffort.resolve(level)).toBe(level)
    expect(EffortPolicy.passLimit(level)).toBe(passes)
    expect(EffortPolicy.validationGate(level)).toBe(gate)
  }
})


test("ultra review-loop budget ignores legacy caps and config migration preserves it", () => {
  expect(reviewLoopState([], { effort: "ultra", maxIterations: 1 }).maxIterations).toBe(Number.POSITIVE_INFINITY)
  expect(reviewLoopState([], { effort: "thorough", maxIterations: 1 }).maxIterations).toBe(Number.POSITIVE_INFINITY)
  expect(reviewLoopState([], { effort: "medium", maxIterations: 1 }).maxIterations).toBe(2)
  expect(ConfigMigrateV1.migrate({ agent: { effort: "ultra" } }).agent).toEqual({ effort: "ultra" })
})
