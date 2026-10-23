/** Headless runs must wait for deliveries, not idle turns (#222).
 * Keep launch edges even before their parent is observed: a fast descendant
 * can launch before the ancestor's task tool has returned its launch part.
 * Only edges reachable from this run's root count toward its pending work.
 */
export const make = (rootSessionID: string) => {
  // Pending deliveries keyed by run (`sessionID@started_at`, #400): a resumed
  // subagent (task_id) reuses its session ID, so keying by session alone lets
  // one run's terminal envelope settle another run's row, and two launches of
  // one session collapse into a single pending entry. Launches observed
  // without a run id (older servers, attach mode) fall back to the session ID.
  const launched = new Map<string, { sessionID: string; parentSessionID: string }>()
  // Latest launch attribution per session, for the reachability walk.
  const parents = new Map<string, string>()
  const resolved = new Set<string>()
  // Task part IDs are stable across event replay, even on older servers that
  // do not emit run IDs. A real task_id resume has its own task part.
  const launchParts = new Set<string>()

  const known = (sessionID: string): boolean => {
    const seen = new Set<string>()
    while (sessionID !== rootSessionID) {
      if (seen.has(sessionID)) return false
      seen.add(sessionID)
      const parent = parents.get(sessionID)
      if (!parent) return false
      sessionID = parent
    }
    return true
  }
  const pending = () =>
    [...launched.entries()]
      .filter(([key, entry]) => known(entry.sessionID) && !resolved.has(key))
      .map(([, entry]) => entry.sessionID)

  return {
    launch(input: { sessionID: string; parentSessionID: string; run?: string; launchID?: string }) {
      if (input.sessionID === rootSessionID) return false
      if (input.launchID !== undefined) {
        if (launchParts.has(input.launchID)) return false
        launchParts.add(input.launchID)
      }
      parents.set(input.sessionID, input.parentSessionID)
      const key = input.run ?? input.sessionID
      // Explicit execution keys stay idempotent after delivery. Legacy keys
      // cannot distinguish a completed-launch replay from task_id resume.
      if (launched.has(key)) {
        // An explicit run identifies one execution forever. Replaying its
        // launch after delivery cannot resurrect completed work. Only legacy
        // session-only launches lack enough identity to distinguish resume.
        if (input.run !== undefined || !resolved.has(key)) return false
        resolved.delete(key)
      }
      launched.set(key, { sessionID: input.sessionID, parentSessionID: input.parentSessionID })
      return known(input.sessionID) && !resolved.has(key)
    },
    // A fast delivery may arrive before its launch part. The key is the run id
    // when the envelope carries one, the session ID otherwise.
    resolve(run: string) {
      resolved.add(run)
    },
    pending,
    settled: () => pending().length === 0,
  }
}

export * as BackgroundTasks from "./background-tasks"
