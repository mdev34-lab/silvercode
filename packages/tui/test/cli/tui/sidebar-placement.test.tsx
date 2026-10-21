/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import type { Message, Part, TextPart } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../fixture/fixture"
import { waitFor } from "../../fixture/frame"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { TuiConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { DataProvider } from "../../../src/context/data"
import { EditorContextProvider } from "../../../src/context/editor"
import { EpilogueProvider } from "../../../src/context/epilogue"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { LocalProvider } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { PromptRefProvider } from "../../../src/context/prompt"
import { RouteProvider } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { Session } from "../../../src/routes/session"
import { SIDEBAR_ID } from "../../../src/routes/session/sidebar"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"

/**
 * SilverCode docks the session sidebar on the left instead of the right.
 *
 * The harness mounts the real `<Session />` route inside the app's provider
 * tree and mocks nothing but the HTTP boundary. Placement is then measured on
 * the laid-out renderables rather than guessed from text: the sidebar panel has
 * to occupy the left edge with the transcript starting after it when docked,
 * and pin to the left edge over a transcript that stays mounted and in place
 * when shown as an overlay on a narrow terminal.
 */

const SESSION_ID = "ses_sidebar_left"
const MESSAGE_ID = "msg_user"
const MESSAGE_TEXT = "Where does the sidebar live?"
const WIDE = 160
const NARROW = 100
const HEIGHT = 40

type Setup = Awaited<ReturnType<typeof testRender>>

const setups: { app: Setup; dispose: () => Promise<void> }[] = []

afterEach(async () => {
  for (const setup of setups.splice(0)) {
    setup.app.renderer.destroy()
    await setup.dispose()
  }
})

function sessionPayload() {
  return {
    id: SESSION_ID,
    slug: "sidebar-placement",
    title: "Sidebar placement",
    projectID: "proj_test",
    version: "0.0.0-test",
    directory,
    time: { created: 0, updated: 0 },
  }
}

function messagesPayload() {
  const info: Message = {
    id: MESSAGE_ID,
    sessionID: SESSION_ID,
    role: "user",
    time: { created: 1_700_000_000_000 },
    agent: "work",
    model: { providerID: "test", modelID: "model" },
  }
  const part: TextPart = {
    id: "prt_text",
    sessionID: SESSION_ID,
    messageID: info.id,
    type: "text",
    text: MESSAGE_TEXT,
  }
  return [{ info, parts: [part] satisfies Part[] }]
}

async function mountSession(width: number) {
  // Disposal is owned by `setups` so the tempdir outlives this function.
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === `/session/${SESSION_ID}`) return json(sessionPayload())
    if (url.pathname === `/session/${SESSION_ID}/message`) return json(messagesPayload())
    if (url.pathname === `/session/${SESSION_ID}/todo`) return json([])
    if (url.pathname === `/session/${SESSION_ID}/diff`) return json([])
    return undefined
  }, events)

  const config = createTuiResolvedConfig({})

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    // The provider tree app.tsx mounts the route in.
    return (
      <ClipboardProvider>
        <OpencodeKeymapProvider keymap={keymap}>
          <ToastProvider>
            <RouteProvider initialRoute={{ type: "session", sessionID: SESSION_ID }}>
              <TuiConfigProvider config={config}>
                <PluginRuntimeProvider value={createPluginRuntime()}>
                  <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <LocationProvider>
                          <EditorContextProvider>
                            <ExitProvider exit={() => {}}>
                              <EpilogueProvider set={() => {}}>
                                <SyncProvider>
                                  <DataProvider>
                                    <ThemeProvider mode="dark">
                                      <LocalProvider>
                                        <PromptStashProvider>
                                          <DialogProvider>
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <PromptRefProvider>
                                                  <Session />
                                                </PromptRefProvider>
                                              </PromptHistoryProvider>
                                            </FrecencyProvider>
                                          </DialogProvider>
                                        </PromptStashProvider>
                                      </LocalProvider>
                                    </ThemeProvider>
                                  </DataProvider>
                                </SyncProvider>
                              </EpilogueProvider>
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

  const app = await testRender(
    () => (
      <TestTuiContexts directory={directory} paths={{ home: "/tmp", state: tmp.path, worktree: directory }}>
        <ArgsProvider>
          <KVProvider>
            <Harness />
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ),
    { width, height: HEIGHT },
  )

  setups.push({ app, dispose: async () => await tmp[Symbol.asyncDispose]() })
  return app
}

function find(app: Setup, id: string) {
  return app.renderer.root.findDescendantById(id)
}

function frameWith(app: Setup, needle: string) {
  return waitFor(app, () => {
    const frame = app.captureCharFrame()
    return frame.includes(needle) ? frame : undefined
  })
}

describe("session sidebar placement", () => {
  test("docks the sidebar on the left with the transcript to its right", async () => {
    const app = await mountSession(WIDE)

    const panel = await waitFor(app, () => find(app, SIDEBAR_ID))
    const message = await waitFor(app, () => find(app, MESSAGE_ID))

    // The panel is a full-height column flush with the left edge, and the
    // transcript only starts once the panel's columns are spent.
    expect(panel.screenX).toBe(0)
    expect(panel.screenY).toBe(0)
    expect(panel.height).toBe(HEIGHT)
    expect(panel.width).toBeGreaterThan(0)
    expect(message.screenX).toBeGreaterThanOrEqual(panel.screenX + panel.width)
    // Docking the panel must not swallow the transcript.
    await frameWith(app, MESSAGE_TEXT)
  })

  test("pins the overlay sidebar to the left edge over a mounted transcript", async () => {
    const app = await mountSession(NARROW)

    // Narrow terminals hide the panel until it is toggled.
    await frameWith(app, MESSAGE_TEXT)
    expect(find(app, SIDEBAR_ID)).toBeUndefined()
    const transcript = await waitFor(app, () => find(app, MESSAGE_ID))
    const transcriptColumn = transcript.screenX

    // <leader>b (ctrl+x then b) toggles the sidebar, same as in the real TUI.
    app.mockInput.pressKey("x", { ctrl: true })
    await app.renderOnce()
    app.mockInput.pressKey("b")

    const panel = await waitFor(app, () => find(app, SIDEBAR_ID))

    // The overlay is pinned to the left edge instead of the right one.
    expect(panel.screenX).toBe(0)
    expect(panel.screenY).toBe(0)
    expect(panel.height).toBe(HEIGHT)
    // The overlay does not reflow the transcript: it stays mounted in the same
    // column, now underneath the panel.
    expect(transcript.screenX).toBe(transcriptColumn)
    expect(transcript.screenX).toBeLessThan(panel.screenX + panel.width)
    // ...so the opaque panel hides it from the rendered frame.
    await waitFor(app, () => (app.captureCharFrame().includes(MESSAGE_TEXT) ? undefined : true))
    expect(app.captureCharFrame()).not.toContain(MESSAGE_TEXT)
  })
})
