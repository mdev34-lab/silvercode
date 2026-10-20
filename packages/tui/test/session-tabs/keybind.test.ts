import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { CommandMap, Definitions } from "../../src/config/keybind"

describe("session tab shortcuts", () => {
  test("each tab command has a default shortcut and a registered command name", () => {
    const app = readFileSync(new URL("../../src/app.tsx", import.meta.url), "utf8")
    expect(Definitions.session_tab_next.default).toBe("ctrl+pagedown")
    expect(Definitions.session_tab_prev.default).toBe("ctrl+pageup")
    expect(Definitions.session_tab_close.default).toBe("<leader>w")
    expect(CommandMap.session_tab_next).toBe("session.tab.next")
    expect(CommandMap.session_tab_prev).toBe("session.tab.prev")
    expect(CommandMap.session_tab_close).toBe("session.tab.close")
    for (const name of ["session.tab.next", "session.tab.prev", "session.tab.close"]) {
      expect(app).toContain(`name: "${name}"`)
      // A handler alone is not enough: the command must be gathered into a binding list.
      const lists = app.match(/const app(?:Global)?BindingCommands = \[[\s\S]*?\] as const/g) ?? []
      expect(lists.some((list) => list.includes(`"${name}"`))).toBe(true)
    }
  })
})
