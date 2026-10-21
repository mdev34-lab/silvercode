import type { CliRenderer } from "@opentui/core"

// Windows Terminal hosts the app inside ConPTY, where Bun does not deliver the
// resize SIGWINCH that OpenTUI 0.6.6 still derives its RESIZE event from, so
// both interfaces keep stale layout/scrollback/mouse geometry on window resize
// (#439). This poll closes the gap without the signal: re-query the live
// console size and feed the renderer's own resize path when the dimensions
// change. Bun caches process.stdout.columns/rows at startup and only refreshes
// them on SIGWINCH (oven-sh/bun#17803), so each poll starts with _refreshSize()
// - that is a live GetConsoleScreenBufferInfo query on win32 and works under
// ConPTY, unlike the signal.

type ResizeTarget = Pick<CliRenderer, "requestResize" | "terminalWidth" | "terminalHeight" | "isDestroyed">

type ResizeSource = {
  /** Reads the current terminal size in columns/rows. Defaults to process stdout. */
  getSize?: () => { columns: number; rows: number }
  /** Busts the cached stdout size before getSize reads it. Defaults to the tty `_refreshSize` hook. */
  refreshSize?: () => void
}

const refreshStdoutSize = () => {
  // Undocumented tty hook (Node/Bun) that re-queries the live window size and
  // updates the cached columns/rows.
  ;(process.stdout as typeof process.stdout & { _refreshSize?: () => void })._refreshSize?.()
}

const readStdoutSize = () => ({ columns: process.stdout.columns ?? 0, rows: process.stdout.rows ?? 0 })

/** One poll step: refresh the cached stdout size, then forward a change to the renderer's resize path. */
export function syncTerminalSize(target: ResizeTarget, options: ResizeSource = {}): void {
  ;(options.refreshSize ?? refreshStdoutSize)()
  const { columns, rows } = (options.getSize ?? readStdoutSize)()
  if (columns <= 0 || rows <= 0) return
  if (target.isDestroyed) return
  if (columns === target.terminalWidth && rows === target.terminalHeight) return
  target.requestResize(columns, rows)
}

/**
 * Low-frequency size-poll fallback for hosts that never deliver resize SIGWINCH.
 * Polling only matters on win32 (ConPTY); elsewhere the signal is reliable and
 * the returned disposer is a no-op. The timer is unref'd so it can never keep
 * the process alive.
 */
export function watchTerminalResize(
  target: ResizeTarget,
  options: ResizeSource & { intervalMs?: number; platform?: typeof process.platform } = {},
): () => void {
  if ((options.platform ?? process.platform) !== "win32") return () => {}
  const step = () => syncTerminalSize(target, options)
  const interval = setInterval(step, options.intervalMs ?? 500)
  interval.unref?.()
  step()
  return () => clearInterval(interval)
}
