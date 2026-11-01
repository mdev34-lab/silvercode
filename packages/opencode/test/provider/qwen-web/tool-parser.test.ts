import { describe, expect, test } from "bun:test"
import { parseCompleteResponse, repairJsonPayload, StreamingToolParser } from "@opencode-ai/webchat/adapters/qwen/tool-parser"

describe("repairJsonPayload", () => {
  test("parses clean JSON", () => {
    expect(repairJsonPayload('{"a":1}')).toEqual({ a: 1 })
    expect(repairJsonPayload("  ")).toBeUndefined()
  })

  test("strips markdown fences", () => {
    expect(repairJsonPayload('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(repairJsonPayload('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  test("removes trailing commas", () => {
    expect(repairJsonPayload('{"a":1,}')).toEqual({ a: 1 })
    expect(repairJsonPayload('{"a":[1,2,]}')).toEqual({ a: [1, 2] })
  })

  test("extracts a balanced object from surrounding prose", () => {
    expect(repairJsonPayload('Sure! {"a":1} here you go')).toEqual({ a: 1 })
  })

  test("completes truncated payloads", () => {
    expect(repairJsonPayload('{"a": "b')).toEqual({ a: "b" })
    expect(repairJsonPayload('{"a": {"b": 1')).toEqual({ a: { b: 1 } })
  })

  test("gives up on non-JSON", () => {
    expect(repairJsonPayload("just words")).toBeUndefined()
  })
})

describe("StreamingToolParser", () => {
  test("passes plain text through", () => {
    const parser = new StreamingToolParser()
    expect(parser.push("Hello, world!")).toEqual({ text: "Hello, world!", toolCalls: [] })
    expect(parser.flush()).toEqual({ text: "", toolCalls: [] })
  })

  test("extracts a canonical block", () => {
    const parser = new StreamingToolParser({ declared: new Set(["read_file"]) })
    const result = parser.push(
      'Let me read that.\n<qw_call>\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n</qw_call>',
    )
    expect(result.text).toBe("Let me read that.\n")
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]?.name).toBe("read_file")
    expect(JSON.parse(result.toolCalls[0]!.input)).toEqual({ path: "a.txt" })
    expect(result.toolCalls[0]?.id).toMatch(/^call_/)
  })

  test("accepts legacy tag spellings", () => {
    const result = parseCompleteResponse('<tool_call>{"name":"a","arguments":{}}</tool_call>')
    expect(result.toolCalls.map((call) => call.name)).toEqual(["a"])
    const plural = parseCompleteResponse('<tool_calls>[{"name":"b"}]</tool_calls>')
    // Arrays are not valid single-call payloads; preserved as text instead.
    expect(plural.toolCalls).toEqual([])
    expect(plural.text).toContain("b")
  })

  test("accepts the function wrapper shape", () => {
    const result = parseCompleteResponse('<qw_call>{"function": {"name": "f", "arguments": "{\\"x\\": 1}"}}</qw_call>')
    expect(result.toolCalls[0]?.name).toBe("f")
    expect(JSON.parse(result.toolCalls[0]!.input)).toEqual({ x: 1 })
  })

  test("handles tags split across chunks", () => {
    const parser = new StreamingToolParser()
    expect(parser.push("Text <qw_").text).toBe("Text ")
    expect(parser.push('call>\n{"name": "t", "argum').toolCalls).toEqual([])
    const last = parser.push('ents": {}}\n</qw_call>\nDone')
    expect(last.toolCalls.map((call) => call.name)).toEqual(["t"])
    expect(last.text).toBe("\nDone")
  })

  test("recovers an unclosed block on flush", () => {
    const parser = new StreamingToolParser()
    const first = parser.push('Working <qw_call>\n{"name": "t", "arguments": {"a": 1}}')
    expect(first.text).toBe("Working ")
    const flushed = parser.flush()
    expect(flushed.text).toBe("")
    expect(flushed.toolCalls.map((call) => call.name)).toEqual(["t"])
  })

  test("preserves unparseable blocks as text", () => {
    const result = parseCompleteResponse("Before <qw_call>not json at all</qw_call> after")
    expect(result.toolCalls).toEqual([])
    expect(result.text).toContain("not json at all")
    expect(result.text).toContain("Before")
  })

  test("enforces the per-turn cap", () => {
    const parser = new StreamingToolParser({ maxToolCalls: 2 })
    parser.push('<qw_call>{"name":"a"}</qw_call><qw_call>{"name":"b"}</qw_call>')
    const extra = parser.push('<qw_call>{"name":"c"}</qw_call>')
    expect(extra.toolCalls).toEqual([])
    expect(parser.isCapped).toBe(true)
    expect(parser.toolCallCount).toBe(3)
  })

  test("accepts unknown tool names (AI SDK repairs them)", () => {
    const result = parseCompleteResponse('<qw_call>{"name":"invented","arguments":{}}</qw_call>', {
      declared: new Set(["real"]),
    })
    expect(result.toolCalls.map((call) => call.name)).toEqual(["invented"])
  })

  test("uses the open-tag name attribute as a fallback", () => {
    const result = parseCompleteResponse('<qw_call name="attr_tool">{"arguments": {"x": true}}</qw_call>')
    expect(result.toolCalls[0]?.name).toBe("attr_tool")
  })

  test("recovers a batch of openless blocks (missing open tags)", () => {
    const batch =
      '{"name": "glob", "arguments": {"pattern": "*.md", "path": "C:\\\\Desktop"}}\n' +
      "</qw_call>\n" +
      '{"name": "glob", "arguments": {"pattern": "*/*.md", "path": "C:\\\\Vault"}}\n' +
      "</qw_call>"
    const result = parseCompleteResponse(batch)
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls.map((call) => call.name)).toEqual(["glob", "glob"])
    expect(JSON.parse(result.toolCalls[0]!.input)).toEqual({ pattern: "*.md", path: "C:\\Desktop" })
    expect(result.text).toBe("")
  })

  test("reconstructs an openless block whose close tag arrives in a later chunk", () => {
    const parser = new StreamingToolParser()
    expect(parser.push('{"name": "glob", "arguments": {"pattern": "*.md"}}\n').text).toBe("")
    const last = parser.push("</qw_call>\nDone")
    expect(last.toolCalls.map((call) => call.name)).toEqual(["glob"])
    expect(last.text).toBe("\nDone")
    expect(parser.flush().text).toBe("")
  })

  test("strips stray close tags from plain text", () => {
    const result = parseCompleteResponse("Before </qw_call> after")
    expect(result.toolCalls).toEqual([])
    expect(result.text).toBe("Before after")
  })

  test("prefers the outer object when arguments contain a nested name key", () => {
    const result = parseCompleteResponse('{"name": "write", "arguments": {"name": "file.txt", "content": "x"}}\n</qw_call>')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]!.name).toBe("write")
    expect(JSON.parse(result.toolCalls[0]!.input)).toEqual({ name: "file.txt", content: "x" })
    expect(result.text).toBe("")
  })

  test("recovers an openless block that precedes a tagged block", () => {
    const result = parseCompleteResponse(
      '{"name": "glob", "arguments": {"pattern": "*.md"}}\n</qw_call>\n<qw_call>{"name": "read", "arguments": {"path": "a.md"}}\n</qw_call>',
    )
    expect(result.toolCalls.map((call) => call.name)).toEqual(["glob", "read"])
    expect(result.text.trim()).toBe("")
  })

  test("holds back a JSON line before a partial close tag split across chunks", () => {
    const parser = new StreamingToolParser()
    expect(parser.push('{"name": "glob", "arguments": {"pattern": "*.md"}}\n</qw_c').text).toBe("")
    const last = parser.push("all>\nDone")
    expect(last.toolCalls.map((call) => call.name)).toEqual(["glob"])
    expect(last.text).toContain("Done")
    expect(parser.flush().text).toBe("")
  })
})

describe("parameter-style tool calls", () => {
  const hybrid =
    '{"name": "write", "arguments": {"content": "<!DOCTYPE html>\n<html>\n<body>x</body>\n</html>\n</parameter>\n<parameter=filePath>\nC:\\work dir\\a.html\n</parameter>\n</function>'

  test("recovers a hybrid JSON/parameter write call with a raw multi-line body", () => {
    const result = parseCompleteResponse(`Plan.\n${hybrid}`)
    expect(result.text.trim()).toBe("Plan.")
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]!.name).toBe("write")
    expect(JSON.parse(result.toolCalls[0]!.input)).toEqual({
      content: "<!DOCTYPE html>\n<html>\n<body>x</body>\n</html>",
      filePath: "C:\\work dir\\a.html",
    })
  })

  test("hybrid first value keeps its leading and inner blank lines", () => {
    const input =
      '{"name":"write","arguments":{"content":"\n\nline1\n\nline2\n\n</parameter><parameter=filePath>\n/a/b.txt\n</parameter></function>'
    const result = parseCompleteResponse(input)
    expect(JSON.parse(result.toolCalls[0]!.input)).toEqual({ content: "\n\nline1\n\nline2\n", filePath: "/a/b.txt" })
    const parser = new StreamingToolParser()
    let calls: Array<{ input: string }> = []
    for (let i = 0; i < input.length; i += 5) calls = calls.concat(parser.push(input.slice(i, i + 5)).toolCalls)
    calls = calls.concat(parser.flush().toolCalls)
    expect(JSON.parse(calls[0]!.input).content).toBe("\n\nline1\n\nline2\n")
  })

  test("a streamed hybrid call is never emitted as text", () => {
    const parser = new StreamingToolParser()
    let text = ""
    const calls: unknown[] = []
    for (let i = 0; i < hybrid.length; i += 7) {
      const out = parser.push(hybrid.slice(i, i + 7))
      text += out.text
      calls.push(...out.toolCalls)
    }
    const end = parser.flush()
    text += end.text
    calls.push(...end.toolCalls)
    expect(text.trim()).toBe("")
    expect(calls).toHaveLength(1)
  })

  test("recovers a hybrid call whose close tag never arrived", () => {
    const result = parseCompleteResponse(hybrid.replace("</function>", ""))
    expect(result.toolCalls).toHaveLength(1)
    expect(result.text.trim()).toBe("")
  })

  test("recovers <function=NAME> calls and parses structured parameters", () => {
    const result = parseCompleteResponse(
      '<function=todowrite>\n<parameter=todos>\n[{"content":"a","status":"pending","priority":"high"}]\n</parameter>\n</function>',
    )
    expect(result.toolCalls).toHaveLength(1)
    expect(JSON.parse(result.toolCalls[0]!.input)).toEqual({
      todos: [{ content: "a", status: "pending", priority: "high" }],
    })
  })
})

describe("parameter-style calls: chunking, EOF tails and context gate", () => {
  const declared = new Set(["write", "todowrite"])
  const xml = "<function=write>\n<parameter=content>\nhello\n</parameter>\n<parameter=filePath>\n/a/b.txt\n</parameter>\n</function>"
  const hybrid = '{"name": "write", "arguments": {"content": "line1\nline2\n</parameter>\n<parameter=filePath>\n/a/b.txt\n</parameter>\n</function>'

  function run(input: string, sizes: number[], options?: { declared?: Set<string> }) {
    const parser = new StreamingToolParser(options)
    let text = ""
    const calls: Array<{ name: string; input: string }> = []
    let cursor = 0
    for (let step = 0; cursor < input.length; step++) {
      const size = sizes[step % sizes.length]!
      const out = parser.push(input.slice(cursor, cursor + size))
      cursor += size
      text += out.text
      calls.push(...out.toolCalls)
    }
    const end = parser.flush()
    return { text: text + end.text, calls: [...calls, ...end.toolCalls] }
  }

  test("every chunk size yields exactly one call and no leaked text", () => {
    for (const input of [xml, `Plan.\n${xml}`, hybrid, `Plan.\n${hybrid}`]) {
      for (let size = 1; size <= 130; size++) {
        const { text, calls } = run(input, [size], { declared })
        expect(calls).toHaveLength(1)
        expect(calls[0]!.name).toBe("write")
        expect(JSON.parse(calls[0]!.input).filePath).toBe("/a/b.txt")
        expect(text.trim()).toBe(input.startsWith("Plan.") ? "Plan." : "")
      }
    }
  })

  test("every single split point of a call is recovered", () => {
    for (let at = 1; at < xml.length; at++) {
      const parser = new StreamingToolParser({ declared })
      const a = parser.push(xml.slice(0, at))
      const b = parser.push(xml.slice(at))
      const c = parser.flush()
      expect(a.text + b.text + c.text).toBe("")
      expect(a.toolCalls.length + b.toolCalls.length + c.toolCalls.length).toBe(1)
    }
  })

  test("EOF without a close tag keeps the text that follows the last parameter", () => {
    const result = parseCompleteResponse(
      "<function=write><parameter=content>hello</parameter>\nexplicação",
      { declared },
    )
    expect(result.toolCalls).toHaveLength(1)
    expect(JSON.parse(result.toolCalls[0]!.input)).toEqual({ content: "hello" })
    expect(result.text.trim()).toBe("explicação")
  })

  test("EOF cut inside a parameter is not turned into a call and loses nothing", () => {
    const input = "<function=write><parameter=content>hello</parameter><parameter=filePath>/a/b"
    const result = parseCompleteResponse(input, { declared })
    expect(result.toolCalls).toHaveLength(0)
    expect(result.text).toContain("hello")
    expect(result.text).toContain("/a/b")
  })

  test("EOF tail check holds for every chunk size", () => {
    const input = "<function=write><parameter=content>hello</parameter>\nexplicação"
    for (let size = 1; size <= 9; size++) {
      const { text, calls } = run(input, [size], { declared })
      expect(calls).toHaveLength(1)
      expect(text.trim()).toBe("explicação")
    }
  })

  test("a call inside a code fence is text", () => {
    const input = "Format:\n```\n" + xml + "\n```\nDone."
    for (const size of [1, 5, 1000]) {
      const { text, calls } = run(input, [size], { declared })
      expect(calls).toHaveLength(0)
      expect(text).toBe(input)
    }
  })

  test("a call that is quoted or mid-line is text", () => {
    for (const input of [`Use \`${xml}\` like this.`, `For example: ${xml}`, `"${xml}"`]) {
      const { text, calls } = run(input, [1000], { declared })
      expect(calls).toHaveLength(0)
      expect(text).toBe(input)
    }
  })

  test("an undeclared tool name is not recognized when tools are declared", () => {
    const result = parseCompleteResponse(xml.replace("write", "rm_rf"), { declared })
    expect(result.toolCalls).toHaveLength(0)
    expect(result.text).toContain("<function=rm_rf>")
    expect(parseCompleteResponse(xml, { declared: new Set() }).toolCalls).toHaveLength(0)
  })

  test("text between the last parameter and the close tag is kept", () => {
    const input = "<function=write><parameter=content>a</parameter> surprise </function>"
    const result = parseCompleteResponse(input, { declared })
    // Treated like an unclosed call: the closed parameters form the call and
    // the stray text is kept, not dropped.
    expect(result.toolCalls).toHaveLength(1)
    expect(result.text).toContain("surprise")
  })

  test("a call after a closed fence is recognized again", () => {
    const { calls } = run("```\nx\n```\n" + xml, [3], { declared })
    expect(calls).toHaveLength(1)
  })

  test("a literal </function> in prose is left untouched", () => {
    const input = "The XML closing tag is </function> and this is ordinary prose."
    for (const size of [1, 4, 1000]) {
      const { text, calls } = run(input, [size], { declared })
      expect(calls).toHaveLength(0)
      expect(text).toBe(input)
    }
    expect(parseCompleteResponse(input).text).toBe(input)
  })

  test("a call followed by prose keeps the prose for every chunk size", () => {
    const input = xml + "\nThat is all."
    for (let size = 1; size <= 130; size++) {
      const { text, calls } = run(input, [size], { declared })
      expect(calls).toHaveLength(1)
      expect(text.trim()).toBe("That is all.")
    }
  })

  test("fenced examples stay text for every 2-way split, any fence style", () => {
    const fences = ["```", "~~~", "``````", "````typescript", "~~~~"]
    for (const fence of fences) {
      const closer = fence.replace(/[a-z]+$/, "")
      const input = `${fence}\n${xml}\n${closer}`
      for (let at = 1; at < input.length; at++) {
        const parser = new StreamingToolParser({ declared })
        const a = parser.push(input.slice(0, at))
        const b = parser.push(input.slice(at))
        const c = parser.flush()
        expect(a.toolCalls.length + b.toolCalls.length + c.toolCalls.length).toBe(0)
        expect(a.text + b.text + c.text).toBe(input)
      }
    }
  })

  test("a call after a closed fence is recognized for every split, any fence style", () => {
    for (const [open, close] of [["```", "```"], ["~~~", "~~~"], ["``````", "``````"], ["````ts", "````"]]) {
      const input = `${open}\ntext\n${close}\n${xml}`
      for (let at = 1; at < input.length; at++) {
        const parser = new StreamingToolParser({ declared })
        const a = parser.push(input.slice(0, at))
        const b = parser.push(input.slice(at))
        const c = parser.flush()
        expect(a.toolCalls.length + b.toolCalls.length + c.toolCalls.length).toBe(1)
        expect(a.text + b.text + c.text).toBe(`${open}\ntext\n${close}\n`)
      }
    }
  })

  test("a shorter or different closing marker does not end a fence", () => {
    for (const input of [`\`\`\`\`\`\`\n${xml}\n\`\`\`\n${xml}`, `~~~\n${xml}\n\`\`\`\n${xml}`]) {
      expect(parseCompleteResponse(input, { declared }).toolCalls).toHaveLength(0)
    }
  })

  test("random chunk partitions match the complete-response result (20k)", () => {
    const only = new Set(["write"])
    const body = "<function=write><parameter=content>hello</parameter><parameter=filePath>/tmp/a</parameter></function>"
    const cases = [
      body,
      "Plan.\n" + body,
      body + "\ntail",
      "```\n" + body + "\n```",
      "~~~\n" + body + "\n~~~",
      "Code:\n````typescript\n" + body + "\n````",
      "```\ntext\n```\n" + body,
      "~~~\ntext\n~~~\n" + body,
      "``````\n" + body + "\n``````\n" + body,
      "<function=write><parameter=content>hello</parameter>\nTail.",
      "<function=write><parameter=content>hello</parameter><parameter=filePath>/a/b",
      "The XML closing tag is </function> and this is ordinary prose.",
    ]
    let seed = 12345
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed
    }
    const shape = (calls: Array<{ name: string; input: string }>) => calls.map(({ name, input }) => ({ name, input }))
    for (const input of cases) {
      const expected = parseCompleteResponse(input, { declared: only })
      for (let round = 0; round < 1700; round++) {
        const parser = new StreamingToolParser({ declared: only })
        let text = ""
        const calls: Array<{ name: string; input: string }> = []
        const sizes: number[] = []
        for (let i = 0; i < input.length; ) {
          const n = 1 + (rand() % 23)
          sizes.push(n)
          const out = parser.push(input.slice(i, i + n))
          text += out.text
          calls.push(...out.toolCalls)
          i += n
        }
        const end = parser.flush()
        text += end.text
        calls.push(...end.toolCalls)
        if (text !== expected.text || JSON.stringify(shape(calls)) !== JSON.stringify(shape(expected.toolCalls))) {
          throw new Error(`partition mismatch for ${JSON.stringify(input)} sizes=${JSON.stringify(sizes)}`)
        }
      }
    }
  })

  test("CRLF fences are recognized, and calls after them are too", () => {
    for (const marker of ["```", "~~~"]) {
      const fenced = `${marker}\r\n${xml}\r\n${marker}`
      const after = `${marker}\r\ntext\r\n${marker}\r\n${xml}`
      expect(parseCompleteResponse(fenced, { declared }).toolCalls).toHaveLength(0)
      expect(parseCompleteResponse(after, { declared }).toolCalls).toHaveLength(1)
      for (let size = 1; size <= 30; size++) {
        const a = run(fenced, [size], { declared })
        expect(a.calls).toHaveLength(0)
        expect(a.text).toBe(fenced)
        const b = run(after, [size], { declared })
        expect(b.calls).toHaveLength(1)
        expect(b.text).toBe(`${marker}\r\ntext\r\n${marker}\r\n`)
      }
    }
  })

  test("indented code (4+ spaces or a tab) is text; up to 3 spaces still counts as a call", () => {
    for (const indent of ["    ", "        ", "\t"]) {
      const input = indent + xml
      for (const size of [1, 7, 1000]) {
        const { text, calls } = run(input, [size], { declared })
        expect(calls).toHaveLength(0)
        expect(text).toBe(input)
      }
    }
    for (const indent of [" ", "  ", "   "]) {
      for (const size of [1, 7, 1000]) expect(run(indent + xml, [size], { declared }).calls).toHaveLength(1)
    }
  })

  test("two calls in a row and a blockquoted fence behave the same streamed or complete", () => {
    for (const input of [xml + "\n" + xml, xml + xml, "> ```\n> " + xml + "\n> ```"]) {
      const expected = parseCompleteResponse(input, { declared })
      for (let size = 1; size <= input.length; size++) {
        const got = run(input, [size], { declared })
        expect(got.text).toBe(expected.text)
        expect(got.calls.map((c) => [c.name, c.input])).toEqual(expected.toolCalls.map((c) => [c.name, c.input]))
      }
    }
  })
})
