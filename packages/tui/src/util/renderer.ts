import type { CliRenderer } from "@opentui/core"

export function destroyRenderer(
  renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy" | "closed">,
): Promise<void> {
  // Since 0.6 the renderer rejects terminal writes as soon as its session starts closing,
  // so the title reset stays best effort while the destroy itself stays guarded.
  try {
    renderer.setTerminalTitle("")
  } catch {}
  if (renderer.isDestroyed) return Promise.resolve()
  renderer.destroy()
  // destroy() only STARTS the async teardown (terminal restore, surface
  // flush): in 0.6.6 it settles on `closed`, and a caller about to exit the
  // process must await it or the terminal can be left unrestored.
  return renderer.closed
}
