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
