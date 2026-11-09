import { describe, expect, test } from "bun:test"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"

describe("ConfigPermissionV1.orderShellRename (#780)", () => {
  test("a spelling written by the later layer moves after its sibling spelling", () => {
    // mergeDeep output for global {shell: ask} + project {bash: allow} +
    // local {shell: deny}: shell keeps the global position, before bash.
    const merged = { shell: "deny", bash: "allow" } as const
    const ordered = ConfigPermissionV1.orderShellRename(merged, { shell: "deny" })
    expect(Object.keys(ordered)).toEqual(["bash", "shell"])
    expect(ordered.shell).toBe("deny")
    expect(ordered.bash).toBe("allow")
  })

  test("both spellings written by the later layer keep the later layer's relative order", () => {
    const merged = { shell: "deny", bash: "allow" } as const
    const ordered = ConfigPermissionV1.orderShellRename(merged, { bash: "allow", shell: "deny" })
    expect(Object.keys(ordered)).toEqual(["bash", "shell"])
  })

  test("keys unrelated to the rename are never repositioned", () => {
    // Base deep-merge keeps "*" at its first-written position; re-writing it
    // in a later layer must not move it past "src/**".
    const merged = { edit: "allow", "*": "allow", "src/**": "deny" } as const
    const ordered = ConfigPermissionV1.orderShellRename(merged, { "*": "allow", edit: "deny" })
    expect(Object.keys(ordered)).toEqual(["edit", "*", "src/**"])
    expect(ordered).toBe(merged)
  })

  test("spellings permute within their own slots and never cross other keys", () => {
    const merged = { read: "allow", shell: "deny", "*": "allow", bash: "ask", edit: "ask" } as const
    const ordered = ConfigPermissionV1.orderShellRename(merged, { shell: "deny" })
    // shell swaps with bash in place; "*", read, and edit do not move, so a
    // spelling can never jump a wildcard or an unrelated key.
    expect(Object.keys(ordered)).toEqual(["read", "bash", "*", "shell", "edit"])
  })

  test("a single layer's written order is preserved exactly", () => {
    const single = { bash: "allow", "*": "deny", edit: "ask" } as const
    expect(ConfigPermissionV1.orderShellRename(single, single)).toBe(single)
    const both = { bash: "ask", "*": "allow", shell: "deny" } as const
    expect(ConfigPermissionV1.orderShellRename(both, both)).toBe(both)
  })

  test("a later layer that writes neither spelling leaves the object untouched", () => {
    const merged = { bash: "deny", shell: "allow" } as const
    expect(ConfigPermissionV1.orderShellRename(merged, { read: "allow" })).toBe(merged)
    expect(ConfigPermissionV1.orderShellRename(merged, "deny")).toBe(merged)
    expect(ConfigPermissionV1.orderShellRename(merged, undefined)).toBe(merged)
    expect(ConfigPermissionV1.orderShellRename(merged, { shell: undefined })).toBe(merged)
  })

  test("clearDerivedShellRename only clears spellings the explicit layer writes", () => {
    const derived: Record<string, unknown> = { shell: "allow", edit: "allow" }
    ConfigPermissionV1.clearDerivedShellRename(derived, { "*": "allow", shell: "deny" })
    expect(derived).toEqual({ edit: "allow" })
    const untouched: Record<string, unknown> = { shell: "deny" }
    ConfigPermissionV1.clearDerivedShellRename(untouched, { bash: "allow" })
    expect(untouched).toEqual({ shell: "deny" })
    ConfigPermissionV1.clearDerivedShellRename(untouched, "deny")
    expect(untouched).toEqual({ shell: "deny" })
  })

  test("values and inner pattern records pass through by reference", () => {
    const patterns = { "rm *": "deny", "*": "allow" } as const
    const merged = { shell: patterns, bash: "allow" } as const
    const ordered = ConfigPermissionV1.orderShellRename(merged, { shell: { "rm *": "deny" } })
    expect(Object.keys(ordered)).toEqual(["bash", "shell"])
    expect(ordered.shell).toBe(patterns)
  })

  test("an empty rule map is not an actual write and never reorders the rename pair", () => {
    const merged = { shell: { "*": "allow" }, bash: { "rm *": "deny" } } as const
    expect(ConfigPermissionV1.orderShellRename(merged, { shell: {} })).toBe(merged)
    expect(ConfigPermissionV1.orderShellRename(merged, { bash: {} })).toBe(merged)
    expect(Object.keys(merged)).toEqual(["shell", "bash"])
  })

  test("clearDerivedShellRename keeps a tools-derived deny when the explicit rule map is empty", () => {
    const derived: Record<string, unknown> = { shell: "deny", edit: "allow" }
    ConfigPermissionV1.clearDerivedShellRename(derived, { shell: {}, bash: {} })
    expect(derived).toEqual({ shell: "deny", edit: "allow" })
  })

  test("stripEmptyShellRules drops only empty rename pattern maps", () => {
    const patterns = { "rm *": "deny" } as const
    const permission = { shell: {}, bash: patterns, edit: "allow", task: {} } as const
    const stripped = ConfigPermissionV1.stripEmptyShellRules(permission) as Record<string, unknown>
    expect(stripped).toEqual({ bash: patterns, edit: "allow", task: {} })
    expect(stripped.bash).toBe(patterns)
    expect(ConfigPermissionV1.stripEmptyShellRules(permission)).not.toBe(permission)
    const actual = { shell: "deny", bash: patterns } as const
    expect(ConfigPermissionV1.stripEmptyShellRules(actual)).toBe(actual)
    expect(ConfigPermissionV1.stripEmptyShellRules("deny")).toBe("deny")
    expect(ConfigPermissionV1.stripEmptyShellRules(undefined)).toBe(undefined)
  })
})
