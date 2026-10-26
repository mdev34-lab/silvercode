import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { QwenWebBrowser, type QwenWebContext, type QwenWebLauncher, type QwenWebPage } from "../src/adapters/qwen/browser"
import { QwenWebTransport } from "../src/adapters/qwen/transport"

// Real QwenWebBrowser + real QwenWebTransport over a fake launcher: a headless relaunch after a challenge
// window must never close a page that a one-shot request is still using.
function harness() {
  const launches: boolean[] = []
  const used: Array<{ id: number; closedAtUse: boolean }> = []
  const gates: Array<() => void> = []
  let hold = false
  let failNext = false
  const launcher: QwenWebLauncher = async (_dir, options) => {
    const id = launches.push(options.headless)
    const closers: Array<() => void> = []
    let closed = false
    const page: QwenWebPage = {
      url: () => "https://chat.qwen.ai/",
      isClosed: () => closed,
      goto: async () => undefined,
      evaluate: (async () => {
        if (hold) await new Promise<void>((resolve) => gates.push(resolve))
        used.push({ id, closedAtUse: closed })
        if (failNext) {
          failNext = false
          throw new Error("boom")
        }
        if (closed) throw new Error("Target page, context or browser has been closed")
        return { status: 200, statusText: "OK", contentType: "application/json", body: "{}" }
      }) as QwenWebPage["evaluate"],
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
  return {
    launches,
    used,
    launcher,
    hold: (value: boolean) => (hold = value),
    failNext: () => (failNext = true),
    release: () => gates.splice(0).forEach((fn) => fn()),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 15))

describe("Qwen headless restore with the real browser and transport", () => {
  let dir: string
  let display: string | undefined
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-restore-"))
    display = process.env["DISPLAY"]
    process.env["DISPLAY"] = ":99"
    delete process.env["QWEN_WEB_HEADLESS"]
  })
  afterEach(() => {
    if (display === undefined) delete process.env["DISPLAY"]
    else process.env["DISPLAY"] = display
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("a request in flight keeps the revealed window until it finishes, then the next request goes headless", async () => {
    const h = harness()
    const browser = new QwenWebBrowser({ launcher: h.launcher, profileDir: dir })
    const transport = new QwenWebTransport({ browser, metadataTimeoutMs: 2000 })
    h.hold(true)
    const first = transport.requestJson("GET", "/one")
    await tick()
    h.hold(false)
    // a challenge shows the window while the first request is still running
    expect(await browser.revealForChallenge()).toBe(true)
    expect(h.launches).toEqual([true, false])
    // a competitor arrives: the first one is mid-flight, so no restore
    const second = await transport.requestJson("GET", "/two")
    expect(second.status).toBe(200)
    expect(h.launches).toEqual([true, false])
    h.release()
    await first.catch(() => undefined)
    // everything finished: the next request restores headless once, and a later one does not relaunch
    await transport.requestJson("GET", "/three")
    await transport.requestJson("GET", "/four")
    expect(h.launches).toEqual([true, false, true])
    expect(h.used.filter((entry) => entry.id === 2).every((entry) => !entry.closedAtUse)).toBe(true)
    await browser.close()
  })

  test("a failed request does not leave the counter stuck, so a later restore still happens", async () => {
    const h = harness()
    const browser = new QwenWebBrowser({ launcher: h.launcher, profileDir: dir })
    const transport = new QwenWebTransport({ browser, metadataTimeoutMs: 2000 })
    await transport.requestJson("GET", "/warm")
    h.failNext()
    await transport.requestJson("GET", "/fails").catch(() => undefined)
    expect(await browser.revealForChallenge()).toBe(true)
    await transport.requestJson("GET", "/after")
    expect(h.launches).toEqual([true, false, true])
    await browser.close()
  })
})
