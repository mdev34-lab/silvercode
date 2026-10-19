/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import type { ReasoningPart } from "@opencode-ai/sdk/v2"
import { DEFAULT_THEMES, addTheme, resolveTheme, type ThemeJson } from "../../../src/theme"
import {
  BASE,
  assistantMessage,
  disposeSessionRoutes,
  mountSessionRoute,
  sessionInfo,
  settle,
  spansMatching,
  textPart,
  userMessage,
  type MountOptions,
} from "../../fixture/session-route"

afterEach(disposeSessionRoutes)

// #241: the live "Thinking" label and the finished "Thought · duration" label
// take colour and style from the theme file, separately, and themes that
// predate the keys keep rendering both in `warning`.

// Two deliberately clashing themes: one dark with italic magenta / bold cyan,
// one built on a light palette with underlined blue / dim red.
const NEON: ThemeJson = {
  ...structuredClone(DEFAULT_THEMES.opencode!),
  theme: {
    ...DEFAULT_THEMES.opencode!.theme,
    thinkingOpacity: 1,
    thinkingStreaming: "#ff00ff",
    thinkingStreamingStyle: { italic: true },
    thinkingCompleted: "#00ffff",
    thinkingCompletedStyle: { bold: true },
  },
}
const PAPER: ThemeJson = {
  ...structuredClone(DEFAULT_THEMES.github!),
  theme: {
    ...DEFAULT_THEMES.github!.theme,
    thinkingOpacity: 1,
    thinkingStreaming: "#0000ff",
    thinkingStreamingStyle: { underline: true },
    thinkingCompleted: "#ff0000",
    thinkingCompletedStyle: { dim: true },
  },
}
addTheme("test-neon", NEON)
addTheme("test-paper", PAPER)

const SIZES = { normal: { width: 140, height: 40 }, narrow: { width: 80, height: 24 } } as const

function reasoning(messageID: string, sessionID: string, end?: number): ReasoningPart {
  return {
    id: "prt_reason",
    sessionID,
    messageID,
    type: "reasoning",
    text: "**Planning the fix**\n\nLooking at the scroll handler",
    time: { start: BASE, ...(end ? { end } : {}) },
  }
}

function scenario(state: "streaming" | "completed"): Omit<MountOptions, "width" | "height" | "theme"> {
  const session = sessionInfo("ses_01_main", { title: "Fix flaky scroll test" })
  const user = userMessage("msg_01_user", session.id, {})
  const assistant = assistantMessage("msg_02_assistant", session.id, {
    time: state === "completed" ? { created: BASE, completed: BASE + 5_000 } : { created: BASE },
  })
  return {
    sessions: [session],
    status: state === "streaming" ? { [session.id]: { type: "busy" } } : {},
    messages: {
      [session.id]: [
        { info: user, parts: [textPart("prt_u", user, "Please fix the flaky scroll test")] },
        {
          info: assistant,
          parts: [reasoning(assistant.id, session.id, state === "completed" ? BASE + 3_000 : undefined)],
        },
      ],
    },
  }
}

function hex(fg: { toInts(): [number, number, number, number] }) {
  const [r, g, b] = fg.toInts()
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")
}

describe("thinking labels are themeable (#241)", () => {
  for (const [name, expected] of [
    [
      "test-neon",
      {
        streaming: "#ff00ff",
        streamingBits: TextAttributes.ITALIC,
        completed: "#00ffff",
        completedBits: TextAttributes.BOLD,
      },
    ],
    [
      "test-paper",
      {
        streaming: "#0000ff",
        streamingBits: TextAttributes.UNDERLINE,
        completed: "#ff0000",
        completedBits: TextAttributes.DIM,
      },
    ],
  ] as const) {
    for (const [sizeName, size] of Object.entries(SIZES)) {
      test(`${name}: streaming label uses thinkingStreaming @ ${sizeName}`, async () => {
        const { app } = await mountSessionRoute({ ...scenario("streaming"), ...size, theme: name })
        await settle(app)
        const label = spansMatching(app, "Thinking: Planning the fix")
        expect(label.length).toBeGreaterThan(0)
        for (const span of label) {
          expect(hex(span.fg)).toBe(expected.streaming)
          expect(span.attributes & expected.streamingBits).toBe(expected.streamingBits)
          expect(span.attributes & expected.completedBits).toBe(0)
        }
        expect(spansMatching(app, "Thought").length).toBe(0)
      })

      test(`${name}: completed label uses thinkingCompleted and keeps its duration @ ${sizeName}`, async () => {
        const { app } = await mountSessionRoute({ ...scenario("completed"), ...size, theme: name })
        await settle(app)
        const label = spansMatching(app, "Thought: Planning the fix · 3.0s")
        expect(label.length).toBeGreaterThan(0)
        for (const span of label) {
          expect(hex(span.fg)).toBe(expected.completed)
          expect(span.attributes & expected.completedBits).toBe(expected.completedBits)
          expect(span.attributes & expected.streamingBits).toBe(0)
        }
        expect(spansMatching(app, "Thinking").length).toBe(0)
      })
    }
  }

  test("themes without the keys keep the warning colour for both labels", async () => {
    const warning = hex(resolveTheme(DEFAULT_THEMES.opencode!, "dark").warning)
    const done = await mountSessionRoute({ ...scenario("completed"), ...SIZES.normal })
    await settle(done.app)
    const completed = spansMatching(done.app, "Thought: Planning the fix · 3.0s")
    expect(completed.length).toBeGreaterThan(0)
    for (const span of completed) {
      expect(hex(span.fg)).toBe(warning)
      expect(
        span.attributes & (TextAttributes.BOLD | TextAttributes.ITALIC | TextAttributes.DIM | TextAttributes.UNDERLINE),
      ).toBe(0)
    }
  })

  test("themes without the keys dim the streaming label with thinkingOpacity, as before", async () => {
    const theme = resolveTheme(DEFAULT_THEMES.opencode!, "dark")
    const { app } = await mountSessionRoute({ ...scenario("streaming"), ...SIZES.normal })
    await settle(app)
    const streaming = spansMatching(app, "Thinking: Planning the fix")
    expect(streaming.length).toBeGreaterThan(0)
    for (const span of streaming) {
      // Blended towards the background at the default 0.6 opacity: same hue
      // family as `warning`, never the plain text colour, never full strength.
      const [r, g, b] = span.fg.toInts()
      const [wr, wg, wb] = theme.warning.toInts()
      expect(hex(span.fg)).not.toBe(hex(theme.text))
      expect(hex(span.fg)).not.toBe(hex(theme.warning))
      expect(Math.sign(wr - wg)).toBe(Math.sign(r - g))
      expect(Math.sign(wg - wb)).toBe(Math.sign(g - b))
    }
  })
})
