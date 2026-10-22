import type { BaseRenderable, BoxRenderable } from "@opentui/core"

const previousByParent = new WeakMap<
  BaseRenderable,
  { frameID: number; previous: WeakMap<BaseRenderable, BaseRenderable | undefined> }
>()

// The pre-wrap handler per element, so a repeated setup replaces the first
// wrapper instead of wrapping it again and stacking the callbacks (#379
// review). Only the very first pre-wrap handler is ever chained.
const originalByElement = new WeakMap<BoxRenderable, (() => void) | undefined>()

export function setPreLayoutSiblingMargin(el: BoxRenderable, margin: (previous?: BaseRenderable) => number) {
  // Run before Yoga layout so scroll geometry matches the rendered frame.
  // Chain any handler the renderable (or a Renderable subclass) already has
  // instead of clobbering it (#379); since 0.6.x the onLifecyclePass setter
  // registers the pass even when this ref runs after insertion.
  const original = originalByElement.has(el) ? originalByElement.get(el) : el.onLifecyclePass?.bind(el)
  originalByElement.set(el, original)
  el.onLifecyclePass = () => {
    original?.()
    const parent = el.parent
    if (!parent) return
    const cached = previousByParent.get(parent)
    const previous = cached?.frameID === el.ctx.frameId ? cached.previous : previousSiblings(parent, el.ctx.frameId)
    const value = margin(previous.get(el))
    if (el.marginTop !== value) el.marginTop = value
  }
}

function previousSiblings(parent: BaseRenderable, frameID: number) {
  const previous = new WeakMap<BaseRenderable, BaseRenderable | undefined>()
  parent.getChildren().forEach((child, index, children) => previous.set(child, children[index - 1]))
  previousByParent.set(parent, { frameID, previous })
  return previous
}
