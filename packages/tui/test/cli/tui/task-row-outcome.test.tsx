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

const envelope = (state: string) =>
  `task_id: ses_child\n<task id="ses_child" state="${state}">\n<task_result>\nbody\n</task_result>\n</task>`

test("a cancelled foreground Task row is not shown as a completed check", async () => {
  const id = "ses_task_rows"
  const user = userMessage("msg_user", id, { agent: "work" })
  const assistant = assistantMessage("msg_assistant", id, { agent: "work", mode: "work" })
  const row = (n: number, description: string, state: string): ToolPart => ({
    id: `prt_task_${n}`,
    sessionID: id,
    messageID: assistant.id,
    type: "tool",
    tool: "task",
    callID: `call_${n}`,
    state: {
      status: "completed",
      input: { description, prompt: "x", subagent_type: "review" },
      output: envelope(state),
      title: description,
      metadata: {},
      time: { start: 1700000000000, end: 1700000001000 },
    },
  })
  const { app } = await mountSessionRoute({
    width: 110,
    height: 24,
    sessions: [sessionInfo(id)],
    messages: {
      [id]: [
        { info: user, parts: [textPart("prt_001", user, "Review the change")] },
        {
          info: assistant,
          parts: [row(1, "Delivered review", "completed"), row(2, "Interrupted review", "cancelled")],
        },
      ],
    },
  })
  await waitFor(app, () => (app.captureCharFrame().includes("Interrupted review") ? true : undefined))
  const frame = await frameOf(app)
  if (process.env.TASK_ROW_CAPTURE) await Bun.write(process.env.TASK_ROW_CAPTURE, frame)
  const lines = frame.split("\n")
  const delivered = lines.find((line) => line.includes("Delivered review"))!
  const cancelled = lines.find((line) => line.includes("Interrupted review"))!
  expect(delivered).toContain("✓")
  expect(cancelled).not.toContain("✓")
  expect(cancelled).toContain("○")
  expect(frame).toContain("Cancelled before delivering a result")
})
