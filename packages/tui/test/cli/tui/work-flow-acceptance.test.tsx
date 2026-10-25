/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import {
  assistantMessage,
  userMessage,
  sessionInfo,
  textPart,
  mountSessionRoute,
  disposeSessionRoutes,
  frameOf,
  waitFor,
} from "../../fixture/session-route"
import type { ToolPart } from "@opencode-ai/sdk/v2"
afterEach(disposeSessionRoutes)
test.skipIf(!process.env.WORK_FLOW_CAPTURE)(
  "actual runtime workflow refusal hydrates in the actual session route",
  async () => {
    const id = "ses_work_flow",
      user = userMessage("msg_user", id, { agent: "work" }),
      assistant = assistantMessage("msg_assistant", id, { agent: "work", mode: "work" })
    const runtime = await Bun.file("/tmp/wf-runtime-refusal.json").json()
    const error = runtime.error
    expect(error).toContain("successful Think")
    const part: ToolPart = {
      id: "prt_002",
      sessionID: id,
      messageID: assistant.id,
      type: "tool",
      tool: "task",
      callID: "blocked",
      state: { status: "error", input: runtime.input, error, time: { start: 1700000000000, end: 1700000001000 } },
    }
    const { app } = await mountSessionRoute({
      width: 110,
      height: 34,
      sessions: [sessionInfo(id)],
      messages: {
        [id]: [
          { info: user, parts: [textPart("prt_001", user, "Fix the Python software bug")] },
          {
            info: assistant,
            parts: [
              part,
              textPart(
                "prt_003",
                assistant,
                "Implementation is blocked until Think returns a successful plan. This is not a completed result.",
              ),
            ],
          },
        ],
      },
    })
    await waitFor(app, () => (app.captureCharFrame().includes("Think") ? true : undefined))
    await Bun.write("/tmp/wf-tui-frame.txt", await frameOf(app))
    expect(await frameOf(app)).toContain("Think")
  },
)

test.skipIf(!process.env.WORK_FLOW_CAPTURE)(
  "actual successful runtime workflow hydrates with Review and completed finish",
  async () => {
    const runtime = await Bun.file("/tmp/wf-runtime-success-medium.json").json()
    const { app } = await mountSessionRoute({
      width: 120,
      height: 42,
      sessions: [runtime.session, ...runtime.children],
      messages: { [runtime.session.id]: runtime.messages, ...runtime.childMessages },
    })
    await waitFor(app, () => (app.captureCharFrame().includes("reviewed work") ? true : undefined))
    const frame = await frameOf(app)
    await Bun.write("/tmp/wf-tui-success.txt", frame)
    expect(frame).toContain("reviewed work")
    expect(frame).toContain("Review")
  },
)

test.skipIf(!process.env.WORK_FLOW_CAPTURE)(
  "actual runtime-owned scope question is readable in the session route",
  async () => {
    const runtime = await Bun.file("/tmp/wf-runtime-question.json").json()
    const { app, sync } = await mountSessionRoute({
      width: 120,
      height: 36,
      sessions: [runtime.session],
      messages: { [runtime.session.id]: [] },
    })
    sync.set("question", runtime.session.id, [runtime.question])
    await waitFor(app, () => (app.captureCharFrame().includes("Non-programming") ? true : undefined))
    const frame = await frameOf(app)
    await Bun.write("/tmp/wf-tui-question.txt", frame)
    expect(frame).toContain("Programming")
    expect(frame).toContain("Non-programming")
  },
)
