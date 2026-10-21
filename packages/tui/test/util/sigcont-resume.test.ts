// #426: SIGCONT resume dedupe and cleanup.
import { expect, mock, test } from "bun:test"
import { createSigcontResume } from "../../src/util/sigcont-resume"

function fakeRenderer() {
  return { isDestroyed: false, resume: mock(() => Promise.resolve()) }
}

test("re-arming dedupes the pending SIGCONT listener", () => {
  const baseline = process.listenerCount("SIGCONT")
  const renderer = fakeRenderer()
  const sigcont = createSigcontResume(renderer)
  sigcont.arm()
  sigcont.arm()
  expect(process.listenerCount("SIGCONT")).toBe(baseline + 1)
  process.emit("SIGCONT")
  expect(renderer.resume).toHaveBeenCalledTimes(1)
  expect(process.listenerCount("SIGCONT")).toBe(baseline)
})

test("dispose drops the pending listener so a later SIGCONT is a no-op", () => {
  const baseline = process.listenerCount("SIGCONT")
  const renderer = fakeRenderer()
  const sigcont = createSigcontResume(renderer)
  sigcont.arm()
  sigcont.dispose()
  expect(process.listenerCount("SIGCONT")).toBe(baseline)
  process.emit("SIGCONT")
  expect(renderer.resume).not.toHaveBeenCalled()
})

test("a renderer destroyed while stopped is not resumed", () => {
  const renderer = fakeRenderer()
  const sigcont = createSigcontResume(renderer)
  sigcont.arm()
  renderer.isDestroyed = true
  process.emit("SIGCONT")
  expect(renderer.resume).not.toHaveBeenCalled()
})
