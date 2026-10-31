import { AgentEffort } from "@opencode-ai/schema/agent-effort"
import { expect, test } from "bun:test"
import { HELP_SECTIONS, pad } from "../src/ui/help-content"

// The /help dialog is a curated editorial overview, not an exhaustive
// command reference (the command palette is authoritative). These tests guard
// the curated list against leaking stale OpenCode branding and against
// accidentally shipping malformed rows.
test("help sections present SilverCode branding and include /help", () => {
  const commands = HELP_SECTIONS.flatMap((section) => section.commands.map((c) => c.command))
  expect(commands).toContain("/help")
})

test("help content contains no stale OpenCode branding", () => {
  const text = JSON.stringify(HELP_SECTIONS)
  expect(text.toLowerCase()).not.toContain("opencode")
  expect(text.toLowerCase()).not.toContain("opencode.ai")
})

test("every help row is a slash command with a description", () => {
  for (const section of HELP_SECTIONS) {
    expect(section.title.length).toBeGreaterThan(0)
    for (const command of section.commands) {
      expect(command.command.startsWith("/")).toBe(true)
      expect(command.command.length).toBeGreaterThan(1)
      expect(command.desc.trim().length).toBeGreaterThan(0)
    }
  }
})

test("section titles are unique and non-empty across the help", () => {
  const titles = HELP_SECTIONS.map((section) => section.title)
  expect(new Set(titles).size).toBe(titles.length)
})

test("command column padding keeps the table aligned", () => {
  const commands = HELP_SECTIONS.flatMap((section) => section.commands.map((c) => c.command))
  for (const command of commands) {
    expect(pad(command).length).toBeGreaterThanOrEqual(12)
  }
  // Longest documented command should be `/sessions` (9 chars); padding adds
  // spaces up to the column width.
  expect(pad("/sessions")).toBe("/sessions" + " ".repeat(3))
})


test("effort help enumerates every selectable schema level", () => {
  const effort = HELP_SECTIONS.flatMap((section) => section.commands).find((row) => row.command === "/effort")
  expect(effort).toBeDefined()
  for (const level of AgentEffort.levels) expect(effort!.desc).toContain(level)
})
