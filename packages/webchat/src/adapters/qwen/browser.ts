/**
 * Patchright Chromium lifecycle for the Qwen Web provider.
 *
 * One persistent browser context owns the user's Qwen session:
 * - the profile lives under SilverCode's data dir (never in the repo),
 * - a single main page serves all generations (streams multiplex by id),
 * - crashes / disconnects are detected and recovered by recreating the
 *   page or relaunching the browser,
 * - a lockfile coordinates multiple SilverCode processes sharing the
 *   profile (Chromium itself refuses a second instance on one profile).
 *
 * Nothing here launches a browser at import time. The browser starts lazily
 * on the first generation or login flow and stays up for process lifetime.
 */
import fs from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { QWEN_WEB_DEFAULTS, QWEN_WEB_ENV, QWEN_WEB_PROFILE_LOCKFILE, QWEN_WEB_PROFILE_SUBDIR } from "./constants"
import { debug } from "./log"
import { qwenWebOrigin, qwenWebUrl } from "./protocol"
import { QwenWebError, isAbortLike, isChallengeMessage } from "./errors"

// ---------------------------------------------------------------------------
// Narrow structural interfaces (real Patchright objects satisfy these;
// tests use lightweight doubles).
// ---------------------------------------------------------------------------

export interface QwenWebCookie {
  name: string
  value: string
  domain?: string
  path?: string
}

export interface QwenWebRequest {
  url(): string
  method(): string
  headers(): Record<string, string>
}

export interface QwenWebPage {
  url(): string
  isClosed(): boolean
  goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded" | "load" | "networkidle"; timeout?: number },
  ): Promise<unknown>
  evaluate<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>
  exposeBinding(name: string, callback: (...args: any[]) => unknown): Promise<void>
  title(): Promise<string>
  context(): QwenWebContext
  on(event: "crash" | "close", handler: () => void): void
  on(event: "request", handler: (request: QwenWebRequest) => void): void
  close(options?: { runBeforeUnload?: boolean }): Promise<void>
  setDefaultTimeout(timeout: number): void
  setDefaultNavigationTimeout(timeout: number): void
}

export interface QwenWebContext {
  pages(): QwenWebPage[]
  newPage(): Promise<QwenWebPage>
  cookies(urls?: string | string[]): Promise<QwenWebCookie[]>
  close(): Promise<void>
  on(event: "close", handler: () => void): void
}

export type QwenWebLauncher = (profileDir: string, options: QwenWebLaunchOptions) => Promise<QwenWebContext>

export interface QwenWebLaunchOptions {
  headless: boolean
  navigationTimeoutMs: number
  pageTimeoutMs: number
}

export interface QwenWebBrowserOptions {
  profileDir?: string
  headless?: boolean
  navigationTimeoutMs?: number
  pageTimeoutMs?: number
  launcher?: QwenWebLauncher
}

export type QwenWebAuthState = "authenticated" | "login" | "challenge" | "unknown"

export interface WaitForLoginOptions {
  timeoutMs?: number
  signal?: AbortSignal
  pollMs?: number
}

// ---------------------------------------------------------------------------
// Profile directory & locking
// ---------------------------------------------------------------------------

export function defaultProfileDir(): string {
  const override = process.env[QWEN_WEB_ENV.profileDir]?.trim()
  if (override) return override
  return path.join(Global.Path.data, QWEN_WEB_PROFILE_SUBDIR)
}

export function profileExists(profileDir?: string): boolean {
  try {
    return fs.statSync(profileDir ?? defaultProfileDir()).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// SilverCode-owned profile metadata (login state; never credentials)
// ---------------------------------------------------------------------------

export interface QwenWebProfileMetadata {
  version: 1
  /** True once a login has been observed in this profile. */
  authenticated: boolean
  /** ISO timestamp of the first observed login. */
  loginAt?: string
  /** ISO timestamp of the last observed authenticated state. */
  lastSeenAt?: string
}

const METADATA_FILENAME = "metadata.json"

function metadataPath(profileDir: string): string {
  return path.join(profileDir, METADATA_FILENAME)
}

/** Read the login-state marker. Returns undefined when absent/corrupt. */
export function readProfileMetadata(profileDir?: string): QwenWebProfileMetadata | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(metadataPath(profileDir ?? defaultProfileDir()), "utf8"),
    ) as Partial<QwenWebProfileMetadata>
    if (!parsed || typeof parsed !== "object") return undefined
    return {
      version: 1,
      authenticated: parsed.authenticated === true,
      ...(typeof parsed.loginAt === "string" ? { loginAt: parsed.loginAt } : {}),
      ...(typeof parsed.lastSeenAt === "string" ? { lastSeenAt: parsed.lastSeenAt } : {}),
    }
  } catch {
    return undefined
  }
}

function writeProfileMetadata(profileDir: string, patch: Partial<QwenWebProfileMetadata>): void {
  try {
    const current = readProfileMetadata(profileDir)
    const next: QwenWebProfileMetadata = {
      version: 1,
      authenticated: patch.authenticated ?? current?.authenticated ?? false,
      loginAt: patch.loginAt ?? current?.loginAt,
      lastSeenAt: patch.lastSeenAt ?? current?.lastSeenAt,
    }
    fs.mkdirSync(profileDir, { recursive: true })
    fs.writeFileSync(metadataPath(profileDir), JSON.stringify(next, null, 2), "utf8")
  } catch (error) {
    debug("browser", "failed to persist profile metadata (non-fatal)", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function markAuthenticated(profileDir: string): void {
  const now = new Date().toISOString()
  const current = readProfileMetadata(profileDir)
  writeProfileMetadata(profileDir, { authenticated: true, loginAt: current?.loginAt ?? now, lastSeenAt: now })
}

function lockfilePath(profileDir: string): string {
  return path.join(profileDir, QWEN_WEB_PROFILE_LOCKFILE)
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException)?.code === "EPERM"
  }
}

/** True when a visible browser window can be shown on this machine. */
export function hasDisplay(): boolean {
  if (process.platform === "darwin" || process.platform === "win32") return true
  return Boolean(process.env["DISPLAY"] || process.env["WAYLAND_DISPLAY"] || process.env["MIR_SOCKET"])
}

function readLockPid(profileDir: string): number | undefined {
  try {
    const raw = fs.readFileSync(lockfilePath(profileDir), "utf8").trim()
    const pid = Number.parseInt(raw, 10)
    return Number.isFinite(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function acquireProfileLock(profileDir: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  fs.mkdirSync(profileDir, { recursive: true })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) throw aborted()
    const owner = readLockPid(profileDir)
    if (owner === undefined || owner === process.pid || !isPidAlive(owner)) {
      try {
        fs.writeFileSync(lockfilePath(profileDir), String(process.pid), "utf8")
        return
      } catch {
        // Lost a race; fall through and retry.
      }
    }
    if (Date.now() >= deadline) {
      throw new QwenWebError({
        code: "browser_error",
        retryable: false,
        message:
          `Another SilverCode process (pid ${owner}) is using the Qwen browser profile at ${profileDir}. ` +
          `Wait for it to exit, or set ${QWEN_WEB_ENV.profileDir} to use a separate profile.`,
      })
    }
    await sleep(500)
  }
}

function releaseProfileLock(profileDir: string): void {
  try {
    if (readLockPid(profileDir) === process.pid) fs.rmSync(lockfilePath(profileDir), { force: true })
  } catch {
    // Best effort.
  }
}

function aborted(): QwenWebError {
  const error = new QwenWebError({ code: "aborted", message: "Qwen Web login wait was aborted", retryable: false })
  error.name = "AbortError"
  return error
}

// ---------------------------------------------------------------------------
// Default Patchright launcher (Chromium only)
// ---------------------------------------------------------------------------

async function defaultLauncher(profileDir: string, options: QwenWebLaunchOptions): Promise<QwenWebContext> {
  let chromium: { launchPersistentContext: (...args: any[]) => Promise<QwenWebContext> }
  try {
    const patchright = await import("patchright")
    chromium = (patchright as unknown as { chromium: typeof chromium }).chromium
  } catch (error) {
    throw new QwenWebError({
      code: "browser_error",
      retryable: false,
      cause: error,
      message: "The `patchright` package could not be loaded. Reinstall SilverCode dependencies and try again.",
    })
  }
  try {
    return await chromium.launchPersistentContext(profileDir, patchrightLaunchOptions(options.headless))
  } catch (error) {
    throw explainLaunchFailure(error)
  }
}

/**
 * Launch options for the Qwen browser profile.
 *
 * The browser must look like a normal human Chromium -- chat.qwen.ai sits
 * behind Alibaba's baxia WAF, which issues interactive challenges to
 * automation-like clients. So beyond Patchright's own `navigator.webdriver`
 * masking, the launch args keep browser-automation tells out:
 *
 * - `--enable-automation` (Playwright/Patchright's default automation flag)
 *   is removed via `ignoreDefaultArgs`, and the "Chrome is being controlled"
 *   infobar is suppressed with `--disable-infobars`.
 * - `--disable-blink-features=AutomationControlled` is belt-and-braces on
 *   top of Patchright's CDP masking.
 * - Flags that only bot orchestrators use (`--disable-background-networking`,
 *   `--disable-sync`, `--disable-default-apps`) are deliberately omitted; a
 *   real user's logged-in Chromium does not carry them.
 */
export function patchrightLaunchOptions(headless: boolean): Record<string, unknown> {
  return {
    headless,
    channel: undefined,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--disable-infobars",
      "--mute-audio",
      "--disable-blink-features=AutomationControlled",
    ],
  }
}

function explainLaunchFailure(error: unknown): QwenWebError {
  const message = error instanceof Error ? error.message : String(error)
  if (/executable doesn't exist|browser has not been found|could not find/i.test(message)) {
    return new QwenWebError({
      code: "browser_error",
      retryable: false,
      cause: error,
      message:
        "Patchright Chromium is not installed. Install it once with `bunx patchright install chromium` (or `npx patchright install chromium`), then retry.",
    })
  }
  if (/singleton|already in use|profile.*lock|user-data-dir/i.test(message)) {
    return new QwenWebError({
      code: "browser_error",
      retryable: false,
      cause: error,
      message:
        "The Qwen browser profile is already in use by another Chromium instance. " +
        `Close it, or set ${QWEN_WEB_ENV.profileDir} to use a separate profile.`,
    })
  }
  return new QwenWebError({
    code: "browser_error",
    retryable: true,
    cause: error,
    message: `Failed to launch the Qwen browser: ${message.slice(0, 300)}`,
  })
}

// ---------------------------------------------------------------------------
// Auth-state detection
// ---------------------------------------------------------------------------

const LOGIN_URL_MARKERS = ["/login", "/auth", "login.", "account/login", "signin", "sign-in"]
const CHALLENGE_URL_MARKERS = ["captcha", "challenge", "verify", "validation", "security-check"]
function urlSuggestsLogin(url: string): boolean {
  const lowered = url.toLowerCase()
  return LOGIN_URL_MARKERS.some((marker) => lowered.includes(marker))
}

function urlSuggestsChallenge(url: string): boolean {
  const lowered = url.toLowerCase()
  return CHALLENGE_URL_MARKERS.some((marker) => lowered.includes(marker))
}

function hasAuthCookie(cookies: QwenWebCookie[]): boolean {
  return cookies.some((cookie) => {
    const name = cookie.name.toLowerCase()
    return name.includes("token") || name.includes("session")
  })
}

/** Cheap signals only: URL + cookies. Used for polling. */
export async function quickAuthState(page: QwenWebPage): Promise<QwenWebAuthState> {
  try {
    const url = page.url()
    // A WAF challenge is the strongest signal: it means traffic is being
    // gated regardless of cookies, so it always wins.
    if (urlSuggestsChallenge(url)) return "challenge"
    // Only Qwen-origin pages can carry a Qwen session: a page on the OAuth
    // provider (e.g. accounts.google.com) has that provider's cookies, whose
    // names (GoogleAccountsLocale_session, SID, ...) match our heuristics
    // and would otherwise be mistaken for an authenticated Qwen login. A
    // signin-shaped foreign URL still reads as an in-progress login.
    if (!url.startsWith(qwenWebOrigin())) return urlSuggestsLogin(url) ? "login" : "unknown"
    const cookies = await page
      .context()
      .cookies(qwenWebOrigin())
      .catch(() => [] as QwenWebCookie[])
    // Cookies first on the Qwen origin: an authenticated user parked on a
    // login-shaped page (/auth, /login) is still authenticated, so it must
    // not read as `login` forever while polling for the session.
    if (hasAuthCookie(cookies)) return "authenticated"
    if (urlSuggestsLogin(url)) return "login"
    return "unknown"
  } catch {
    return "unknown"
  }
}

// ---------------------------------------------------------------------------
// Browser manager
// ---------------------------------------------------------------------------

export class QwenWebBrowser {
  private context: QwenWebContext | undefined
  private page: QwenWebPage | undefined
  private launching: Promise<QwenWebContext> | undefined
  private challengeReveal: Promise<boolean> | undefined
  private contextDead = false
  private pageDead = false
  private lockHeldFor: string | undefined
  private readonly launcher: QwenWebLauncher
  private readonly profileDir: string
  private headless: boolean
  private readonly headlessExplicit: boolean
  private readonly navigationTimeoutMs: number
  private readonly pageTimeoutMs: number
  private readonly pageOpenHandlers = new Set<(page: QwenWebPage) => void>()

  /** Register a callback that runs whenever this browser adopts a page, before any navigation on it. */
  onPageOpen(handler: (page: QwenWebPage) => void): void {
    this.pageOpenHandlers.add(handler)
  }

  constructor(options?: QwenWebBrowserOptions) {
    this.launcher = options?.launcher ?? defaultLauncher
    this.profileDir = options?.profileDir ?? defaultProfileDir()
    this.headlessExplicit = options?.headless !== undefined || process.env[QWEN_WEB_ENV.headless] !== undefined
    this.headless = options?.headless ?? readHeadlessDefault()
    this.navigationTimeoutMs =
      options?.navigationTimeoutMs ??
      readTimeoutDefault(QWEN_WEB_ENV.navigationTimeoutMs, QWEN_WEB_DEFAULTS.navigationTimeoutMs)
    this.pageTimeoutMs =
      options?.pageTimeoutMs ?? readTimeoutDefault(QWEN_WEB_ENV.pageTimeoutMs, QWEN_WEB_DEFAULTS.pageTimeoutMs)
  }

  isRunning(): boolean {
    return this.context !== undefined && !this.contextDead
  }

  getProfileDir(): string {
    return this.profileDir
  }

  /**
   * Whether the login page will be visible to the user.
   *
   * The browser defaults to headless, but an interactive login flips a
   * not-yet-running browser to headed when a display is available (unless
   * headless mode was explicitly requested).
   */
  get loginHeaded(): boolean {
    if (!this.headless) return true
    if (this.isRunning() || this.headlessExplicit) return false
    return hasDisplay()
  }

  /**
   * Reveal a visible window for a mid-run human-verification challenge.
   *
   * Headless cannot be toggled on a live persistent context, so a running
   * headless browser is closed and relaunched headed. Returns true when a
   * headed window is now showing (already headed, or relaunched). Returns
   * false when no window can open: headless was explicitly requested, or
   * no display is available. Callers must then say so instead of
   * promising a window.
   */
  async revealForChallenge(signal?: AbortSignal): Promise<boolean> {
    if (!this.headless) return true
    if (this.headlessExplicit || !hasDisplay()) return false
    if (this.challengeReveal) return this.challengeReveal

    const inFlightLaunch = this.launching
    if (inFlightLaunch) {
      await inFlightLaunch.catch(() => {})
      if (this.launching === inFlightLaunch) this.launching = undefined
    }

    debug("browser", "relaunching headed so the user can solve the verification challenge")
    const operation = this.restartWithHeadless(signal, false)
      .then(() => {
        this.headless = false
        return true
      })
      .catch(async (error) => {
        // Roll back the logical mode and clean up any partially-created headed context.
        await this.close()
        throw error
      })
    this.challengeReveal = operation.finally(() => {
      this.challengeReveal = undefined
    })
    return this.challengeReveal
  }

  /**
   * Open the Qwen login page on the main page for an interactive login.
   * The user logs in normally; callers poll `detectAuthState` (or use
   * `waitForLogin`) to observe completion. Already-authenticated profiles
   * return immediately without navigating.
   */
  async openLoginPage(signal?: AbortSignal): Promise<QwenWebPage> {
    if (!this.isRunning() && !this.headlessExplicit && hasDisplay() && this.headless) {
      debug("browser", "switching to headed mode for interactive login")
      this.headless = false
    }
    const page = await this.ensureOnOrigin(signal)
    try {
      if (!page.isClosed()) {
        const quick = await quickAuthState(page)
        if (quick === "authenticated") return page
      }
    } catch {
      // Fall through to navigation.
    }
    try {
      await page.goto(qwenWebUrl("/auth"), { waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs })
    } catch (error) {
      if (isAbortLike(error) || signal?.aborted) throw error
      throw new QwenWebError({
        code: "browser_error",
        retryable: true,
        message: "Browser navigation to the Qwen login page failed",
        cause: error,
      })
    }
    return page
  }

  /** Ensure a live context + main page. Launches the browser on first use. */
  async ensure(signal?: AbortSignal): Promise<{ context: QwenWebContext; page: QwenWebPage }> {
    return this.ensureInternal(signal)
  }

  private async ensureInternal(
    signal?: AbortSignal,
    headlessOverride?: boolean,
  ): Promise<{ context: QwenWebContext; page: QwenWebPage }> {
    if (this.context && !this.contextDead) {
      const page = await this.ensurePage()
      return { context: this.context, page }
    }
    if (!this.launching) {
      this.launching = this.launch(signal, headlessOverride).finally(() => {
        this.launching = undefined
      })
    }
    const context = await this.launching
    const page = await this.ensurePage()
    return { context, page }
  }

  /** Page accessor for callers that already ensured the browser. */
  async activePage(signal?: AbortSignal): Promise<QwenWebPage> {
    const { page } = await this.ensure(signal)
    return page
  }

  private async launch(signal?: AbortSignal, headless = this.headless): Promise<QwenWebContext> {
    await acquireProfileLock(this.profileDir, QWEN_WEB_DEFAULTS.profileLockTimeoutMs, signal)
    this.lockHeldFor = this.profileDir
    try {
      debug("browser", `launching Chromium (headless=${headless})`, { profileDir: this.profileDir })
      const startedAt = Date.now()
      const context = await this.launcher(this.profileDir, {
        headless,
        navigationTimeoutMs: this.navigationTimeoutMs,
        pageTimeoutMs: this.pageTimeoutMs,
      })
      this.contextDead = false
      context.on("close", () => {
        debug("browser", "context closed")
        this.contextDead = true
        this.context = undefined
        this.page = undefined
      })
      this.context = context
      debug("browser", `Chromium ready in ${Date.now() - startedAt}ms`)
      await this.navigateHome(signal)
      return context
    } catch (error) {
      this.releaseLock()
      throw error
    }
  }

  private async ensurePage(): Promise<QwenWebPage> {
    const context = this.context
    if (!context || this.contextDead)
      throw new QwenWebError({ code: "browser_error", retryable: true, message: "Browser context is not available" })
    if (this.page && !this.pageDead && !this.page.isClosed()) return this.page
    const existing = context.pages().filter((candidate) => !candidate.isClosed())
    const page =
      existing.find((candidate) => candidate.url().startsWith(qwenWebOrigin())) ??
      existing[0] ??
      (await context.newPage())
    page.setDefaultTimeout(this.pageTimeoutMs)
    page.setDefaultNavigationTimeout(this.navigationTimeoutMs)
    page.on("crash", () => {
      debug("browser", "page crashed")
      this.pageDead = true
    })
    page.on("close", () => {
      debug("browser", "page closed")
      this.pageDead = true
    })
    for (const handler of this.pageOpenHandlers) handler(page)
    this.page = page
    this.pageDead = false
    // Tidy stray blank tabs left by profile startup, keeping the main page.
    for (const extra of existing) {
      if (extra !== page && extra.url() === "about:blank") await extra.close({ runBeforeUnload: false }).catch(() => {})
    }
    return page
  }

  /** Navigate the main page to the Qwen home (best effort, bounded). */
  private async navigateHome(signal?: AbortSignal): Promise<void> {
    if (!this.context || this.contextDead) return
    const page = await this.ensurePage().catch(() => undefined)
    if (!page) return
    if (signal?.aborted) return
    try {
      const url = page.url()
      if (url.startsWith(qwenWebOrigin()) && new URL(url).pathname === "/") return
      await page.goto(qwenWebUrl("/"), { waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs })
    } catch (error) {
      debug("browser", "home navigation failed (non-fatal)", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Ensure the main page sits on the Qwen origin before page-context requests.
   *
   * `steer: false` never navigates: callers that only want to reuse the page
   * as-is (background bookkeeping such as the model catalog refresh, which
   * must not drag a page out from under an active generation) get the page
   * without steering.
   */
  async ensureOnOrigin(signal?: AbortSignal, opts?: { steer?: boolean }): Promise<QwenWebPage> {
    const steer = opts?.steer ?? true
    const page = await this.activePage(signal)
    if (!steer) return page
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (!page.url().startsWith(qwenWebOrigin())) {
          debug("browser", "navigating to origin", { attempt, from: page.url().slice(0, 120) })
          await page.goto(qwenWebUrl("/"), { waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs })
        }
        return page
      } catch (error) {
        if (isAbortLike(error) || signal?.aborted) throw error
        debug("browser", "origin navigation failed; retrying once", {
          attempt,
          url: page.url().slice(0, 120),
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        })
        if (attempt === 2) {
          throw new QwenWebError({
            code: "browser_error",
            retryable: true,
            message: "Browser navigation to chat.qwen.ai failed",
            cause: error,
          })
        }
        await sleep(750)
      }
    }
    return page
  }

  /**
   * Full authentication check: cheap signals first, then an authenticated
   * endpoint probe inside the page context as the decider.
   *
   * `steer: false` (used while an interactive login is in flight) never
   * navigates the page: OAuth redirects must not be yanked back to the Qwen
   * home page mid-flow.
   */
  async detectAuthState(signal?: AbortSignal, opts?: { steer?: boolean }): Promise<QwenWebAuthState> {
    const steer = opts?.steer ?? true
    const page = steer ? await this.ensureOnOrigin(signal) : await this.activePage(signal)
    const quick = await quickAuthState(page)
    if (quick === "challenge" || quick === "login") return quick
    if (steer || page.url().startsWith(qwenWebOrigin())) {
      const probe = await this.probeSession(page).catch(() => "unknown" as const)
      // An authenticated probe wins: page text may mention "captcha" in chat titles.
      if (probe !== "authenticated" && (await this.sniffChallenge(page))) return "challenge"
      const state = probe !== "unknown" ? probe : quick
      if (state === "authenticated") markAuthenticated(this.profileDir)
      return state
    }
    // Foreign origin mid-OAuth: only the cheap signals apply; a cross-origin
    // page cannot complete the same-origin authenticated probe fetch.
    return quick
  }

  private async sniffChallenge(page: QwenWebPage): Promise<boolean> {
    try {
      const sample = await page.evaluate(() => {
        const title = document.title ?? ""
        const body = (document.body?.textContent ?? "").slice(0, 4000)
        return `${title}\n${body}`.toLowerCase()
      }, undefined)
      return isChallengeMessage(sample)
    } catch {
      return false
    }
  }

  /** `GET /api/models` in-page: 2xx = authenticated, 401/403 = login. */
  private async probeSession(page: QwenWebPage): Promise<QwenWebAuthState> {
    const url = qwenWebUrl("/api/models")
    const result = await page.evaluate(async (target: string) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20_000)
      try {
        const response = await fetch(target, {
          method: "GET",
          credentials: "include",
          headers: { accept: "application/json, text/plain, */*", source: "web" },
          signal: controller.signal,
        })
        const contentType = response.headers.get("content-type") ?? ""
        const body = await response.text().catch(() => "")
        return { status: response.status, contentType, body: body.slice(0, 2000) }
      } finally {
        clearTimeout(timer)
      }
    }, url)
    const sample = `${result.contentType}\n${result.body}`
    // Status is not enough: WAFs commonly return challenge pages with 200,
    // 401, or 403. The body signal always wins over auth classification.
    // Known trade-off (deferred, needs a product call): a 401/403 login page
    // whose markup merely mentions "captcha" (e.g. an embedded widget script)
    // also reports "challenge" here, pausing the run instead of prompting a
    // re-login. Both directions need the user, so the body-wins rule this
    // workstream ships stays as-is until that call is made.
    if (isChallengeMessage(sample)) return "challenge"
    if (result.status >= 200 && result.status < 300) return "authenticated"
    if (result.status === 401 || result.status === 403) return "login"
    if (result.body && /<!doctype\s+html|<html\b/i.test(result.body)) return "login"
    return "unknown"
  }

  /**
   * Wait until the user completes login in the browser window.
   * Challenges simply extend the wait: the user solves them manually.
   */
  async waitForLogin(options?: WaitForLoginOptions): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? QWEN_WEB_DEFAULTS.loginTimeoutMs
    const pollMs = options?.pollMs ?? 1500
    const signal = options?.signal
    const deadline = Date.now() + timeoutMs
    let sawChallenge = false
    for (;;) {
      if (signal?.aborted) throw aborted()
      const state = await this.detectAuthState(signal, { steer: false }).catch(() => "unknown" as const)
      if (state === "authenticated") return
      if (state === "challenge" && !sawChallenge) {
        sawChallenge = true
        // Best effort: surface a visible window so the user has somewhere
        // to solve the challenge; the wait continues regardless.
        await this.revealForChallenge(signal).catch(() => false)
        debug("browser", "human-verification challenge visible; waiting for the user to solve it manually")
      }
      if (Date.now() >= deadline) {
        throw new QwenWebError({
          code: "login_required",
          retryable: false,
          message:
            "Timed out waiting for Qwen login. Open the browser window, complete the login" +
            (sawChallenge ? " and the human-verification challenge," : ",") +
            " then try again.",
        })
      }
      await sleep(pollMs)
    }
  }

  /** Graceful shutdown: close the context and release the profile lock. */
  async close(): Promise<void> {
    const context = this.context
    this.context = undefined
    this.page = undefined
    this.contextDead = false
    this.pageDead = false
    if (context) await context.close().catch(() => {})
    this.releaseLock()
    debug("browser", "closed")
  }

  /** Restart the browser (used after crashes / dead contexts). */
  async restart(signal?: AbortSignal): Promise<{ context: QwenWebContext; page: QwenWebPage }> {
    return this.restartWithHeadless(signal)
  }

  private async restartWithHeadless(
    signal?: AbortSignal,
    headlessOverride?: boolean,
  ): Promise<{ context: QwenWebContext; page: QwenWebPage }> {
    debug("browser", "restarting")
    await this.close()
    return this.ensureInternal(signal, headlessOverride)
  }

  /** Drop the cached main page so the next use recreates it. */
  invalidatePage(): void {
    this.pageDead = true
  }

  private releaseLock(): void {
    if (this.lockHeldFor) {
      releaseProfileLock(this.lockHeldFor)
      this.lockHeldFor = undefined
    }
  }
}

function readHeadlessDefault(): boolean {
  const value = process.env[QWEN_WEB_ENV.headless]?.toLowerCase()
  if (value === "false" || value === "0") return false
  return QWEN_WEB_DEFAULTS.headless
}

function readTimeoutDefault(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Process-wide shared browser. Tests construct `QwenWebBrowser` directly. */
let shared: QwenWebBrowser | undefined

export function sharedBrowser(): QwenWebBrowser {
  if (!shared) shared = new QwenWebBrowser()
  return shared
}

/** Test seam: replace or clear the shared instance. */
export function setSharedBrowser(browser: QwenWebBrowser | undefined): void {
  shared = browser
}

export async function closeSharedBrowser(): Promise<void> {
  if (shared) {
    await shared.close().catch(() => {})
    shared = undefined
  }
}
