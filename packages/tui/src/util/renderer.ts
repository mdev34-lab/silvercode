import type { CliRenderer } from "@opentui/core"

export function destroyRenderer(renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">) {
  // Since 0.6 the renderer rejects terminal writes as soon as its session starts closing,
  // so the title reset stays best effort while the destroy itself stays guarded.
  try {
    renderer.setTerminalTitle("")
  } catch {}
  if (renderer.isDestroyed) return
  renderer.destroy()
}
