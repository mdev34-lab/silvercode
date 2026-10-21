import { describe, expect, test } from "bun:test"
import { withoutRepeatedResult } from "../../src/cli/cmd/run/tool"

describe("withoutRepeatedResult", () => {
  const status = "[effort medium | review unreviewed/not-required, passes 0/2 | validation standard/incomplete]"

  test("drops a result that repeats the printed text and keeps the status line", () => {
    expect(withoutRepeatedResult(`OK\n\n${status}`, "OK")).toBe(status)
  })

  test("returns empty when nothing else is left", () => {
    expect(withoutRepeatedResult("OK", "OK")).toBe("")
  })

  test("keeps a result that adds something new", () => {
    expect(withoutRepeatedResult(`Fixed calc.py\n\n${status}`, "OK")).toBeUndefined()
  })
})
