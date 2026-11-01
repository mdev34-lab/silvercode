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

// Activity block spacing: the real `<Session />` route draws exactly one blank
// terminal row between the typed working blocks (Ran / Explored / Edited) and
// before an expanded block's details, and every detail line shares one
// two-column inner indent. These tests read the rendered character frame, so
// they measure the rows a user sees rather than the props that produced them.
// Set ACTIVITY_CAPTURE_DIR to also write the frames (`<name>.txt`) and their
// OpenTUI spans (`<name>.json`, one colour per cell) for the pixel evidence.

afterEach(disposeSessionRoutes)

const SIZES = {
  normal: { width: 140, height: 40 },
  narrow: { width: 80, height: 24 },
} as const

const SESSION = "ses_padding"
const at = (offset: number) => BASE + offset * 1000

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

// Read-then-edit: the block above ends with a one-line detail row, which is the
// case where a missing blank row would glue that row to the next block header.
function mountReadThenEdit(size: keyof typeof SIZES) {
  const session = sessionInfo(SESSION, { title: "Fix the App class" })
  const user = userMessage("msg_00_user", SESSION)
  const work = assistantMessage("msg_01_work", SESSION, { time: { created: at(1), completed: at(6) } })
  const parts: Part[] = [
    toolPart("prt_read", work.id, "read", { filePath: "src/app.py", limit: 70, offset: 465 }, {}, at(1), at(2)),
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

// A tool panel keeps its left border and background across its padding rows,
// so a padding row carries border glyphs and no text. Dropping those glyphs is
// what makes "blank row" mean "one empty terminal row", whether the blank is
// the block's own margin or the panel's padding.
const PANEL_EDGE = /[┃│┏┓┗┛┡┩└┘┌┐├┤]/g

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
function rowsOf(frame: string, anchor: string) {
  const left = columnOf(frame, anchor)
  return frame
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => line.slice(left).replace(PANEL_EDGE, "").trimEnd())
}

function rowOf(rows: string[], needle: string) {
  const index = rows.findIndex((line) => line.includes(needle))
  if (index === -1) throw new Error(`needle "${needle}" not found in rows:\n${rows.join("\n")}`)
  return index
}

// Every row strictly between two rows of the transcript. The block contract is
// one blank row, so this must be exactly one empty row: not zero (touching) and
// not two (the double padding this change has to avoid).
function between(frame: string, anchor: string, upper: string, lower: string) {
  const rows = rowsOf(frame, anchor)
  const from = rowOf(rows, upper)
  const to = rowOf(rows, lower)
  if (to <= from) throw new Error(`"${lower}" is not below "${upper}":\n${rows.join("\n")}`)
  return rows.slice(from + 1, to)
}

function expectOneBlankRowBetween(frame: string, anchor: string, upper: string, lower: string) {
  expect({ upper, lower, rows: between(frame, anchor, upper, lower) }).toEqual({ upper, lower, rows: [""] })
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
  const lines = spans.lines.map((line) =>
    line.spans.map((span) => ({
      text: span.text,
      fg: [Math.round(span.fg.r), Math.round(span.fg.g), Math.round(span.fg.b), span.fg.a],
      bg: [Math.round(span.bg.r), Math.round(span.bg.g), Math.round(span.bg.b), span.bg.a],
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
      expect(frame).not.toContain("Read src/app.py")
      expect(frame).not.toContain("$ rg -n")
    })

    test(`${size}: a one-line read row never touches the next block`, async () => {
      const { app } = await mountReadThenEdit(size)
      await settle(app)
      const frame = await settledFrame(app, "Edited 1 file")
      await capture(app, `activity-padding-read-edit-${size}`)

      // Expanded: the read row is the whole detail area of the block above.
      expectOneBlankRowBetween(frame, "− Explored 1 file", "→ Read src/app.py", "− Edited 1 file")
      expect(columnOf(frame, "→ Read src/app.py")).toBe(columnOf(frame, "− Edited 1 file") + 2)
    })

    test(`${size}: a standalone Thought keeps its blank row`, async () => {
      const { app } = await mountProposal(size, { kv: { activity_groups_expanded: true } })
      await settle(app)
      const frame = await settledFrame(app, "Thought: Verifying the edit")

      expectOneBlankRowBetween(frame, "− Explored 1 file", "Now verify the edit.", "+ Thought: Verifying the edit")
    })
  }

  // Normal width shows the whole run, so every boundary of the proposal's
  // example (command panel, read, edit) is measured in one frame.
  test("normal: expanded blocks keep one blank row between them and before their details", async () => {
    const { app } = await mountProposal("normal", { kv: { activity_groups_expanded: true } })
    await settle(app)
    const frame = await settledFrame(app, "Edited 1 file")
    await capture(app, "activity-padding-expanded-normal")

    const anchor = "− Ran 1 command"
    // One blank row before the details of a block, whichever row draws it ...
    expectOneBlankRowBetween(frame, anchor, "− Ran 1 command", "+ Thought: Planning the edit")
    // (the command panel pads its top by one row, and that is the blank row) ...
    expectOneBlankRowBetween(frame, anchor, "+ Thought: Planning the edit", "$ rg -n")
    expectOneBlankRowBetween(frame, anchor, "− Explored 1 file", "→ Read src/app.py")
    // ... and one blank row between the blocks. The panel's bottom padding row
    // is that row after it; a margin here would draw two.
    expectOneBlankRowBetween(frame, anchor, "Click to expand", "− Explored 1 file")
    expectOneBlankRowBetween(frame, anchor, "→ Read src/app.py", "− Edited 1 file")
  })

  test("normal: one two-column inner indent for every detail line", async () => {
    const { app } = await mountProposal("normal", { kv: { activity_groups_expanded: true } })
    await settle(app)
    const frame = await settledFrame(app, "Edited 1 file")

    const header = columnOf(frame, "− Ran 1 command")
    // Detail rows start two columns right of the header marker ...
    expect(columnOf(frame, "+ Thought: Planning the edit")).toBe(header + 2)
    expect(columnOf(frame, "→ Read src/app.py")).toBe(header + 2)
    expect(columnOf(frame, "← Edit src/app.py")).toBe(header + 2)
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
  test("narrow: expanded blocks keep one blank row between them and before their details", async () => {
    const { app } = await mountProposal("narrow", { kv: { activity_groups_expanded: true } })
    await settle(app)
    const frame = await settledFrame(app, "Edited 1 file")
    await capture(app, "activity-padding-expanded-narrow")

    const anchor = "− Explored 1 file"
    expectOneBlankRowBetween(frame, anchor, "Click to expand", "− Explored 1 file")
    expectOneBlankRowBetween(frame, anchor, "− Explored 1 file", "→ Read src/app.py")
    expectOneBlankRowBetween(frame, anchor, "→ Read src/app.py", "− Edited 1 file")
    expectOneBlankRowBetween(frame, anchor, "− Edited 1 file", "← Edit src/app.py")
  })

  test("narrow: the shared detail column holds on the visible blocks", async () => {
    const { app } = await mountProposal("narrow", { kv: { activity_groups_expanded: true } })
    await settle(app)
    const frame = await settledFrame(app, "Edited 1 file")

    const header = columnOf(frame, "− Explored 1 file")
    expect(columnOf(frame, "→ Read src/app.py")).toBe(header + 2)
    expect(columnOf(frame, "← Edit src/app.py")).toBe(header + 2)
    expect(columnOf(frame, "Click to expand")).toBe(header + 2)
    expect(columnOf(frame, "− Edited 1 file")).toBe(header)
  })
})
