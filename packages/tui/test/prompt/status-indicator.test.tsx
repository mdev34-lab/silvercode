/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import { onCleanup, onMount } from "solid-js"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../fixture/fixture"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import { TestTuiContexts } from "../fixture/tui-environment"
import { ArgsProvider } from "../../src/context/args"
import { KVProvider } from "../../src/context/kv"
import { ProjectProvider } from "../../src/context/project"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { PermissionProvider } from "../../src/context/permission"
import { LocalProvider } from "../../src/context/local"
import { ExitProvider } from "../../src/context/exit"
import { ThemeProvider } from "../../src/context/theme"
import { RouteProvider } from "../../src/context/route"
import { LocationProvider } from "../../src/context/location"
import { EditorContextProvider } from "../../src/context/editor"
import { DataProvider } from "../../src/context/data"
import { FrecencyProvider } from "../../src/prompt/frecency"
import { ClipboardProvider } from "../../src/context/clipboard"
import { createPluginRuntime, PluginRuntimeProvider } from "../../src/plugin/runtime"
import { TuiConfigProvider, resolve } from "../../src/config"
import { PromptRefProvider } from "../../src/context/prompt"
import { PromptStashProvider } from "../../src/prompt/stash"
import { PromptHistoryProvider } from "../../src/prompt/history"
import { ToastProvider } from "../../src/ui/toast"
import { DialogProvider } from "../../src/ui/dialog"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { Prompt } from "../../src/component/prompt"
import { captureFrame } from "../fixture/frame"

/**
 * Regression test for the prompt status indicator.
 *
 * The indicator used to be an 8-column Knight Rider sweep; `spinnerDef` now
 * returns the two-frame blink `["■", " "]` at a 500ms interval, so a single
 * square cell toggles on and off next to the status text. These tests render
 * the production composer and drive a real `session.status: busy` event so the
 * actual `<spinner>` call site is exercised, then assert the square blinks in
 * place without pushing the status text around.
 */

const SESSION_ID = "ses_blink"

type Setup = Awaited<ReturnType<typeof testRender>>

async function waitUntil(fn: () => boolean, timeout = 15_000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error(`timed out after ${timeout}ms`)
    await Bun.sleep(10)
  }
}

/** The line holding the running status: the spinner square sits left of "esc interrupt". */
function statusRow(frame: string) {
  return frame.split("\n").find((line) => line.includes("esc interrupt")) ?? ""
}

/** Pumps frames until both halves of the blink have been observed, in order. */
async function observeBlink(app: Setup, timeout = 8_000) {
  const start = Date.now()
  let on: string | undefined
  let off: string | undefined
  while (Date.now() - start < timeout) {
    const row = statusRow(await captureFrame(app))
    if (row.includes("■") && on === undefined) on = row
    if (on !== undefined && !row.includes("■")) off = row
    if (on !== undefined && off !== undefined) return { on, off }
    await app.renderOnce()
    await Bun.sleep(25)
  }
  throw new Error(`status indicator did not blink within ${timeout}ms on=${on ?? "none"}`)
}

describe("prompt status indicator", () => {
  test("blinks a single square on and off while a session is busy", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const calls = createFetch((url) => {
      if (url.pathname === "/api/agent") {
        return json({
          location: { directory, project: { id: "proj_test", directory } },
          data: [{ id: "build", name: "build", description: "Build agent", permissions: [] }],
        })
      }
      return undefined
    })
    const config = resolve({}, { terminalSuspend: true })
    const pluginRuntime = createPluginRuntime()
    const events = createEventSource()

    let sync!: ReturnType<typeof useSync>
    let done!: () => void
    const ready = new Promise<void>((resolve) => {
      done = resolve
    })

    function Harness() {
      const renderer = useRenderer()
      const keymap = createDefaultOpenTuiKeymap(renderer)
      const off = registerOpencodeKeymap(keymap, renderer, config)
      onCleanup(off)

      return (
        <ClipboardProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <ToastProvider>
              <RouteProvider initialRoute={{ type: "session", sessionID: SESSION_ID }}>
                <TuiConfigProvider config={config}>
                  <PluginRuntimeProvider value={pluginRuntime}>
                    <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                      <PermissionProvider>
                        <ProjectProvider>
                          <LocationProvider>
                            <EditorContextProvider>
                              <ExitProvider exit={() => {}}>
                                <SyncProvider>
                                  <DataProvider>
                                    <ThemeProvider mode="dark">
                                      <LocalProvider>
                                        <PromptStashProvider>
                                          <DialogProvider>
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <PromptRefProvider>
                                                  <Probe />
                                                </PromptRefProvider>
                                              </PromptHistoryProvider>
                                            </FrecencyProvider>
                                          </DialogProvider>
                                        </PromptStashProvider>
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

    function Probe() {
      const s = useSync()
      onMount(() => {
        sync = s
        done()
      })
      return <Prompt sessionID={SESSION_ID} />
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
      { width: 100, height: 24, kittyKeyboard: true },
    )

    try {
      await ready
      await waitUntil(() => sync.status === "complete")
      await app.renderOnce()
      expect(statusRow(app.captureCharFrame())).toBe("")

      const event: GlobalEvent = {
        directory,
        project: "proj_test",
        payload: {
          id: "evt_status",
          type: "session.status",
          properties: { sessionID: SESSION_ID, status: { type: "busy" } },
        },
      } as GlobalEvent
      events.emit(event)
      await waitUntil(() => sync.data.session_status[SESSION_ID]?.type === "busy")
      await app.renderOnce()

      const { on, off } = await observeBlink(app)
      const column = on.indexOf("■")

      // One square cell, not the old eight-column sweep.
      expect(column).toBeGreaterThanOrEqual(0)
      expect(on.split("■")).toHaveLength(2)
      // The blink is a real toggle in place: the off frame blanks that same cell
      // while the status text stays put, so the indicator keeps a one-cell slot.
      expect(off.slice(column, column + 1)).toBe(" ")
      expect(off).not.toContain("■")
      expect(off.indexOf("esc interrupt")).toBe(on.indexOf("esc interrupt"))
      expect(column).toBeLessThan(on.indexOf("esc interrupt"))
    } finally {
      app.renderer.destroy()
    }
  })
})
