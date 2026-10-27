/** Visibility only (#555): a long provider-requested retry wait used to leave a headless run silent.
 * Announces the wait without touching the retry policy. A child can report its wait before its launch
 * reaches the run loop, so the latest retry status of a not-yet-owned session is held and announced once
 * the launch ties that session to the run.
 */
export type RetryStatus = { type: string; attempt?: number; next?: number; action?: { reason?: string } }

export const make = (input: {
  rootSessionID: string
  owns: (sessionID: string) => boolean
  print: (line: string) => void
  threshold: number
  json: boolean
  now?: () => number
}) => {
  const now = input.now ?? Date.now
  const noticed = new Map<string, number>()
  const held = new Map<string, RetryStatus>()

  const notice = (sessionID: string, status: RetryStatus) => {
    if (status.type !== "retry") {
      noticed.delete(sessionID)
      return
    }
    if (input.json) return
    const wait = (status.next ?? 0) - now()
    if (wait <= input.threshold || status.attempt === noticed.get(sessionID)) return
    noticed.set(sessionID, status.attempt ?? 0)
    // A fixed category, never the provider's retry message: that text can carry raw
    // response bodies, URLs or control characters.
    const reason =
      status.action?.reason === "free_tier_limit"
        ? "free usage limit reached"
        : status.action?.reason === "account_rate_limit"
          ? "account rate limit"
          : "retrying after a provider error"
    input.print(
      `${sessionID === input.rootSessionID ? "" : "subagent "}waiting about ${Math.ceil(wait / 1000)}s before retrying (attempt ${status.attempt}): ${reason}`,
    )
  }

  return {
    /** Feed every session.status event. */
    status(sessionID: string, status: RetryStatus) {
      if (input.owns(sessionID)) {
        held.delete(sessionID)
        notice(sessionID, status)
      } else if (status.type === "retry") held.set(sessionID, status)
      else held.delete(sessionID)
    },
    /** Call after a launch was recorded: announces held waits of sessions that are now owned. */
    launched() {
      for (const [sessionID, status] of held) {
        if (!input.owns(sessionID)) continue
        held.delete(sessionID)
        notice(sessionID, status)
      }
    },
  }
}

export * as RetryNotice from "./retry-notice"
