import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { finishBlockView, tintColor } from "../../../src/routes/session"

function part(status: "pending" | "running" | "completed" | "error", metadata?: Record<string, unknown>) {
  return { state: { status, input: {}, metadata } } as unknown as Parameters<typeof finishBlockView>[0]
}

describe("finish block view", () => {
  test("a finished call is colored by the reason the agent declared", () => {
    expect(finishBlockView(part("completed"), { reason: "success" }, "done")).toMatchObject({
      tone: "success",
      title: "✓ Task completed",
      detail: "done",
    })
    expect(finishBlockView(part("completed"), { reason: "failure" }, "no")).toMatchObject({
      tone: "failure",
      title: "✗ Task failed",
    })
    expect(finishBlockView(part("completed"), { reason: "waiting_for_subagent" })?.tone).toBe("waiting")
    expect(finishBlockView(part("completed", { waiting: true }), { reason: "success" })?.tone).toBe("waiting")
  })

  test("a call that errored is the quiet row, not the red failed block", () => {
    expect(finishBlockView(part("error"), { reason: "failure" })).toMatchObject({
      tone: "quiet",
      title: "Finish call failed",
    })
  })

  test("pending and running calls have no block", () => {
    expect(finishBlockView(part("pending"), {})).toBeUndefined()
    expect(finishBlockView(part("running"), {})).toBeUndefined()
  })

  test("the tint is a dark blend of the color over the base", () => {
    const tint = tintColor(RGBA.fromInts(100, 200, 100), RGBA.fromInts(20, 20, 20), 0.14)
    expect(tint.g).toBeGreaterThan(RGBA.fromInts(20, 20, 20).g)
    expect(tint.g).toBeLessThan(RGBA.fromInts(100, 200, 100).g)
  })
})
