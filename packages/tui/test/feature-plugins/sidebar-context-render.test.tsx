/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { captureFrame } from "../fixture/frame"
import { testRender, type JSX } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, SessionNextContextPrepared } from "@opencode-ai/sdk/v2"
import plugin from "../../src/feature-plugins/sidebar/context"

const message = (input: number): AssistantMessage => ({
  id: "m",
  sessionID: "s",
  role: "assistant",
  time: { created: 0, completed: 1 },
  parentID: "u",
  modelID: "model",
  providerID: "test",
  mode: "work",
  agent: "work",
  path: { cwd: "/tmp", root: "/tmp" },
  cost: 0,
  tokens: { input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
})

const report = (overrides: Partial<SessionNextContextPrepared["data"]> = {}): SessionNextContextPrepared["data"] => ({
  timestamp: 0,
  sessionID: "s",
  tokens: 30_000,
  overheadTokens: 4_000,
  reclaimedTokens: 0,
  limit: 200_000,
  utilization: 0.15,
  outcome: "untouched",
  ...overrides,
})

for (const item of [
  { name: "empty", messages: [], model: true, report: undefined, detail: "usage unknown", bar: "░".repeat(20) },
  {
    name: "missing-model",
    messages: [message(1199)],
    model: false,
    report: undefined,
    detail: "usage unknown",
    bar: "░".repeat(20),
  },
  {
    name: "measured-zero-percent",
    messages: [message(0)],
    model: true,
    report: undefined,
    detail: "1 tokens · 0% used",
    bar: "░".repeat(20),
  },
  {
    name: "input-only",
    messages: [{ ...message(30000), tokens: { input: 30000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }],
    model: true,
    report: undefined,
    detail: "30,000 tokens · 15% used",
    bar: "█".repeat(3) + "░".repeat(17),
  },
  {
    name: "near-limit",
    messages: [message(183999)],
    model: true,
    report: undefined,
    detail: "184,000 tokens · 92% used",
    bar: "█".repeat(18) + "░".repeat(2),
  },
  {
    // The runtime measured a request much smaller than the assistant turn that produced it: the
    // report wins, so the sidebar cannot describe a request that was never sent.
    name: "reduced-report-overrides-assistant-tokens",
    messages: [message(183999)],
    model: true,
    report: report({ tokens: 60_000, reclaimedTokens: 124_000, utilization: 0.3, outcome: "reduced" }),
    detail: "60,000 tokens · 124,000 reclaimed",
    bar: "█".repeat(6) + "░".repeat(14),
  },
  {
    name: "exhausted-report",
    messages: [message(183999)],
    model: true,
    report: report({ tokens: 190_000, reclaimedTokens: 12_000, utilization: 0.95, outcome: "exhausted" }),
    detail: "190,000 tokens · context exhausted",
    bar: "█".repeat(19) + "░".repeat(1),
  },
  {
    name: "report-without-declared-window",
    messages: [message(183999)],
    model: false,
    report: report({ limit: undefined, utilization: 0 }),
    detail: "usage unknown",
    bar: "░".repeat(20),
  },
])
  test(`render slot ${item.name}`, async () => {
    let view!: () => JSX.Element
    const api = {
      theme: { current: { text: RGBA.fromHex("#eeeeee"), textMuted: RGBA.fromHex("#aaaaaa") } },
      state: {
        session: {
          messages: () => item.messages,
          get: () => ({ cost: 1.25 }),
          context: () => item.report,
        },
        provider: item.model ? [{ id: "test", models: { model: { limit: { context: 200000 } } } }] : [],
      },
      slots: {
        register: (definition: {
          slots: { sidebar_content: (ctx: unknown, props: { session_id: string }) => JSX.Element }
        }) => {
          view = () => definition.slots.sidebar_content({}, { session_id: "s" })
        },
      },
    } as unknown as TuiPluginApi
    await plugin.tui(api, undefined, {
      id: plugin.id,
      source: "internal",
      spec: plugin.id,
      target: plugin.id,
      first_time: 0,
      last_time: 0,
      time_changed: 0,
      load_count: 1,
      fingerprint: "test",
      state: "first",
    })
    const app = await testRender(() => view(), { width: 40, height: 6 })
    try {
      await app.renderOnce()
      const frame = await captureFrame(app)
      expect(frame).toContain("Context")
      expect(frame).toContain(item.bar)
      expect(frame).toContain(item.detail)
      expect(frame).toContain("$1.25 spent")
      expect(frame).not.toContain("▨")
    } finally {
      app.renderer.destroy()
    }
  })
