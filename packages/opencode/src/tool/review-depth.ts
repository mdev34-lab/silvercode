import type { AgentEffort } from "@opencode-ai/schema/agent-effort"
import { isReviewAgent } from "../agent/review-agents"

/**
 * Shared by dispatch and finish availability, including the #233 depth handoff.
 * Only unset depth (whose legacy default is 1) can be lifted. Explicit zero,
 * one, and every other configured limit remain exact user restrictions.
 */
export function reviewDepthLimit(
  configured: number | undefined,
  effort: AgentEffort.Level,
  caller: string | undefined,
  target: string,
) {
  const limit = configured ?? 1
  return configured === undefined && effort === "ultra" && isReviewAgent(caller) && isReviewAgent(target) ? 2 : limit
}
