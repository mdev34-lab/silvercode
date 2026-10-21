/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import type { GlobalEvent, Message, SessionStatus } from "@opencode-ai/sdk/v2"
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
import { RouteProvider, useRoute } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { Session } from "../../../src/routes/session"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { DOUBLE_PRESS_WINDOW_MS } from "../../../src/util/double-press"

/**
 * Double-Esc while a subagent trace is open stops that subagent and nothing
 * else. The harness mounts the real Session route on a child session, presses
 * Escape on the real keymap, and reads the subagent footer: the abort request
 * must carry the child's session id (the fixture throws on any request the
 * test did not account for, so a parent abort fails the run rather than
 * passing silently), the trace must say the cancellation is in flight, and
 * then report the cancelled child once its transcript carries the abort.
 */

const PARENT_ID = "ses_stop_parent"
const CHILD_ID = "ses_stop_child"
const SIBLING_ID = "ses_stop_sibling"
const HEIGHT = 40

type Setup = Awaited<ReturnType<typeof testRender>>

const setups: { app: Setup; dispose: () => Promise<void> }[] = []

afterEach(async () => {
  for (const setup of setups.splice(0)) {
    setup.app.renderer.destroy()
    await setup.dispose()
  }
})

function globalEvent(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

function statusEvent(status: SessionStatus): GlobalEvent {
  return globalEvent({ id: "evt_status", type: "session.status", properties: { sessionID: CHILD_ID, status } })
}

function abortedMessage(id: string): Message {
  return {
    id,
    sessionID: CHILD_ID,
    parentID: "msg_stop_user",
    role: "assistant",
    time: { created: 1_700_000_000_000, completed: 1_700_000_001_000 },
    modelID: "model",
    providerID: "test",
    mode: "review",
    agent: "review",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    error: { name: "MessageAbortedError", data: { message: "Aborted" } },
  }
}

function abortedMessageEvent(id: string): GlobalEvent {
  return globalEvent({
    id: "evt_aborted",
    type: "message.updated",
    properties: { sessionID: CHILD_ID, info: abortedMessage(id) },
  })
}

function completedMessage(id: string): Message {
  return {
    id,
    sessionID: CHILD_ID,
    parentID: "msg_stop_user",
    role: "assistant",
    time: { created: 1_700_000_000_000, completed: 1_700_000_001_000 },
    modelID: "model",
    providerID: "test",
    mode: "review",
    agent: "review",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function completedMessageEvent(id: string): GlobalEvent {
  return globalEvent({
    id: "evt_completed",
    type: "message.updated",
    properties: { sessionID: CHILD_ID, info: completedMessage(id) },
  })
}

function rowOf(frame: string, needle: string): number {
  const row = frame.split("\n").findIndex((line) => line.includes(needle))
  if (row === -1) throw new Error(`needle "${needle}" not found in frame:\n${frame}`)
  return row
}

function columnOf(frame: string, needle: string): number {
  const line = frame.split("\n")[rowOf(frame, needle)] ?? ""
  return line.indexOf(needle)
}

async function mountChildTrace(status: SessionStatus, options: { sibling?: boolean; failAbort?: boolean } = {}) {
  // Disposal is owned by `setups` so the tempdir outlives this function.
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const aborts: string[] = []
  const failAbort = { current: options.failAbort === true }
  const events = createEventSource()
  function sessionInfo(id: string, title: string) {
    return {
      id,
      slug: title,
      parentID: PARENT_ID,
      title,
      projectID: "proj_test",
      version: "0.0.0-test",
      directory,
      time: { created: 0, updated: 0 },
    }
  }
  const calls = createFetch((url) => {
    if (url.pathname === `/session/${CHILD_ID}`) return json(sessionInfo(CHILD_ID, "Cache fix (@review subagent)"))
    if (options.sibling && url.pathname === `/session/${SIBLING_ID}`)
      return json(sessionInfo(SIBLING_ID, "Docs pass (@explore subagent)"))
    if (url.pathname.endsWith("/message") || url.pathname.endsWith("/todo") || url.pathname.endsWith("/diff")) {
      if (url.pathname.startsWith(`/session/${CHILD_ID}/`)) return json([])
      if (options.sibling && url.pathname.startsWith(`/session/${SIBLING_ID}/`)) return json([])
      return undefined
    }
    if (url.pathname === "/session/status")
      return json(options.sibling ? { [CHILD_ID]: status, [SIBLING_ID]: { type: "busy" } } : { [CHILD_ID]: status })
    if (url.pathname === `/session/${CHILD_ID}/abort` || url.pathname === `/session/${SIBLING_ID}/abort`) {
      aborts.push(url.pathname)
      if (failAbort.current) return json({ error: "abort failed" }, { status: 500 })
      return json(true)
    }
    return undefined
  }, events)

  const config = createTuiResolvedConfig({})
  let navigate: ((sessionID: string) => void) | undefined
  let openDialog: (() => void) | undefined

  function RouteProbe() {
    const route = useRoute()
    navigate = (sessionID: string) => route.navigate({ type: "session", sessionID })
    return undefined
  }

  function DialogProbe() {
    const dialog = useDialog()
    openDialog = () => dialog.replace(() => <text>Probe dialog</text>)
    return undefined
  }

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
            <RouteProvider initialRoute={{ type: "session", sessionID: CHILD_ID }}>
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
                                                  <RouteProbe />
                                                  <DialogProbe />
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
    { width: 160, height: HEIGHT },
  )

  setups.push({ app, dispose: async () => await tmp[Symbol.asyncDispose]() })
  return {
    app,
    aborts,
    events,
    failAbort,
    navigate: (sessionID: string) => navigate?.(sessionID),
    openDialog: () => openDialog?.(),
  }
}

describe("subagent double-Esc stop", () => {
  test("cancels the subagent whose trace is open and nothing else", async () => {
    const { app, aborts, events } = await mountChildTrace({ type: "busy" })

    const frame = await waitFor(app, () => {
      const current = app.captureCharFrame()
      return current.includes("Stop subagent") ? current : undefined
    })
    expect(frame).toContain("Review")
    // The trace exposes the double-press action in its footer.
    expect(frame).toContain("escape escape")

    app.mockInput.pressEscape()
    await waitFor(app, () => (app.captureCharFrame().includes("again to stop") ? true : undefined))
    // The first press only arms the double-press window.
    expect(aborts).toEqual([])

    app.mockInput.pressEscape()
    await waitFor(app, () => (app.captureCharFrame().includes("Cancelling…") ? true : undefined))
    // The abort targeted the viewed child's execution handle, never the parent.
    expect(aborts).toEqual([`/session/${CHILD_ID}/abort`])

    // The child exits: the transcript records the abort and the session goes idle.
    events.emit(abortedMessageEvent("msg_stop_child"))
    events.emit(statusEvent({ type: "idle" }))

    const cancelled = await waitFor(app, () => {
      const current = app.captureCharFrame()
      return current.includes("Cancelled") ? current : undefined
    })
    // The trace stays inspectable and no longer offers the stopped subagent.
    expect(cancelled).toContain("Review")
    expect(cancelled).not.toContain("Cancelling…")
    expect(cancelled).not.toContain("Stop subagent")
    expect(aborts).toEqual([`/session/${CHILD_ID}/abort`])
  })

  test("re-targets the stop to whichever subagent trace is open", async () => {
    const { app, aborts, navigate } = await mountChildTrace({ type: "busy" }, { sibling: true })

    await waitFor(app, () => (app.captureCharFrame().includes("Stop subagent") ? true : undefined))

    // Arm the first trace, then switch to the sibling: the arm belongs to the
    // trace it was made on, so the first press on the sibling only arms it.
    app.mockInput.pressEscape()
    await waitFor(app, () => (app.captureCharFrame().includes("again to stop") ? true : undefined))

    navigate(SIBLING_ID)
    const sibling = await waitFor(app, () => {
      const current = app.captureCharFrame()
      return current.includes("Explore") ? current : undefined
    })
    expect(sibling).toContain("Stop subagent")
    expect(sibling).not.toContain("again to stop")

    app.mockInput.pressEscape()
    await waitFor(app, () => (app.captureCharFrame().includes("again to stop") ? true : undefined))
    expect(aborts).toEqual([])

    app.mockInput.pressEscape()
    await waitFor(app, () => (app.captureCharFrame().includes("Cancelling…") ? true : undefined))

    // The confirmed press stopped the trace that was open, not the earlier child.
    expect(aborts).toEqual([`/session/${SIBLING_ID}/abort`])
  })

  test("leaves a finished subagent trace and the parent alone", async () => {
    const { app, aborts } = await mountChildTrace({ type: "idle" })

    const frame = await waitFor(app, () => {
      const current = app.captureCharFrame()
      return current.includes("Review") ? current : undefined
    })
    // Nothing to stop: the action is not offered, so Esc has no binding here.
    expect(frame).not.toContain("Stop subagent")

    app.mockInput.pressEscape()
    app.mockInput.pressEscape()
    await app.renderOnce()
    await app.renderOnce()

    expect(aborts).toEqual([])
    expect(app.captureCharFrame()).not.toContain("Cancelling…")
  })

  test("an accepted but ineffective abort leaves no stale cancellation label", async () => {
    const { app, aborts, events } = await mountChildTrace({ type: "busy" })

    await waitFor(app, () => (app.captureCharFrame().includes("Stop subagent") ? true : undefined))
    app.mockInput.pressEscape()
    await waitFor(app, () => (app.captureCharFrame().includes("again to stop") ? true : undefined))
    app.mockInput.pressEscape()
    await waitFor(app, () => (app.captureCharFrame().includes("Cancelling…") ? true : undefined))
    expect(aborts).toEqual([`/session/${CHILD_ID}/abort`])

    // The abort was accepted but the child kept working and finished on its
    // own: a completed turn is not a cancellation.
    events.emit(completedMessageEvent("msg_stop_finished"))
    events.emit(statusEvent({ type: "idle" }))
    await waitFor(app, () => (app.captureCharFrame().includes("Stop subagent") ? undefined : true))

    const finished = app.captureCharFrame()
    expect(finished).not.toContain("Cancelling…")
    expect(finished).not.toContain("Cancelled")

    // The child runs again: the stale request must not resurface as progress.
    events.emit(statusEvent({ type: "busy" }))
    await waitFor(app, () => (app.captureCharFrame().includes("Stop subagent") ? true : undefined))
    expect(app.captureCharFrame()).not.toContain("Cancelling…")
    expect(aborts).toEqual([`/session/${CHILD_ID}/abort`])
  })

  test("a failed abort request reads as still running and can be retried", async () => {
    const { app, aborts, failAbort } = await mountChildTrace({ type: "busy" }, { failAbort: true })

    await waitFor(app, () => (app.captureCharFrame().includes("Stop subagent") ? true : undefined))
    app.mockInput.pressEscape()
    await waitFor(app, () => (app.captureCharFrame().includes("again to stop") ? true : undefined))
    app.mockInput.pressEscape()
    // The press consumed the arm and reached the server; the request failed.
    await waitFor(app, () => (app.captureCharFrame().includes("again to stop") ? undefined : true))
    await waitFor(app, () => (aborts.length === 1 ? true : undefined))
    // A request that never landed must not read as progress: the footer is back
    // to offering the stop instead of claiming a cancellation is under way.
    await waitFor(app, () => {
      const current = app.captureCharFrame()
      return !current.includes("Cancelling…") && !current.includes("Cancelled") ? true : undefined
    })
    expect(aborts).toEqual([`/session/${CHILD_ID}/abort`])
    expect(app.captureCharFrame()).toContain("Stop subagent escape escape")

    // The second attempt is a fresh double press, not a re-armed leftover.
    failAbort.current = false
    app.mockInput.pressEscape()
    await waitFor(app, () => (app.captureCharFrame().includes("again to stop") ? true : undefined))
    app.mockInput.pressEscape()
    await waitFor(app, () => (app.captureCharFrame().includes("Cancelling…") ? true : undefined))
    expect(aborts).toEqual([`/session/${CHILD_ID}/abort`, `/session/${CHILD_ID}/abort`])
  })

  test("clicking the stop action twice cancels the traced subagent", async () => {
    const { app, aborts } = await mountChildTrace({ type: "busy" })

    const frame = await waitFor(app, () => {
      const current = app.captureCharFrame()
      return current.includes("Stop subagent") ? current : undefined
    })
    const column = columnOf(frame, "Stop subagent") + 2
    const row = rowOf(frame, "Stop subagent")

    await app.mockMouse.click(column, row)
    await waitFor(app, () => (app.captureCharFrame().includes("again to stop") ? true : undefined))
    expect(aborts).toEqual([])

    await app.mockMouse.click(column, rowOf(app.captureCharFrame(), "Stop subagent"))
    await waitFor(app, () => (app.captureCharFrame().includes("Cancelling…") ? true : undefined))
    expect(aborts).toEqual([`/session/${CHILD_ID}/abort`])
  })

  test("an armed stop lapses when the second press never comes", async () => {
    const { app, aborts } = await mountChildTrace({ type: "busy" })

    await waitFor(app, () => (app.captureCharFrame().includes("Stop subagent") ? true : undefined))

    app.mockInput.pressEscape()
    await waitFor(app, () => (app.captureCharFrame().includes("again to stop") ? true : undefined))

    // Wait the window out. Rendering keeps running, so this asserts the lapse
    // itself rather than a paused clock.
    await Bun.sleep(DOUBLE_PRESS_WINDOW_MS + 250)
    await waitFor(app, () => (app.captureCharFrame().includes("again to stop") ? undefined : true))

    // A press after the lapse re-arms instead of cancelling.
    app.mockInput.pressEscape()
    await waitFor(app, () => (app.captureCharFrame().includes("again to stop") ? true : undefined))
    expect(aborts).toEqual([])
    // This test spends the real window on purpose; the default test budget is
    // shorter than the window it waits out.
  }, 15_000)

  test("Esc over the trace belongs to a dialog while one is open", async () => {
    const { app, aborts, openDialog } = await mountChildTrace({ type: "busy" })

    await waitFor(app, () => (app.captureCharFrame().includes("Stop subagent") ? true : undefined))
    openDialog()
    await waitFor(app, () => (app.captureCharFrame().includes("Probe dialog") ? true : undefined))

    // The overlay owns Esc: it closes, and the stop neither arms nor fires.
    app.mockInput.pressEscape()
    await waitFor(app, () => (app.captureCharFrame().includes("Probe dialog") ? undefined : true))

    const closed = app.captureCharFrame()
    expect(closed).toContain("Stop subagent")
    expect(closed).not.toContain("again to stop")
    expect(aborts).toEqual([])
  })
})
