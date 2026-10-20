import { expect, test } from "bun:test"
import { logo } from "@opencode-ai/tui/logo"
import { UI } from "../../src/cli/ui"

// The shared art keeps a blank bottom row (room for descenders, which this
// wordmark does not use). Both renderers drop trailing blank rows so captured
// help/log output never ends in empty lines; compare only the inked rows.
const inked = logo.left.map((_, index) => index).filter((index) => index <= lastInkedRow())
function lastInkedRow() {
  let last = -1
  for (const [index, row] of logo.left.entries()) {
    if (row.trim() !== "" || (logo.right[index] ?? "").trim() !== "") last = index
  }
  return last
}

test("plain wordmark is derived from the shared logo art", () => {
  // A CRLF checkout can smuggle \r into either side; compare row by row with
  // the exact wordmark transform instead of absolute widths.
  const clean = (value: string) => value.replaceAll("\r", "")
  const rows = clean(UI.logo()).split("\n")
  expect(rows).toHaveLength(inked.length)
  for (const [index, row] of rows.entries()) {
    const expected = clean(logo.left[index] + " " + (logo.right[index] ?? ""))
      .replaceAll("^", "▀")
      .replaceAll(/[_~,]/g, " ")
    // The plain renderer drops the rectangular template's trailing blanks, so
    // captured help/log output never carries trailing whitespace.
    expect(row).toBe(expected.trimEnd())
  }
})

test("plain wordmark has no trailing whitespace", () => {
  expect(UI.logo()).not.toMatch(/[ \t]+$/m)
})

test("plain wordmark expands every shadow mark", () => {
  expect(UI.logo()).not.toMatch(/[_^~,\u2800]/)
})

test("plain wordmark honours the pad", () => {
  expect(
    UI.logo("  ")
      .split("\n")
      .every((row) => row.startsWith("  ")),
  ).toBe(true)
})

test("colored wordmark keeps the highlighted half on one column", () => {
  // The colored renderer pads the muted half so the highlighted half lines up
  // on every row; trimming the left half (rather than only line ends) would
  // slide `code` left on the rows that end in blanks.
  const plain = (row: string) => row.replaceAll("^", "▀").replaceAll(/[_~,]/g, " ")
  const stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
  try {
    const rows = UI.logo().split(/\r?\n/)
    expect(rows).toHaveLength(inked.length)
    for (const [index, row] of rows.entries()) {
      const left = plain(logo.left[index]!)
      const visible = row.replace(/\x1b\[[0-9;]*m/g, "")
      expect(visible.startsWith(left + " ")).toBe(true)
      expect(visible.slice(left.length + 1)).toBe(plain(logo.right[index]!).trimEnd())
    }
  } finally {
    if (stdout) Object.defineProperty(process.stdout, "isTTY", stdout)
    else delete (process.stdout as { isTTY?: boolean }).isTTY
  }
})
