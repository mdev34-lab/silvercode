import { useRenderer } from "@opentui/solid"
import { createSignal, type Accessor } from "solid-js"

interface Dimensions {
  width: number
  height: number
}

// One shared dimensions source for every consumer on screen. The library's
// useTerminalDimensions() adds a renderer "resize" listener per call site, so
// a single resize event used to fan out to 15+ listeners and trigger that many
// reactive updates at once (layout thrash while drag-resizing). This module
// keeps one listener per renderer and one signal for all consumers, and
// coalesces a burst of resize events into a single update per animation frame.
interface Shared {
  renderer: ReturnType<typeof useRenderer>
  callback: (width: number, height: number) => void
  frame: number
  accessor: Accessor<Dimensions>
}

let shared: Shared | undefined

export function useTerminalDimensions(): Accessor<Dimensions> {
  const renderer = useRenderer()
  if (shared && shared.renderer === renderer) {
    return shared.accessor
  }
  if (shared) {
    shared.renderer.off("resize", shared.callback)
    if (shared.frame) shared.renderer.cancelAnimationFrame(shared.frame)
  }
  const [dimensions, setDimensions] = createSignal<Dimensions>({
    width: renderer.width,
    height: renderer.height,
  })
  const state: Shared = {
    renderer,
    frame: 0,
    accessor: dimensions,
    callback: (width, height) => {
      if (state.frame) {
        renderer.cancelAnimationFrame(state.frame)
      }
      state.frame = renderer.requestAnimationFrame(() => {
        state.frame = 0
        const current = dimensions()
        if (current.width === width && current.height === height) return
        setDimensions({ width, height })
      })
    },
  }
  renderer.on("resize", state.callback)
  shared = state
  return dimensions
}
