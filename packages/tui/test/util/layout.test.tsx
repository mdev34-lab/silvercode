/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { BoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { setPreLayoutSiblingMargin } from "../../src/util/layout"

test("applies the sibling margin when attached after mount (#379)", async () => {
  let second!: BoxRenderable
  const app = await testRender(
    () => (
      <box flexDirection="column">
        <box height={2} />
        <box ref={(el: BoxRenderable) => (second = el)} height={2} />
      </box>
    ),
    { width: 40, height: 10 },
  )
  try {
    await app.renderOnce()
    // Attach after the element is already mounted: the 0.6.x onLifecyclePass
    // setter must register the pass post-insertion.
    setPreLayoutSiblingMargin(second, (previous) => (previous ? 1 : 0))
    await app.renderOnce()
    expect(second.marginTop).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("chains an existing onLifecyclePass handler instead of clobbering it (#379)", async () => {
  let second!: BoxRenderable
  let existingRan = 0
  const app = await testRender(
    () => (
      <box flexDirection="column">
        <box height={2} />
        <box ref={(el: BoxRenderable) => (second = el)} height={2} />
      </box>
    ),
    { width: 40, height: 10 },
  )
  try {
    await app.renderOnce()
    // Simulate a Renderable subclass that already owns the hook.
    second.onLifecyclePass = () => {
      existingRan++
    }
    setPreLayoutSiblingMargin(second, (previous) => (previous ? 1 : 0))
    await app.renderOnce()
    expect(second.marginTop).toBe(1)
    expect(existingRan).toBeGreaterThan(0)
  } finally {
    app.renderer.destroy()
  }
})

test("a repeated setup replaces the first wrapper instead of stacking callbacks (#379)", async () => {
  let second!: BoxRenderable
  let existingRan = 0
  const app = await testRender(
    () => (
      <box flexDirection="column">
        <box height={2} />
        <box ref={(el: BoxRenderable) => (second = el)} height={2} />
      </box>
    ),
    { width: 40, height: 10 },
  )
  try {
    await app.renderOnce()
    second.onLifecyclePass = () => {
      existingRan++
    }
    // The superseded wrapper must never run: count the FIRST margin
    // callback, which the old stacking code still invoked on every pass.
    let firstMarginRan = 0
    setPreLayoutSiblingMargin(second, () => {
      firstMarginRan++
      return 1
    })
    setPreLayoutSiblingMargin(second, () => 2)
    const before = existingRan
    await app.renderOnce()
    // The latest margin wins, and the chained original runs once per pass,
    // not once per stacked wrapper.
    expect(second.marginTop).toBe(2)
    expect(firstMarginRan).toBe(0)
    expect(existingRan - before).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})
