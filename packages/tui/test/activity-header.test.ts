import { describe, expect, test } from "bun:test"
import type { AssistantMessage, ReasoningPart, ToolPart } from "@opencode-ai/sdk/v2"
import {
  activityKindOf,
  computeActivitySubGroups,
  countActivityTargets,
  summarizeActivity,
  typedActivityHeader,
  type ActivityGroup,
  type ActivityItem,
} from "../src/util/activity"

const message = { id: "m1", sessionID: "s1", role: "assistant" } as unknown as AssistantMessage

function tool(id: string, name: string, input: Record<string, unknown>, start = 1000, end = 2000): ToolPart {
  return {
    id,
    sessionID: "s1",
    messageID: "m1",
    type: "tool",
    callID: id,
    tool: name,
    state: { status: "completed", input, output: "", title: "", metadata: {}, time: { start, end } },
  }
}

function reasoning(id: string): ReasoningPart {
  return { id, sessionID: "s1", messageID: "m1", type: "reasoning", text: "thinking", time: { start: 1000 } }
}

function groupOf(parts: (ToolPart | ReasoningPart)[]): ActivityGroup {
  const group: ActivityGroup = { id: "act-1", items: [], parts: [] }
  for (const part of parts) {
    const item = { message, part } as ActivityItem
    group.parts.push(item)
    if (part.type === "tool") group.items.push(item)
  }
  return group
}

function headerOf(kind: Parameters<typeof typedActivityHeader>[0], items: ActivityItem[], working = false) {
  const parts = items.map((item) => item.part)
  const summary = summarizeActivity(parts)
  if (working) summary.working = true
  summary.durationMs = 3000
  return typedActivityHeader(kind, summary, countActivityTargets(items), { expanded: false, duration: "3s" })
}

describe("activityKindOf", () => {
  test("maps the known kinds and leaves everything else misc", () => {
    expect(activityKindOf("read")).toBe("explore")
    expect(activityKindOf("glob")).toBe("explore")
    expect(activityKindOf("grep")).toBe("explore")
    expect(activityKindOf("list")).toBe("explore")
    expect(activityKindOf("shell")).toBe("shell")
    // Legacy persisted parts from before the #780 rename still say "bash"
    // and must group with canonical shell calls.
    expect(activityKindOf("bash")).toBe("shell")
    expect(activityKindOf("write")).toBe("edit")
    expect(activityKindOf("edit")).toBe("edit")
    expect(activityKindOf("apply_patch")).toBe("edit")
    expect(activityKindOf("webfetch")).toBe("misc")
    expect(activityKindOf("skill")).toBe("misc")
  })
})

describe("typedActivityHeader", () => {
  test("explore counts distinct files, shell counts calls, edit counts distinct files", () => {
    const explore = groupOf([tool("a", "read", { filePath: "src/a.ts" }), tool("b", "read", { filePath: "src/a.ts" }), tool("c", "grep", { pattern: "x" })]).items
    expect(headerOf("explore", explore).main).toBe("Explored 2 files · 3s")
    const shell = groupOf([tool("a", "shell", { command: "ls" }), tool("b", "shell", { command: "ls" })]).items
    expect(headerOf("shell", shell).main).toBe("Ran 2 commands · 3s")
    const edit = groupOf([tool("a", "edit", { filePath: "src/a.ts" }), tool("b", "edit", { filePath: "src/a.ts" })]).items
    expect(headerOf("edit", edit).main).toBe("Edited 1 file · 3s")
  })

  test("working labels name the work in progress", () => {
    const explore = groupOf([tool("a", "read", { filePath: "src/a.ts" })]).items
    expect(headerOf("explore", explore, true).main).toBe("Exploring files... · 3s")
    const shell = groupOf([tool("a", "shell", { command: "ls" })]).items
    expect(headerOf("shell", shell, true).main).toBe("Running command... · 3s")
    const edit = groupOf([tool("a", "edit", { filePath: "src/a.ts" })]).items
    expect(headerOf("edit", edit, true).main).toBe("Editing files... · 3s")
  })

  test("misc keeps the original Working/Worked wording and counts calls", () => {
    const misc = groupOf([tool("a", "webfetch", { url: "https://x" }), tool("b", "webfetch", { url: "https://y" })]).items
    expect(headerOf("misc", misc).main).toBe("Worked for 3s · 2 tool calls")
    expect(headerOf("misc", misc, true).main).toBe("Working... 2 tool calls · 3s")
  })

  test("marker is + collapsed and − expanded, failed counts flag the block", () => {
    const items = groupOf([tool("a", "shell", { command: "ls" })]).items
    const failed = structuredClone(items)
    ;(failed[0]!.part.state as { status: string; error: string }).status = "error"
    ;(failed[0]!.part.state as { status: string; error: string }).error = "boom"
    const summary = summarizeActivity(failed.map((item) => item.part))
    const header = typedActivityHeader("shell", summary, 1, { expanded: true, duration: "3s" })
    expect(header.marker).toBe("−")
    expect(header.failed).toBe("1 failed")
    expect(typedActivityHeader("shell", summary, 1, { expanded: false, duration: "3s" }).marker).toBe("+")
  })
})

describe("computeActivitySubGroups", () => {
  test("splits interleaved kinds chronologically: a kind change closes the block", () => {
    const group = groupOf([
      tool("a", "read", { filePath: "src/a.ts" }),
      tool("b", "shell", { command: "ls" }),
      tool("c", "read", { filePath: "src/b.ts" }),
    ])
    const subs = computeActivitySubGroups(group)
    expect(subs.map((sub) => sub.kind)).toEqual(["explore", "shell", "explore"])
    expect(subs[0]!.items.map((item) => item.part.id)).toEqual(["a"])
    expect(subs[1]!.items.map((item) => item.part.id)).toEqual(["b"])
    expect(subs[2]!.items.map((item) => item.part.id)).toEqual(["c"])
    expect(subs[0]!.id).toBe("act-1:explore:1")
    expect(subs[1]!.id).toBe("act-1:shell:1")
    expect(subs[2]!.id).toBe("act-1:explore:2")
  })

  test("write, shell, write opens a new edit block after the command", () => {
    const group = groupOf([
      tool("a", "write", { filePath: "src/a.ts" }),
      tool("b", "shell", { command: "ls" }),
      tool("c", "write", { filePath: "src/b.ts" }),
    ])
    const subs = computeActivitySubGroups(group)
    expect(subs.map((sub) => [sub.kind, sub.id])).toEqual([
      ["edit", "act-1:edit:1"],
      ["shell", "act-1:shell:1"],
      ["edit", "act-1:edit:2"],
    ])
  })

  test("reasoning joins the block of the tool call that follows it", () => {
    const group = groupOf([reasoning("r1"), tool("a", "shell", { command: "ls" }), tool("b", "read", { filePath: "x" })])
    const subs = computeActivitySubGroups(group)
    expect(subs[0]!.kind).toBe("shell")
    expect(subs[0]!.parts.map((item) => item.part.id)).toEqual(["r1", "a"])
  })

  test("trailing reasoning joins the previous tool's block, not a misc block", () => {
    const group = groupOf([tool("a", "read", { filePath: "x" }), reasoning("r1")])
    const subs = computeActivitySubGroups(group)
    expect(subs.map((sub) => sub.kind)).toEqual(["explore"])
    expect(subs[0]!.parts.map((item) => item.part.id)).toEqual(["a", "r1"])
  })
})

describe("activity kind lookup", () => {
  test("inherited object property names are misc, not a bogus kind", () => {
    expect(activityKindOf("constructor")).toBe("misc")
    expect(activityKindOf("toString")).toBe("misc")
    expect(activityKindOf("hasOwnProperty")).toBe("misc")
    expect(activityKindOf("read")).toBe("explore")
  })

  test("a tool named constructor groups under misc", () => {
    const group = groupOf([tool("t1", "constructor", {})])
    const subs = computeActivitySubGroups(group)
    expect(subs).toHaveLength(1)
    expect(subs[0]?.kind).toBe("misc")
  })
})

describe("activity target counting", () => {
  test("path spellings normalize to one target", () => {
    const group = groupOf([
      tool("t1", "read", { filePath: "src/a.ts" }),
      tool("t2", "read", { filePath: "./src/a.ts" }),
    ])
    const subs = computeActivitySubGroups(group)
    expect(subs).toHaveLength(1)
    expect(countActivityTargets(subs[0]!.items)).toBe(1)
  })

  test("repeated patches to the same file count once, parsed from patchText", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch\n"
    const group = groupOf([
      tool("t1", "apply_patch", { patchText: patch }),
      tool("t2", "apply_patch", { patchText: patch }),
    ])
    const subs = computeActivitySubGroups(group)
    expect(subs).toHaveLength(1)
    expect(subs[0]?.kind).toBe("edit")
    expect(countActivityTargets(subs[0]!.items)).toBe(1)
  })

  test("one multi-file patch counts each affected file", () => {
    const patch =
      "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+created\n*** Delete File: ./src/c.ts\n*** End Patch\n"
    const group = groupOf([tool("t1", "apply_patch", { patchText: patch })])
    const subs = computeActivitySubGroups(group)
    expect(subs).toHaveLength(1)
    expect(countActivityTargets(subs[0]!.items)).toBe(3)
    const summary = summarizeActivity(group.items.map((item) => item.part as ToolPart))
    const header = typedActivityHeader("edit", summary, 3, { expanded: false, duration: undefined })
    expect(header.main).toBe("Edited 3 files")
  })

  test("windows counting folds separator and case aliases into one target", () => {
    const group = groupOf([
      tool("t1", "read", { filePath: "src\\App.ts" }),
      tool("t2", "read", { filePath: "src/app.ts" }),
      tool("t3", "read", { filePath: "./SRC/APP.TS" }),
    ])
    const subs = computeActivitySubGroups(group)
    expect(countActivityTargets(subs[0]!.items, "win32")).toBe(1)
  })

  test("posix counting keeps backslash and case literal, so aliases stay distinct", () => {
    const group = groupOf([
      tool("t1", "read", { filePath: "src\\app.ts" }),
      tool("t2", "read", { filePath: "src/app.ts" }),
      tool("t3", "read", { filePath: "src/App.ts" }),
    ])
    const subs = computeActivitySubGroups(group)
    expect(countActivityTargets(subs[0]!.items, "linux")).toBe(3)
  })

  test("windows counting folds case aliases parsed from patch headers", () => {
    const upper = "*** Begin Patch\n*** Update File: SRC/APP.TS\n@@\n-old\n+new\n*** End Patch\n"
    const lower = "*** Begin Patch\n*** Update File: src\\app.ts\n@@\n-old\n+new\n*** End Patch\n"
    const group = groupOf([
      tool("t1", "apply_patch", { patchText: upper }),
      tool("t2", "apply_patch", { patchText: lower }),
    ])
    const subs = computeActivitySubGroups(group)
    expect(countActivityTargets(subs[0]!.items, "win32")).toBe(1)
    expect(countActivityTargets(subs[0]!.items, "linux")).toBe(2)
  })

  test("a patch with unparseable text falls back to one target per call", () => {
    const group = groupOf([tool("t1", "apply_patch", { patchText: "not a patch" })])
    const subs = computeActivitySubGroups(group)
    expect(countActivityTargets(subs[0]!.items)).toBe(1)
  })
})
