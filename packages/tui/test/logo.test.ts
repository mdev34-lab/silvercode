import { expect, test } from "bun:test"
import { badge, go, logo } from "../src/logo"

// "," is only expanded by tui/component/logo.tsx, so the shared art must not use it.
const alphabet = new Set([" ", "▀", "▄", "█", "_", "^", "~"])

// The wordmark templates carry a blank bottom row (room for descenders, which
// silvercode does not use); the go mark has four rows.
const templates = {
  "logo.left": { rows: logo.left, count: 5 },
  "logo.right": { rows: logo.right, count: 5 },
  "go.left": { rows: go.left, count: 4 },
  "go.right": { rows: go.right, count: 4 },
  badge: { rows: badge, count: 5 },
}

for (const [name, { rows, count }] of Object.entries(templates)) {
  test(`${name} is a rectangular ${count} row template`, () => {
    expect(rows).toHaveLength(count)
    expect(new Set(rows.map((row) => row.length)).size).toBe(1)
  })

  test(`${name} only uses universally supported glyphs`, () => {
    expect(rows.flatMap((row) => Array.from(row)).filter((char) => !alphabet.has(char))).toEqual([])
  })
}

test("badge is the leading glyph of the wordmark", () => {
  expect(badge).toEqual(logo.left.map((row) => row.slice(0, 4)))
})

// Half-cell bitmap of the wordmark: two rows of pixels per template row, so
// ascender and baseline alignment can be asserted directly.
const pixels = logo.left
  .map((row, index) => row + " " + (logo.right[index] ?? ""))
  .flatMap((row) => {
    const top = Array.from(row).map((char) => "█▀^".includes(char))
    const bottom = Array.from(row).map((char) => "█▄".includes(char))
    return [top, bottom]
  })

const inkRows = (start: number, width: number) =>
  pixels.flatMap((row, index) => (row.slice(start, start + width).some(Boolean) ? [index] : []))

// Left half is "silver" (muted); the right half starts one column after it.
// Glyphs are {start, width}: "i" and "l" are a single column, the rest four.
const LEFT_SPANS = [
  [0, 4],
  [5, 1],
  [7, 1],
  [9, 4],
  [14, 4],
  [19, 4],
] as const
const RIGHT_SPANS = [
  [0, 4],
  [5, 4],
  [10, 4],
  [15, 4],
] as const
const RIGHT_OFFSET = logo.left[0]!.length + 1

test("every glyph spans the same half-cell rows 1-7 and nothing is drawn outside them", () => {
  // Pixel row 0 and the descender rows (8-9) stay empty: this wordmark has no
  // ascender above the body and no descenders. Row 1 is the top line (including
  // the "i" dot), row 7 is the shared baseline.
  const spans = [
    ...LEFT_SPANS.map(([start, width]) => [start, width]),
    ...RIGHT_SPANS.map(([start, width]) => [start + RIGHT_OFFSET, width]),
  ]
  for (const [start, width] of spans) {
    const rows = inkRows(start!, width!)
    expect(Math.min(...rows)).toBe(1)
    expect(Math.max(...rows)).toBe(7)
  }
  expect(pixels[0]!.some(Boolean)).toBe(false)
  expect(pixels.slice(8).some((row) => row.some(Boolean))).toBe(false)
})

test("wordmark renders silvercode with an even baseline", () => {
  expect(pixels.map((row) => row.map((on) => (on ? "#" : ".")).join("")).join("\n")).toMatchSnapshot()
})

// Independent expectation of the glyphs: the wordmark must actually spell
// "silver" (muted half) + "code" (highlighted half). Each entry is the glyph on
// the half-cell grid, pixel rows 1-7 (row 1 the top line, row 7 the baseline):
// "#" ink, "s" shadow counter, "." empty. These were checked against the
// rendered pixels (see the snapshot). If the art drifts to a different word
// these comparisons fail, unlike a snapshot taken from the art itself.
const EXPECTED_GLYPHS: Record<string, string[]> = {
  s: [".###", "#...", "#...", ".##.", "...#", "...#", "###."],
  i: ["#", ".", "#", "#", "#", "#", "#"],
  l: ["#", "#", "#", "#", "#", "#", "#"],
  v: ["#..#", "#..#", "#..#", "#..#", "#..#", ".#.#", "..#."],
  e: [".##.", "#..#", "#..#", "####", "#...", "#...", ".###"],
  r: ["###.", "#..#", "#...", "#...", "#...", "#...", "#..."],
  c: [".###", "#sss", "#sss", "#...", "#...", "#...", ".###"],
  o: [".##.", "#ss#", "#ss#", "#..#", "#..#", "#..#", ".##."],
  d: ["...#", "...#", ".###", "#ss#", "#ss#", "#..#", ".###"],
  E: [".##.", "#ss#", "#ss#", "####", "#...", "#...", ".###"],
}

const cellPixels = (char: string): [string, string] => {
  if (char === "█") return ["#", "#"]
  if (char === "▀") return ["#", "."]
  if (char === "▄") return [".", "#"]
  if (char === "_") return ["s", "s"]
  if (char === "^") return ["#", "s"]
  if (char === "~") return ["s", "."]
  return [".", "."]
}

// Pixel rows 0-7 for each template row pair, i.e. the half-cell grid.
const cellRows = (row: string) =>
  row.split("").reduce<[string[], string[]]>(
    ([top, bottom], char) => {
      const [upper, lower] = cellPixels(char)
      top.push(upper)
      bottom.push(lower)
      return [top, bottom]
    },
    [[], []],
  )

const pixelRows = (part: string[]) =>
  part.flatMap((row) => {
    const [top, bottom] = cellRows(row)
    return [top, bottom]
  })

const glyphPixels = (part: string[], start: number, width: number) =>
  pixelRows(part).map((row) => row.slice(start, start + width).join(""))

test("wordmark spells silver plus code, glyph by glyph", () => {
  const word = "silvercode"
  const left = word.slice(0, 6)
  const right = word.slice(6)
  expect(left).toBe("silver")
  expect(right).toBe("code")
  for (const [index, letter] of Array.from(left).entries()) {
    const [start, width] = LEFT_SPANS[index]!
    // Pixel rows 1-7 are the letter body; row 0 is never drawn.
    expect(glyphPixels(logo.left, start, width).slice(1, 8)).toEqual(EXPECTED_GLYPHS[letter])
  }
  for (const [index, letter] of Array.from(right).entries()) {
    const [start, width] = RIGHT_SPANS[index]!
    // The final "e" of the highlighted half is drawn with a shadow counter.
    const expected = index === 3 ? EXPECTED_GLYPHS.E : EXPECTED_GLYPHS[letter]
    expect(glyphPixels(logo.right, start, width).slice(1, 8)).toEqual(expected)
  }
})
