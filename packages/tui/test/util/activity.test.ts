import { describe, expect, test } from "bun:test"
import type { AssistantMessage, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import {
  activityHeader,
  computeActivityGroups,
  NON_WORK_TOOLS,
  resolveActivityExpanded,
  summarizeActivity,
  toggleActivityOverride,
  toolPartOutcome,
  type ActivityRow,
} from "../../src/util/activity"

const sessionID = "ses_test"

function assistant(id: string, created: number): AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created, completed: created + 1000 },
    parentID: "msg_user",
    modelID: "model",
    providerID: "test",
    mode: "work",
    agent: "work",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function user(id: string, created: number): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "work",
    model: { providerID: "test", modelID: "model" },
  }
}

function text(messageID: string, id: string, value: string) {
  return { id, sessionID, messageID, type: "text" as const, text: value }
}

function reasoning(messageID: string, id: string, value: string) {
  return {
    id,
    sessionID,
    messageID,
    type: "reasoning" as const,
    text: value,
    time: { start: 0 },
  }
}

function invisible(messageID: string, id: string, type: "step-start" | "step-finish" | "patch") {
  if (type === "step-start") return { id, sessionID, messageID, type: "step-start" as const }
  if (type === "step-finish")
    return {
      id,
      sessionID,
      messageID,
      type: "step-finish" as const,
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
  return { id, sessionID, messageID, type: "patch" as const, hash: "abc", files: [] }
}

function tool(
  messageID: string,
  id: string,
  state: ToolPart["state"] = { status: "completed", input: {}, output: "", title: "", metadata: {}, time: { start: 0, end: 1 } },
  toolName = "bash",
): ToolPart {
  return { id, sessionID, messageID, type: "tool", callID: `call_${id}`, tool: toolName, state }
}

const running = (start: number): ToolPart["state"] => ({ status: "running", input: {}, time: { start } })
const completed = (start: number, end: number): ToolPart["state"] => ({
  status: "completed",
  input: {},
  output: "",
  title: "",
  metadata: {},
  time: { start, end },
})
const failed = (start: number, end: number, error: string): ToolPart["state"] => ({
  status: "error",
  input: {},
  error,
  time: { start, end },
})

describe("toolPartOutcome", () => {
  const part = (state: ToolPart["state"]) => tool("m1", "p1", state)

  test("passes through non-error statuses", () => {
    expect(toolPartOutcome(part({ status: "pending", input: {}, raw: "" }))).toBe("pending")
    expect(toolPartOutcome(part(running(0)))).toBe("running")
    expect(toolPartOutcome(part(completed(0, 1)))).toBe("completed")
  })

  test("classifies user-caused errors as denied", () => {
    expect(toolPartOutcome(part(failed(0, 1, "QuestionRejectedError")))).toBe("denied")
    expect(toolPartOutcome(part(failed(0, 1, "rejected permission for bash")))).toBe("denied")
    expect(toolPartOutcome(part(failed(0, 1, "specified a rule that rejects this call")))).toBe("denied")
    expect(toolPartOutcome(part(failed(0, 1, "user dismissed the question")))).toBe("denied")
  })

  test("classifies aborts as interrupted", () => {
    expect(toolPartOutcome(part(failed(0, 1, "Tool execution aborted")))).toBe("interrupted")
    const state: ToolPart["state"] = {
      status: "error",
      input: {},
      error: "Tool execution aborted",
      metadata: { interrupted: true },
      time: { start: 0, end: 1 },
    }
    expect(toolPartOutcome(part(state))).toBe("interrupted")
  })

  test("keeps real failures as errors", () => {
    expect(toolPartOutcome(part(failed(0, 1, "command not found")))).toBe("error")
  })
})

describe("computeActivityGroups", () => {
  test("groups consecutive tool calls in one message", () => {
    const rows: ActivityRow[] = [
      { message: assistant("m1", 1), parts: [tool("m1", "t1"), tool("m1", "t2", completed(0, 2), "read")] },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(1)
    const group = result.byID.get("act-t1")
    expect(group?.items.map((item) => item.part.id)).toEqual(["t1", "t2"])
    expect(result.groupOf.get("t1")).toBe("act-t1")
    expect(result.groupOf.get("t2")).toBe("act-t1")
  })

  test("groups a single tool call on its own", () => {
    const rows: ActivityRow[] = [{ message: assistant("m1", 1), parts: [tool("m1", "t1")] }]
    const result = computeActivityGroups(rows)
    expect(result.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1"])
  })

  test("merges tool calls across consecutive assistant messages", () => {
    const rows: ActivityRow[] = [
      { message: assistant("m1", 1), parts: [tool("m1", "t1", completed(0, 1)) ] },
      { message: assistant("m2", 2), parts: [tool("m2", "t2", completed(1, 2))] },
      { message: assistant("m3", 3), parts: [tool("m3", "t3", completed(2, 3))] },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(1)
    expect(result.byID.get("act-t1")?.items.map((item) => item.message.id)).toEqual(["m1", "m2", "m3"])
  })

  test("splits a group at assistant text", () => {
    const rows: ActivityRow[] = [
      { message: assistant("m1", 1), parts: [tool("m1", "t1", completed(0, 1)), text("m1", "x1", "Let me check.")] },
      { message: assistant("m2", 2), parts: [tool("m2", "t2", completed(1, 2)), tool("m2", "t3", completed(1, 3))] },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(2)
    expect(result.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1"])
    expect(result.byID.get("act-t2")?.items.map((item) => item.part.id)).toEqual(["t2", "t3"])
  })

  test("keeps a group together across reasoning parts", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [tool("m1", "t1", completed(0, 1)), reasoning("m1", "r1", "thinking"), tool("m1", "t2", completed(1, 2))],
      },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(1)
    expect(result.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1", "t2"])
    expect(result.byID.get("act-t1")?.parts.map((item) => item.part.id)).toEqual(["t1", "r1", "t2"])
    expect(result.groupOf.get("r1")).toBe("act-t1")
    expect(result.groupOf.get("t2")).toBe("act-t1")
  })

  test("associates leading and trailing reasoning with the surrounding work run", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [reasoning("m1", "r1", "planning"), tool("m1", "t1", completed(0, 1))],
      },
      {
        message: assistant("m2", 2),
        parts: [tool("m2", "t2", running(1)), reasoning("m2", "r2", "checking the result")],
      },
    ]
    const result = computeActivityGroups(rows)
    const group = result.byID.get("act-t1")
    expect(group?.items.map((item) => item.part.id)).toEqual(["t1", "t2"])
    expect(group?.parts.map((item) => item.part.id)).toEqual(["r1", "t1", "t2", "r2"])
    expect(result.groupOf.get("r1")).toBe("act-t1")
    expect(result.groupOf.get("r2")).toBe("act-t1")
  })

  test("keeps reasoning standalone when no tool run follows it", () => {
    const rows: ActivityRow[] = [
      { message: assistant("m1", 1), parts: [reasoning("m1", "r1", "thinking")] },
      { message: assistant("m2", 2), parts: [text("m2", "x1", "Done.")] },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(0)
    expect(result.groupOf.has("r1")).toBe(false)
  })

  test("keeps one group across stream placeholders and interleaved reasoning", () => {
    const rows: ActivityRow[] = [
      { message: assistant("m1", 1), parts: [text("m1", "placeholder-1", ""), tool("m1", "t1", completed(0, 1))] },
      { message: assistant("m2", 2), parts: [text("m2", "placeholder-2", ""), tool("m2", "t2", completed(1, 2))] },
      {
        message: assistant("m3", 3),
        parts: [
          text("m3", "placeholder-3", ""),
          reasoning("m3", "r1", "thinking about the trace"),
          tool("m3", "t3", completed(2, 3)),
          tool("m3", "t4", completed(2, 4)),
        ],
      },
      {
        message: assistant("m4", 4),
        parts: [
          text("m4", "placeholder-4", ""),
          reasoning("m4", "r2", "thinking again"),
          tool("m4", "t5", completed(4, 5)),
          tool("m4", "t6", completed(4, 6)),
        ],
      },
      { message: assistant("m5", 5), parts: [text("m5", "placeholder-5", ""), tool("m5", "t7", completed(6, 7))] },
      { message: assistant("m6", 6), parts: [text("m6", "placeholder-6", ""), tool("m6", "t8", completed(7, 8), "finish")] },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(1)
    const group = result.byID.get("act-t1")
    // The trailing `finish` call is orchestration: it does not count toward
    // the work run and, being rendered outside it, closes it — nothing follows
    // it here, so the group keeps just the concrete tools and their
    // interleaved reasoning.
    expect(group?.items.map((item) => item.part.id)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7"])
    expect(group?.parts.map((item) => item.part.id)).toEqual([
      "t1",
      "t2",
      "r1",
      "t3",
      "t4",
      "r2",
      "t5",
      "t6",
      "t7",
    ])
    expect(result.groupOf.get("r1")).toBe("act-t1")
    expect(result.groupOf.get("r2")).toBe("act-t1")
    expect(result.groupOf.get("t8")).toBeUndefined()
  })

  test("still splits a group at assistant text when reasoning is present", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [
          tool("m1", "t1", completed(0, 1)),
          reasoning("m1", "r1", "thinking"),
          text("m1", "x1", "Let me summarize."),
          tool("m1", "t2", completed(1, 2)),
        ],
      },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(2)
    expect(result.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1"])
    expect(result.byID.get("act-t1")?.parts.map((item) => item.part.id)).toEqual(["t1", "r1"])
    expect(result.byID.get("act-t2")?.items.map((item) => item.part.id)).toEqual(["t2"])
    expect(result.groupOf.get("r1")).toBe("act-t1")
  })

  test("splits a group at user messages", () => {
    const rows: ActivityRow[] = [
      { message: assistant("m1", 1), parts: [tool("m1", "t1", completed(0, 1))] },
      { message: user("u1", 2), parts: [text("u1", "x1", "again")] },
      { message: assistant("m2", 3), parts: [tool("m2", "t2", completed(1, 2))] },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(2)
    expect(result.byID.get("act-t1")?.items).toHaveLength(1)
    expect(result.byID.get("act-t2")?.items).toHaveLength(1)
  })

  test("does not split a group at invisible parts", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [
          invisible("m1", "s1", "step-start"),
          tool("m1", "t1", completed(0, 1)),
          invisible("m1", "s2", "step-finish"),
          invisible("m1", "s3", "step-start"),
          tool("m1", "t2", completed(1, 2)),
          invisible("m1", "s4", "step-finish"),
        ],
      },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(1)
    expect(result.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1", "t2"])
  })

  test("does not split a group at blank text parts", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [
          tool("m1", "t1", completed(0, 1)),
          text("m1", "x0", ""),
          text("m1", "x1", "  \n "),
          tool("m1", "t2", completed(1, 2)),
        ],
      },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(1)
    expect(result.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1", "t2"])
  })

  test("keeps one working activity across batches, blank text, and thinking", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [tool("m1", "t1", completed(0, 1)), tool("m1", "t2", completed(0, 2))],
      },
      {
        message: assistant("m2", 2),
        parts: [text("m2", "x0", ""), tool("m2", "t3", completed(2, 3)), tool("m2", "t4", completed(2, 4))],
      },
      { message: assistant("m3", 3), parts: [reasoning("m3", "r1", "thinking A")] },
      {
        message: assistant("m4", 4),
        parts: [tool("m4", "t5", completed(4, 5)), tool("m4", "t6", completed(4, 6))],
      },
      { message: assistant("m5", 5), parts: [reasoning("m5", "r2", "thinking B")] },
      {
        message: assistant("m6", 6),
        parts: [text("m6", "x1", " \n"), tool("m6", "t7", completed(6, 7))],
      },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(1)
    const group = result.byID.get("act-t1")
    expect(group?.items.map((item) => item.part.id)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7"])
    expect(group?.parts.map((item) => item.part.id)).toEqual(["t1", "t2", "t3", "t4", "r1", "t5", "t6", "r2", "t7"])
    for (const id of ["t1", "t2", "t3", "t4", "r1", "t5", "t6", "r2", "t7"]) {
      expect(result.groupOf.get(id)).toBe("act-t1")
    }
  })

  test("visibility toggles change expansion, not grouping membership", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [tool("m1", "t1", completed(0, 1)), tool("m1", "t2", completed(1, 2))],
      },
    ]
    // Re-evaluating the same transcript state (as a visibility toggle does)
    // yields identical membership; only the expansion resolution varies.
    const membership = [...computeActivityGroups(rows).groupOf.entries()]
    expect([...computeActivityGroups(rows).groupOf.entries()]).toEqual(membership)
    expect(resolveActivityExpanded(undefined, false)).toBe(false)
    expect(resolveActivityExpanded(undefined, true)).toBe(true)
    const group = computeActivityGroups(rows).byID.get("act-t1")
    expect(group).toBeDefined()
    const summary = summarizeActivity((group?.items ?? []).map((item) => item.part))
    expect(activityHeader(summary, { expanded: false, duration: undefined }).marker).toBe("+")
    expect(activityHeader(summary, { expanded: true, duration: undefined }).marker).toBe("−")
  })

  test("keeps the group id stable while the run grows at its tail", () => {
    const t1 = tool("m1", "t1", completed(0, 1))
    const t2 = tool("m2", "t2", completed(1, 2))
    const t3 = tool("m3", "t3", running(2))
    const base = computeActivityGroups([
      { message: assistant("m1", 1), parts: [t1] },
      { message: assistant("m2", 2), parts: [t2] },
    ])
    const grown = computeActivityGroups([
      { message: assistant("m1", 1), parts: [t1] },
      { message: assistant("m2", 2), parts: [t2] },
      { message: assistant("m3", 3), parts: [t3] },
    ])
    expect([...base.byID.keys()]).toEqual(["act-t1"])
    expect([...grown.byID.keys()]).toEqual(["act-t1"])
    expect(grown.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1", "t2", "t3"])
  })

  test("re-keys a group when its first part is removed", () => {
    const t2 = tool("m1", "t2", completed(1, 2))
    const t3 = tool("m1", "t3", completed(2, 3))
    const before = computeActivityGroups([
      { message: assistant("m1", 1), parts: [tool("m1", "t1", completed(0, 1)), t2, t3] },
    ])
    const after = computeActivityGroups([{ message: assistant("m1", 1), parts: [t2, t3] }])
    expect(before.byID.has("act-t1")).toBe(true)
    expect(after.byID.has("act-t1")).toBe(false)
    expect(after.byID.get("act-t2")?.items.map((item) => item.part.id)).toEqual(["t2", "t3"])
  })

  test("leaves non-tool conversations ungrouped", () => {
    const rows: ActivityRow[] = [
      { message: user("u1", 1), parts: [text("u1", "x1", "hello")] },
      { message: assistant("m1", 2), parts: [text("m1", "x2", "hi")] },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(0)
    expect(result.groupOf.size).toBe(0)
  })

  test("excludes orchestration/protocol tools from a mixed run and splits at them", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [
          tool("m1", "t1", completed(0, 1), "todowrite"),
          tool("m1", "t2", completed(0, 2)),
          tool("m1", "t3", completed(1, 3), "task"),
          tool("m1", "t4", completed(1, 4), "read"),
          tool("m1", "t5", completed(2, 5), "edit"),
          tool("m1", "t6", completed(3, 6), "finish"),
        ],
      },
    ]
    const result = computeActivityGroups(rows)
    // The group ids come from the first included tool of each block, and only
    // the concrete operational tools (bash, read, edit) are counted.
    expect([...result.byID.keys()]).toEqual(["act-t2", "act-t4"])
    expect(result.byID.get("act-t2")?.items.map((item) => item.part.id)).toEqual(["t2"])
    expect(result.byID.get("act-t4")?.items.map((item) => item.part.id)).toEqual(["t4", "t5"])
    // Excluded tools are not mapped to any group so the renderer keeps them
    // visible as their own native top-level rows; not owning them is exactly
    // why they close the run they land in.
    expect(result.groupOf.get("t1")).toBeUndefined()
    expect(result.groupOf.get("t3")).toBeUndefined()
    expect(result.groupOf.get("t6")).toBeUndefined()
    expect(result.groupOf.get("t2")).toBe("act-t2")
    expect(result.groupOf.get("t4")).toBe("act-t4")
    expect(result.groupOf.get("t5")).toBe("act-t4")
  })

  test("ends the run at a non-work call instead of absorbing it", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [
          tool("m1", "t1", completed(0, 1), "read"),
          tool("m1", "t2", completed(1, 2), "finish"),
          tool("m1", "t3", completed(2, 3), "grep"),
        ],
      },
    ]
    const result = computeActivityGroups(rows)
    // The finish row renders outside both blocks, so the work after it opens a
    // new group rather than resuming the one above it.
    expect([...result.byID.keys()]).toEqual(["act-t1", "act-t3"])
    expect(result.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1"])
    expect(result.byID.get("act-t3")?.items.map((item) => item.part.id)).toEqual(["t3"])
  })

  test("closes the run at every non-work exception the implementation supports", () => {
    // The boundary rule follows group membership rather than a per-tool list,
    // so every tool in the exception set must end its run. Iterating the set
    // keeps this honest when a new exception is registered: it is covered the
    // moment it joins NON_WORK_TOOLS, and it can never nest inside the open
    // Working block.
    for (const exception of NON_WORK_TOOLS) {
      const result = computeActivityGroups([
        {
          message: assistant("m1", 1),
          parts: [
            tool("m1", "t1", completed(0, 1), "read"),
            tool("m1", "t2", completed(1, 2), "bash"),
            tool("m1", "t3", completed(2, 3), exception),
            tool("m1", "t4", completed(3, 4), "grep"),
            tool("m1", "t5", completed(4, 5), "edit"),
          ],
        },
      ])
      expect([...result.byID.keys()]).toEqual(["act-t1", "act-t4"])
      expect(result.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1", "t2"])
      expect(result.byID.get("act-t4")?.items.map((item) => item.part.id)).toEqual(["t4", "t5"])
      expect(result.groupOf.get("t3")).toBeUndefined()
      expect(result.groupOf.get("t1")).toBe("act-t1")
      expect(result.groupOf.get("t4")).toBe("act-t4")
    }
  })

  test("does not pull pending reasoning across a non-work call into the next run", () => {
    for (const exception of NON_WORK_TOOLS) {
      const result = computeActivityGroups([
        {
          message: assistant("m1", 1),
          parts: [
            reasoning("m1", "r1", "thinking before the exception"),
            reasoning("m1", "r2", "more thinking before the exception"),
            tool("m1", "t1", completed(0, 1), exception),
            reasoning("m1", "r3", "thinking after the exception"),
            tool("m1", "t2", completed(1, 2), "bash"),
            tool("m1", "t3", completed(2, 3), "grep"),
          ],
        },
      ])
      // Reasoning rendered in front of the exception stays out of the group
      // that opens after it, exactly like reasoning in front of assistant text.
      expect([...result.byID.keys()]).toEqual(["act-t2"])
      expect(result.byID.get("act-t2")?.parts.map((item) => item.part.id)).toEqual(["r3", "t2", "t3"])
      expect(result.groupOf.has("r1")).toBe(false)
      expect(result.groupOf.has("r2")).toBe(false)
      expect(result.groupOf.get("r3")).toBe("act-t2")
    }
  })

  test("does not create a group for an all-excluded sequence", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [
          tool("m1", "t1", completed(0, 1), "todowrite"),
          tool("m1", "t2", completed(1, 2), "finish"),
          tool("m1", "t3", completed(2, 3), "task"),
        ],
      },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(0)
    expect(result.groupOf.size).toBe(0)
  })

  test("excludes orchestration tools from summaries, counts, and failures", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [
          tool("m1", "t1", completed(100, 120), "todowrite"),
          tool("m1", "t2", completed(150, 160)),
          tool("m1", "t3", failed(160, 170, "boom"), "task"),
          tool("m1", "t4", completed(180, 220), "read"),
          tool("m1", "t5", failed(230, 240, "command not found")),
          tool("m1", "t6", completed(250, 260), "finish"),
        ],
      },
    ]
    const result = computeActivityGroups(rows)
    // The exceptions split the stream into two blocks, but neither exception
    // joins an activity summary: only the concrete tools (t2 bash, t4 read,
    // t5 bash) remain, and the failing bash is the only counted failure.
    const summary = summarizeActivity(
      [...result.byID.values()].flatMap((group) => group.items.map((item) => item.part)),
    )
    expect(summary).toMatchObject({ count: 3, working: false, failed: 1 })
    expect(summary.durationMs).toBe(240 - 150)
    expect(result.groupOf.has("t1")).toBe(false)
    expect(result.groupOf.has("t3")).toBe(false)
    expect(result.groupOf.has("t6")).toBe(false)
  })

  test("closes the run at a to-do call and opens a new one after it", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [
          tool("m1", "t1", completed(0, 1), "read"),
          tool("m1", "t2", completed(1, 2), "bash"),
          tool("m1", "t3", completed(2, 3), "todowrite"),
          tool("m1", "t4", completed(3, 4), "edit"),
          tool("m1", "t5", completed(4, 5), "bash"),
        ],
      },
    ]
    const result = computeActivityGroups(rows)
    // Two ids, not one: the closed run is never resumed by the work that
    // follows the to-do call. Separate ids are also what keeps the collapse
    // and expand state of the two blocks independent in the transcript.
    expect([...result.byID.keys()]).toEqual(["act-t1", "act-t4"])
    expect(result.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1", "t2"])
    expect(result.byID.get("act-t4")?.items.map((item) => item.part.id)).toEqual(["t4", "t5"])
    // The to-do call belongs to neither run; it renders as its own block.
    expect(result.groupOf.get("t3")).toBeUndefined()
    expect(result.groupOf.get("t1")).toBe("act-t1")
    expect(result.groupOf.get("t4")).toBe("act-t4")
  })

  test("finalizes a streaming run at a to-do call without waiting on later work", () => {
    const todo = tool("m2", "t3", completed(300, 350), "todowrite")
    const t4 = tool("m2", "t4", running(400), "edit")
    const streaming = computeActivityGroups([
      {
        message: assistant("m1", 1),
        parts: [tool("m1", "t1", running(100), "read"), tool("m1", "t2", running(200), "bash")],
      },
      { message: assistant("m2", 2), parts: [todo, t4] },
    ])
    // The to-do call closes the run even while its own tools are in flight, so
    // the work that follows it never gets folded into the block above.
    expect([...streaming.byID.keys()]).toEqual(["act-t1", "act-t4"])
    expect(streaming.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1", "t2"])
    expect(streaming.byID.get("act-t4")?.items.map((item) => item.part.id)).toEqual(["t4"])
    expect(summarizeActivity(streaming.byID.get("act-t4")!.items.map((item) => item.part)).working).toBe(true)

    // Once its own tools settle, the closed run finalizes on its own timing:
    // neither the to-do call nor the new run stretches it.
    const settled = computeActivityGroups([
      {
        message: assistant("m1", 1),
        parts: [tool("m1", "t1", completed(100, 500), "read"), tool("m1", "t2", completed(200, 700), "bash")],
      },
      { message: assistant("m2", 2), parts: [todo, t4] },
    ])
    const summary = summarizeActivity(settled.byID.get("act-t1")!.items.map((item) => item.part))
    expect(summary).toMatchObject({ count: 2, working: false, failed: 0 })
    expect(summary.durationMs).toBe(700 - 100)
  })

  test("splits the run at each of several sequential to-do calls", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [
          tool("m1", "t1", completed(0, 1), "read"),
          tool("m1", "t2", completed(1, 2), "bash"),
          tool("m1", "t3", completed(2, 3), "todowrite"),
          tool("m1", "t4", completed(3, 4), "todoread"),
          tool("m1", "t5", completed(4, 5), "edit"),
          tool("m1", "t6", completed(5, 6), "todowrite"),
          tool("m1", "t7", completed(6, 7), "grep"),
        ],
      },
    ]
    const result = computeActivityGroups(rows)
    expect([...result.byID.keys()]).toEqual(["act-t1", "act-t5", "act-t7"])
    expect(result.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1", "t2"])
    expect(result.byID.get("act-t5")?.items.map((item) => item.part.id)).toEqual(["t5"])
    expect(result.byID.get("act-t7")?.items.map((item) => item.part.id)).toEqual(["t7"])
    expect(result.groupOf.size).toBe(4)
  })

  test("keeps sequential to-do calls from forming a run of their own", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [
          tool("m1", "t1", completed(0, 1), "todowrite"),
          tool("m1", "t2", completed(1, 2), "todoread"),
          tool("m1", "t3", completed(2, 3), "todowrite"),
        ],
      },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(0)
    expect(result.groupOf.size).toBe(0)
  })

  test("splits the run at non-work calls between ordinary tools", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [
          tool("m1", "t1", completed(0, 1), "read"),
          tool("m1", "t2", completed(1, 2), "finish"),
          tool("m1", "t3", completed(2, 3), "task"),
        ],
      },
      {
        message: assistant("m2", 2),
        parts: [tool("m2", "t4", completed(3, 4), "grep"), tool("m2", "t5", completed(4, 5), "edit")],
      },
    ]
    const result = computeActivityGroups(rows)
    // Ordinary tools only stay together with the work that shares their run:
    // the turn-completion and delegation rows render as top-level transcript
    // entries between the two blocks.
    expect([...result.byID.keys()]).toEqual(["act-t1", "act-t4"])
    expect(result.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1"])
    expect(result.byID.get("act-t4")?.items.map((item) => item.part.id)).toEqual(["t4", "t5"])
  })

  test("attaches reasoning after a to-do call to the new run", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [
          tool("m1", "t1", completed(0, 1), "read"),
          tool("m1", "t2", completed(1, 2), "bash"),
          tool("m1", "t3", completed(2, 3), "todowrite"),
          reasoning("m1", "r1", "planning the next step"),
          tool("m1", "t4", completed(3, 4), "edit"),
        ],
      },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.get("act-t1")?.parts.map((item) => item.part.id)).toEqual(["t1", "t2"])
    expect(result.byID.get("act-t4")?.parts.map((item) => item.part.id)).toEqual(["r1", "t4"])
    expect(result.groupOf.get("r1")).toBe("act-t4")
  })

  test("does not pull reasoning from before a to-do call into the next run", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [
          reasoning("m1", "r1", "thinking before the to-do call"),
          tool("m1", "t1", completed(0, 1), "todowrite"),
          tool("m1", "t2", completed(1, 2), "bash"),
          tool("m1", "t3", completed(2, 3), "grep"),
        ],
      },
    ]
    const result = computeActivityGroups(rows)
    // The run boundary behaves like assistant text: reasoning rendered in front
    // of the to-do call stays out of the group opened after it.
    expect(result.byID.get("act-t2")?.parts.map((item) => item.part.id)).toEqual(["t2", "t3"])
    expect(result.groupOf.has("r1")).toBe(false)
  })
})

describe("summarizeActivity", () => {
  test("reports working state and no duration while a tool runs", () => {
    const summary = summarizeActivity([tool("m1", "t1", completed(0, 1)), tool("m1", "t2", running(1))])
    expect(summary).toEqual({ count: 2, working: true, failed: 0, denied: false, interrupted: false, durationMs: undefined })
  })

  test("treats pending tools as working", () => {
    const summary = summarizeActivity([tool("m1", "t1", { status: "pending", input: {}, raw: "" })])
    expect(summary.working).toBe(true)
    expect(summary.durationMs).toBeUndefined()
  })

  test("computes duration across the whole group", () => {
    const summary = summarizeActivity([
      tool("m1", "t1", completed(100, 500)),
      tool("m2", "t2", completed(400, 900)),
      tool("m3", "t3", completed(800, 1420)),
    ])
    expect(summary.working).toBe(false)
    expect(summary.durationMs).toBe(1420 - 100)
  })

  test("counts hard failures only", () => {
    const summary = summarizeActivity([
      tool("m1", "t1", completed(0, 1)),
      tool("m1", "t2", failed(1, 2, "boom")),
      tool("m1", "t3", failed(2, 3, "QuestionRejectedError")),
      tool("m1", "t4", failed(3, 4, "Tool execution aborted")),
    ])
    expect(summary.failed).toBe(1)
    expect(summary.denied).toBe(true)
    expect(summary.interrupted).toBe(true)
    expect(summary.durationMs).toBe(4 - 0)
  })
})

describe("activityHeader", () => {
  test("renders the active state with a count", () => {
    const header = activityHeader(
      { count: 3, working: true, failed: 0, denied: false, interrupted: false, durationMs: undefined },
      { expanded: false, duration: undefined },
    )
    expect(header).toEqual({ marker: "+", main: "Working... 3 tool calls", failed: undefined, note: undefined })
  })

  test("surfaces failures while working", () => {
    const header = activityHeader(
      { count: 3, working: true, failed: 2, denied: false, interrupted: false, durationMs: undefined },
      { expanded: false, duration: undefined },
    )
    expect(header.main).toBe("Working... 3 tool calls")
    expect(header.failed).toBe("2 failed")
  })

  test("renders the completed state with duration and count", () => {
    const header = activityHeader(
      { count: 9, working: false, failed: 0, denied: false, interrupted: false, durationMs: 4200 },
      { expanded: false, duration: "4.2s" },
    )
    expect(header).toEqual({ marker: "+", main: "Worked for 4.2s · 9 tool calls", failed: undefined, note: undefined })
  })

  test("pluralizes a single tool call", () => {
    const header = activityHeader(
      { count: 1, working: false, failed: 0, denied: false, interrupted: false, durationMs: 4200 },
      { expanded: false, duration: "4.2s" },
    )
    expect(header.main).toBe("Worked for 4.2s · 1 tool call")
  })

  test("omits the duration when timing data is unavailable", () => {
    const header = activityHeader(
      { count: 2, working: false, failed: 0, denied: false, interrupted: false, durationMs: undefined },
      { expanded: false, duration: undefined },
    )
    expect(header.main).toBe("2 tool calls")
  })

  test("flags completed groups that contain failures", () => {
    const header = activityHeader(
      { count: 5, working: false, failed: 1, denied: false, interrupted: false, durationMs: 1000 },
      { expanded: false, duration: "1.0s" },
    )
    expect(header.main).toBe("Worked for 1.0s · 5 tool calls")
    expect(header.failed).toBe("1 failed")
  })

  test("notes interrupted and denied groups", () => {
    const interrupted = activityHeader(
      { count: 2, working: false, failed: 0, denied: false, interrupted: true, durationMs: 1000 },
      { expanded: true, duration: "1.0s" },
    )
    expect(interrupted).toMatchObject({ marker: "−", note: "interrupted" })
    const denied = activityHeader(
      { count: 2, working: false, failed: 0, denied: true, interrupted: false, durationMs: 1000 },
      { expanded: false, duration: "1.0s" },
    )
    expect(denied).toMatchObject({ marker: "+", note: "denied" })
  })
})

describe("activity expanded overrides", () => {
  test("follows the global default without an override", () => {
    expect(resolveActivityExpanded(undefined, false)).toBe(false)
    expect(resolveActivityExpanded(undefined, true)).toBe(true)
  })

  test("an explicit override wins over the global default", () => {
    expect(resolveActivityExpanded(true, false)).toBe(true)
    expect(resolveActivityExpanded(false, true)).toBe(false)
  })

  test("toggling stores only overrides that differ from the default", () => {
    // collapsed -> expanded
    expect(toggleActivityOverride(undefined, false)).toBe(true)
    // expanded -> collapsed clears back to the default
    expect(toggleActivityOverride(true, false)).toBe(undefined)
    // expanded (via global) -> collapsed stores an explicit false
    expect(toggleActivityOverride(undefined, true)).toBe(false)
    // collapsed (via override) -> expanded clears back to the default
    expect(toggleActivityOverride(false, true)).toBe(undefined)
  })

  test("toggling twice returns to the previous state", () => {
    for (const allExpanded of [false, true]) {
      for (const override of [undefined, true, false] as const) {
        const once = toggleActivityOverride(override, allExpanded)
        const twice = toggleActivityOverride(once, allExpanded)
        expect(resolveActivityExpanded(twice, allExpanded)).toBe(resolveActivityExpanded(override, allExpanded))
      }
    }
  })
})

describe("computeActivityGroups wrapper identity", () => {
  // Parts are reused across both recomputes, like store parts that the sync
  // layer mutates in place while streaming.
  const message = assistant("m1", 1)
  const parts = [reasoning("m1", "prt_1", "Thinking."), tool("m1", "prt_2"), tool("m1", "prt_3")]
  const rows = (info: AssistantMessage = message): ActivityRow[] => [{ message: info, parts }]

  const partOf = (groups: ReturnType<typeof computeActivityGroups>, id: string) => {
    const group = groups.byID.values().next().value!
    expect(groups.groupOf.get(id)).toBe(group.id)
    return group.parts.find((part) => part.part.id === id)!
  }

  test("reuses the same wrapper object for a part across recomputes", () => {
    // The transcript renders group parts inside a keyed <For>; fresh wrapper
    // objects on every recompute would remount every nested row and reset its
    // local state (e.g. a manually expanded reasoning block) on each stream
    // update. Parts keep their object identity while the store mutates them in
    // place, so the wrappers must too.
    const first = computeActivityGroups(rows())
    const second = computeActivityGroups(rows())

    for (const part of parts) {
      expect(partOf(second, part.id)).toBe(partOf(first, part.id))
    }
  })

  test("follows a replaced message info object on the cached wrapper", () => {
    const first = computeActivityGroups(rows())
    const replaced = assistant("m1", 2)
    const second = computeActivityGroups(rows(replaced))

    for (const part of parts) {
      const item = partOf(second, part.id)
      expect(item.message).toBe(replaced)
      expect(item).toBe(partOf(first, part.id))
    }
  })
})
