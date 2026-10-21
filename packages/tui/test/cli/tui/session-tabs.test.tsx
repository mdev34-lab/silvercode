/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import { onCleanup, Show } from "solid-js"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../fixture/fixture"
import { captureFrame } from "../../fixture/frame"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ArgsProvider } from "../../../src/context/args"
import { KVProvider } from "../../../src/context/kv"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { PermissionProvider } from "../../../src/context/permission"
import { LocalProvider } from "../../../src/context/local"
import { ExitProvider } from "../../../src/context/exit"
import { ThemeProvider } from "../../../src/context/theme"
import { RouteProvider, useRoute, type Route } from "../../../src/context/route"
import { LocationProvider } from "../../../src/context/location"
import { EditorContextProvider } from "../../../src/context/editor"
import { DataProvider } from "../../../src/context/data"
import { SessionTabsProvider, useSessionTabs } from "../../../src/context/session-tabs"
import { SessionTabsBar } from "../../../src/component/session-tabs-bar"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { TuiConfigProvider, resolve } from "../../../src/config"
import { PromptRefProvider } from "../../../src/context/prompt"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { ToastProvider } from "../../../src/ui/toast"
import { DialogProvider } from "../../../src/ui/dialog"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { Prompt, type PromptRef } from "../../../src/component/prompt"

/**
 * Session tabs against the production composer and tab bar. Each test drives the
 * real route, prompt, sync, and session-status event path with a fake server.
 *
 * Covers: per-session drafts across repeated switches (the old single-slot
 * prompt stash leaked one session's draft into the next), background work and
 * attention without stealing focus, close and reopen without cancelling or
 * deleting the session, tab layout at normal and narrow widths, and restore.
 */

const A = "ses_tab_a"
const B = "ses_tab_b"
const C = "ses_tab_c"
const TITLES: Record<string, string> = {
  [A]: "Investigate flaky tests",
  [B]: "Draft release notes",
  [C]: "Third session",
}

type Handle = {
  route?: ReturnType<typeof useRoute>
  tabs?: ReturnType<typeof useSessionTabs>
  sync?: ReturnType<typeof useSync>
  refs: Record<string, PromptRef | undefined>
}

type Setup = Awaited<ReturnType<typeof testRender>>

function sessionRow(id: string) {
  return {
    id,
    slug: id,
    title: TITLES[id] ?? id,
    projectID: "proj_test",
    version: "0.0.0-test",
    directory,
    time: { created: 0, updated: 0 },
  }
}

async function waitUntil(fn: () => boolean, timeout = 15_000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error(`timed out after ${timeout}ms`)
    await Bun.sleep(10)
  }
}

async function settle(app: Setup, passes = 6) {
  for (let i = 0; i < passes; i++) {
    await app.renderOnce()
    await Bun.sleep(5)
  }
}

function firstLine(frame: string) {
  return frame.split("\n")[0] ?? ""
}

async function mount(options: { width: number; route: Route; sessions: string[]; kv?: Record<string, unknown> }) {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify(options.kv ?? {}))

  const events = createEventSource()
  const requests: string[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json(options.sessions.map(sessionRow))
    return undefined
  }, events)
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    requests.push(`${request.method} ${new URL(request.url).pathname}`)
    return calls.fetch(input, init)
  }

  const handle: Handle = { refs: {} }
  const config = resolve({}, { terminalSuspend: true })
  const pluginRuntime = createPluginRuntime()

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <ClipboardProvider>
        <OpencodeKeymapProvider keymap={keymap}>
          <ToastProvider>
            <RouteProvider initialRoute={options.route}>
              <TuiConfigProvider config={config}>
                <PluginRuntimeProvider value={pluginRuntime}>
                  <SDKProvider url="http://test" directory={directory} fetch={fetch as unknown as typeof globalThis.fetch} events={events.source}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <LocationProvider>
                          <EditorContextProvider>
                            <ExitProvider exit={() => {}}>
                              <SyncProvider>
                                <DataProvider>
                                  <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                                    <LocalProvider>
                                      <SessionTabsProvider>
                                        <PromptStashProvider>
                                          <DialogProvider>
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <PromptRefProvider>
                                                  <Screen />
                                                </PromptRefProvider>
                                              </PromptHistoryProvider>
                                            </FrecencyProvider>
                                          </DialogProvider>
                                        </PromptStashProvider>
                                      </SessionTabsProvider>
                                    </LocalProvider>
                                  </ThemeProvider>
                                </DataProvider>
                              </SyncProvider>
                            </ExitProvider>
                          </EditorContextProvider>
                        </LocationProvider>
                      </ProjectProvider>
                    </PermissionProvider>
                  </SDKProvider>
                </PluginRuntimeProvider>
              </TuiConfigProvider>
            </RouteProvider>
          </ToastProvider>
        </OpencodeKeymapProvider>
      </ClipboardProvider>
    )
  }

  function Screen() {
    const route = useRoute()
    handle.route = route
    handle.tabs = useSessionTabs()
    handle.sync = useSync()
    return (
      <box flexDirection="column">
        <SessionTabsBar />
        <Show when={route.data.type === "session" ? route.data.sessionID : undefined} keyed>
          {(sessionID) => (
            <Prompt
              sessionID={sessionID}
              ref={(ref) => {
                handle.refs[sessionID] = ref
              }}
            />
          )}
        </Show>
      </box>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <ArgsProvider>
          <KVProvider>
            <Harness />
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ),
    { width: options.width, height: 24, kittyKeyboard: true },
  )

  await waitUntil(() => handle.sync?.status === "complete")
  await settle(app)

  function emitStatus(sessionID: string, type: "busy" | "idle") {
    const event: GlobalEvent = {
      directory,
      project: "proj_test",
      payload: {
        id: `evt_${sessionID}_${type}_${Math.random()}`,
        type: "session.status",
        properties: { sessionID, status: { type } },
      },
    } as GlobalEvent
    events.emit(event)
  }

  async function go(sessionID: string) {
    handle.route!.navigate({ type: "session", sessionID })
    await waitUntil(() => handle.route!.data.type === "session" && handle.refs[sessionID] !== undefined)
    await settle(app, 2)
  }

  async function dispose() {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }

  return { app, handle, requests, emitStatus, go, dispose }
}

describe("session tabs", () => {
  test("each session keeps its own draft across repeated switches", async () => {
    const env = await mount({ width: 100, route: { type: "session", sessionID: A }, sessions: [A, B] })
    try {
      await waitUntil(() => env.handle.refs[A] !== undefined)
      env.handle.refs[A]!.set({ input: "draft for A", parts: [] })

      await env.go(B)
      // The old single-slot stash handed A's draft to whichever prompt mounted next.
      expect(env.handle.refs[B]!.current.input).toBe("")
      env.handle.refs[B]!.set({ input: "draft for B", parts: [] })

      for (let round = 0; round < 3; round++) {
        await env.go(A)
        expect(env.handle.refs[A]!.current.input).toBe("draft for A")
        expect(await captureFrame(env.app)).toContain("draft for A")
        expect(await captureFrame(env.app)).not.toContain("draft for B")

        await env.go(B)
        expect(env.handle.refs[B]!.current.input).toBe("draft for B")
        expect(await captureFrame(env.app)).not.toContain("draft for A")
      }
    } finally {
      await env.dispose()
    }
  })

  test("background work continues and attention appears without moving focus", async () => {
    const env = await mount({ width: 100, route: { type: "session", sessionID: B }, sessions: [A, B] })
    try {
      await env.go(A)
      expect(env.handle.tabs!.open).toEqual([B, A])

      env.emitStatus(B, "busy")
      await waitUntil(() => env.handle.sync!.data.session_status[B]?.type === "busy")
      await settle(env.app)
      expect(firstLine(await captureFrame(env.app))).toContain("●")
      expect(env.handle.route!.data).toEqual({ type: "session", sessionID: A })

      env.emitStatus(B, "idle")
      await waitUntil(() => env.handle.sync!.data.session_status[B]?.type === "idle")
      await settle(env.app)
      expect(env.handle.tabs!.isAttention(B)).toBe(true)
      expect(firstLine(await captureFrame(env.app))).toContain("◆")
      // Still on A: attention never steals focus.
      expect(env.handle.route!.data).toEqual({ type: "session", sessionID: A })

      await env.go(B)
      expect(env.handle.tabs!.isAttention(B)).toBe(false)
      expect(firstLine(await captureFrame(env.app))).not.toContain("◆")
    } finally {
      await env.dispose()
    }
  })

  test("closing a tab keeps the session running and the draft reopenable", async () => {
    const env = await mount({ width: 100, route: { type: "session", sessionID: A }, sessions: [A, B] })
    try {
      await waitUntil(() => env.handle.refs[A] !== undefined)
      await env.go(B)
      env.handle.refs[B]!.set({ input: "unsent B", parts: [] })
      env.emitStatus(B, "busy")
      await waitUntil(() => env.handle.sync!.data.session_status[B]?.type === "busy")

      // Closing the active tab moves to the neighbour; B's run and draft remain.
      env.handle.tabs!.close(B)
      await waitUntil(() => env.handle.route!.data.type === "session" && env.handle.route!.data.sessionID === A)
      await settle(env.app)
      expect(env.handle.tabs!.open).toEqual([A])
      expect(env.handle.refs[A]!.current.input).toBe("")
      expect(env.handle.sync!.data.session_status[B]?.type).toBe("busy")
      expect(env.requests.filter((line) => line.startsWith("DELETE") || line.includes("abort"))).toEqual([])

      // Reopening is the session list's navigation; the tab and draft come back.
      await env.go(B)
      expect(env.handle.tabs!.open).toEqual([A, B])
      expect(env.handle.refs[B]!.current.input).toBe("unsent B")
      expect(env.handle.sync!.data.session_status[B]?.type).toBe("busy")
    } finally {
      await env.dispose()
    }
  })

  test("the tab strip keeps every title at normal width", async () => {
    const env = await mount({ width: 120, route: { type: "session", sessionID: A }, sessions: [A, B, C] })
    try {
      await env.go(B)
      await env.go(C)
      const line = firstLine(await captureFrame(env.app))
      expect(line).toContain("1 Investigate flaky tests")
      expect(line).toContain("2 Draft release notes")
      expect(line).toContain("3 Third session")
      expect(line).toContain("+")
      expect(line).not.toContain("…")
    } finally {
      await env.dispose()
    }
  })

  test("the tab strip stays inside a narrow width and keeps the active tab readable", async () => {
    const env = await mount({ width: 40, route: { type: "session", sessionID: A }, sessions: [A, B, C] })
    try {
      await env.go(B)
      await env.go(C)
      const line = firstLine(await captureFrame(env.app)).trimEnd()
      expect(line.length).toBeLessThanOrEqual(40)
      // The active tab is always in the window, with its number and a readable prefix.
      expect(line).toContain("3 Th")
      expect(line).toContain("…")
      expect(line).toContain("+")
    } finally {
      await env.dispose()
    }
  })

  test("restored tabs keep their saved order, drop unknown sessions, and leave the route alone", async () => {
    const env = await mount({
      width: 100,
      route: { type: "home" },
      sessions: [A, B],
      kv: { session_tabs: [B, "ses_gone", A] },
    })
    try {
      await waitUntil(() => env.handle.tabs!.open.length === 2)
      expect(env.handle.tabs!.open).toEqual([B, A])
      expect(env.handle.tabs!.active).toBeUndefined()
      expect(env.handle.route!.data.type).toBe("home")
    } finally {
      await env.dispose()
    }
  })
})
