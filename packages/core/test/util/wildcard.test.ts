import { describe, expect, test } from "bun:test"
import { Wildcard } from "@opencode-ai/core/util/wildcard"

describe("Wildcard.matchAction across the bash -> shell rename", () => {
  test("matches the exact current and legacy names", () => {
    expect(Wildcard.matchAction("shell", "shell")).toBe(true)
    expect(Wildcard.matchAction("shell", "bash")).toBe(true)
    expect(Wildcard.matchAction("bash", "shell")).toBe(true)
    expect(Wildcard.matchAction("bash", "bash")).toBe(true)
  })

  test("legacy wildcard patterns keep matching the renamed tool", () => {
    expect(Wildcard.matchAction("shell", "*")).toBe(true)
    expect(Wildcard.matchAction("shell", "ba*")).toBe(true)
    expect(Wildcard.matchAction("shell", "b*")).toBe(true)
    expect(Wildcard.matchAction("shell", "bas?")).toBe(true)
  })

  // #780 finding: a wildcard written when the tool was called `bash` keeps the
  // extension it had then. `s*` covered `skill`, not the shell tool, so it must
  // not silently recruit the renamed tool and bypass an explicit legacy deny.
  test("wildcard patterns keep their pre-rename extension (s* does not recruit shell)", () => {
    expect(Wildcard.matchAction("shell", "s*")).toBe(false)
    expect(Wildcard.matchAction("shell", "sh*")).toBe(false)
    expect(Wildcard.matchAction("shell", "shell*")).toBe(false)
    expect(Wildcard.matchAction("bash", "s*")).toBe(false)
    // `s*` still matches the tools it always matched.
    expect(Wildcard.matchAction("skill", "s*")).toBe(true)
  })

  test("non-renamed actions are matched plainly", () => {
    expect(Wildcard.matchAction("read", "r*")).toBe(true)
    expect(Wildcard.matchAction("read", "read")).toBe(true)
    expect(Wildcard.matchAction("read", "edit")).toBe(false)
    expect(Wildcard.matchAction("edit", "shell")).toBe(false)
    expect(Wildcard.matchAction("edit", "bash")).toBe(false)
  })
})
