import { describe, expect, test } from "bun:test"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"

describe("ConfigPermissionV1.merge (rule-sequence semantics)", () => {
  test("a key written by the later layer takes the later layer's position", () => {
    const merged = ConfigPermissionV1.merge({ shell: "ask", "*": "allow" }, { shell: "deny" })
    expect(Object.keys(merged)).toEqual(["*", "shell"])
    expect(merged.shell).toBe("deny")
  })

  test("an inner pattern written by the later layer takes the later position", () => {
    const merged = ConfigPermissionV1.merge({ shell: { "rm *": "allow", "*": "allow" } }, { shell: { "rm *": "deny" } })
    expect(merged.shell).toEqual({ "*": "allow", "rm *": "deny" })
    expect(Object.keys(merged.shell as object)).toEqual(["*", "rm *"])
  })

  test("a flat action promotes to the * pattern instead of replacing inner patterns", () => {
    expect(ConfigPermissionV1.merge({ shell: "deny" }, { shell: { "git *": "allow" } }).shell).toEqual({
      "*": "deny",
      "git *": "allow",
    })
    expect(ConfigPermissionV1.merge({ shell: { "git *": "allow" } }, { shell: "deny" }).shell).toEqual({
      "git *": "allow",
      "*": "deny",
    })
  })

  test("distinct keys keep target-then-source sequence (no spelling is folded away)", () => {
    const merged = ConfigPermissionV1.merge({ bash: "deny" }, { shell: "allow" })
    expect(Object.keys(merged)).toEqual(["bash", "shell"])
  })

  test("a string layer is the * key", () => {
    expect(ConfigPermissionV1.merge("ask", { shell: "deny" })).toEqual({ "*": "ask", shell: "deny" })
    expect(ConfigPermissionV1.merge(undefined, undefined)).toEqual({})
    expect(ConfigPermissionV1.merge({ read: "allow" }, undefined)).toEqual({ read: "allow" })
  })
})
