/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { Part, ReasoningPart, ToolPart } from "@opencode-ai/sdk/v2"
import {
  assistantMessage,
  BASE,
  disposeSessionRoutes,
  frameOf,
  mountSessionRoute,
  sessionInfo,
  settle,
  textPart,
  userMessage,
  waitFor,
  type MountOptions,
} from "../../fixture/session-route"
import { captureSpans } from "../../fixture/frame"

// Activity block spacing contract, as corrected: one blank terminal row
// BETWEEN activity blocks and nowhere else. A block header is joined to the
// block's own detail rows — the first detail row follows its header with no
// blank row between them (a tool panel's own padding and gap rows belong to the
// panel, they are not a separator) — and every detail line shares one compact
// two-column inner indent under the header. Rows outside a block (a lone tool
// call, a non-work call, assistant text) keep the transcript's own spacing.
//
// These tests mount the real `<Session />` route and read the rendered
// character frame, so they measure the rows a user sees rather than the props
// that produced them. Rendered file paths use the platform separator
// (`usePathFormatter` -> `path.relative`), so every needle that names a file is
// built with `path.sep`; a hard-coded "/" only passes on POSIX.
//
// Set ACTIVITY_CAPTURE_DIR to also write the frames (`<name>.txt`) and their
// OpenTUI spans (`<name>.json`, one colour per cell) for the pixel evidence.

afterEach(disposeSessionRoutes)

const SIZES = {
  normal: { width: 140, height: 40 },
  narrow: { width: 80, height: 24 },
} as const

const SESSION = "ses_padding"
const at = (offset: number) => BASE + offset * 1000

// The path the app renders for `src/app.py`, in the platform's own spelling.
const SRC_APP = `src${path.sep}app.py`
const READ_ROW = `Read ${SRC_APP}`
const EDIT_ROW = `Edit ${SRC_APP}`
const READ_ROW_INPUT = `${READ_ROW} [limit=70, offset=465]`
// The same rows as they start on screen, marker included, for column checks.
const READ_ROW_CELL = `→ ${READ_ROW_INPUT}`
const EDIT_ROW_CELL = `← ${EDIT_ROW}`

// The proposal's example run: one command with a panel of output, one read,
// one edit, and the reasoning that planned the command.
const COMMAND_OUTPUT = [
  "28:class App:",
  "29:    def __init__(self, name):",
  "30:        self.name = name",
  "31:        self.items = []",
  "32:        self.ready = False",
].join("\n")

function reasoningPart(messageID: string, id: string, text: string, start: number, end?: number): ReasoningPart {
  return {
    id,
    sessionID: SESSION,
    messageID,
    type: "reasoning",
    text,
    time: { start, ...(end === undefined ? {} : { end }) },
  }
}

function toolPart(
  id: string,
  messageID: string,
  tool: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
  start: number,
  end: number,
): ToolPart {
  return {
    id,
    sessionID: SESSION,
    messageID,
    type: "tool",
    callID: id,
    tool,
    state: { status: "completed", input, output: "", title: "", metadata, time: { start, end } },
  }
}

function proposalRun() {
  const work = assistantMessage("msg_01_work", SESSION, { time: { created: at(1), completed: at(12) } })
  const closing = assistantMessage("msg_02_closing", SESSION, { time: { created: at(13), completed: at(22) } })
  return {
    work,
    closing,
    reasoning: reasoningPart(
      work.id,
      "prt_reason_plan",
      "**Planning the edit**\n\nThe App class owns the state.",
      at(1),
      at(2.2),
    ),
    bash: toolPart(
      "prt_bash",
      work.id,
      "bash",
      { command: 'rg -n "class App" src/app.py' },
      { output: COMMAND_OUTPUT },
      at(2.2),
      at(3.4),
    ),
    read: toolPart(
      "prt_read",
      work.id,
      "read",
      { filePath: "src/app.py", limit: 70, offset: 465 },
      {},
      at(3.4),
      at(11.5),
    ),
    edit: toolPart(
      "prt_edit",
      work.id,
      "edit",
      { filePath: "src/app.py", oldString: "ready = False", newString: "ready = True" },
      {},
      at(11.5),
      at(11.52),
    ),
    note: textPart("prt_note", closing, "Now verify the edit."),
    trailing: reasoningPart(
      closing.id,
      "prt_reason_verify",
      "**Verifying the edit**\n\nThe edit is consistent.",
      at(20),
      at(21.6),
    ),
  }
}

function mountProposal(size: keyof typeof SIZES, options: Partial<MountOptions> = {}) {
  const session = sessionInfo(SESSION, { title: "Fix the App class" })
  const user = userMessage("msg_00_user", SESSION)
  const run = proposalRun()
  const messages: NonNullable<MountOptions["messages"]> = {
    [SESSION]: [
      { info: user, parts: [textPart("prt_user", user, "Fix the App class")] },
      { info: run.work, parts: [run.reasoning, run.bash, run.read, run.edit] },
      { info: run.closing, parts: [run.note, run.trailing] },
    ],
  }
  return mountSessionRoute({ ...SIZES[size], sessions: [session], messages, ...options })
}

// Read-then-edit: two blocks whose last detail row is a single line, which is
// the case where a stray row above the detail would push the header away from
// its own call, and a missing row below would glue that call to the next header.
function mountReadThenEdit(size: keyof typeof SIZES, filePath = "src/app.py") {
  const session = sessionInfo(SESSION, { title: "Fix the App class" })
  const user = userMessage("msg_00_user", SESSION)
  const work = assistantMessage("msg_01_work", SESSION, { time: { created: at(1), completed: at(6) } })
  const parts: Part[] = [
    toolPart("prt_read", work.id, "read", { filePath, limit: 70, offset: 465 }, {}, at(1), at(2)),
    toolPart(
      "prt_edit",
      work.id,
      "edit",
      { filePath: "src/app.py", oldString: "ready = False", newString: "ready = True" },
      {},
      at(2),
      at(2.02),
    ),
  ]
  const messages: NonNullable<MountOptions["messages"]> = {
    [SESSION]: [
      { info: user, parts: [textPart("prt_user", user, "Fix the App class")] },
      { info: work, parts },
    ],
  }
  return mountSessionRoute({
    ...SIZES[size],
    sessions: [session],
    messages,
    kv: { activity_groups_expanded: true },
  })
}

// Two command panels in one block: with two or more calls the run becomes an
// activity block, and the panels are that block's detail rows.
function mountTwoPanels() {
  const session = sessionInfo(SESSION, { title: "Fix the App class" })
  const user = userMessage("msg_00_user", SESSION)
  const work = assistantMessage("msg_01_work", SESSION, { time: { created: at(1), completed: at(6) } })
  const parts: Part[] = [
    toolPart(
      "prt_bash_1",
      work.id,
      "bash",
      { command: 'rg -n "class App" src' },
      { output: "12:class App:" },
      at(1),
      at(2),
    ),
    toolPart("prt_bash_2", work.id, "bash", { command: "ls -la src" }, { output: "widget.py" }, at(2), at(3)),
    toolPart("prt_read", work.id, "read", { filePath: "src/app.py" }, {}, at(3), at(4)),
  ]
  const messages: NonNullable<MountOptions["messages"]> = {
    [SESSION]: [
      { info: user, parts: [textPart("prt_user", user, "Fix the App class")] },
      { info: work, parts },
    ],
  }
  return mountSessionRoute({
    ...SIZES.normal,
    sessions: [session],
    messages,
    kv: { activity_groups_expanded: true },
  })
}

// Tools the transcript renders outside any activity block: a single call is not
// a run, and a non-work call ends the run it lands in. Their rows must keep the
// spacing the transcript draws for itself.
function mountOutsideBlock() {
  const session = sessionInfo(SESSION, { title: "Sequencing the parser" })
  const user = userMessage("msg_00_user", SESSION)
  const work = assistantMessage("msg_01_work", SESSION, { time: { created: at(1), completed: at(6) } })
  const closing = assistantMessage("msg_02_closing", SESSION, { time: { created: at(6), completed: at(7) } })
  const single = assistantMessage("msg_03_single", SESSION, { time: { created: at(8), completed: at(9) } })
  const messages: NonNullable<MountOptions["messages"]> = {
    [SESSION]: [
      { info: user, parts: [textPart("prt_user", user, "Please fix the parser")] },
      {
        info: work,
        parts: [
          toolPart("prt_read_a", work.id, "read", { filePath: "src/app.py", limit: 70, offset: 465 }, {}, at(1), at(2)),
          toolPart("prt_read_b", work.id, "read", { filePath: "src/b.py", limit: 70, offset: 1 }, {}, at(2), at(3)),
          toolPart(
            "prt_todo",
            work.id,
            "todowrite",
            { todos: [{ content: "Fix it", status: "pending", priority: "high", id: "1" }] },
            {},
            at(3),
            at(4),
          ),
        ],
      },
      { info: closing, parts: [textPart("prt_after_todo", closing, "After the todos.")] },
      {
        info: single,
        parts: [
          toolPart("prt_bash", single.id, "bash", { command: "ls -la src" }, { output: "widget.py" }, at(8), at(9)),
          textPart("prt_after_bash", single, "After the command."),
        ],
      },
    ],
  }
  return mountSessionRoute({ ...SIZES.normal, sessions: [session], messages, kv: { activity_groups_expanded: true } })
}

// A tool panel keeps its left border and background across its padding rows,
// so a padding row carries border glyphs and no text. Dropping those glyphs is
// what makes "blank row" mean "one empty terminal row", whether the blank is
// the block's own margin or the panel's padding.
const PANEL_EDGE = /[┃│┏┓┗┛┡┩└┘┌┐├┤]/g

// A row that holds nothing but panel border glyphs: the panel's own padding or
// gap row. It belongs to the panel, so it is not a separator between rows.
const PANEL_OWNED_ROW = /^[┃│]+$/

// Column of the first cell of `needle` on its row. Needles include the row's
// marker (`−`, `→`, `+`) so columns compare the cells the row starts on.
function columnOf(frame: string, needle: string) {
  const row = frame
    .replace(/\n$/, "")
    .split("\n")
    .find((line) => line.includes(needle))
  if (!row) throw new Error(`needle "${needle}" not found in frame:\n${frame}`)
  return row.indexOf(needle)
}

// The transcript columns only, starting at `anchor` (a block header marker):
// the docked sidebar sits left of it and would otherwise contribute text to a
// row these tests read as blank.
function cropFrom(frame: string, anchor: string) {
  const left = columnOf(frame, anchor)
  return frame
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => line.slice(left))
}

// Content rows: panel border glyphs removed, so a padding row reads as blank.
function rowsOf(frame: string, anchor: string) {
  return cropFrom(frame, anchor).map((line) => line.replace(PANEL_EDGE, "").trimEnd())
}

// Raw rows: border glyphs kept, so a panel's own padding stays distinguishable
// from a truly empty terminal row.
function rawRowsOf(frame: string, anchor: string) {
  return cropFrom(frame, anchor).map((line) => line.trimEnd())
}

function rowOf(rows: string[], needle: string) {
  const index = rows.findIndex((line) => line.includes(needle))
  if (index === -1) throw new Error(`needle "${needle}" not found in rows:\n${rows.join("\n")}`)
  return index
}

// Every row strictly between two rows of the transcript.
function between(rows: string[], upper: string, lower: string) {
  const from = rowOf(rows, upper)
  const to = rowOf(rows, lower)
  if (to <= from) throw new Error(`"${lower}" is not below "${upper}":\n${rows.join("\n")}`)
  return rows.slice(from + 1, to)
}

// The block boundary: exactly one blank terminal row, not zero (touching) and
// not two (the double padding this correction has to avoid).
function expectOneBlankRowBetween(frame: string, anchor: string, upper: string, lower: string) {
  expect({ upper, lower, rows: between(rowsOf(frame, anchor), upper, lower) }).toEqual({ upper, lower, rows: [""] })
}

// No separator between two rows of the same block: every row in between must be
// owned by a detail row itself (a panel's padding or gap), never an empty
// terminal row. This is the corrected rule for a block header and its first
// detail row, and for two detail rows of one block.
function expectNoBlankRowBetween(frame: string, anchor: string, upper: string, lower: string) {
  const raw = between(rawRowsOf(frame, anchor), upper, lower)
  expect({ upper, lower, blank: raw.filter((line) => line.trim() === "") }).toEqual({ upper, lower, blank: [] })
}

async function settledFrame(app: Awaited<ReturnType<typeof mountSessionRoute>>["app"], needle: string) {
  await waitFor(app, () => (app.captureCharFrame().includes(needle) ? true : undefined))
  return frameOf(app)
}

// Visual evidence: the character frame plus the OpenTUI spans that drew it.
async function capture(app: Awaited<ReturnType<typeof mountSessionRoute>>["app"], name: string) {
  const dir = process.env.ACTIVITY_CAPTURE_DIR
  if (!dir) return
  await mkdir(dir, { recursive: true })
  await Bun.write(path.join(dir, `${name}.txt`), await frameOf(app))
  const spans = await captureSpans(app)
  // RGBA components are normalized floats; the recorder keeps 8-bit values so
  // the evidence can reproduce the exact pixels the renderer drew.
  const rgba = (color: { r: number; g: number; b: number; a: number }) =>
    [color.r, color.g, color.b, color.a].map((value) => Math.round(value * 255))
  const lines = spans.lines.map((line) =>
    line.spans.map((span) => ({
      text: span.text,
      fg: rgba(span.fg),
      bg: rgba(span.bg),
      attributes: span.attributes,
      width: span.width,
    })),
  )
  await Bun.write(path.join(dir, `${name}.json`), JSON.stringify({ cols: spans.cols, rows: spans.rows, lines }))
}

describe("activity block spacing", () => {
  for (const size of ["normal", "narrow"] as const) {
    test(`${size}: collapsed blocks keep one blank row between them`, async () => {
      const { app } = await mountProposal(size)
      await settle(app)
      const frame = await settledFrame(app, "Edited 1 file")
      await capture(app, `activity-padding-collapsed-${size}`)

      // Three typed blocks, one blank row at each boundary and no more.
      expectOneBlankRowBetween(frame, "+ Ran 1 command", "+ Ran 1 command", "+ Explored 1 file")
      expectOneBlankRowBetween(frame, "+ Ran 1 command", "+ Explored 1 file", "+ Edited 1 file")
      // Nothing from a collapsed block's details leaks into the transcript.
      expect(frame).not.toContain(READ_ROW)
      expect(frame).not.toContain(EDIT_ROW)
      expect(frame).not.toContain("$ rg -n")
    })

    test(`${size}: a detail row starts directly under its block header`, async () => {
      const { app } = await mountReadThenEdit(size)
      await settle(app)
      const frame = await settledFrame(app, "Edited 1 file")
      await capture(app, `activity-padding-read-edit-${size}`)

      // Expanded: the read row is the whole detail area of the block above. It
      // follows its header with no blank row, and the next block still keeps
      // exactly one blank row below it.
      expectNoBlankRowBetween(frame, "− Explored 1 file", "− Explored 1 file", READ_ROW_INPUT)
      expectNoBlankRowBetween(frame, "− Edited 1 file", "− Edited 1 file", EDIT_ROW)
      expectOneBlankRowBetween(frame, "− Explored 1 file", READ_ROW_INPUT, "− Edited 1 file")
      // The compact two-column inner indent holds in both directions.
      expect(columnOf(frame, READ_ROW_CELL)).toBe(columnOf(frame, "− Explored 1 file") + 2)
      expect(columnOf(frame, EDIT_ROW_CELL)).toBe(columnOf(frame, "− Edited 1 file") + 2)
    })

    test(`${size}: a standalone Thought keeps its blank row`, async () => {
      const { app } = await mountProposal(size, { kv: { activity_groups_expanded: true } })
      await settle(app)
      const frame = await settledFrame(app, "Thought: Verifying the edit")

      expectOneBlankRowBetween(frame, "− Explored 1 file", "Now verify the edit.", "+ Thought: Verifying the edit")
    })
  }

  // A long read argument wraps inside its row. The wrapped row still counts as
  // one detail line: it starts directly after the same header, its wrapped text
  // stays on the row's text column, and exactly one blank row follows its last
  // line. The separator spelling comes from `path.sep`, so the needle matches
  // the native rendering on Windows and POSIX alike.
  test("narrow: a wrapped detail row starts under its header and keeps the block spacing", async () => {
    const long = ["src", "packages", "tui", "src", "component", "prompt", "history", "very-long-file-name-app.py"].join(
      path.sep,
    )
    const { app } = await mountReadThenEdit("narrow", long)
    await settle(app)
    const frame = await settledFrame(app, "Edited 1 file")

    const wrappedHead = `Read ${["src", "packages", "tui", "src", "component", "prompt", "history"].join(path.sep)}${path.sep}`
    const wrappedTail = "name-app.py [limit=70, offset=465]"

    const rows = rowsOf(frame, "− Explored 1 file")
    const header = rowOf(rows, "− Explored 1 file")
    const first = rowOf(rows, wrappedHead)
    const tail = rowOf(rows, wrappedTail)
    const edited = rowOf(rows, "− Edited 1 file")
    expect(tail).toBeGreaterThan(first)
    expect(edited).toBeGreaterThan(tail)

    // The wrap paints over rows of its own, so measure on the content rows:
    // every row between the header and the wrapped text is the detail's own,
    // and the block boundary below the tail is exactly one blank row.
    expect(rows.slice(header + 1, first)).toEqual([])
    expect({ rows: rows.slice(tail + 1, edited) }).toEqual({ rows: [""] })
    // The wrapped text keeps the row's own text column instead of drifting.
    expect(columnOf(frame, wrappedTail)).toBe(columnOf(frame, wrappedHead))
  })

  // Normal width shows the whole run, so every boundary of the proposal's
  // example (command panel, read, edit) is measured in one frame.
  test("normal: expanded blocks keep one blank row between them and none before their details", async () => {
    const { app } = await mountProposal("normal", { kv: { activity_groups_expanded: true } })
    await settle(app)
    const frame = await settledFrame(app, "Edited 1 file")
    await capture(app, "activity-padding-expanded-normal")

    const anchor = "− Ran 1 command"
    // The header is joined to the reasoning that planned the command: the
    // assistant turn starts the transcript's flat run directly under it.
    expectNoBlankRowBetween(frame, anchor, "− Ran 1 command", "+ Thought: Planning the edit")
    // The panel's top padding row is the panel's own; no blank row is added
    // between the header and the call it summarizes.
    expectNoBlankRowBetween(frame, anchor, "+ Thought: Planning the edit", "$ rg -n")
    expectNoBlankRowBetween(frame, anchor, "− Ran 1 command", "$ rg -n")
    // A one-line detail row starts directly under its own header too.
    expectNoBlankRowBetween(frame, anchor, "− Explored 1 file", READ_ROW_INPUT)
    expectNoBlankRowBetween(frame, anchor, "− Edited 1 file", EDIT_ROW)
    // Between blocks: the panel's bottom padding row is the row after it, so a
    // margin here would draw two.
    expectOneBlankRowBetween(frame, anchor, "Click to expand", "− Explored 1 file")
    expectOneBlankRowBetween(frame, anchor, READ_ROW_INPUT, "− Edited 1 file")
    expectOneBlankRowBetween(frame, anchor, "← Edit src/app.py", "Now verify the edit.")
  })

  // Two command panels are one block's detail rows: the block stays compact
  // inside (no blank row between the panels, none above the first) and the
  // boundary below the last panel is still exactly one blank row.
  test("normal: a block of two panels stays compact inside and separated outside", async () => {
    const { app } = await mountTwoPanels()
    await settle(app)
    const frame = await settledFrame(app, "Explored 1 file")
    await capture(app, "activity-padding-two-panels-normal")

    const anchor = "− Ran 2 commands"
    expectNoBlankRowBetween(frame, anchor, "− Ran 2 commands", '$ rg -n "class App" src')
    expectNoBlankRowBetween(frame, anchor, '$ rg -n "class App" src', "$ ls -la src")
    expectNoBlankRowBetween(frame, anchor, "12:class App:", "$ ls -la src")
    expectNoBlankRowBetween(frame, anchor, "− Explored 1 file", READ_ROW)
    // The last panel's own bottom padding row is the block boundary row.
    expectOneBlankRowBetween(frame, anchor, "widget.py", "− Explored 1 file")
    // Panel content keeps the shared two-column inner indent.
    expect(columnOf(frame, '$ rg -n "class App"')).toBe(columnOf(frame, anchor) + 2)
    expect(columnOf(frame, "$ ls -la src")).toBe(columnOf(frame, anchor) + 2)
  })

  test("normal: one two-column inner indent for every detail line", async () => {
    const { app } = await mountProposal("normal", { kv: { activity_groups_expanded: true } })
    await settle(app)
    const frame = await settledFrame(app, "Edited 1 file")

    const header = columnOf(frame, "− Ran 1 command")
    // Detail rows start two columns right of the header marker ...
    expect(columnOf(frame, "+ Thought: Planning the edit")).toBe(header + 2)
    expect(columnOf(frame, READ_ROW_CELL)).toBe(header + 2)
    expect(columnOf(frame, EDIT_ROW_CELL)).toBe(header + 2)
    // ... and the command panel's content lands on that same column, while its
    // left border stays on the header's column.
    expect(columnOf(frame, "$ rg -n")).toBe(header + 2)
    expect(columnOf(frame, "28:class App:")).toBe(header + 2)
    expect(columnOf(frame, "Click to expand")).toBe(header + 2)
    expect(columnOf(frame, "┃ $ rg -n")).toBe(header)
    // The headers themselves stay on the transcript column: the indent is
    // inner-only.
    expect(columnOf(frame, "− Explored 1 file")).toBe(header)
    expect(columnOf(frame, "− Edited 1 file")).toBe(header)
  })

  // A narrow terminal scrolls the head of the run out of one 24-row frame, so
  // the measurements use the rows that are on screen: the panel tail and the
  // typed blocks below it.
  test("narrow: expanded blocks keep one blank row between them and none before their details", async () => {
    const { app } = await mountProposal("narrow", { kv: { activity_groups_expanded: true } })
    await settle(app)
    const frame = await settledFrame(app, "Edited 1 file")
    await capture(app, "activity-padding-expanded-narrow")

    const anchor = "− Explored 1 file"
    expectNoBlankRowBetween(frame, anchor, "− Explored 1 file", READ_ROW_INPUT)
    expectNoBlankRowBetween(frame, anchor, "− Edited 1 file", EDIT_ROW)
    expectOneBlankRowBetween(frame, anchor, "Click to expand", "− Explored 1 file")
    expectOneBlankRowBetween(frame, anchor, READ_ROW_INPUT, "− Edited 1 file")
  })

  test("narrow: the shared detail column holds on the visible blocks", async () => {
    const { app } = await mountProposal("narrow", { kv: { activity_groups_expanded: true } })
    await settle(app)
    const frame = await settledFrame(app, "Edited 1 file")

    const header = columnOf(frame, "− Explored 1 file")
    expect(columnOf(frame, READ_ROW_CELL)).toBe(header + 2)
    expect(columnOf(frame, EDIT_ROW_CELL)).toBe(header + 2)
    expect(columnOf(frame, "Click to expand")).toBe(header + 2)
    expect(columnOf(frame, "− Edited 1 file")).toBe(header)
  })

  // Rows outside any activity block are untouched by this spacing: they keep
  // the transcript's own anatomy (the panel's margin and its own padding, the
  // inline row's single blank row), and a non-work call stays on the transcript
  // column with exactly one blank row between it and the block above.
  test("transcript-level tools keep their own spacing", async () => {
    const { app } = await mountOutsideBlock()
    await settle(app)
    const frame = await settledFrame(app, "After the command.")
    // Every measurement is taken from an assistant text row, which sits on the
    // transcript column, so no needle is read from a cropped sidebar column.
    const anchor = "After the todos."

    // A lone bash call is not a run: its panel keeps the transcript margin row
    // above its own top padding row, and its bottom padding row plus the text
    // margin below it.
    expect(between(rowsOf(frame, anchor), anchor, "$ ls -la src")).toEqual(["", ""])
    expect(between(rowsOf(frame, anchor), "widget.py", "After the command.")).toEqual(["", ""])

    // A non-work call ends the run: one blank row below the block's last detail
    // row, and it stays on the transcript column.
    expectOneBlankRowBetween(frame, anchor, `Read src${path.sep}b.py [limit=70, offset=1]`, "⚙ Updating todos...")
    expect(columnOf(frame, "⚙ Updating todos...")).toBe(columnOf(frame, "− Explored 2 files"))
    expectOneBlankRowBetween(frame, anchor, "⚙ Updating todos...", "After the todos.")
  })
})
