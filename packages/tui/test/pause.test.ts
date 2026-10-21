import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { pauseBefore, pauseLabel } from "../src/util/pause"

const reasoning = (start: number, end?: number) => ({ type: "reasoning", time: { start, end } }) as unknown as Part
const text = (start: number) => ({ type: "text", time: { start } }) as unknown as Part
const tool = (start?: number) =>
  ({ type: "tool", state: start === undefined ? { status: "pending" } : { status: "running", time: { start } } }) as unknown as Part

describe("pauseBefore", () => {
  test("marks a long silence after reasoning", () => {
    expect(pauseBefore([reasoning(0, 1000), tool(19000)], 1)).toBe(18000)
    expect(pauseBefore([reasoning(0, 1000), text(11000)], 1)).toBe(10000)
  })
  test("ignores short gaps and the first part", () => {
    expect(pauseBefore([reasoning(0, 1000), tool(2500)], 1)).toBeUndefined()
    expect(pauseBefore([reasoning(0, 1000), tool(10999)], 1)).toBeUndefined()
    expect(pauseBefore([reasoning(0, 1000)], 0)).toBeUndefined()
  })
  test("ignores parts that do not follow reasoning or lack timing", () => {
    expect(pauseBefore([text(0), tool(19000)], 1)).toBeUndefined()
    expect(pauseBefore([reasoning(0), tool(19000)], 1)).toBeUndefined()
    expect(pauseBefore([reasoning(0, 1000), tool()], 1)).toBeUndefined()
  })
  test("labels seconds and minutes", () => {
    expect(pauseLabel(8000)).toBe("8s")
    expect(pauseLabel(75000)).toBe("1m 15s")
  })
})
