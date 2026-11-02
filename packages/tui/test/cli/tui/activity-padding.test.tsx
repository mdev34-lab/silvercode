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

// A reasoning body that exercises the markdown the block must not eat: a title
// block, a paragraph, a fenced code block, and a trailing paragraph. The blank
// lines between them are content, so they have to survive.
const THOUGHT_BODY = [
  "**Planning the edit**",
  "",
  "The App class owns the state, so change the initializer.",
  "",
  "```python",
  "self.ready = True",
  "```",
  "",
  "Then re-read the file to confirm.",
].join("\n")

const THOUGHT_TITLE = "Thought: Planning the edit"
const THOUGHT_PARA = "The App class owns the state, so change the initializer."
const THOUGHT_LAST = "Then re-read the file to confirm."

// `nested` puts the reasoning in a run with two tool calls, so it is a detail
// row inside an activity block. Without it the reasoning is a transcript-level
// block of its own. "show" keeps a completed thought open, which is the state
// whose body spacing this covers; "hide" collapses it to a clickable header.
function mountThought(size: keyof typeof SIZES, options: { nested: boolean; mode?: "show" | "hide" }) {
  const session = sessionInfo(SESSION, { title: "Fix the App class" })
  const user = userMessage("msg_00_user", SESSION)
  const work = assistantMessage("msg_01_work", SESSION, { time: { created: at(1), completed: at(9) } })
  const thought = reasoningPart(work.id, "prt_think", THOUGHT_BODY, at(1), at(2))
  const parts: Part[] = options.nested
    ? [
        thought,
        toolPart("prt_read", work.id, "read", { filePath: "src/app.py", limit: 70, offset: 465 }, {}, at(2), at(3)),
        toolPart(
          "prt_edit",
          work.id,
          "edit",
          { filePath: "src/app.py", oldString: "ready = False", newString: "ready = True" },
          {},
          at(3),
          at(4),
        ),
      ]
    : [thought]
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
    kv: { activity_groups_expanded: true, thinking_mode: options.mode ?? "show" },
  })
}

// The colour the renderer recorded for the cell that starts `needle`, as 8-bit
// RGBA. Colours are part of the accepted rendering, so the spacing change is
// only correct if these stay put.
async function colorOf(app: Awaited<ReturnType<typeof mountSessionRoute>>["app"], needle: string) {
  const spans = await captureSpans(app)
  const rows = Array.from(
    spans.lines as unknown as { spans: { text: string; fg: any; bg: any; attributes: number }[] }[],
  )
  const rgba = (color: { r: number; g: number; b: number; a: number }) =>
    [color.r, color.g, color.b, color.a].map((value) => Math.round(value * 255))
  for (const line of rows) {
    const text = line.spans.map((span) => span.text).join("")
    if (!text.includes(needle)) continue
    const span = line.spans.find((span) => span.text.includes(needle)) ?? line.spans.find((span) => span.text.trim())
    if (!span) continue
    return { fg: rgba(span.fg), bg: rgba(span.bg), attributes: span.attributes }
  }
  throw new Error(`no span starts "${needle}"`)
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

// A call the session has not finished. `state.status === "pending"` keeps the
// row on InlineToolRow's pending fallback (`~ <pending text>`) instead of the
// icon + text row that every completed fixture above uses, so these fixtures
// are the only coverage of that branch.
function pendingToolPart(id: string, messageID: string, tool: string, input: Record<string, unknown>): ToolPart {
  return {
    id,
    sessionID: SESSION,
    messageID,
    type: "tool",
    callID: id,
    tool,
    state: { status: "pending", input, raw: "" },
  }
}

const PENDING_READ = "~ Reading file..."
const PENDING_GREP = "~ Searching content..."
const PENDING_HEADER_LABEL = "Exploring files..."

// Two pending calls in one run: the run is an activity block, so each pending
// row is a detail row under the block header. `standalone` renders a single
// pending call instead, which is not a run and stays at transcript level.
function mountPending(size: keyof typeof SIZES, standalone: boolean) {
  const session = sessionInfo(SESSION, { title: "Fix the App class" })
  const user = userMessage("msg_00_user", SESSION)
  const work = assistantMessage("msg_01_work", SESSION, { time: { created: at(1), completed: at(9) } })
  const closing = assistantMessage("msg_02_closing", SESSION, { time: { created: at(9), completed: at(10) } })
  const parts: Part[] = standalone
    ? [pendingToolPart("prt_pending_read", work.id, "read", { filePath: "src/app.py" })]
    : [
        pendingToolPart("prt_pending_read", work.id, "read", { filePath: "src/app.py" }),
        pendingToolPart("prt_pending_grep", work.id, "grep", { pattern: "class App" }),
      ]
  const messages: NonNullable<MountOptions["messages"]> = {
    [SESSION]: [
      { info: user, parts: [textPart("prt_user", user, "Fix the App class")] },
      { info: work, parts },
      { info: closing, parts: [textPart("prt_closing", closing, "After the pending calls.")] },
    ],
  }
  return mountSessionRoute({
    ...SIZES[size],
    sessions: [session],
    messages,
    kv: standalone ? {} : { activity_groups_expanded: true },
  })
}

// A read row that loaded two more files, and an answered question with two
// groups. Both draw sub-rows and a group gap of their own, so both are places
// where decorative spacing can leak inside a block.
const LOADED_FILES = ["src/app.py", "src/util/state.py"]
const LOADED_FIRST = `↳ Loaded ${SRC_APP}`
const LOADED_SECOND = `↳ Loaded src${path.sep}util${path.sep}state.py`
const QUESTION_LIST = ["Which module owns the initializer?", "Should ready default to true?"]
const QUESTION_ANSWERS = [["src/app.py"], ["Yes, keep it False"]]

function mountReadLoaded(size: keyof typeof SIZES, insideBlock: boolean) {
  const session = sessionInfo(SESSION, { title: "Fix the App class" })
  const user = userMessage("msg_00_user", SESSION)
  const work = assistantMessage("msg_01_work", SESSION, { time: { created: at(1), completed: at(6) } })
  const read = toolPart(
    "prt_read",
    work.id,
    "read",
    { filePath: "src/app.py", limit: 70, offset: 465 },
    { loaded: LOADED_FILES },
    at(1),
    at(2),
  )
  const parts: Part[] = insideBlock
    ? [
        read,
        toolPart(
          "prt_edit",
          work.id,
          "edit",
          { filePath: "src/app.py", oldString: "ready = False", newString: "ready = True" },
          {},
          at(2),
          at(3),
        ),
      ]
    : [read]
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
    kv: insideBlock ? { activity_groups_expanded: true } : {},
  })
}

function mountQuestions(size: keyof typeof SIZES, insideBlock: boolean) {
  const session = sessionInfo(SESSION, { title: "Fix the App class" })
  const user = userMessage("msg_00_user", SESSION)
  const work = assistantMessage("msg_01_work", SESSION, { time: { created: at(1), completed: at(6) } })
  const question = toolPart(
    "prt_question",
    work.id,
    "question",
    { questions: QUESTION_LIST.map((question) => ({ question })) },
    { answers: QUESTION_ANSWERS },
    at(1),
    at(2),
  )
  const parts: Part[] = insideBlock
    ? [question, toolPart("prt_read", work.id, "read", { filePath: "src/app.py" }, {}, at(2), at(3))]
    : [question]
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
    kv: insideBlock ? { activity_groups_expanded: true } : {},
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

// A running block header draws `− <spinner> Exploring files...`, and the spinner
// cycles ten glyphs at 80ms, so which glyph a frame catches is a matter of when
// the capture lands — `⠼` in one run, `⠸` in another. Freezing one animation
// frame into the needle makes the test depend on render timing; instead the
// header's real prefix is asserted by shape (marker, one spinner frame, the full
// label) and the column is measured from the row the renderer actually drew.
const PENDING_HEADER = /^− [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Exploring files\.\.\.$/u

function pendingHeader(frame: string): { column: number; anchor: string } {
  const row = frame
    .replace(/\n$/, "")
    .split("\n")
    .find((line) => line.includes(PENDING_HEADER_LABEL))
  if (!row) throw new Error(`pending header "${PENDING_HEADER_LABEL}" not found in frame:\n${frame}`)
  const column = row.indexOf("−")
  const anchor = row.slice(column).trimEnd()
  if (!PENDING_HEADER.test(anchor)) {
    throw new Error(`pending header does not start with a spinner prefix: ${JSON.stringify(anchor)}`)
  }
  return { column, anchor }
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

// Content rows: every panel border glyph removed. What is left is the text the
// row actually renders, so a row that draws only the panel's border — an empty
// content row inside a panel — reads as blank, exactly as it looks on screen.
function rowsOf(frame: string, anchor: string) {
  return cropFrom(frame, anchor).map((line) => line.replace(PANEL_EDGE, "").trimEnd())
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

// No blank row between two rows of the same block — including a row that draws
// nothing but the panel's border. The rule is "a blank row only between blocks",
// so any empty content row between a header and its tool call, or between two
// rows inside a panel, is a violation however it is decorated.
function expectNoBlankRowBetween(frame: string, anchor: string, upper: string, lower: string) {
  expect({ upper, lower, rows: between(rowsOf(frame, anchor), upper, lower) }).toEqual({
    upper,
    lower,
    rows: [],
  })
}

// A whole span inside one block: every content row must carry text.
function expectNoBlankRows(frame: string, anchor: string, from: string, to: string) {
  const rows = between(rowsOf(frame, anchor), from, to)
  expect({ from, to, blank: rows.filter((line) => line === "") }).toEqual({ from, to, blank: [] })
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
      // Each block is header + one detail row, and nothing blank in between.
      expectNoBlankRows(frame, "− Explored 1 file", "− Explored 1 file", READ_ROW_INPUT)
      expectNoBlankRows(frame, "− Edited 1 file", "− Edited 1 file", EDIT_ROW)
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

    // Needles avoid the separator entirely: the row prefix and the wrapped
    // continuation are separator-free, so the wrap point does not matter and
    // the same assertions hold on Windows and POSIX.
    const wrappedHead = "Read src"
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
    // No blank row between the header and the call it summarizes.
    expectNoBlankRowBetween(frame, anchor, "+ Thought: Planning the edit", "$ rg -n")
    // The panel inside a block draws no padding or gap rows of its own: the
    // command, every output row and the expand hint are consecutive content
    // rows. Border glyphs are stripped, so a border-only row counts as blank.
    expectNoBlankRowBetween(frame, anchor, "$ rg -n", "28:class App:")
    expectNoBlankRowBetween(frame, anchor, "30:        self.name = name", "…")
    expectNoBlankRowBetween(frame, anchor, "…", "Click to expand")
    // The whole block, header to the last row of its panel, holds no blank row.
    expectNoBlankRows(frame, anchor, "− Ran 1 command", "Click to expand")
    // A one-line detail row starts directly under its own header too.
    expectNoBlankRowBetween(frame, anchor, "− Explored 1 file", READ_ROW_INPUT)
    expectNoBlankRowBetween(frame, anchor, "− Edited 1 file", EDIT_ROW)
    // Between blocks: the panel's bottom padding row is the row after it, so a
    // margin here would draw two.
    expectOneBlankRowBetween(frame, anchor, "Click to expand", "− Explored 1 file")
    expectOneBlankRowBetween(frame, anchor, READ_ROW_INPUT, "− Edited 1 file")
    expectOneBlankRowBetween(frame, anchor, EDIT_ROW_CELL, "Now verify the edit.")
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
    expectNoBlankRowBetween(frame, anchor, '$ rg -n "class App" src', "12:class App:")
    expectNoBlankRowBetween(frame, anchor, "12:class App:", "$ ls -la src")
    expectNoBlankRowBetween(frame, anchor, "$ ls -la src", "widget.py")
    expectNoBlankRowBetween(frame, anchor, "− Explored 1 file", READ_ROW)
    // Both panels and the seam between them: no blank row anywhere inside.
    expectNoBlankRows(frame, anchor, "− Ran 2 commands", "widget.py")
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
    // The visible panel tail is consecutive content rows too.
    expectNoBlankRowBetween(frame, anchor, "…", "Click to expand")
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
  // Nested reasoning inside a block has a body too. When it is open (the
  // "show" display mode, or after clicking it in "hide" mode) the body is the
  // next row of the block: no blank row between the reasoning header and its
  // first line of text. The body's own markdown blank lines are content and
  // are preserved, and the block is compact from the header to its last row.
  test("normal: an expanded nested reasoning body starts directly under its header", async () => {
    const { app } = await mountThought("normal", { nested: true })
    await settle(app)
    const frame = await settledFrame(app, THOUGHT_LAST)
    await capture(app, "activity-padding-nested-body-normal")

    const anchor = "− Explored 1 file"
    // Header -> body: no gap.
    expectNoBlankRowBetween(frame, anchor, THOUGHT_TITLE, THOUGHT_PARA)
    // The body is one compact detail area: its markdown blank line before the
    // fence is content, and so is the one before the trailing paragraph.
    expect({ rows: between(rowsOf(frame, anchor), THOUGHT_PARA, "```python") }).toEqual({ rows: [""] })
    // (leading indent trimmed: this asserts the content rows, not the column)
    expect(between(rowsOf(frame, anchor), "self.ready = True", THOUGHT_LAST).map((line) => line.trim())).toEqual([
      "```",
      "",
    ])
    // The last line of the body is followed directly by the next detail row.
    // The body's own blank lines are markdown content, which is why the
    // whole-block rule is not asserted across a body — only at its seams.
    expectNoBlankRowBetween(frame, anchor, THOUGHT_LAST, READ_ROW_INPUT)

    // Order and content survive: title, paragraph, fenced block, trailing text.
    const rows = rowsOf(frame, anchor)
    expect(rowOf(rows, THOUGHT_TITLE)).toBeLessThan(rowOf(rows, THOUGHT_PARA))
    expect(rowOf(rows, THOUGHT_PARA)).toBeLessThan(rowOf(rows, "```python"))
    expect(rowOf(rows, "```python")).toBeLessThan(rowOf(rows, "self.ready = True"))
    expect(rowOf(rows, "self.ready = True")).toBeLessThan(rowOf(rows, THOUGHT_LAST))
    // Colours are untouched: the dimmed header accent and the muted body on the
    // transcript background.
    expect(await colorOf(app, THOUGHT_TITLE)).toEqual({ fg: [151, 104, 44, 255], bg: [10, 10, 10, 255], attributes: 0 })
    expect(await colorOf(app, THOUGHT_PARA)).toEqual({ fg: [128, 128, 128, 255], bg: [10, 10, 10, 255], attributes: 0 })
    expect(await colorOf(app, "self.ready = True")).toEqual({
      fg: [128, 128, 128, 255],
      bg: [10, 10, 10, 255],
      attributes: 0,
    })
  })

  // The same reasoning at transcript level keeps the transcript's own blank row
  // before and after its body: the compaction is activity-only.
  test("normal: a standalone reasoning body keeps its blank row on both sides", async () => {
    const { app } = await mountThought("normal", { nested: false })
    await settle(app)
    const frame = await settledFrame(app, THOUGHT_LAST)

    expectOneBlankRowBetween(frame, THOUGHT_TITLE, THOUGHT_TITLE, THOUGHT_PARA)
    expectOneBlankRowBetween(frame, THOUGHT_TITLE, THOUGHT_LAST, "▣  Build · Test Model")
    // Same body, same content, different surroundings.
    expect(frame).toContain("self.ready = True")
    expect(between(rowsOf(frame, THOUGHT_TITLE), THOUGHT_PARA, "```python")).toEqual([""])
    expect(await colorOf(app, THOUGHT_PARA)).toEqual({ fg: [128, 128, 128, 255], bg: [10, 10, 10, 255], attributes: 0 })
  })

  // The same compaction at 80 columns: the body follows its header directly and
  // the block stays compact, so a narrow window does not reintroduce the gap.
  test("narrow: an expanded nested reasoning body stays compact", async () => {
    const { app } = await mountThought("narrow", { nested: true })
    await settle(app)
    const frame = await settledFrame(app, THOUGHT_LAST)
    await capture(app, "activity-padding-nested-body-narrow")

    const anchor = "− Explored 1 file"
    expectNoBlankRowBetween(frame, anchor, THOUGHT_TITLE, THOUGHT_PARA)
    expectNoBlankRowBetween(frame, anchor, THOUGHT_LAST, READ_ROW_INPUT)
    expect({ rows: between(rowsOf(frame, anchor), THOUGHT_PARA, "```python") }).toEqual({ rows: [""] })
  })

  // The header is still the control it was: in "hide" mode clicking the
  // collapsed thought opens its body, and the opened body is compact inside the
  // block (the hide mode's own body indent is preserved).
  test("normal: clicking a nested thought opens a compact body", async () => {
    const { app } = await mountThought("normal", { nested: true, mode: "hide" })
    await settle(app)
    const collapsed = await settledFrame(app, "+ Thought: Planning the edit")
    expect(collapsed).not.toContain(THOUGHT_PARA)

    const row = collapsed.split("\n").findIndex((line) => line.includes("+ Thought: Planning the edit"))
    expect(row).toBeGreaterThan(-1)
    await app.mockMouse.click(collapsed.split("\n")[row]!.indexOf("+ Thought") + 2, row)
    await settle(app)
    const frame = await settledFrame(app, THOUGHT_LAST)
    await capture(app, "activity-padding-nested-body-clicked-normal")

    const anchor = "− Explored 1 file"
    expectNoBlankRowBetween(frame, anchor, `- ${THOUGHT_TITLE}`, THOUGHT_PARA)
    expectNoBlankRowBetween(frame, anchor, THOUGHT_LAST, READ_ROW_INPUT)
    // The collapsed marker is gone and the body is indented two columns past
    // the reasoning header, as hide mode draws it.
    expect(frame).not.toContain("+ Thought: Planning the edit")
    expect(columnOf(frame, THOUGHT_PARA)).toBe(columnOf(frame, `- ${THOUGHT_TITLE}`) + 2)
  })

  // A read row's loaded files are sub-rows of that detail row. Inside a block
  // they take the shared detail indent, so they sit on the same column as the
  // read row instead of stacking a second transcript-level indent past it.
  for (const size of ["normal", "narrow"] as const) {
    test(`${size}: loaded files of a read row share the detail column inside a block`, async () => {
      const { app } = await mountReadLoaded(size, true)
      await settle(app)
      const frame = await settledFrame(app, LOADED_SECOND)
      await capture(app, `activity-padding-loaded-${size}`)

      const header = columnOf(frame, "− Explored 1 file")
      const read = columnOf(frame, READ_ROW_CELL)
      expect(read).toBe(header + 2)
      // Both loaded rows align with the read row they belong to.
      expect(columnOf(frame, LOADED_FIRST)).toBe(read)
      expect(columnOf(frame, LOADED_SECOND)).toBe(read)
      // Nothing decorative between the row and its loaded files.
      expectNoBlankRowBetween(frame, "− Explored 1 file", READ_ROW_CELL, LOADED_FIRST)
      expectNoBlankRowBetween(frame, "− Explored 1 file", LOADED_FIRST, LOADED_SECOND)
      // Order and text survive, and the row keeps its muted colour.
      const rows = rowsOf(frame, "− Explored 1 file")
      expect(rowOf(rows, READ_ROW_CELL)).toBeLessThan(rowOf(rows, LOADED_FIRST))
      expect(rowOf(rows, LOADED_FIRST)).toBeLessThan(rowOf(rows, LOADED_SECOND))
      expect(await colorOf(app, LOADED_FIRST)).toEqual({
        fg: [128, 128, 128, 255],
        bg: [10, 10, 10, 255],
        attributes: 0,
      })
    })
  }

  // The same read outside a block keeps the transcript's own indent: the loaded
  // row still lines up with its read row, exactly as before this change.
  test("normal: a standalone read keeps its loaded files on the row's column", async () => {
    const { app } = await mountReadLoaded("normal", false)
    await settle(app)
    const frame = await settledFrame(app, LOADED_SECOND)

    expect(columnOf(frame, READ_ROW_CELL)).toBe(columnOf(frame, LOADED_FIRST))
    expect(columnOf(frame, LOADED_FIRST)).toBe(columnOf(frame, LOADED_SECOND))
    expectNoBlankRowBetween(frame, READ_ROW_CELL, READ_ROW_CELL, LOADED_FIRST)
    expect(await colorOf(app, LOADED_FIRST)).toEqual({
      fg: [128, 128, 128, 255],
      bg: [10, 10, 10, 255],
      attributes: 0,
    })
  })

  // An answered question panel stacks its groups with a blank row at transcript
  // level. Inside a block that row would be a blank row inside the block, so
  // the groups follow each other directly.
  for (const size of ["normal", "narrow"] as const) {
    test(`${size}: question groups have no decorative blank row inside a block`, async () => {
      const { app } = await mountQuestions(size, true)
      await settle(app)
      const frame = await settledFrame(app, QUESTION_LIST[1]!)
      await capture(app, `activity-padding-questions-${size}`)

      const rows = rowsOf(frame, "− Worked for")
      const first = rowOf(rows, QUESTION_LIST[0]!)
      const answer = rowOf(rows, "src/app.py")
      const second = rowOf(rows, QUESTION_LIST[1]!)
      expect(answer).toBeGreaterThan(first)
      expect(second).toBeGreaterThan(answer)
      // Question, its answer, then the next question: no row in between.
      expect({ rows: rows.slice(answer + 1, second) }).toEqual({ rows: [] })
      // The panel and its first group start on the shared detail column.
      expect(columnOf(frame, "# Questions")).toBe(columnOf(frame, "− Worked for") + 2)
      expect(columnOf(frame, QUESTION_LIST[0]!)).toBe(columnOf(frame, "− Worked for") + 2)
      // Text and colours are untouched: muted question, full-text answer.
      expect(await colorOf(app, QUESTION_LIST[0]!)).toEqual({
        fg: [128, 128, 128, 255],
        bg: [20, 20, 20, 255],
        attributes: 0,
      })
      expect(await colorOf(app, "src/app.py")).toEqual({
        fg: [238, 238, 238, 255],
        bg: [20, 20, 20, 255],
        attributes: 0,
      })
    })
  }

  // The control: outside a block the answered panel keeps its blank row between
  // groups, so the compaction is activity-only.
  test("normal: a standalone question panel keeps its group blank row", async () => {
    const { app } = await mountQuestions("normal", false)
    await settle(app)
    const frame = await settledFrame(app, QUESTION_LIST[1]!)

    expectOneBlankRowBetween(frame, "# Questions", "src/app.py", QUESTION_LIST[1]!)
    expect(await colorOf(app, QUESTION_LIST[1]!)).toEqual({
      fg: [128, 128, 128, 255],
      bg: [20, 20, 20, 255],
      attributes: 0,
    })
  })

  // A pending detail row draws `~ <pending text>` instead of icon + text. Its
  // `~` stands on the marker column a completed row's icon uses, which inside a
  // block is the shared two-column detail indent — the pending text must not add
  // a transcript-level indent on top of it.
  for (const size of ["normal", "narrow"] as const) {
    test(`${size}: a pending detail row sits on the shared marker column`, async () => {
      const { app } = await mountPending(size, false)
      await settle(app)
      const frame = await settledFrame(app, PENDING_GREP)
      await capture(app, `activity-padding-pending-${size}`)

      const header = pendingHeader(frame)
      // The marker column is +2, the same column the completed cases assert for
      // a detail row's icon: not 5 (wrapper indent plus a second text indent).
      expect(columnOf(frame, PENDING_READ)).toBe(header.column + 2)
      expect(columnOf(frame, PENDING_GREP)).toBe(header.column + 2)
      expect(columnOf(frame, PENDING_READ)).not.toBe(header.column + 5)
      // Header -> first pending row, and row -> row: no blank row either way.
      expectNoBlankRowBetween(frame, header.anchor, header.anchor, PENDING_READ)
      expectNoBlankRowBetween(frame, header.anchor, PENDING_READ, PENDING_GREP)
      // The block boundary below the last pending row is still one blank row.
      expectOneBlankRowBetween(frame, header.anchor, PENDING_GREP, "After the pending calls.")
      // Pending text, colours and the `~` marker are untouched.
      expect(await colorOf(app, PENDING_READ)).toEqual({
        fg: [238, 238, 238, 255],
        bg: [10, 10, 10, 255],
        attributes: 0,
      })
      expect(frame).toContain("Reading file...")
      expect(frame).toContain("Searching content...")
    })
  }

  // The control: a lone pending call is not a run, so it stays at transcript
  // level and lines up with the transcript's own text column, at both widths.
  for (const size of ["normal", "narrow"] as const) {
    test(`${size}: a standalone pending row stays on the transcript column`, async () => {
      const { app } = await mountPending(size, true)
      await settle(app)
      const frame = await settledFrame(app, "After the pending calls.")

      expect(columnOf(frame, PENDING_READ)).toBe(columnOf(frame, "After the pending calls."))
      expect(frame).not.toContain("Exploring files...")
      expect(await colorOf(app, PENDING_READ)).toEqual({
        fg: [238, 238, 238, 255],
        bg: [10, 10, 10, 255],
        attributes: 0,
      })
    })
  }

  test("transcript-level tools keep their own spacing", async () => {
    const { app } = await mountOutsideBlock()
    await settle(app)
    const frame = await settledFrame(app, "After the command.")
    // Every measurement is taken from an assistant text row, which sits on the
    // transcript column, so no needle is read from a cropped sidebar column.
    const anchor = "After the todos."

    // A lone bash call is not a run: its panel keeps the transcript margin row
    // above its own top padding row, its own gap row between the command and the
    // output, and its bottom padding row plus the text margin below it. This is
    // the anatomy a panel inside a block does not get.
    expect(between(rowsOf(frame, anchor), anchor, "$ ls -la src")).toEqual(["", ""])
    expect(between(rowsOf(frame, anchor), "$ ls -la src", "widget.py")).toEqual([""])
    expect(between(rowsOf(frame, anchor), "widget.py", "After the command.")).toEqual(["", ""])

    // A non-work call ends the run: one blank row below the block's last detail
    // row, and it stays on the transcript column.
    expectOneBlankRowBetween(frame, anchor, `Read src${path.sep}b.py [limit=70, offset=1]`, "⚙ Updating todos...")
    expect(columnOf(frame, "⚙ Updating todos...")).toBe(columnOf(frame, "− Explored 2 files"))
    expectOneBlankRowBetween(frame, anchor, "⚙ Updating todos...", "After the todos.")
  })
})
