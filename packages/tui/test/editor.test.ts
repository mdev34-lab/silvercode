import { afterEach, expect, test } from "bun:test"
import { normalizePromptContent, openEditor } from "../src/editor"

const editor = process.env.EDITOR
const visual = process.env.VISUAL

afterEach(() => {
  process.env.EDITOR = editor
  process.env.VISUAL = visual
})

test("rejects when the external editor cannot start", async () => {
  delete process.env.VISUAL
  process.env.EDITOR = "opencode-editor-that-does-not-exist"
  const renderer = {
    suspend() {},
    resume() {},
    requestRender() {},
    currentRenderBuffer: { clear() {} },
  }

  await expect(openEditor({ value: "original", renderer: renderer as never })).rejects.toThrow()
})

test("normalizes a single trailing editor newline for one-line prompts", () => {
  expect(normalizePromptContent("hello\n")).toBe("hello")
  expect(normalizePromptContent("hello\r\n")).toBe("hello")
})

test("preserves multiline prompts that end with a newline", () => {
  expect(normalizePromptContent("hello\nworld\n")).toBe("hello\nworld\n")
})

// Cross-platform no-op editor: the current bun/node binary with --version
// exits 0 without touching the file, so openEditor returns the original value.
// (EDITOR="true" is not a command on Windows.)
function useNoopEditor() {
  delete process.env.VISUAL
  process.env.EDITOR = `${process.execPath} --version`
}

function makeRenderer(overrides: Record<string, unknown> = {}) {
  const calls = { suspend: 0, resume: 0, requestRender: 0 }
  const renderer = {
    calls,
    isDestroyed: false,
    suspend() {
      calls.suspend++
    },
    async resume() {
      calls.resume++
    },
    requestRender() {
      calls.requestRender++
    },
    currentRenderBuffer: { clear() {} },
    ...overrides,
  }
  return renderer
}

test("skips resume when the renderer was destroyed while the editor ran (#377)", async () => {
  useNoopEditor()
  const renderer = makeRenderer({ isDestroyed: true })

  await expect(openEditor({ value: "original", renderer: renderer as never })).resolves.toBe("original")
  expect(renderer.calls.resume).toBe(0)
  expect(renderer.calls.requestRender).toBe(0)
})

test("resumes and repaints when the renderer stays live (#377)", async () => {
  useNoopEditor()
  const renderer = makeRenderer()

  await expect(openEditor({ value: "original", renderer: renderer as never })).resolves.toBe("original")
  expect(renderer.calls.resume).toBe(1)
  expect(renderer.calls.requestRender).toBe(1)
})

test("swallows a resume() failure only when teardown landed mid-resume (#377)", async () => {
  useNoopEditor()
  const renderer = makeRenderer({
    async resume() {
      renderer.calls.resume++
      // Teardown lands while resume() is in flight (the async race): the
      // native guard then throws on the destroyed renderer.
      renderer.isDestroyed = true
      throw new Error("Native scene resume requires completed suspension")
    },
  })

  await expect(openEditor({ value: "original", renderer: renderer as never })).resolves.toBe("original")
  expect(renderer.calls.resume).toBe(1)
  expect(renderer.calls.requestRender).toBe(0)
})

test("propagates a resume() failure when the renderer is still live (#377)", async () => {
  useNoopEditor()
  const renderer = makeRenderer({
    async resume() {
      renderer.calls.resume++
      throw new Error("terminal ioctl failed")
    },
  })

  await expect(openEditor({ value: "original", renderer: renderer as never })).rejects.toThrow(
    "terminal ioctl failed",
  )
  expect(renderer.calls.requestRender).toBe(0)
})

test("skips requestRender when teardown lands after a successful resume (#377)", async () => {
  useNoopEditor()
  const renderer = makeRenderer({
    async resume() {
      renderer.calls.resume++
      renderer.isDestroyed = true
    },
  })

  await expect(openEditor({ value: "original", renderer: renderer as never })).resolves.toBe("original")
  expect(renderer.calls.resume).toBe(1)
  expect(renderer.calls.requestRender).toBe(0)
})
