/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import {
  BASE,
  assistantMessage,
  disposeSessionRoutes,
  frameOf,
  mountSessionRoute,
  provider,
  rows,
  sessionInfo,
  settle,
  textPart,
  userMessage,
  waitFor,
  type MountOptions,
} from "../../fixture/session-route"
import { CONTEXT_BAR_WIDTH, contextBarGlyphs, type ContextUsage } from "../../../src/feature-plugins/sidebar/context"
import { Locale } from "../../../src/util/locale"
import { DEFAULT_THEMES, addTheme } from "../../../src/theme"

afterEach(disposeSessionRoutes)

// #241 owns the presentation of the context indicator: the sidebar bar is
// primary, the status-line count/percent (and the same detail in a subagent
// footer) is optional and must agree with the bar, and "unknown" may never
// look like a confidently empty bar. Measurement semantics belong to #243 —
// these tests only check that every surface reads the one shared source.

addTheme("test-context-light", structuredClone(DEFAULT_THEMES.github!))

// `input-only` is a completed turn with measured input but no output tokens:
// the sidebar always counted it, the status line used to ignore it.
const STATES = {
  empty: { input: 0, output: 0, context: 200_000 },
  partial: { input: 29_523, output: 200, context: 200_000 },
  "input-only": { input: 30_000, output: 0, context: 200_000 },
  "near-limit": { input: 183_800, output: 200, context: 200_000 },
  unknown: { input: 29_523, output: 200, context: 0 },
} as const

type StateName = keyof typeof STATES

function expectedUsage(state: StateName): ContextUsage {
  const { input, output, context } = STATES[state]
  const tokens = input + output
  if (tokens === 0) return { status: "unknown", tokens: 0 }
  if (!context) return { status: "unknown", tokens }
  return { status: "known", tokens, percent: Math.round((tokens / context) * 100) }
}

// #139 replaced the old util/context-usage module (contextLabel/contextUsageFrom)
// with the report-driven derivation; the compact label format itself is
// unchanged, so the oracle is kept here in the same shape #241 asserted.
function compactLabel(usage: ContextUsage) {
  if (usage.status === "unknown") return
  return `${Locale.number(usage.tokens)} (${usage.percent}%)`
}

function scenario(state: StateName, child = false): Omit<MountOptions, "width" | "height" | "theme"> {
  const { input, output, context } = STATES[state]
  const parent = sessionInfo("ses_01_main", { title: "Fix flaky scroll test" })
  const session = child ? sessionInfo("ses_02_child", { title: "@explore subagent", parentID: parent.id }) : parent
  const user = userMessage("msg_01_user", session.id, {})
  const assistant = assistantMessage("msg_02_assistant", session.id, {
    time: { created: BASE, completed: BASE + 5_000 },
    tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const parts: NonNullable<MountOptions["messages"]>[string] = [
    { info: user, parts: [textPart("prt_u", user, "Please fix the flaky scroll test")] },
  ]
  if (input + output > 0) parts.push({ info: assistant, parts: [textPart("prt_a", assistant, "Done.")] })
  return {
    sessions: child ? [session, parent] : [session],
    providers: [provider(context)],
    messages: { [session.id]: parts },
  }
}

async function barRow(app: Parameters<typeof rows>[0]) {
  return (await rows(app)).find((row) => /[█░]{20}/.test(row))
}

const SIZES = { normal: { width: 140, height: 40 }, narrow: { width: 80, height: 24 } } as const

describe("context indicator agreement (#241)", () => {
  for (const theme of [undefined, "test-context-light"]) {
    for (const [sizeName, size] of Object.entries(SIZES)) {
      for (const state of Object.keys(STATES) as StateName[]) {
        test(`${state} @ ${sizeName} (${theme ?? "default theme"})`, async () => {
          const { app, keymap } = await mountSessionRoute({ ...scenario(state), ...size, theme })
          await settle(app)
          // Narrow terminals hide the sidebar; the toggle brings the same bar
          // back as an overlay, so the primary indicator is still reachable.
          if (sizeName === "narrow") {
            keymap().dispatchCommand("session.sidebar.toggle")
            await waitFor(app, () => (app.captureCharFrame().includes("Context") ? true : undefined))
            await settle(app)
          }

          const usage = expectedUsage(state)
          const frame = await frameOf(app)
          const bar = await barRow(app)
          expect(bar).toBeDefined()
          expect(bar).toContain(contextBarGlyphs(usage))

          if (usage.status === "unknown") {
            // Unknown is explicit text next to an empty bar, and the compact
            // status-line detail shows no count at all.
            expect(frame).toContain("usage unknown")
            expect(frame).not.toMatch(/\d+% used/)
            expect(frame).not.toMatch(/\(\d+%\)/)
            expect(frame).not.toMatch(/\b\d+(\.\d+)?K\b/)
            expect(frame).not.toContain("0 tokens")
            return
          }

          // The detail line and the compact status-line label are derived from
          // the same measurement the bar was drawn from.
          const filled = Math.round((usage.percent / 100) * CONTEXT_BAR_WIDTH)
          expect(bar!.match(/█/g)?.length ?? 0).toBe(filled)
          expect(frame).toContain(`${usage.tokens.toLocaleString()} tokens · ${usage.percent}% used`)
          expect(frame).toContain(compactLabel(usage)!)
        })
      }
    }
  }

  // Child sessions replace the prompt with the subagent footer (and show no
  // sidebar), so the footer's compact detail is the only readout there: it
  // must be the same label the status line derives from the shared source.
  test("a subagent footer shows the same compact detail as the status line would", async () => {
    const { app } = await mountSessionRoute({ ...scenario("near-limit", true), ...SIZES.normal })
    await settle(app)
    const frame = await frameOf(app)
    expect(frame).toContain("Explore")
    expect(frame).toContain(compactLabel(expectedUsage("near-limit"))!)
  })

  test("a subagent footer with unknown usage shows no count", async () => {
    const { app } = await mountSessionRoute({ ...scenario("unknown", true), ...SIZES.normal })
    await settle(app)
    const frame = await frameOf(app)
    expect(frame).toContain("Explore")
    expect(frame).not.toMatch(/\(\d+%\)/)
    expect(frame).not.toMatch(/\d+(\.\d+)?K\b/)
  })
})
