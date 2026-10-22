import { expect, test } from "bun:test"
import { captureFrame } from "./fixture/frame"

test("captureFrame retries OutputBusy and then returns the frame", async () => {
  let calls = 0
  const frame = await captureFrame({
    captureCharFrame() {
      calls++
      if (calls < 3) throw new Error("OutputBusy: buffer leased")
      return "frame"
    },
  })
  expect(frame).toBe("frame")
  expect(calls).toBe(3)
})

test("captureFrame rethrows non-busy errors without retrying", async () => {
  let calls = 0
  await expect(
    captureFrame({
      captureCharFrame() {
        calls++
        throw new Error("boom")
      },
    }),
  ).rejects.toThrow("boom")
  expect(calls).toBe(1)
})

test("captureFrame gives up after the retry budget when the buffer stays busy", async () => {
  let calls = 0
  await expect(
    captureFrame({
      captureCharFrame() {
        calls++
        throw new Error("OutputBusy: buffer leased")
      },
    }),
  ).rejects.toThrow("OutputBusy")
  expect(calls).toBe(41)
})
