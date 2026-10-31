import type { Level as SchemaLevel } from "../../../schema/src/agent-effort"
import { expect, test } from "bun:test"
import type { AgentEffortLevel, Config } from "../src/v2/gen/types.gen"

// Exhaustive in both directions: adding a level to either contract without the
// other fails typecheck. The SDK has no runtime effort map or cycle.
const sdkToSchema = (level: AgentEffortLevel): SchemaLevel => level
const schemaToSdk = (level: SchemaLevel): AgentEffortLevel => level
const levels: Record<AgentEffortLevel, true> = { fast: true, medium: true, thorough: true, ultra: true }

test("SDK configuration can carry ultra without a cast", () => {
  const config = { agent: { effort: "ultra" } } satisfies Config
  expect(sdkToSchema(config.agent.effort)).toBe("ultra")
  expect(schemaToSdk("ultra")).toBe("ultra")
  expect(Object.keys(levels)).toEqual(["fast", "medium", "thorough", "ultra"])
})
