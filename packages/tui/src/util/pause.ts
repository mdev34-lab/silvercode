import type { Part } from "@opencode-ai/sdk/v2"

// Only a real stall gets a marker: a minute with no token arriving. Normal streaming never gets near this.
export const PAUSE_MIN_MS = 60_000

function startOf(part: Part | undefined): number | undefined {
  if (!part) return undefined
  // A tool part is only timed once its arguments finished streaming, so it cannot tell a silent model from one that is still sending tokens.
  if (part.type === "text" || part.type === "reasoning") return part.time?.start
  return undefined
}

/**
 * Milliseconds with no token between the last thinking token and the next text or
 * thinking part, when long enough to be a stall.
 */
export function pauseBefore(parts: readonly Part[], index: number): number | undefined {
  // A retry opens a new step, so look past the step marker to the previous visible part.
  let before = index - 1
  while (before >= 0 && parts[before]?.type === "step-start") before--
  const prev = parts[before]
  if (!prev || prev.type !== "reasoning") return undefined
  const end = prev.time.end
  const start = startOf(parts[index])
  if (end === undefined || start === undefined) return undefined
  const gap = start - end
  // The stream watchdog fires a minute after the last token, so allow a second of timer jitter.
  return gap >= PAUSE_MIN_MS - 1000 ? gap : undefined
}

export function pauseLabel(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
