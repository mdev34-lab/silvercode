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
    expect(out).toContain("wrote nothing")
    expect(out).toContain("statement about this one call only")
    expect(out).toContain("earlier tool calls in this session may already have run")
    expect(out).toContain("including on this same path")
    // the continuation instruction: inspect first, then write a first chunk, then append with edit
    expect(out).toContain("inspecting")
    expect(out).toContain("first chunk")
    expect(out).toContain("append")
    expect(out).toContain("edit calls")
    expect(out).toContain("oldString")
    // write replaces the whole file, so the guidance must not send a second full write
    expect(out).toContain("write replaces the entire file")
    // no invented content from the fragment, and no unqualified "nothing was written"
    expect(out).not.toContain("line two that never finished")
    expect(out).not.toContain("nothing was written in the session")
  })

  test("says content is unknown instead of inferring that none arrived", () => {
    // the fragment had complete content before the path, so "no content arrived" would be
    // false; the repair may only say the content was not recovered
    const recovery = truncatedWriteRecovery(
      "write",
      '{"content":"alpha beta gamma","filePath":"/tmp/known.md","extra":',
    )
    const out = repairToolCallMessage(new Error("JSON Parse error: Expected '}'"), recovery)
    expect(out).toContain("/tmp/known.md")
    expect(out).toContain("not recovered")
    expect(out).toContain("unknown")
    expect(out).not.toContain("No file content arrived")
    expect(out).not.toContain("no content arrived")
    expect(out).not.toContain("alpha beta gamma")
  })

  test("does not tell the model to re-issue the whole file with a second write", () => {
    const out = repairToolCallMessage(new Error("JSON Parse error: Expected '}'"), {
      tool: "write",
      filePath: "/tmp/report.md",
    })
    // using write again for later chunks would replace what the first chunk wrote, so the
    // guidance has to append through edit instead
    expect(out).toContain("do not start over with write")
    expect(out).toContain("would discard what is already there")
    expect(out).toContain("edit calls")
    expect(out).not.toContain("then send follow-up calls that append the remaining chunks to the same file")
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

  test("returns undefined for a duplicate key, which makes the target ambiguous", () => {
    // complete JSON here would resolve filePath to "last.md"; reporting the first
    // occurrence would name a file the payload never targeted
    const raw = '{"filePath":"/tmp/first.md","filePath":"/tmp/last.md","content":"unfinished'
    expect(salvageStringArgument(raw, "filePath")).toBeUndefined()
  })

  test("returns undefined for a duplicate key that repeats the same value", () => {
    const raw = '{"filePath":"/tmp/same.md","filePath":"/tmp/same.md","content":"x'
    expect(salvageStringArgument(raw, "filePath")).toBeUndefined()
  })

  test("returns undefined when the wanted key repeats even after an unrelated member", () => {
    const raw = '{"filePath":"/a.md","content":"one","filePath":"/b.md"'
    expect(salvageStringArgument(raw, "filePath")).toBeUndefined()
  })

  test("returns undefined for key-shaped text inside a top-level array", () => {
    // not an object prefix: the key text inside an array is never a member, even when it
    // is followed by a complete string and a well-formed separator
    expect(salvageStringArgument('["filePath":"/etc/passwd","content":"x', "filePath")).toBeUndefined()
    expect(salvageStringArgument('["filePath":"/etc/passwd","content":"complete"', "filePath")).toBeUndefined()
    expect(salvageStringArgument('["filePath"]', "filePath")).toBeUndefined()
  })

  test("returns undefined for a structurally invalid prefix", () => {
    // missing comma between members
    expect(salvageStringArgument('{"filePath":"/a.md" "content":"x"', "filePath")).toBeUndefined()
    // unquoted key
    expect(salvageStringArgument('{filePath:"/a.md","content":"x', "filePath")).toBeUndefined()
    // bare value where a key must be
    expect(salvageStringArgument('{"content":"x",123,"filePath":"/a.md"', "filePath")).toBeUndefined()
  })

  test("ignores a nested filePath member and keeps only the top-level one", () => {
    expect(salvageStringArgument('{"nested":{"filePath":"/tmp/inner.md"},"content":"x', "filePath")).toBeUndefined()
    expect(
      salvageStringArgument('{"nested":{"filePath":"/tmp/inner.md"},"filePath":"/tmp/outer.md","content":"x', "filePath"),
    ).toBe("/tmp/outer.md")
  })

  test("keeps a completed member when the fragment stops right after another key", () => {
    // valid prefix: the value of `content` simply never arrived
    expect(salvageStringArgument('{"filePath":"/tmp/a.md","content"', "filePath")).toBe("/tmp/a.md")
    expect(salvageStringArgument('{"filePath":"/tmp/a.md",', "filePath")).toBe("/tmp/a.md")
  })

  test("does not report a non-string value for the wanted key", () => {
    expect(salvageStringArgument('{"filePath":123,"content":"x', "filePath")).toBeUndefined()
    expect(salvageStringArgument('{"filePath":null,"content":"x', "filePath")).toBeUndefined()
    expect(salvageStringArgument('{"filePath":["/tmp/a.md"],"content":"x', "filePath")).toBeUndefined()
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

  test("does not engage on an ambiguous duplicate-key payload", () => {
    expect(
      truncatedWriteRecovery("write", '{"filePath":"/tmp/first.md","filePath":"/tmp/last.md","content":"unfinished'),
    ).toBeUndefined()
  })

  test("does not engage for non-string raw arguments", () => {
    expect(truncatedWriteRecovery("write", undefined)).toBeUndefined()
    expect(truncatedWriteRecovery("write", { filePath: "/tmp/a.txt" })).toBeUndefined()
    expect(truncatedWriteRecovery("write", "")).toBeUndefined()
  })
})
