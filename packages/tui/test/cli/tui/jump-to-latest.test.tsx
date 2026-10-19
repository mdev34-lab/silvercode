/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import {
  assistantMessage,
  disposeSessionRoutes,
  frameOf,
  mountSessionRoute,
  rows,
  sessionInfo,
  settle,
  snapshot,
  textPart,
  userMessage,
} from "../../fixture/session-route"

afterEach(disposeSessionRoutes)

// #241: a transcript that is scrolled away from its newest output keeps a
// visible "Jump to latest" affordance. Invoking it returns to the latest
// message, never touches the prompt draft, and new output must not yank a
// reader back down while they are looking at older messages.

const SESSION = sessionInfo("ses_01_main", { title: "Long transcript" })
const CHIP = "Jump to latest"

function transcript(turns: number) {
  const list: { info: Message; parts: Part[] }[] = []
  for (let i = 1; i <= turns; i++) {
    const n = String(i).padStart(2, "0")
    const user = userMessage(`msg_${n}a_user`, SESSION.id, {})
    const assistant = assistantMessage(`msg_${n}b_assistant`, SESSION.id, {})
    list.push({ info: user, parts: [textPart(`prt_${n}u`, user, `Question ${i}`)] })
    list.push({ info: assistant, parts: [textPart(`prt_${n}a`, assistant, `Reply ${i}\nline two\nline three`)] })
  }
  return list
}

function firstVisibleTurn(app: Parameters<typeof frameOf>[0]) {
  return rows(app)
    .find((row) => row.includes("Question"))
    ?.trim()
}

// Wheel over the transcript (right of the docked sidebar at the normal size).
async function wheel(app: Awaited<ReturnType<typeof mountSessionRoute>>["app"], times: number) {
  for (let i = 0; i < times; i++) await app.mockMouse.scroll(app.renderer.width - 10, 5, "up")
  await settle(app)
}

describe("jump to latest (#241)", () => {
  for (const [sizeName, size] of Object.entries({
    normal: { width: 140, height: 40 },
    narrow: { width: 80, height: 24 },
  })) {
    test(`appears only when scrolled away and returns to the latest output @ ${sizeName}`, async () => {
      const { app, sync, keymap } = await mountSessionRoute({
        ...size,
        sessions: [SESSION],
        messages: { [SESSION.id]: transcript(30) },
      })
      await settle(app)

      // Pinned to the newest output: no chip, latest reply visible.
      expect(frameOf(app)).toContain("Reply 30")
      expect(frameOf(app)).not.toContain(CHIP)

      // A draft in the prompt must survive everything below. (The prompt
      // stashes its draft across mounts, so start from an empty one.)
      keymap().dispatchCommand("prompt.clear")
      await app.mockInput.typeText("draft text")
      await settle(app)
      expect(rows(app).filter((row) => row.includes("draft text")).length).toBe(1)

      await wheel(app, 6)
      await snapshot(app, `scrolled-away-${sizeName}`)
      const parked = firstVisibleTurn(app)
      expect(frameOf(app)).not.toContain("Reply 30")
      expect(frameOf(app)).toContain(CHIP)
      // The chip sits in the gap row above the prompt: one row, fully inside
      // the terminal width, and it does not shift the prompt or the draft.
      const chipRows = rows(app).filter((row) => row.includes(CHIP))
      expect(chipRows.length).toBe(1)
      expect(chipRows[0]!.length).toBe(size.width)
      expect(frameOf(app)).toContain("draft text")

      // New output arrives while the reader is away: the viewport stays put
      // and the chip stays on screen.
      const late = assistantMessage("msg_99_assistant", SESSION.id, {})
      sync.set("message", SESSION.id, (list) => [...list, late])
      sync.set("part", late.id, [textPart("prt_99", late, "Reply 31 arrives late")])
      await settle(app)
      expect(firstVisibleTurn(app)).toBe(parked)
      expect(frameOf(app)).not.toContain("Reply 31")
      expect(frameOf(app)).toContain(CHIP)

      // Keyboard path: the existing hidden command the chip advertises.
      keymap().dispatchCommand("session.last")
      await settle(app)
      expect(frameOf(app)).toContain("Reply 31 arrives late")
      expect(frameOf(app)).not.toContain(CHIP)
      expect(frameOf(app)).toContain("draft text")

      // Sticky scrolling is re-engaged: further output follows automatically.
      const later = assistantMessage("msg_99b_assistant", SESSION.id, {})
      sync.set("message", SESSION.id, (list) => [...list, later])
      sync.set("part", later.id, [textPart("prt_99b", later, "Reply 32 follows")])
      await settle(app)
      expect(frameOf(app)).toContain("Reply 32 follows")
      expect(frameOf(app)).not.toContain(CHIP)
    })
  }

  test("the chip is a click target", async () => {
    const { app } = await mountSessionRoute({
      width: 80,
      height: 24,
      sessions: [SESSION],
      messages: { [SESSION.id]: transcript(30) },
    })
    await settle(app)
    await wheel(app, 6)
    const row = rows(app).findIndex((line) => line.includes(CHIP))
    const col = rows(app)[row]!.indexOf(CHIP)
    expect(row).toBeGreaterThan(0)

    await app.mockMouse.click(col + 2, row)
    await settle(app)
    expect(frameOf(app)).toContain("Reply 30")
    expect(frameOf(app)).not.toContain(CHIP)
  })

  test("a short transcript never shows the chip", async () => {
    const { app } = await mountSessionRoute({
      width: 80,
      height: 24,
      sessions: [SESSION],
      messages: { [SESSION.id]: transcript(1) },
    })
    await settle(app)
    await wheel(app, 3)
    expect(frameOf(app)).toContain("Reply 1")
    expect(frameOf(app)).not.toContain(CHIP)
  })
})
