import type { Part } from "@opencode-ai/sdk/v2"

// A pause shorter than this is just normal streaming latency and gets no marker.
export const PAUSE_MIN_MS = 10_000

function startOf(part: Part | undefined): number | undefined {
  if (!part) return undefined
  if (part.type === "tool") return "time" in part.state ? part.state.time.start : undefined
  if (part.type === "text" || part.type === "reasoning") return part.time?.start
  return undefined
}

/**
 * Milliseconds the model was silent between a finished reasoning part and the
 * part that follows it, when long enough to be worth marking.
 */
export function pauseBefore(parts: readonly Part[], index: number): number | undefined {
  const prev = parts[index - 1]
  if (!prev || prev.type !== "reasoning") return undefined
  const end = prev.time.end
  const start = startOf(parts[index])
  if (end === undefined || start === undefined) return undefined
  const gap = start - end
  return gap >= PAUSE_MIN_MS ? gap : undefined
}

export function pauseLabel(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
