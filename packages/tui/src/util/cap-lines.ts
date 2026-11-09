// Per-line length cap for tool output rendered in the TUI. A single pathological
// line (minified JSON, a base64 blob, a one-line stack trace) otherwise floods
// the scrollback: with no newlines it cannot be folded by the collapsed-preview
// line budget, and renderers differ in how they treat overflow — the `<code>`
// renderable used by `write` clips long lines at its width, while the `<text>`
// renderable used by `shell`/generic output wraps them, jittering the viewport.
// Capping each line before rendering keeps both paths bounded identically.
export const MAX_OUTPUT_LINE_LENGTH = 2000

// The truncation marker can grow with the omitted-char count (e.g. "+999999
// chars"); reserve a fixed prefix for it so a capped line never runs much past
// the cap.
const LINE_MARKER_BUDGET = 24

export function capLineLength(line: string, max: number = MAX_OUTPUT_LINE_LENGTH): string {
  if (line.length <= max) return line
  const visible = Math.max(0, max - LINE_MARKER_BUDGET)
  return `${line.slice(0, visible)} ... [+${line.length - visible} chars]`
}

// Caps each line of multiline tool output independently, preserving newlines and
// every line (short lines pass through untouched).
export function capOutputLines(output: string, max: number = MAX_OUTPUT_LINE_LENGTH): string {
  return output
    .split("\n")
    .map((line) => capLineLength(line, max))
    .join("\n")
}
