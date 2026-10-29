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

  test("drops a repeated multi-paragraph result and keeps the status line", () => {
    const answer = "First paragraph.\n\nSecond paragraph."
    expect(withoutRepeatedResult(`${answer}\n\n${status}`, answer)).toBe(status)
    expect(withoutRepeatedResult(answer, answer)).toBe("")
  })

  test("keeps new paragraphs after a repeated multi-paragraph result", () => {
    const answer = "First paragraph.\n\nSecond paragraph."
    expect(withoutRepeatedResult(`${answer}\n\nAdditional detail.\n\n${status}`, answer)).toBe(
      `Additional detail.\n\n${status}`,
    )
  })

  test("does not remove a prefix from a different result", () => {
    expect(withoutRepeatedResult(`OK but not finished\n\n${status}`, "OK")).toBeUndefined()
    expect(
      withoutRepeatedResult(`First.\n\nSecond, with more detail.\n\n${status}`, "First.\n\nSecond"),
    ).toBeUndefined()
  })

  test("recognizes whitespace and CRLF around the paragraph boundary", () => {
    const answer = "First paragraph.\r\n\r\nSecond paragraph."
    expect(withoutRepeatedResult(` ${answer}  \r\n \r\n${status} `, answer)).toBe(status)
  })
})
