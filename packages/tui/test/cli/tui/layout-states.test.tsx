/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import type { Part, PermissionRequest, ReasoningPart, ToolPart } from "@opencode-ai/sdk/v2"
import {
  assistantMessage,
  BASE,
  disposeSessionRoutes,
  frameOf,
  mountSessionRoute,
  rows,
  sessionInfo,
  settle,
  snapshot,
  spansOf,
  textPart,
  userMessage,
  type MountOptions,
} from "../../fixture/session-route"

// #241 layout evidence: the real `<Session />` route in each work state at a
// normal (sidebar docked) and a narrow (sidebar hidden) size. Every state must
// keep the prompt, the session identity, the selected model/effort, the
// current work state and any attention need visible without overlap. Set
// LAYOUT_CAPTURE_DIR to also write the rendered frames for review.

afterEach(disposeSessionRoutes)

const SIZES = {
  normal: { width: 140, height: 40 },
  narrow: { width: 80, height: 24 },
} as const

function reasoning(messageID: string, sessionID: string, text: string, end?: number): ReasoningPart {
  return {
    id: "prt_reason",
    sessionID,
    messageID,
    type: "reasoning",
    text,
    time: { start: BASE, ...(end ? { end } : {}) },
  }
}

function tool(id: string, messageID: string, sessionID: string, running: boolean): ToolPart {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: id,
    tool: "bash",
    state: running
      ? { status: "running", input: { command: "bun test scroll.test.ts" }, time: { start: BASE } }
      : {
          status: "completed",
          input: { command: "bun test scroll.test.ts" },
          output: "1 pass",
          title: "",
          metadata: {},
          time: { start: BASE, end: BASE + 100 },
        },
  }
}

// The prompt reads the command from the tool call it guards, so the request
// points at the running bash part of the assistant message.
function permission(sessionID: string, messageID: string, callID: string): PermissionRequest {
  return {
    id: "per_1",
    sessionID,
    permission: "bash",
    patterns: ["bun test *"],
    metadata: {},
    always: ["bun test *"],
    tool: { messageID, callID },
  }
}

type State = "idle" | "working" | "permission" | "error" | "multi-session"

function scenario(state: State): Omit<MountOptions, "width" | "height"> {
  const session = sessionInfo("ses_01_main", { title: "Fix flaky scroll test", cost: 0.42 })
  const user = userMessage("msg_01_user", session.id)
  const base = {
    parentID: user.id,
    cost: 0.42,
    tokens: { input: 29_523, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const userRow = { info: user, parts: [textPart("prt_u1", user, "Please fix the flaky scroll test")] }

  if (state === "idle") {
    const assistant = assistantMessage("msg_02_assistant", session.id, { ...base, finish: "stop" })
    return {
      sessions: [session],
      messages: {
        [session.id]: [
          userRow,
          {
            info: assistant,
            parts: [
              reasoning(assistant.id, session.id, "**Planning the fix**\n\nThe test races layout.", BASE + 3000),
              textPart("prt_a1", assistant, "Done. The test now waits for layout to settle."),
            ],
          },
        ],
      },
    }
  }

  if (state === "working") {
    const assistant = assistantMessage("msg_02_assistant", session.id, { ...base, time: { created: BASE } })
    return {
      sessions: [session],
      status: { [session.id]: { type: "busy" } },
      messages: {
        [session.id]: [
          userRow,
          {
            info: assistant,
            parts: [
              reasoning(assistant.id, session.id, "**Planning the fix**\n\nLooking at the scroll handler"),
              tool("prt_tool_1", assistant.id, session.id, true),
            ],
          },
        ],
      },
    }
  }

  if (state === "permission") {
    const assistant = assistantMessage("msg_02_assistant", session.id, { ...base, time: { created: BASE } })
    return {
      sessions: [session],
      status: { [session.id]: { type: "busy" } },
      permissions: { [session.id]: [permission(session.id, assistant.id, "prt_tool_1")] },
      messages: {
        [session.id]: [userRow, { info: assistant, parts: [tool("prt_tool_1", assistant.id, session.id, true)] }],
      },
    }
  }

  if (state === "error") {
    const assistant = assistantMessage("msg_02_assistant", session.id, {
      ...base,
      error: {
        name: "APIError",
        data: { message: "API error: Rate limit exceeded. Try again in 5s.", isRetryable: true },
      },
    })
    return {
      sessions: [session],
      status: {
        [session.id]: { type: "retry", attempt: 2, message: "Rate limit exceeded", next: Date.now() + 30_000 },
      },
      messages: { [session.id]: [userRow, { info: assistant, parts: [] as Part[] }] },
    }
  }

  // multi-session: a parent with two subagent children, viewing the first child.
  const child1 = sessionInfo("ses_02_child", { title: "@explore subagent", parentID: session.id })
  const child2 = sessionInfo("ses_03_child", { title: "@review subagent", parentID: session.id })
  const childUser = userMessage("msg_01_user", child1.id)
  const childAssistant = assistantMessage("msg_02_assistant", child1.id, { ...base, time: { created: BASE } })
  return {
    sessions: [child1, session, child2],
    status: { [child1.id]: { type: "busy" } },
    messages: {
      [child1.id]: [
        { info: childUser, parts: [textPart("prt_cu1", childUser, "Find every caller of scrollTo")] },
        { info: childAssistant, parts: [tool("prt_tool_1", childAssistant.id, child1.id, true)] },
      ],
    },
  }
}

// No two primary controls may be drawn over each other: a row that contains
// an identity/status word must still contain it as a whole word.
function expectWholeWords(frame: string, words: string[]) {
  for (const word of words) {
    expect(frame).toContain(word)
  }
}

describe("session layout states (#241)", () => {
  for (const [sizeName, size] of Object.entries(SIZES)) {
    for (const state of ["idle", "working", "permission", "error", "multi-session"] as State[]) {
      test(`${state} @ ${sizeName} ${size.width}x${size.height}`, async () => {
        const { app } = await mountSessionRoute({ ...scenario(state), ...size })
        await settle(app)
        const frame = frameOf(app)
        await snapshot(app, `${state}-${sizeName}`)

        // Nothing wider than the terminal: every row fits the width exactly.
        for (const row of rows(app)) expect(row.length).toBe(size.width)

        // Model + effort stay discoverable from the prompt meta row in every
        // state that shows the prompt; the permission prompt replaces the
        // prompt but must announce itself instead of looking idle.
        if (state === "permission") {
          // The request, the guarded command and every action/hint are whole
          // words: nothing clipped at the right edge, even at 80 columns.
          expectWholeWords(frame, [
            "Permission required",
            "$ bun test scroll.test.ts",
            "Allow once",
            "Allow always",
            "Reject",
            "fullscreen",
            "select",
            "enter confirm",
          ])
          expect(frame).not.toContain("Ask anything")
        } else if (state === "multi-session") {
          // Child-session footer: identity and every navigation control intact.
          expectWholeWords(frame, ["Explore", "(1 of 2)", "Stop subagent", "Parent", "Prev", "Next"])
        } else {
          expectWholeWords(frame, ["Build", "Test Model", "medium"])
        }
        // The command-palette hint is the one secondary control that yields
        // its slot: a retry notice replaces it until the provider recovers.
        if (state === "idle" || state === "working") expect(frame).toContain("ctrl+p commands")

        if (state === "working") {
          // Work state: live reasoning label plus the interrupt affordance.
          expectWholeWords(spansOf(app), ["Thinking", "esc interrupt"])
        }
        if (state === "error") {
          // Failure cannot hide behind an idle-looking screen: the status line
          // carries the retry notice and the transcript carries the error.
          expectWholeWords(frame, ["Rate limit exceeded", "retrying", "attempt #2", "API error"])
          expect(frame).not.toContain("ctrl+p commands")
        }
        if (state === "idle") {
          // Completed reasoning keeps its duration visible once collapsed.
          expectWholeWords(frame, ["Thought", "3.0s"])
        }

        // Session identity and the context bar live in the docked sidebar at
        // the normal size; narrow terminals hide the sidebar by default, so
        // the idle status line names the session instead of the directory.
        if (sizeName === "normal" && state !== "multi-session") {
          expectWholeWords(frame, ["Fix flaky scroll test", "Context", "29,723 tokens · 15% used"])
        }
        if (sizeName === "narrow" && state === "idle") {
          expectWholeWords(frame, ["Fix flaky scroll test", "29.7K (15%)"])
          expect(frame).not.toContain("/tmp/opencode")
        }
      })
    }
  }
})
