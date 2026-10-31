import type { AgentEffort } from "@opencode-ai/schema/agent-effort"
import { isReviewAgent } from "../agent/review-agents"

/** Shared by dispatch and finish availability, including the #233 depth handoff. */
export function reviewDepthLimit(
  configured: number | undefined,
  effort: AgentEffort.Level,
  caller: string | undefined,
  target: string,
) {
  const limit = configured ?? 1
  return effort === "ultra" && isReviewAgent(caller) && isReviewAgent(target) ? Math.max(limit, 2) : limit
}
