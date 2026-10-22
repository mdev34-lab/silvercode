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
    expect(activityKindOf("bash")).toBe("bash")
    expect(activityKindOf("write")).toBe("edit")
    expect(activityKindOf("edit")).toBe("edit")
    expect(activityKindOf("apply_patch")).toBe("edit")
    expect(activityKindOf("webfetch")).toBe("misc")
    expect(activityKindOf("skill")).toBe("misc")
  })
})

describe("typedActivityHeader", () => {
  test("explore counts distinct files, bash counts calls, edit counts distinct files", () => {
    const explore = groupOf([tool("a", "read", { filePath: "src/a.ts" }), tool("b", "read", { filePath: "src/a.ts" }), tool("c", "grep", { pattern: "x" })]).items
    expect(headerOf("explore", explore).main).toBe("Explored 2 files · 3s")
    const bash = groupOf([tool("a", "bash", { command: "ls" }), tool("b", "bash", { command: "ls" })]).items
    expect(headerOf("bash", bash).main).toBe("Ran 2 commands · 3s")
    const edit = groupOf([tool("a", "edit", { filePath: "src/a.ts" }), tool("b", "edit", { filePath: "src/a.ts" })]).items
    expect(headerOf("edit", edit).main).toBe("Edited 1 file · 3s")
  })

  test("working labels name the work in progress", () => {
    const explore = groupOf([tool("a", "read", { filePath: "src/a.ts" })]).items
    expect(headerOf("explore", explore, true).main).toBe("Exploring files... · 3s")
    const bash = groupOf([tool("a", "bash", { command: "ls" })]).items
    expect(headerOf("bash", bash, true).main).toBe("Running command... · 3s")
    const edit = groupOf([tool("a", "edit", { filePath: "src/a.ts" })]).items
    expect(headerOf("edit", edit, true).main).toBe("Editing files... · 3s")
  })

  test("misc keeps the original Working/Worked wording and counts calls", () => {
    const misc = groupOf([tool("a", "webfetch", { url: "https://x" }), tool("b", "webfetch", { url: "https://y" })]).items
    expect(headerOf("misc", misc).main).toBe("Worked for 3s · 2 tool calls")
    expect(headerOf("misc", misc, true).main).toBe("Working... 2 tool calls · 3s")
  })

  test("marker is + collapsed and − expanded, failed counts flag the block", () => {
    const items = groupOf([tool("a", "bash", { command: "ls" })]).items
    const failed = structuredClone(items)
    ;(failed[0]!.part.state as { status: string; error: string }).status = "error"
    ;(failed[0]!.part.state as { status: string; error: string }).error = "boom"
    const summary = summarizeActivity(failed.map((item) => item.part))
    const header = typedActivityHeader("bash", summary, 1, { expanded: true, duration: "3s" })
    expect(header.marker).toBe("−")
    expect(header.failed).toBe("1 failed")
    expect(typedActivityHeader("bash", summary, 1, { expanded: false, duration: "3s" }).marker).toBe("+")
  })
})

describe("computeActivitySubGroups", () => {
  test("merges interleaved kinds in first-appearance order", () => {
    const group = groupOf([
      tool("a", "read", { filePath: "src/a.ts" }),
      tool("b", "bash", { command: "ls" }),
      tool("c", "read", { filePath: "src/b.ts" }),
    ])
    const subs = computeActivitySubGroups(group)
    expect(subs.map((sub) => sub.kind)).toEqual(["explore", "bash"])
    expect(subs[0]!.items.map((item) => item.part.id)).toEqual(["a", "c"])
    expect(subs[0]!.id).toBe("act-1:explore")
    expect(subs[1]!.id).toBe("act-1:bash")
  })

  test("reasoning joins the block of the tool call that follows it", () => {
    const group = groupOf([reasoning("r1"), tool("a", "bash", { command: "ls" }), tool("b", "read", { filePath: "x" })])
    const subs = computeActivitySubGroups(group)
    expect(subs[0]!.kind).toBe("bash")
    expect(subs[0]!.parts.map((item) => item.part.id)).toEqual(["r1", "a"])
  })

  test("trailing reasoning joins the previous tool's block, not a misc block", () => {
    const group = groupOf([tool("a", "read", { filePath: "x" }), reasoning("r1")])
    const subs = computeActivitySubGroups(group)
    expect(subs.map((sub) => sub.kind)).toEqual(["explore"])
    expect(subs[0]!.parts.map((item) => item.part.id)).toEqual(["a", "r1"])
  })
})
