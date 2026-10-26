import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { QwenWebBrowser, type QwenWebContext, type QwenWebLauncher, type QwenWebPage } from "../src/adapters/qwen/browser"

// A window revealed for a challenge is shown once; the retry and later requests must run headless again.
function fakeLauncher() {
  const launches: boolean[] = []
  const launcher: QwenWebLauncher = async (_dir, options) => {
    launches.push(options.headless)
    const closers: Array<() => void> = []
    let closed = false
    const page: QwenWebPage = {
      url: () => "https://chat.qwen.ai/",
      isClosed: () => closed,
      goto: async () => undefined,
      evaluate: async () => undefined as never,
      exposeBinding: async () => undefined,
      title: async () => "Qwen",
      context: () => context,
      on: () => undefined,
      close: async () => undefined,
      setDefaultTimeout: () => undefined,
      setDefaultNavigationTimeout: () => undefined,
    }
    const context: QwenWebContext = {
      pages: () => [page],
      newPage: async () => page,
      cookies: async () => [],
      close: async () => {
        closed = true
        closers.forEach((fn) => fn())
      },
      on: (_event, handler) => void closers.push(handler),
    }
    return context
  }
  return { launches, launcher }
}

describe("Qwen challenge window", () => {
  let dir: string
  let display: string | undefined
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-headless-"))
    display = process.env["DISPLAY"]
    process.env["DISPLAY"] = ":99"
    delete process.env["QWEN_WEB_HEADLESS"]
  })
  afterEach(() => {
    if (display === undefined) delete process.env["DISPLAY"]
    else process.env["DISPLAY"] = display
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("the retry and later requests go back to headless after a challenge window", async () => {
    const { launches, launcher } = fakeLauncher()
    const browser = new QwenWebBrowser({ launcher, profileDir: dir })
    await browser.ensureForRequest()
    expect(launches).toEqual([true])
    expect(await browser.revealForChallenge()).toBe(true)
    expect(launches).toEqual([true, false])
    await browser.ensureForRequest()
    await browser.ensureForRequest()
    expect(launches).toEqual([true, false, true])
    await browser.close()
  })

  test("concurrent retries share one headless relaunch", async () => {
    const { launches, launcher } = fakeLauncher()
    const browser = new QwenWebBrowser({ launcher, profileDir: dir })
    await browser.ensureForRequest()
    await browser.revealForChallenge()
    await Promise.all([browser.ensureForRequest(), browser.ensureForRequest(), browser.ensureForRequest()])
    expect(launches).toEqual([true, false, true])
    await browser.close()
  })

  test("the restore waits while another request is mid-flight, then happens on a later request", async () => {
    const { launches, launcher } = fakeLauncher()
    const browser = new QwenWebBrowser({ launcher, profileDir: dir })
    await browser.ensureForRequest()
    await browser.revealForChallenge()
    await browser.ensureForRequest(undefined, { canRestore: () => false })
    await browser.ensureForRequest(undefined, { canRestore: () => false })
    expect(launches).toEqual([true, false])
    await browser.ensureForRequest(undefined, { canRestore: () => true })
    expect(launches).toEqual([true, false, true])
    await browser.close()
  })

  test("explicit headless never opens a window", async () => {
    const { launches, launcher } = fakeLauncher()
    const browser = new QwenWebBrowser({ launcher, profileDir: dir, headless: true })
    await browser.ensureForRequest()
    expect(await browser.revealForChallenge()).toBe(false)
    expect(launches).toEqual([true])
    await browser.close()
  })
})
