import { describe, expect, test } from "bun:test"
import { repairToolCallMessage, salvageStringArgument, truncatedWriteRecovery } from "@/session/llm"

// A `write` call cut off inside the content body: the path is complete, the body is not.
const TRUNCATED_WRITE = '{"filePath":"/tmp/report.md","content":"# Report\\n\\nline one\\nline two that never finished'

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

  test("keeps a non-parse failure verbatim even when a recovery is supplied", () => {
    const message = "Invalid input for tool write: expected string at content"
    expect(repairToolCallMessage(new Error(message), { tool: "write", filePath: "/tmp/report.md" })).toBe(message)
  })

  test("qualifies the truncation cause instead of asserting it", () => {
    const out = repairToolCallMessage(
      new Error("JSON Parse error: Expected '}'"),
      truncatedWriteRecovery("write", TRUNCATED_WRITE),
    )
    expect(out).toContain("usually")
    expect(out).toContain("output-token limit")
    expect(out).not.toContain("was cut off at the output-token limit,")
  })

  test("states the recovered path, that this call wrote nothing, and how to continue", () => {
    const out = repairToolCallMessage(
      new Error("JSON Parse error: Expected '}'"),
      truncatedWriteRecovery("write", TRUNCATED_WRITE),
    )
    expect(out).toContain("/tmp/report.md")
    // this call did not execute, and the claim stays scoped to this call
    expect(out).toContain("did not execute")
    expect(out).toContain("wrote no file")
    expect(out).toContain("statement about this one call only")
    expect(out).toContain("earlier tool calls in this session may already have run")
    // the continuation instruction: write a first chunk, then append
    expect(out).toContain("first chunk")
    expect(out).toContain("append")
    expect(out).toContain("smaller chunks")
    // no invented content from the fragment, and no unqualified "nothing was written"
    expect(out).not.toContain("line two that never finished")
    expect(out).not.toContain("nothing was written in the session")
  })
})

describe("salvageStringArgument", () => {
  test("recovers a complete filePath out of a fragment cut inside content", () => {
    expect(salvageStringArgument(TRUNCATED_WRITE, "filePath")).toBe("/tmp/report.md")
  })

  test("recovers a path that arrived after the content field", () => {
    const raw = '{"content":"hello","filePath":"/tmp/after.txt","extra":'
    expect(salvageStringArgument(raw, "filePath")).toBe("/tmp/after.txt")
  })

  test("decodes escapes in the recovered value", () => {
    const raw = '{"filePath":"/tmp/quote\\"and\\u00e9.txt","content":"body'
    expect(salvageStringArgument(raw, "filePath")).toBe('/tmp/quote"andé.txt')
  })

  test("returns undefined when the value itself was cut off", () => {
    expect(salvageStringArgument('{"filePath":"/tmp/incompl', "filePath")).toBeUndefined()
  })

  test("returns undefined when the key never appeared", () => {
    expect(salvageStringArgument('{"content":"body cut off', "filePath")).toBeUndefined()
  })

  test("ignores a key-shaped sequence that only exists inside another string value", () => {
    const raw = '{"content":"talking about \\"filePath\\": \\"/etc/passwd\\" here'
    expect(salvageStringArgument(raw, "filePath")).toBeUndefined()
  })
})

describe("truncatedWriteRecovery", () => {
  test("salvages the path without fabricating content", () => {
    const recovery = truncatedWriteRecovery("write", TRUNCATED_WRITE)
    expect(recovery).toEqual({ tool: "write", filePath: "/tmp/report.md" })
    // the only recovered field is the path: no content is carried anywhere
    expect(Object.keys(recovery ?? {})).toEqual(["tool", "filePath"])
  })

  test("is case-insensitive about the tool name", () => {
    expect(truncatedWriteRecovery("Write", TRUNCATED_WRITE)?.filePath).toBe("/tmp/report.md")
  })

  test("does not engage for other tools, even on a parse failure", () => {
    expect(truncatedWriteRecovery("edit", '{"filePath":"/tmp/a.txt","oldString":"x')).toBeUndefined()
    expect(truncatedWriteRecovery("bash", '{"command":"ls')).toBeUndefined()
  })

  test("does not engage when the arguments parsed cleanly", () => {
    expect(truncatedWriteRecovery("write", '{"filePath":"/tmp/a.txt","content":"hi"}')).toBeUndefined()
  })

  test("does not engage when no path is recoverable", () => {
    expect(truncatedWriteRecovery("write", '{"content":"body cut off')).toBeUndefined()
    expect(truncatedWriteRecovery("write", '{"filePath":"/tmp/cut')).toBeUndefined()
  })

  test("does not engage for non-string raw arguments", () => {
    expect(truncatedWriteRecovery("write", undefined)).toBeUndefined()
    expect(truncatedWriteRecovery("write", { filePath: "/tmp/a.txt" })).toBeUndefined()
    expect(truncatedWriteRecovery("write", "")).toBeUndefined()
  })
})
