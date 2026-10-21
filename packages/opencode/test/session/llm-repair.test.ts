import { describe, expect, test } from "bun:test"
import { repairToolCallMessage } from "@/session/llm"

describe("repairToolCallMessage", () => {
  test("enriches a truncated-json parse error with cause and recovery", () => {
    const out = repairToolCallMessage(new Error("JSON Parse error: Unterminated string"))
    expect(out).toContain("not valid JSON")
    expect(out).toContain("output-token limit")
    expect(out).toContain("smaller")
  })

  test("matches parse failures carried in the error cause", () => {
    const error = new Error("Invalid input for tool write")
    ;(error as { cause?: unknown }).cause = new SyntaxError("Unexpected end of JSON input")
    const out = repairToolCallMessage(error)
    expect(out).toContain("not valid JSON")
  })

  test("keeps non-parse failures verbatim", () => {
    const message = "Invalid input for tool bash: expected string at command"
    expect(repairToolCallMessage(new Error(message))).toBe(message)
  })
})
