import { describe, expect, test } from "bun:test"
import { Wildcard } from "@opencode-ai/core/util/wildcard"

describe("Wildcard.matchAction across the bash -> shell rename", () => {
  test("matches a pattern against either spelling of the tool name (union)", () => {
    expect(Wildcard.matchAction("shell", "shell")).toBe(true)
    expect(Wildcard.matchAction("shell", "bash")).toBe(true)
    expect(Wildcard.matchAction("bash", "shell")).toBe(true)
    expect(Wildcard.matchAction("bash", "bash")).toBe(true)
    expect(Wildcard.matchAction("shell", "*")).toBe(true)
    expect(Wildcard.matchAction("shell", "ba*")).toBe(true)
    expect(Wildcard.matchAction("shell", "bas?")).toBe(true)
    // Canonical wildcard patterns name the tool under its current name too.
    expect(Wildcard.matchAction("shell", "s*")).toBe(true)
    expect(Wildcard.matchAction("shell", "sh*")).toBe(true)
    expect(Wildcard.matchAction("skill", "s*")).toBe(true)
    expect(Wildcard.matchAction("read", "edit")).toBe(false)
    expect(Wildcard.matchAction("edit", "shell")).toBe(false)
    expect(Wildcard.matchAction("edit", "bash")).toBe(false)
  })

  test("recruitedByRename flags only wildcard matches that exist because of the new name", () => {
    expect(Wildcard.recruitedByRename("shell", "s*")).toBe(true)
    expect(Wildcard.recruitedByRename("shell", "sh*")).toBe(true)
    expect(Wildcard.recruitedByRename("shell", "*hell")).toBe(true)
    // Exact spellings name the tool in either era — never recruited.
    expect(Wildcard.recruitedByRename("shell", "shell")).toBe(false)
    expect(Wildcard.recruitedByRename("shell", "bash")).toBe(false)
    // Wildcards that already matched the legacy name are not recruited.
    expect(Wildcard.recruitedByRename("shell", "*")).toBe(false)
    expect(Wildcard.recruitedByRename("shell", "ba*")).toBe(false)
    expect(Wildcard.recruitedByRename("skill", "s*")).toBe(false)
    expect(Wildcard.recruitedByRename("read", "r*")).toBe(false)
  })

  test("matchesLegacyName is plain pre-rename matching", () => {
    expect(Wildcard.matchesLegacyName("shell", "bash")).toBe(true)
    expect(Wildcard.matchesLegacyName("shell", "ba*")).toBe(true)
    expect(Wildcard.matchesLegacyName("shell", "*")).toBe(true)
    expect(Wildcard.matchesLegacyName("shell", "shell")).toBe(false)
    expect(Wildcard.matchesLegacyName("shell", "s*")).toBe(false)
    expect(Wildcard.matchesLegacyName("read", "r*")).toBe(false)
  })

  test("winningRule lets canonical wildcards work but never past a legacy deny", () => {
    type Rule = { pattern: string; effect: "allow" | "ask" | "deny" }
    const win = (rules: Rule[]) =>
      Wildcard.winningRule(
        rules,
        "shell",
        (rule) => rule.pattern,
        () => true,
        (rule) => rule.effect === "deny",
      )?.effect
    // Canonical carve-outs work, including over a * default.
    expect(win([{ pattern: "s*", effect: "allow" }])).toBe("allow")
    expect(
      win([
        { pattern: "*", effect: "ask" },
        { pattern: "s*", effect: "allow" },
      ]),
    ).toBe("allow")
    // A recruited wildcard cannot lift a legacy-visible deny (allow or ask).
    expect(
      win([
        { pattern: "bash", effect: "deny" },
        { pattern: "s*", effect: "allow" },
      ]),
    ).toBe("deny")
    expect(
      win([
        { pattern: "bash", effect: "deny" },
        { pattern: "s*", effect: "ask" },
      ]),
    ).toBe("deny")
    expect(
      win([
        { pattern: "ba*", effect: "deny" },
        { pattern: "s*", effect: "allow" },
      ]),
    ).toBe("deny")
    // An exact new-name rule is first-class: explicit re-permits win by order.
    expect(
      win([
        { pattern: "bash", effect: "deny" },
        { pattern: "shell", effect: "allow" },
      ]),
    ).toBe("allow")
    // Only deny is clamped: a legacy ask may be overridden by a canonical allow.
    expect(
      win([
        { pattern: "bash", effect: "ask" },
        { pattern: "s*", effect: "allow" },
      ]),
    ).toBe("allow")
    // Narrowing is never clamped.
    expect(
      win([
        { pattern: "bash", effect: "allow" },
        { pattern: "s*", effect: "deny" },
      ]),
    ).toBe("deny")
  })
})
