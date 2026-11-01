/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../fixture/fixture"
import { captureFrame } from "../fixture/frame"
import { createFetch, directory, json } from "../fixture/tui-sdk"
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
import { wait } from "../cli/cmd/tui/sync-fixture"

describe("prompt badge", () => {
  test("renders YOLO badge when in yolo mode", async () => {
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
              <RouteProvider>
                <TuiConfigProvider config={config}>
                  <PluginRuntimeProvider value={pluginRuntime}>
                    <SDKProvider url="http://test" directory={directory} fetch={calls.fetch}>
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
      return <Prompt />
    }

    const app = await testRender(() => (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <ArgsProvider yolo={true}>
          <KVProvider>
            <Harness />
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ))

    try {
      await ready
      await wait(() => sync.status === "complete")
      await app.renderOnce()
      const frame = await captureFrame(app)
      expect(frame).toContain("YOLO")
    } finally {
      app.renderer.destroy()
    }
  })

  test("does not render badges in supervised mode", async () => {
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
              <RouteProvider>
                <TuiConfigProvider config={config}>
                  <PluginRuntimeProvider value={pluginRuntime}>
                    <SDKProvider url="http://test" directory={directory} fetch={calls.fetch}>
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
      return <Prompt />
    }

    const app = await testRender(() => (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <ArgsProvider>
          <KVProvider>
            <Harness />
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ))

    try {
      await ready
      await wait(() => sync.status === "complete")
      await app.renderOnce()
      const frame = await captureFrame(app)
      expect(frame).not.toContain("YOLO")
    } finally {
      app.renderer.destroy()
    }
  })
})
