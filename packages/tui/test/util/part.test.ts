import { expect, test } from "bun:test"
import type { Part, ReasoningPart, TextPart, ToolPart, ToolState } from "@opencode-ai/sdk/v2"
import { applyPartDelta, applyPartUpdated, mergePartText } from "../../src/util/part"

function reasoning(overrides: Partial<ReasoningPart> = {}): ReasoningPart {
  return {
    id: "part-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "reasoning",
    text: "",
    time: { start: 1 },
    ...overrides,
  }
}

function text(overrides: Partial<TextPart> = {}): TextPart {
  return {
    id: "part-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "text",
    text: "",
    ...overrides,
  }
}

function toolPart(partID: string, tool: string, state: ToolState): ToolPart {
  return {
    id: partID,
    sessionID: "session-1",
    messageID: "message-1",
    type: "tool",
    callID: `call-${partID}`,
    tool,
    state,
  }
}

function partText(part: Part): string {
  return (part as TextPart | ReasoningPart).text
}

// A permissive view of `state` so status-specific fields (output, error,
// metadata, time) can be asserted after cross-status merges without cast spam.
type AnyToolState = ToolState & {
  output?: string
  error?: string
  title?: string
  metadata?: Record<string, unknown>
  time?: { start: number; end?: number }
  attachments?: unknown[]
  input?: Record<string, unknown>
}

test("preserves streamed reasoning text when an empty snapshot arrives", () => {
  const current = reasoning({ text: "already streamed chain of thought" })
  const incoming = reasoning({ text: "" })
  expect(mergePartText(current, incoming)).toEqual({ ...incoming, text: current.text })
})

test("keeps the incoming reasoning snapshot when it is non-empty", () => {
  const current = reasoning({ text: "partial" })
  const incoming = reasoning({ text: "partial full text" })
  expect(mergePartText(current, incoming)).toBe(incoming)
})

test("preserves streamed reasoning text while adopting the incoming time", () => {
  const current = reasoning({ text: "thought", time: { start: 1 } })
  const incoming = reasoning({ text: "", time: { start: 1, end: 10 } })
  expect(mergePartText(current, incoming)).toEqual({
    ...incoming,
    text: "thought",
    time: { start: 1, end: 10 },
  })
})

test("preserves streamed text-part text when an empty snapshot arrives", () => {
  const current = text({ text: "streamed answer" })
  const incoming = text({ text: "" })
  expect(mergePartText(current, incoming)).toEqual({ ...incoming, text: "streamed answer" })
})

test("adopts the incoming snapshot when it extends the streamed text", () => {
  const current = text({ text: "streamed" })
  const incoming = text({ text: "streamed answer" })
  expect(mergePartText(current, incoming)).toBe(incoming)
})

test("accepts the empty snapshot when nothing was streamed yet", () => {
  const current = reasoning({ text: "" })
  const incoming = reasoning({ text: "" })
  expect(mergePartText(current, incoming)).toBe(incoming)
})

test("accepts the incoming snapshot when there is no existing part", () => {
  const incoming = reasoning({ text: "fresh" })
  expect(mergePartText(undefined, incoming)).toBe(incoming)
})

test("leaves non-streamed part types untouched", () => {
  const current: Part = { id: "part-1", sessionID: "s", messageID: "m", type: "step-start" }
  const incoming: Part = { id: "part-1", sessionID: "s", messageID: "m", type: "step-start" }
  expect(mergePartText(current, incoming)).toBe(incoming)
})

test("part updated reducer seeds the part list when none exists", () => {
  expect(applyPartUpdated(undefined, reasoning({ text: "" }))).toEqual([reasoning({ text: "" })])
})

test("part updated reducer inserts a new part in id order", () => {
  const parts = applyPartUpdated(undefined, { ...reasoning(), id: "part-2" })
  const next = applyPartUpdated(parts, { ...reasoning(), id: "part-1" })
  expect(next.map((part) => part.id)).toEqual(["part-1", "part-2"])
})

test("part updated reducer preserves streamed text across a live event sequence", () => {
  // reasoning-start: the durable snapshot is persisted with empty text.
  let parts = applyPartUpdated(undefined, reasoning({ text: "" }))
  expect(partText(parts[0])).toBe("")

  // message.part.delta: live deltas append to the part.
  parts = applyPartDelta(parts, "part-1", "text", "hello")!
  parts = applyPartDelta(parts, "part-1", "text", " world")!
  expect(partText(parts[0])).toBe("hello world")

  // message.part.updated: a stale empty snapshot arrives after streaming.
  parts = applyPartUpdated(parts, reasoning({ text: "", time: { start: 1, end: 10 } }))

  expect(partText(parts[0])).toBe("hello world")
  expect((parts[0] as ReasoningPart).time.end).toBe(10)
})

test("part updated reducer applies a non-empty snapshot verbatim", () => {
  let parts = applyPartUpdated(undefined, reasoning({ text: "" }))
  parts = applyPartDelta(parts, "part-1", "text", "partial")!
  parts = applyPartUpdated(parts, reasoning({ text: "partial full text" }))
  expect(partText(parts[0])).toBe("partial full text")
})

test("part delta reducer returns undefined when there is no part to append to", () => {
  expect(applyPartDelta(undefined, "part-1", "text", "x")).toBeUndefined()
  const parts = applyPartUpdated(undefined, reasoning({ text: "" }))
  expect(applyPartDelta(parts, "missing", "text", "x")).toBeUndefined()
})

test("streamed updates keep the part object identity stable", () => {
  // Solid's <For> keys list items by object identity. Replacing the part for
  // every delta would dispose and recreate the streaming component per token
  // (full re-parse/re-layout per token = the streaming redraw/flicker), so the
  // reducers must merge into the existing part, not return a substituted one.
  let parts = applyPartUpdated(undefined, reasoning({ text: "" }))
  const original = parts[0]
  parts = applyPartDelta(parts, "part-1", "text", "hello")!
  parts = applyPartDelta(parts, "part-1", "text", " world")!
  // A stale empty durable snapshot arriving mid-stream must keep identity too.
  parts = applyPartUpdated(parts, reasoning({ text: "", time: { start: 1, end: 10 } }))
  expect(parts[0]).toBe(original)
  expect(partText(parts[0])).toBe("hello world")
  expect((parts[0] as ReasoningPart).time.end).toBe(10)
})

test("inserts a missing part without replacing the surrounding list identity", () => {
  let parts = applyPartUpdated(undefined, { ...reasoning(), id: "part-2" })
  const original = parts[0]
  parts = applyPartUpdated(parts, { ...reasoning(), id: "part-1" })
  expect(parts[1]).toBe(original)
  expect(parts.map((part) => part.id)).toEqual(["part-1", "part-2"])
})

test("an authoritative snapshot equal to the streamed text is adopted", () => {
  // deltas: "Hello " + "world"; then the durable row persisted "Hello world".
  let parts = applyPartUpdated(undefined, text({ text: "" }))
  const original = parts[0]
  parts = applyPartDelta(parts, "part-1", "text", "Hello ")!
  parts = applyPartDelta(parts, "part-1", "text", "world")!
  parts = applyPartUpdated(parts, text({ text: "Hello world" }))
  expect(parts[0]).toBe(original)
  expect(partText(parts[0])).toBe("Hello world")
})

test("a partially persisted snapshot never truncates streamed text", () => {
  // deltas: "Hello " + "world"; then a durable row persisted only the prefix.
  let parts = applyPartUpdated(undefined, text({ text: "" }))
  const original = parts[0]
  parts = applyPartDelta(parts, "part-1", "text", "Hello ")!
  parts = applyPartDelta(parts, "part-1", "text", "world")!
  parts = applyPartUpdated(parts, text({ text: "Hello " }))
  expect(parts[0]).toBe(original)
  expect(partText(parts[0])).toBe("Hello world")
})

test("a reconnect snapshot longer than the streamed replay is adopted", () => {
  // The provider persisted more than was replayed after an SSE reconnect.
  let parts = applyPartUpdated(undefined, text({ text: "" }))
  parts = applyPartDelta(parts, "part-1", "text", "Hello ")!
  parts = applyPartUpdated(parts, text({ text: "Hello world and more" }))
  expect(partText(parts[0])).toBe("Hello world and more")
})

test("reasoning parts stream with the same identity and text semantics", () => {
  let parts = applyPartUpdated(undefined, reasoning({ text: "", time: { start: 1 } }))
  const original = parts[0]
  parts = applyPartDelta(parts, "part-1", "text", "think")!
  parts = applyPartDelta(parts, "part-1", "text", "ing")!
  // stale empty snapshot mid-stream
  parts = applyPartUpdated(parts, reasoning({ text: "", time: { start: 1 } }))
  expect(parts[0]).toBe(original)
  expect(partText(parts[0])).toBe("thinking")
  // authoritative durable snapshot adopts and keeps identity
  parts = applyPartUpdated(parts, reasoning({ text: "thinking harder", time: { start: 1, end: 2 } }))
  expect(parts[0]).toBe(original)
  expect(partText(parts[0])).toBe("thinking harder")
  expect((parts[0] as ReasoningPart).time.end).toBe(2)
})

test("delta on a non-text string field appends without losing identity", () => {
  type WithNote = ReasoningPart & { note?: string }
  let parts = applyPartUpdated(undefined, { ...reasoning({ text: "", time: { start: 1 } }), note: "" } as WithNote)
  const original = parts[0]
  parts = applyPartDelta(parts, "part-1", "note", "keep ")!
  parts = applyPartDelta(parts, "part-1", "note", "going")!
  expect(parts[0]).toBe(original)
  expect((parts[0] as WithNote).note).toBe("keep going")
})

test("delta on a non-string field is ignored instead of corrupting the part", () => {
  let parts = applyPartUpdated(undefined, reasoning({ text: "x", time: { start: 1 }, metadata: { a: 1 } }))
  const original = parts[0]
  parts = applyPartDelta(parts, "part-1", "metadata", "oops")!
  expect(parts[0]).toBe(original)
  expect((parts[0] as ReasoningPart).metadata).toEqual({ a: 1 })
  parts = applyPartDelta(parts, "part-1", "time", "oops")!
  expect((parts[0] as ReasoningPart).time).toEqual({ start: 1 })
})

test("a new part arriving during streaming keeps existing parts mounted", () => {
  let parts = applyPartUpdated(undefined, text({ id: "part-a", text: "" }))
  const originalA = parts[0]
  parts = applyPartDelta(parts, "part-a", "text", "a1")!
  parts = applyPartUpdated(parts, text({ id: "part-b", text: "" }))
  const originalB = parts[1]
  expect(parts[0]).toBe(originalA)
  parts = applyPartDelta(parts, "part-b", "text", "b1")!
  expect(parts[0]).toBe(originalA)
  expect(parts[1]).toBe(originalB)
  expect(partText(parts[0])).toBe("a1")
  expect(partText(parts[1])).toBe("b1")
})

test("a stale snapshot does not rewind tool status or shrink tool output", () => {
  const running: ToolPart = {
    id: "part-tool",
    sessionID: "session-1",
    messageID: "message-1",
    type: "tool",
    callID: "call-1",
    tool: "bash",
    state: { status: "running", input: { command: "ls" }, title: "ls", time: { start: 1 } },
  }
  let parts = applyPartUpdated(undefined, running)
  const original = parts[0]
  const completed: ToolPart = {
    ...running,
    state: {
      status: "completed",
      input: { command: "ls" },
      output: "a\nb\n",
      title: "ls",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
  parts = applyPartUpdated(parts, completed)
  expect(parts[0]).toBe(original)
  expect((parts[0] as ToolPart).state.status).toBe("completed")

  // A stale replay of the running row must not rewind status or drop output.
  parts = applyPartUpdated(parts, running)
  expect(parts[0]).toBe(original)
  const state = (parts[0] as ToolPart).state as AnyToolState
  expect(state.status).toBe("completed")
  expect(state.output).toBe("a\nb\n")
  expect(state.time?.end).toBe(2)
})

test("tool state adopts progress and preserves the interrupted flag", () => {
  const running: ToolPart = {
    id: "part-tool",
    sessionID: "session-1",
    messageID: "message-1",
    type: "tool",
    callID: "call-1",
    tool: "todowrite",
    state: { status: "running", input: {}, title: "todo", time: { start: 1 } },
  }
  let parts = applyPartUpdated(undefined, running)
  const interrupted: ToolPart = {
    ...running,
    state: {
      status: "error",
      input: {},
      error: "Tool execution aborted",
      metadata: { interrupted: true },
      time: { start: 1, end: 3 },
    },
  }
  parts = applyPartUpdated(parts, interrupted)
  // A stale running replay must not clear `interrupted`.
  parts = applyPartUpdated(parts, running)
  const state = (parts[0] as ToolPart).state as AnyToolState
  expect(state.status).toBe("error")
  expect(state.metadata?.interrupted).toBe(true)
  expect(state.error).toBe("Tool execution aborted")
})

test("time.end never regresses when a stale snapshot omits it", () => {
  let parts = applyPartUpdated(undefined, reasoning({ text: "x", time: { start: 1, end: 10 } }))
  parts = applyPartUpdated(parts, reasoning({ text: "x", time: { start: 1 } }))
  expect((parts[0] as ReasoningPart).time.end).toBe(10)
  // A later durable row with a newer end wins.
  parts = applyPartUpdated(parts, reasoning({ text: "x", time: { start: 1, end: 12 } }))
  expect((parts[0] as ReasoningPart).time.end).toBe(12)
})

test("new fields added by a newer schema are adopted", () => {
  let parts = applyPartUpdated(undefined, reasoning({ text: "x", time: { start: 1 } }))
  const original = parts[0]
  const incoming = {
    ...reasoning({ text: "x", time: { start: 1 } }),
    futureField: { nested: true },
  } as ReasoningPart & {
    futureField: { nested: boolean }
  }
  parts = applyPartUpdated(parts, incoming)
  expect(parts[0]).toBe(original)
  expect((parts[0] as ReasoningPart & { futureField?: unknown }).futureField).toEqual({ nested: true })
})

test("a same-length conflicting snapshot never replaces streamed text", () => {
  // Reviewer case: both snapshots non-empty, same length, different content.
  // Without a revision number the protocol offers no causal ordering here —
  // text already on screen must never be swapped out. Compare with the
  // append-only delta model: a legitimate snapshot is a prefix or an
  // extension of the streamed text, never an arbitrary string.
  let parts = applyPartUpdated(undefined, text({ text: "Hello world!" }))
  const original = parts[0]
  parts = applyPartUpdated(parts, text({ text: "Hello there" }))
  expect(parts[0]).toBe(original)
  expect(partText(parts[0])).toBe("Hello world!")
})

test("a same-length conflicting terminal snapshot is not accepted either", () => {
  // Both snapshots already finished (`time.end`): the part terminal state
  // reached the TUI first, so a replayed row with the same length but other
  // content cannot be causally newer.
  let parts = applyPartUpdated(undefined, text({ text: "Hello world!", time: { start: 1, end: 2 } }))
  const original = parts[0]
  parts = applyPartUpdated(parts, text({ text: "Hello there", time: { start: 1, end: 2 } }))
  expect(parts[0]).toBe(original)
  expect(partText(parts[0])).toBe("Hello world!")
})

test("the terminal text-end snapshot can rewrite streamed content", () => {
  // The `experimental.text.complete` plugin rewrites the final text; the
  // processor publishes that rewrite together with `time.end` in the
  // `text-end` snapshot. That snapshot is causally newer than the deltas.
  let parts = applyPartUpdated(undefined, text({ text: "Hello world" }))
  parts = applyPartDelta(parts, "part-1", "text", "!")!
  expect(partText(parts[0])).toBe("Hello world!")
  const original = parts[0]
  parts = applyPartUpdated(parts, text({ text: "Hello there", time: { start: 1, end: 2 } }))
  expect(parts[0]).toBe(original)
  expect(partText(parts[0])).toBe("Hello there")
})

test.each(["Hello", ""])("terminal text rewrite accepts prefix or empty text: %j", (rewritten) => {
  let parts = applyPartUpdated(undefined, text({ text: "", time: { start: 1 } }))
  const original = parts[0]
  parts = applyPartDelta(parts, "part-1", "text", "Hello secret")!
  parts = applyPartUpdated(parts, text({ text: rewritten, time: { start: 99, end: 2 } }))
  expect(parts[0]).toBe(original)
  expect(partText(parts[0])).toBe(rewritten)
  expect((parts[0] as TextPart).time).toEqual({ start: 1, end: 2 })
})

test.each(["Hello", ""])("non-terminal text prefix or empty snapshot remains stale: %j", (stale) => {
  let parts = applyPartUpdated(undefined, text({ text: "", time: { start: 1 } }))
  const original = parts[0]
  parts = applyPartDelta(parts, "part-1", "text", "Hello secret")!
  parts = applyPartUpdated(parts, text({ text: stale, time: { start: 1 } }))
  expect(parts[0]).toBe(original)
  expect(partText(parts[0])).toBe("Hello secret")
  expect((parts[0] as TextPart).time).toEqual({ start: 1 })
})

test.each(["Hello", ""])("already-terminal text rejects another terminal prefix or empty snapshot: %j", (stale) => {
  let parts = applyPartUpdated(undefined, text({ text: "Hello secret", time: { start: 1, end: 10 } }))
  const original = parts[0]
  parts = applyPartUpdated(parts, text({ text: stale, time: { start: 99, end: 5 } }))
  expect(parts[0]).toBe(original)
  expect(partText(parts[0])).toBe("Hello secret")
  expect((parts[0] as TextPart).time).toEqual({ start: 1, end: 10 })
})

test("a finished part is not rewound by an unfinished conflicting snapshot", () => {
  let parts = applyPartUpdated(undefined, text({ text: "Hello there", time: { start: 1, end: 2 } }))
  const original = parts[0]
  parts = applyPartUpdated(parts, text({ text: "Hello world!" }))
  expect(parts[0]).toBe(original)
  expect(partText(parts[0])).toBe("Hello there")
})

test("a non-terminal prefix snapshot is older than the streamed text", () => {
  let parts = applyPartUpdated(undefined, text({ text: "Hello world" }))
  const original = parts[0]
  // Durable row persisted partway through the same stream.
  parts = applyPartUpdated(parts, text({ text: "Hello worl" }))
  expect(parts[0]).toBe(original)
  expect(partText(parts[0])).toBe("Hello world")
})

test("time.start is immutable after the part is created", () => {
  let parts = applyPartUpdated(undefined, reasoning({ text: "x", time: { start: 100, end: 200 } }))
  // A stale row replayed with an earlier start (or any other start) must not
  // move the clock backwards; the first value seen is the creation time.
  parts = applyPartUpdated(parts, reasoning({ text: "x", time: { start: 50 } }))
  expect((parts[0] as ReasoningPart).time).toEqual({ start: 100, end: 200 })
  parts = applyPartUpdated(parts, reasoning({ text: "x", time: { start: 150, end: 200 } }))
  expect((parts[0] as ReasoningPart).time).toEqual({ start: 100, end: 200 })
})

test("tool output is fixed by the single terminal transition", () => {
  let parts = applyPartUpdated(
    undefined,
    toolPart("part-tool", "bash", { status: "running", input: {}, time: { start: 1 } }),
  )
  // First terminal snapshot carries the result.
  parts = applyPartUpdated(
    parts,
    toolPart("part-tool", "bash", {
      status: "completed",
      input: {},
      output: "abcdef",
      title: "bash",
      metadata: {},
      time: { start: 1, end: 2 },
    }),
  )
  // A replayed terminal row with the same length but different content cannot
  // carry newer output: the result is written once when the tool finished.
  parts = applyPartUpdated(
    parts,
    toolPart("part-tool", "bash", {
      status: "completed",
      input: {},
      output: "123456",
      title: "bash",
      metadata: {},
      time: { start: 1, end: 2 },
    }),
  )
  const state = (parts[0] as ToolPart).state as AnyToolState
  expect(state.output).toBe("abcdef")
})

test("tool error is fixed by the single terminal transition", () => {
  let parts = applyPartUpdated(
    undefined,
    toolPart("part-tool", "bash", { status: "running", input: {}, time: { start: 1 } }),
  )
  parts = applyPartUpdated(
    parts,
    toolPart("part-tool", "bash", {
      status: "error",
      input: {},
      error: "boom",
      metadata: {},
      time: { start: 1, end: 2 },
    }),
  )
  const original = parts[0]
  parts = applyPartUpdated(
    parts,
    toolPart("part-tool", "bash", {
      status: "error",
      input: {},
      error: "different",
      metadata: {},
      time: { start: 1, end: 2 },
    }),
  )
  expect(parts[0]).toBe(original)
  expect(((parts[0] as ToolPart).state as AnyToolState).error).toBe("boom")
})

test("running input updates are adopted on a same-status replay", () => {
  let parts = applyPartUpdated(
    undefined,
    toolPart("part-tool", "bash", { status: "running", input: { command: "a" }, time: { start: 1 } }),
  )
  const original = parts[0]
  // `tool-call` is re-published while the tool runs to update `input`.
  parts = applyPartUpdated(
    parts,
    toolPart("part-tool", "bash", { status: "running", input: { command: "b" }, time: { start: 1 } }),
  )
  expect(parts[0]).toBe(original)
  const state = (parts[0] as ToolPart).state as AnyToolState
  expect(state.input).toEqual({ command: "b" })
  expect(state.time).toEqual({ start: 1 })
})

test("a same-status replay can add schema fields without overwriting existing ones", () => {
  let parts = applyPartUpdated(
    undefined,
    toolPart("part-tool", "bash", {
      status: "completed",
      input: {},
      output: "a",
      title: "bash",
      metadata: {},
      time: { start: 1, end: 2 },
    }),
  )
  const original = parts[0]
  const incoming = {
    ...parts[0],
    state: {
      status: "completed" as const,
      input: {},
      output: "different",
      title: "different",
      metadata: {},
      time: { start: 1, end: 2 },
      attachments: [{ id: "file-1" } as never],
    },
  } as ToolPart
  parts = applyPartUpdated(parts, incoming)
  expect(parts[0]).toBe(original)
  const state = (parts[0] as ToolPart).state as AnyToolState
  expect(state.output).toBe("a")
  expect(state.title).toBe("bash")
  expect(state.attachments).toEqual([{ id: "file-1" }])
})

test("a finished part is not reopened by a longer non-terminal snapshot", () => {
  // Reviewer case: current is terminal ("final answer", time.end set); a
  // replayed non-terminal snapshot can still "extend" the final text, but it
  // is an older row. The terminal guard must run before the prefix/extension
  // rules, or the extension would be adopted and reopen the finished part.
  let parts = applyPartUpdated(undefined, text({ text: "final answer", time: { start: 1, end: 100 } }))
  const original = parts[0]
  parts = applyPartUpdated(parts, text({ text: "final answer plus stale stuff" }))
  expect(parts[0]).toBe(original)
  expect(partText(parts[0])).toBe("final answer")
  expect((parts[0] as TextPart).time?.end).toBe(100)
})

test("a finished part is not reopened by a shorter non-terminal snapshot", () => {
  let parts = applyPartUpdated(undefined, text({ text: "final answer", time: { start: 1, end: 100 } }))
  parts = applyPartUpdated(parts, text({ text: "final ans" }))
  expect(partText(parts[0])).toBe("final answer")
  expect((parts[0] as TextPart).time?.end).toBe(100)
})

test("a second terminal snapshot with different text cannot replace the first", () => {
  // A second terminal row with different text has no known causal ordering,
  // including when an orphan settlement snapshot is replayed.
  let parts = applyPartUpdated(undefined, text({ text: "final answer", time: { start: 1, end: 100 } }))
  const original = parts[0]
  parts = applyPartUpdated(parts, text({ text: "final answer plus stale stuff", time: { start: 1, end: 200 } }))
  expect(parts[0]).toBe(original)
  expect(partText(parts[0])).toBe("final answer")
})

test.each(["text", "reasoning"] as const)(
  "orphan settlement makes %s terminal without truncating streamed text",
  (type) => {
    const initial = type === "text" ? text({ time: { start: 1 } }) : reasoning({ time: { start: 1 } })
    let parts = applyPartUpdated(undefined, initial)
    const original = parts[0]
    parts = applyPartDelta(parts, "part-1", "text", "streamed content")!
    const recovered = {
      ...initial,
      text: "streamed",
      time: { start: 9, end: 10 },
      recovery: "orphaned" as const,
    }
    parts = applyPartUpdated(parts, recovered)
    expect(parts[0]).toBe(original)
    expect(parts[0]).toMatchObject({ text: "streamed content", time: { start: 1, end: 10 } })
    parts = applyPartDelta(parts, "part-1", "text", " stale")!
    parts = applyPartUpdated(parts, { ...initial, text: "streamed content plus stale" })
    expect(parts[0]).toMatchObject({ text: "streamed content", time: { start: 1, end: 10 } })
  },
)

test.each(["Hello", ""])(
  "a stale nonterminal recovery marker cannot poison a terminal plugin rewrite: %j",
  (rewritten) => {
    let parts = applyPartUpdated(undefined, { ...text({ time: { start: 1 } }), recovery: "orphaned" })
    parts = applyPartDelta(parts, "part-1", "text", "Hello secret")!
    parts = applyPartUpdated(
      parts,
      text({ text: rewritten, time: { start: 1, end: 2 }, metadata: { "opencode.orphaned": true } }),
    )
    expect(parts[0]).toMatchObject({ text: rewritten, time: { start: 1, end: 2 } })
    expect((parts[0] as TextPart).recovery).toBeUndefined()
  },
)

test("an orphan snapshot adopts a durable extension or the only available text", () => {
  const recovered = text({ text: "partial durable text", time: { start: 1, end: 2 }, recovery: "orphaned" })
  expect(mergePartText(undefined, recovered)).toBe(recovered)
  expect(mergePartText(text({ text: "partial", time: { start: 1 } }), recovered)).toBe(recovered)
  expect(mergePartText(text({ text: "different live text", time: { start: 1 } }), recovered)).toMatchObject({
    text: "different live text",
    time: { start: 1, end: 2 },
  })
})
