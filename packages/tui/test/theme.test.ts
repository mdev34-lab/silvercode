import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { TextAttributes, type TerminalColors } from "@opentui/core"
import { DEFAULT_THEMES, addTheme, allThemes, hasTheme, resolveTheme, terminalMode, textAttributes } from "../src/theme"
import { discoverThemes } from "../src/context/theme"
import { tmpdir } from "./fixture/fixture"

test("addTheme writes into module theme store", () => {
  const name = `plugin-theme-${Date.now()}`
  expect(addTheme(name, DEFAULT_THEMES.opencode)).toBe(true)
  expect(allThemes()[name]).toBeDefined()
})

test("addTheme keeps first theme for duplicate names", () => {
  const name = `plugin-theme-keep-${Date.now()}`
  const one = structuredClone(DEFAULT_THEMES.opencode)
  const two = structuredClone(DEFAULT_THEMES.opencode)
  one.theme.primary = "#101010"
  two.theme.primary = "#fefefe"

  expect(addTheme(name, one)).toBe(true)
  expect(addTheme(name, two)).toBe(false)
  expect(allThemes()[name]!.theme.primary).toBe("#101010")
})

test("addTheme ignores entries without a theme object", () => {
  const name = `plugin-theme-invalid-${Date.now()}`
  expect(addTheme(name, { defs: { a: "#ffffff" } })).toBe(false)
  expect(allThemes()[name]).toBeUndefined()
})

test("hasTheme checks theme presence", () => {
  const name = `plugin-theme-has-${Date.now()}`
  expect(hasTheme(name)).toBe(false)
  expect(addTheme(name, DEFAULT_THEMES.opencode)).toBe(true)
  expect(hasTheme(name)).toBe(true)
})

// #241: reasoning label colours/styles are theme keys with a backward-compatible default.
test("resolveTheme defaults the thinking labels to warning with no text style", () => {
  for (const name of ["opencode", "github", "gruvbox"]) {
    const theme = resolveTheme(DEFAULT_THEMES[name]!, "dark")
    expect(theme.thinkingStreaming).toEqual(theme.warning)
    expect(theme.thinkingCompleted).toEqual(theme.warning)
    expect(theme.thinkingStreamingStyle).toEqual({})
    expect(theme.thinkingCompletedStyle).toEqual({})
    expect(theme.thinkingOpacity).toBe(0.6)
  }
})

test("resolveTheme reads thinking colours as hex, defs refs or theme refs, and styles as objects", () => {
  const item = structuredClone(DEFAULT_THEMES.opencode!)
  item.defs = { ...item.defs, mint: "#00ff99" }
  item.theme.thinkingStreaming = "mint"
  item.theme.thinkingStreamingStyle = { italic: true, dim: true }
  item.theme.thinkingCompleted = "primary"
  item.theme.thinkingCompletedStyle = { bold: true }
  const theme = resolveTheme(item, "dark")
  expect(theme.thinkingStreaming.toInts().slice(0, 3)).toEqual([0, 255, 153])
  expect(theme.thinkingCompleted).toEqual(theme.primary)
  expect(theme.thinkingStreamingStyle).toEqual({ italic: true, dim: true })
  expect(theme.thinkingCompletedStyle).toEqual({ bold: true })
  // Every other key is still a colour: the style objects never reach the colour loop.
  const plain = new Set([
    "thinkingStreamingStyle",
    "thinkingCompletedStyle",
    "thinkingOpacity",
    "_hasSelectedListItemText",
  ])
  for (const [key, value] of Object.entries(theme)) {
    if (plain.has(key)) continue
    expect(typeof (value as { toInts?: unknown }).toInts).toBe("function")
  }
})

test("textAttributes maps a theme text style onto renderer attribute bits", () => {
  expect(textAttributes(undefined)).toBe(TextAttributes.NONE)
  expect(textAttributes({})).toBe(TextAttributes.NONE)
  expect(textAttributes({ bold: true })).toBe(TextAttributes.BOLD)
  expect(textAttributes({ italic: true, underline: true })).toBe(TextAttributes.ITALIC | TextAttributes.UNDERLINE)
  expect(textAttributes({ dim: true, bold: false })).toBe(TextAttributes.DIM)
})

test("resolveTheme rejects circular color refs", () => {
  const item = structuredClone(DEFAULT_THEMES.opencode)
  item.defs = { ...item.defs, one: "two", two: "one" }
  item.theme.primary = "one"
  expect(() => resolveTheme(item, "dark")).toThrow("Circular color reference")
})

function terminalColors(defaultBackground: string | null, palette: Array<string | null> = []): TerminalColors {
  return {
    palette,
    defaultForeground: null,
    defaultBackground,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
}

test("terminalMode derives mode from refreshed background", () => {
  expect(terminalMode(terminalColors("#fbf1c7"))).toBe("light")
  expect(terminalMode(terminalColors("#1a1b26"))).toBe("dark")
})

test("terminalMode does not derive mode from ANSI slot zero", () => {
  expect(terminalMode(terminalColors(null, ["#000000"]))).toBeUndefined()
})

test("custom theme precedence follows directory order", async () => {
  await using tmp = await tmpdir()
  const global = path.join(tmp.path, "global")
  const project = path.join(tmp.path, "project")
  await mkdir(path.join(global, "themes"), { recursive: true })
  await mkdir(path.join(project, "themes"), { recursive: true })
  await writeFile(path.join(global, "themes", "custom.json"), JSON.stringify({ source: "global" }))
  await writeFile(path.join(project, "themes", "custom.json"), JSON.stringify({ source: "project" }))

  await expect(discoverThemes([global, project])).resolves.toEqual({ custom: { source: "project" } })
})
