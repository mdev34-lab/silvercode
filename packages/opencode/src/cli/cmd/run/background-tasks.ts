/** Headless runs must wait for deliveries, not idle turns (#222).
 * Keep launch edges even before their parent is observed: a fast descendant
 * can launch before the ancestor's task tool has returned its launch part.
 * Only edges reachable from this run's root count toward its pending work.
 */
export const make = (rootSessionID: string) => {
  const launched = new Map<string, string>()
  const resolved = new Set<string>()

  const known = (sessionID: string): boolean => {
    const seen = new Set<string>()
    while (sessionID !== rootSessionID) {
      if (seen.has(sessionID)) return false
      seen.add(sessionID)
      const parent = launched.get(sessionID)
      if (!parent) return false
      sessionID = parent
    }
    return true
  }
  const pending = () => [...launched.keys()].filter((id) => known(id) && !resolved.has(id))

  return {
    launch(input: { sessionID: string; parentSessionID: string }) {
      if (input.sessionID === rootSessionID) return false
      // A session already launched and still pending is the same run. One that
      // already resolved was resumed (task_id): a new run, so it is pending again.
      if (launched.has(input.sessionID)) {
        if (!resolved.has(input.sessionID)) return false
        resolved.delete(input.sessionID)
      }
      launched.set(input.sessionID, input.parentSessionID)
      return known(input.sessionID) && !resolved.has(input.sessionID)
    },
    // A fast delivery may arrive before its launch part.
    resolve(sessionID: string) {
      resolved.add(sessionID)
    },
    pending,
    settled: () => pending().length === 0,
  }
}

export * as BackgroundTasks from "./background-tasks"
