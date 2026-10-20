export type ProbeOutcome = "ok" | "transient" | "error"

export type HealthEntry = {
  outcome: ProbeOutcome
  /** When the probe finished, in epoch milliseconds. */
  at: number
  /** Consecutive probes that did not succeed. */
  failures: number
}

export type HealthStatus = "working" | "degraded" | "failing" | "unknown"

/** Time between probes of a healthy model. */
export const PROBE_TTL_MS = 10 * 60_000
/** Evidence older than this is shown as unknown, never as working. */
export const STALE_MS = 30 * 60_000
const MAX_BACKOFF_STEPS = 3

export function next(previous: HealthEntry | undefined, outcome: ProbeOutcome, at: number): HealthEntry {
  return { outcome, at, failures: outcome === "ok" ? 0 : (previous?.failures ?? 0) + 1 }
}

/** One rate limit or network error is degraded; only repeated real errors count as failing. */
export function status(entry: HealthEntry | undefined, now: number): HealthStatus {
  if (!entry || now - entry.at > STALE_MS) return "unknown"
  if (entry.outcome === "ok") return "working"
  if (entry.outcome === "error" && entry.failures >= 2) return "failing"
  return "degraded"
}

/** When the model is next due for a probe. Failures back off exponentially up to 8x the base interval. */
export function due(entry: HealthEntry | undefined): number {
  if (!entry) return 0
  return entry.at + PROBE_TTL_MS * 2 ** Math.min(entry.failures, MAX_BACKOFF_STEPS)
}

export function age(entry: HealthEntry, now: number): string {
  const minutes = Math.max(Math.floor((now - entry.at) / 60_000), 0)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}
