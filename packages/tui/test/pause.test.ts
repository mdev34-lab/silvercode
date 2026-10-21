import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { pauseBefore, pauseLabel } from "../src/util/pause"

const reasoning = (start: number, end?: number) => ({ type: "reasoning", time: { start, end } }) as unknown as Part
const text = (start: number) => ({ type: "text", time: { start } }) as unknown as Part
const tool = (start?: number) =>
  ({ type: "tool", state: start === undefined ? { status: "pending" } : { status: "running", time: { start } } }) as unknown as Part

describe("pauseBefore", () => {
  test("marks a stall of a minute or more before the next text or thought", () => {
    expect(pauseBefore([reasoning(0, 1000), text(61000)], 1)).toBe(60000)
    expect(pauseBefore([reasoning(0, 1000), reasoning(121000, 122000)], 1)).toBe(120000)
  })
  test("a retry's step marker does not hide the stall", () => {
    const step = { type: "step-start" } as unknown as Part
    expect(pauseBefore([reasoning(0, 1000), step, reasoning(63000, 64000)], 2)).toBe(62000)
  })
  test("normal streaming latency never gets a marker", () => {
    expect(pauseBefore([reasoning(0, 1000), text(3000)], 1)).toBeUndefined()
    expect(pauseBefore([reasoning(0, 1000), text(30000)], 1)).toBeUndefined()
    expect(pauseBefore([reasoning(0, 1000), text(58000)], 1)).toBeUndefined()
    expect(pauseBefore([reasoning(0, 1000), text(60000)], 1)).toBe(59000)
  })
  test("tool calls are never marked, since their time includes streamed arguments", () => {
    expect(pauseBefore([reasoning(0, 1000), tool(300000)], 1)).toBeUndefined()
  })
  test("ignores the first part and parts that do not follow reasoning or lack timing", () => {
    expect(pauseBefore([reasoning(0, 1000)], 0)).toBeUndefined()
    expect(pauseBefore([text(0), text(300000)], 1)).toBeUndefined()
    expect(pauseBefore([reasoning(0), text(300000)], 1)).toBeUndefined()
  })
  test("labels seconds and minutes", () => {
    expect(pauseLabel(60000)).toBe("1m 0s")
    expect(pauseLabel(75000)).toBe("1m 15s")
  })
})
