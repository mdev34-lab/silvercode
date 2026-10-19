import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  defaultProfileDir,
  hasDisplay,
  patchrightLaunchOptions,
  profileExists,
  QwenWebBrowser,
  quickAuthState,
  readProfileMetadata,
  type QwenWebContext,
  type QwenWebPage,
} from "@opencode-ai/webchat/adapters/qwen/browser"

let tmpdirs: string[] = []
const savedEnv = { ...process.env }

function tmpProfile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-web-profile-"))
  tmpdirs.push(dir)
  return dir
}

afterEach(() => {
  process.env = { ...savedEnv }
  for (const dir of tmpdirs) fs.rmSync(dir, { recursive: true, force: true })
  tmpdirs = []
})

function fakePage(overrides: Partial<QwenWebPage> = {}): QwenWebPage & { navigations: string[] } {
  const page = {
    navigations: [] as string[],
    url: () => "https://chat.qwen.ai/",
    isClosed: () => false,
    goto: async (url: string) => {
      page.navigations.push(url)
      return {} as unknown
    },
    evaluate: async () => undefined as unknown,
    exposeBinding: async () => {},
    title: async () => "",
    context: () =>
      ({
        cookies: async () => [],
      }) as unknown as QwenWebContext,
    on: () => {},
    close: async () => {},
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    ...overrides,
  }
  return page as unknown as QwenWebPage & { navigations: string[] }
}

function fakeContext(pages: QwenWebPage[]): QwenWebContext & { closed: boolean; created: number } {
  const context = {
    closed: false,
    created: 0,
    pages: () => pages.filter((page) => !page.isClosed()),
    newPage: async () => {
      context.created++
      const page = fakePage()
      pages.push(page)
      return page
    },
    cookies: async () => [],
    close: async () => {
      context.closed = true
    },
    on: () => {},
  }
  return context as unknown as QwenWebContext & { closed: boolean; created: number }
}

describe("profile directory and metadata", () => {
  test("defaultProfileDir honors the override", () => {
    const dir = tmpProfile()
    process.env["QWEN_WEB_PROFILE_DIR"] = dir
    expect(defaultProfileDir()).toBe(dir)
    expect(profileExists(dir)).toBe(true)
    expect(profileExists(path.join(dir, "missing"))).toBe(false)
  })

  test("default profile lives under the data dir", () => {
    delete process.env["QWEN_WEB_PROFILE_DIR"]
    expect(defaultProfileDir()).toContain(`qwen-web${path.sep}browser-profile`)
  })

  test("metadata round-trips, missing and corrupt read as undefined", () => {
    const dir = tmpProfile()
    expect(readProfileMetadata(dir)).toBeUndefined()
    fs.writeFileSync(path.join(dir, "metadata.json"), "{corrupt", "utf8")
    expect(readProfileMetadata(dir)).toBeUndefined()
    fs.writeFileSync(
      path.join(dir, "metadata.json"),
      JSON.stringify({ version: 1, authenticated: true, loginAt: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    )
    expect(readProfileMetadata(dir)).toMatchObject({ authenticated: true, loginAt: "2026-01-01T00:00:00.000Z" })
  })
})

describe("hasDisplay", () => {
  test("reflects display environment on linux", () => {
    if (process.platform === "darwin" || process.platform === "win32") {
      expect(hasDisplay()).toBe(true)
      return
    }
    delete process.env["DISPLAY"]
    delete process.env["WAYLAND_DISPLAY"]
    delete process.env["MIR_SOCKET"]
    expect(hasDisplay()).toBe(false)
    process.env["DISPLAY"] = ":0"
    expect(hasDisplay()).toBe(true)
  })
})

describe("quickAuthState", () => {
  test("login and challenge urls", async () => {
    expect(await quickAuthState(fakePage({ url: () => "https://chat.qwen.ai/auth" }))).toBe("login")
    expect(await quickAuthState(fakePage({ url: () => "https://chat.qwen.ai/?x=captcha" }))).toBe("challenge")
  })

  test("auth cookies mean authenticated", async () => {
    const page = fakePage()
    page.context = () => ({ cookies: async (urls?: string | string[]) => {
      expect(urls).toBe("https://chat.qwen.ai")
      return [{ name: "token", value: "abc" }]
    } }) as unknown as QwenWebContext
    expect(await quickAuthState(page)).toBe("authenticated")
    const bare = fakePage()
    bare.context = () => ({ cookies: async () => [{ name: "nothing", value: "x" }] }) as unknown as QwenWebContext
    expect(await quickAuthState(bare)).toBe("unknown")
  })

  test("foreign-origin pages never read as authenticated", async () => {
    const inert = fakePage({ url: () => "https://accounts.google.com/AccountChooser" })
    inert.context = () =>
      ({
        cookies: async () => [{ name: "GoogleAccountsLocale_session", value: "x" }],
      }) as unknown as QwenWebContext
    expect(await quickAuthState(inert)).toBe("unknown")
    const loginish = fakePage({ url: () => "https://accounts.google.com/signin/v1/identifier" })
    loginish.context = () =>
      ({
        cookies: async () => [{ name: "GoogleAccountsLocale_session", value: "x" }],
      }) as unknown as QwenWebContext
    expect(await quickAuthState(loginish)).toBe("login")
    // OAuth redirect targets sit outside the Qwen origin too.
    const redirect = fakePage({ url: () => "https://accounts.google.com/o/oauth2/v2/auth/" })
    redirect.context = () =>
      ({ cookies: async () => [{ name: "session", value: "x" }] }) as unknown as QwenWebContext
    expect(await quickAuthState(redirect)).toBe("login")
  })

  test("throwing pages read as unknown", async () => {
    const page = fakePage({
      url: () => {
        throw new Error("dead")
      },
    })
    expect(await quickAuthState(page)).toBe("unknown")
  })

  test("an authenticated session parked on a login-shaped url stays authenticated", async () => {
    const page = fakePage({ url: () => "https://chat.qwen.ai/auth" })
    page.context = () =>
      ({ cookies: async () => [{ name: "token", value: "abc" }] }) as unknown as QwenWebContext
    expect(await quickAuthState(page)).toBe("authenticated")
  })
})

describe("QwenWebBrowser lifecycle", () => {
  test("challenge probe outranks 403 login and can re-check as authenticated after manual resolution", async () => {
    const dir = tmpProfile()
    let probe = { status: 403, contentType: "application/json", body: "human verification required" }
    const page = fakePage({
      evaluate: async (_fn: unknown, arg: unknown) => {
        if (arg === undefined) return { title: "Qwen", body: "ordinary page" }
        return probe
      },
    })
    const browser = new QwenWebBrowser({ profileDir: dir, launcher: async () => fakeContext([page]) })

    expect(await browser.detectAuthState()).toBe("challenge")
    probe = { status: 200, contentType: "application/json", body: '{"success":true}' }
    expect(await browser.detectAuthState()).toBe("authenticated")
    await browser.close()
  })

  test("ensure launches once and reuses the context", async () => {
    const dir = tmpProfile()
    const context = fakeContext([fakePage()])
    let launches = 0
    const browser = new QwenWebBrowser({
      profileDir: dir,
      launcher: async () => {
        launches++
        return context
      },
    })
    expect(browser.isRunning()).toBe(false)
    const first = await browser.ensure()
    const second = await browser.ensure()
    expect(launches).toBe(1)
    expect(first.context).toBe(context)
    expect(second.page).toBe(first.page)
    expect(browser.isRunning()).toBe(true)
    await browser.close()
    expect(browser.isRunning()).toBe(false)
    expect(context.closed).toBe(true)
    expect(fs.existsSync(path.join(dir, "silvercode.lock"))).toBe(false)
  })

  test("stale and self-owned locks do not block launch", async () => {
    for (const pid of ["42424242", String(process.pid)]) {
      const dir = tmpProfile()
      fs.writeFileSync(path.join(dir, "silvercode.lock"), pid, "utf8")
      const context = fakeContext([fakePage()])
      const browser = new QwenWebBrowser({ profileDir: dir, launcher: async () => context })
      await browser.ensure()
      expect(browser.isRunning()).toBe(true)
      await browser.close()
    }
  })

  test("invalidatePage recreates the page", async () => {
    const dir = tmpProfile()
    const context = fakeContext([])
    const browser = new QwenWebBrowser({ profileDir: dir, launcher: async () => context })
    const first = await browser.ensure()
    browser.invalidatePage()
    // Invalidation marks the cached page dead; the underlying page is gone too.
    first.page.isClosed = () => true
    const second = await browser.ensure()
    expect(second.page).not.toBe(first.page)
    expect(context.created).toBe(2)
    await browser.close()
  })

  test("ensureOnOrigin navigates foreign pages home", async () => {
    const dir = tmpProfile()
    const page = fakePage({ url: () => "https://example.com/" }) as QwenWebPage & { navigations: string[] }
    const context = fakeContext([page])
    const browser = new QwenWebBrowser({ profileDir: dir, launcher: async () => context })
    // navigateHome runs on launch; clear it to isolate ensureOnOrigin.
    await browser.ensure()
    page.navigations.length = 0
    await browser.ensureOnOrigin()
    expect(page.navigations).toEqual(["https://chat.qwen.ai"])
    await browser.close()
  })
})

describe("login behavior", () => {
  test("loginHeaded predicts the headed login switch", () => {
    delete process.env["QWEN_WEB_HEADLESS"]
    if (process.platform !== "darwin" && process.platform !== "win32") {
      delete process.env["DISPLAY"]
      delete process.env["WAYLAND_DISPLAY"]
      delete process.env["MIR_SOCKET"]
    }
    const headlessOnly = new QwenWebBrowser({ profileDir: tmpProfile(), headless: true })
    expect(headlessOnly.loginHeaded).toBe(false)
    const headed = new QwenWebBrowser({ profileDir: tmpProfile(), headless: false })
    expect(headed.loginHeaded).toBe(true)

    process.env["DISPLAY"] = ":1"
    const auto = new QwenWebBrowser({ profileDir: tmpProfile() })
    expect(auto.loginHeaded).toBe(true)
  })

  test("openLoginPage flips to headed when a display exists", async () => {
    process.env["DISPLAY"] = ":1"
    delete process.env["QWEN_WEB_HEADLESS"]
    const dir = tmpProfile()
    const page = fakePage({ url: () => "https://chat.qwen.ai/auth" }) as QwenWebPage & { navigations: string[] }
    let launchedHeadless: boolean | undefined
    const browser = new QwenWebBrowser({
      profileDir: dir,
      launcher: async (_profileDir, options) => {
        launchedHeadless = options.headless
        return fakeContext([page])
      },
    })
    await browser.openLoginPage()
    expect(launchedHeadless).toBe(false)
    expect(page.navigations[page.navigations.length - 1]).toBe("https://chat.qwen.ai/auth")
    await browser.close()
  })

  test("openLoginPage skips navigation when already authenticated", async () => {
    const dir = tmpProfile()
    const page = fakePage() as QwenWebPage & { navigations: string[] }
    page.context = () => ({ cookies: async () => [{ name: "session", value: "x" }] }) as unknown as QwenWebContext
    const browser = new QwenWebBrowser({ profileDir: dir, headless: true, launcher: async () => fakeContext([page]) })
    await browser.openLoginPage()
    // One navigation at most (launch home navigation); never to /auth.
    expect(page.navigations).not.toContain("https://chat.qwen.ai/auth")
    await browser.close()
  })

  test("waitForLogin does not succeed or navigate on a Google OAuth page", async () => {
    const dir = tmpProfile()
    const page = fakePage() as QwenWebPage & { navigations: string[] }
    page.context = () =>
      ({
        cookies: async () => [{ name: "GoogleAccountsLocale_session", value: "x" }],
      }) as unknown as QwenWebContext
    const browser = new QwenWebBrowser({ profileDir: dir, headless: true, launcher: async () => fakeContext([page]) })
    await browser.ensure()
    page.navigations.length = 0
    // Mid-OAuth the page sits on Google's origin with Google session cookies.
    ;(page as { url: () => string }).url = () => "https://accounts.google.com/signin/v1/identifier"
    await expect(browser.waitForLogin({ timeoutMs: 60, pollMs: 15 })).rejects.toThrow(/Timed out waiting for Qwen login/)
    // The OAuth page was never steered back to the Qwen origin.
    expect(page.navigations).toEqual([])
    await browser.close()
  })
})

describe("revealForChallenge", () => {
  test("explicit headless never opens a window", async () => {
    let launches = 0
    const browser = new QwenWebBrowser({
      profileDir: tmpProfile(),
      headless: true,
      launcher: async () => {
        launches++
        return fakeContext([fakePage()])
      },
    })
    expect(await browser.revealForChallenge()).toBe(false)
    expect(launches).toBe(0)
    await browser.close()
  })

  test("already-headed browser needs no relaunch", async () => {
    let launches = 0
    const browser = new QwenWebBrowser({
      profileDir: tmpProfile(),
      headless: false,
      launcher: async () => {
        launches++
        return fakeContext([fakePage()])
      },
    })
    expect(await browser.revealForChallenge()).toBe(true)
    expect(launches).toBe(0)
    await browser.close()
  })

  test.skipIf(!hasDisplay())("headless browser relaunches headed", async () => {
    delete process.env["QWEN_WEB_HEADLESS"]
    const launchedHeadless: boolean[] = []
    const browser = new QwenWebBrowser({
      profileDir: tmpProfile(),
      launcher: async (_profileDir, options) => {
        launchedHeadless.push(options.headless)
        return fakeContext([fakePage()])
      },
    })
    await browser.ensure()
    expect(launchedHeadless).toEqual([true])
    expect(await browser.revealForChallenge()).toBe(true)
    expect(launchedHeadless).toEqual([true, false])
    await browser.close()
  })

  test("restores headless state when the headed relaunch fails", async () => {
    delete process.env["QWEN_WEB_HEADLESS"]
    if (process.platform !== "darwin" && process.platform !== "win32") process.env["DISPLAY"] = ":1"
    const launchedHeadless: boolean[] = []
    let launches = 0
    const browser = new QwenWebBrowser({
      profileDir: tmpProfile(),
      launcher: async (_profileDir, options) => {
        launchedHeadless.push(options.headless)
        launches++
        // Every headed launch fails: the retry must attempt (and fail) again
        // rather than finding a live headed browser or flipping headless early.
        if (!options.headless) throw new Error("headed relaunch failed")
        return fakeContext([fakePage()])
      },
    })
    await browser.ensure()
    await expect(browser.revealForChallenge()).rejects.toThrow("headed relaunch failed")
    await expect(browser.revealForChallenge()).rejects.toThrow("headed relaunch failed")
    expect(launchedHeadless).toEqual([true, false, false])
    await browser.close()
  })

  test("concurrent reveals share one headed relaunch", async () => {
    delete process.env["QWEN_WEB_HEADLESS"]
    if (process.platform !== "darwin" && process.platform !== "win32") process.env["DISPLAY"] = ":1"
    const launchedHeadless: boolean[] = []
    let releaseRelaunch!: () => void
    const relaunchGate = new Promise<void>((resolve) => {
      releaseRelaunch = resolve
    })
    let launches = 0
    const browser = new QwenWebBrowser({
      profileDir: tmpProfile(),
      launcher: async (_profileDir, options) => {
        launchedHeadless.push(options.headless)
        launches++
        if (launches === 2) await relaunchGate
        return fakeContext([fakePage()])
      },
    })
    await browser.ensure()
    const first = browser.revealForChallenge()
    const second = browser.revealForChallenge()
    const secondSettledEarly = await Promise.race([
      second.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ])
    expect(secondSettledEarly).toBe(false)
    releaseRelaunch()
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(launchedHeadless).toEqual([true, false])
    await browser.close()
  })
})

describe("patchrightLaunchOptions", () => {
  const options = patchrightLaunchOptions(false)

  test("removes the automation flag and keeps normal-launch flags", () => {
    expect(options.ignoreDefaultArgs).toContain("--enable-automation")
    const args = options.args as string[]
    expect(args).toContain("--disable-blink-features=AutomationControlled")
    expect(args).toContain("--disable-infobars")
    expect(args).toContain("--no-first-run")
    expect(args).toContain("--no-default-browser-check")
  })

  test("does not carry bot-orchestrator flags", () => {
    const args = options.args as string[]
    for (const flag of ["--disable-background-networking", "--disable-sync", "--disable-default-apps"]) {
      expect(args).not.toContain(flag)
    }
  })

  test("keeps a consistent human-like profile surface", () => {
    expect(options).toMatchObject({
      headless: false,
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
    })
    expect(typeof options.timezoneId).toBe("string")
  })
})
