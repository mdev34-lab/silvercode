import { describe, expect, it } from "bun:test"
import type { OptimizedBuffer } from "@opentui/core"
import { GoUpsellArtPainter } from "../../src/component/bg-pulse-render"

function makeBuffer(width: number, height: number, cellOverride?: number): OptimizedBuffer {
  const cells = cellOverride ?? width * height
  return {
    width,
    height,
    buffers: {
      char: new Uint32Array(cells),
      fg: new Uint16Array(cells * 4),
      bg: new Uint16Array(cells * 4),
      attributes: new Uint32Array(cells),
    },
  } as unknown as OptimizedBuffer
}

function makePainter() {
  const painter = new GoUpsellArtPainter()
  painter.setBackgroundPanel([18, 18, 18])
  painter.setPrimary([120, 200, 255])
  return painter
}

describe("GoUpsellArtPainter bounds (#378)", () => {
  it("paints into a normal frame buffer", () => {
    const painter = makePainter()
    const buffer = makeBuffer(80, 24)
    expect(() => painter.render(buffer, { deltaTime: 16 })).not.toThrow()
    expect(buffer.buffers.bg.some((value) => value !== 0)).toBe(true)
  })

  it("paints with the frame cache enabled across sizes", () => {
    const painter = makePainter()
    expect(() => {
      for (let frame = 0; frame < 12; frame++) painter.render(makeBuffer(60, 20), { deltaTime: 16, cache: true })
      for (let frame = 0; frame < 12; frame++) painter.render(makeBuffer(30, 10), { deltaTime: 16, cache: true })
      for (let frame = 0; frame < 12; frame++) painter.render(makeBuffer(90, 30), { deltaTime: 16, cache: true })
    }).not.toThrow()
  })

  it("skips zero-sized layout transitions", () => {
    const painter = makePainter()
    expect(() => painter.render(makeBuffer(0, 0), { deltaTime: 16 })).not.toThrow()
    expect(() => painter.render(makeBuffer(40, 0), { deltaTime: 16 })).not.toThrow()
  })

  it("skips a stale native view shorter than the buffer claims", () => {
    const painter = makePainter()
    expect(() => painter.render(makeBuffer(80, 24, 100), { deltaTime: 16 })).not.toThrow()
    expect(() => painter.render(makeBuffer(80, 24, 100), { deltaTime: 16, cache: true })).not.toThrow()
  })

  it("paints when the frame is smaller than the logo", () => {
    const painter = makePainter()
    const buffer = makeBuffer(6, 2)
    expect(() => painter.render(buffer, { deltaTime: 16, rgb: true })).not.toThrow()
    expect(buffer.buffers.bg.some((value) => value !== 0)).toBe(true)
  })
})

describe("GoUpsellArtPainter skipped frames (#378 review)", () => {
  it("advances the pulse clock even when the frame is skipped", () => {
    const skipped = makePainter()
    skipped.render(makeBuffer(0, 0), { deltaTime: 400 })
    skipped.render(makeBuffer(80, 24, 100), { deltaTime: 400 })
    const afterSkips = makeBuffer(80, 24)
    skipped.render(afterSkips, { deltaTime: 0 })

    const direct = makePainter()
    const reference = makeBuffer(80, 24)
    direct.render(reference, { deltaTime: 800 })

    expect(Array.from(afterSkips.buffers.bg)).toEqual(Array.from(reference.buffers.bg))
  })
})
