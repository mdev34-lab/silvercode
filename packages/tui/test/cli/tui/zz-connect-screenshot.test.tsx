/** @jsxImportSource @opentui/solid */
// Throwaway evidence test for #474: renders the real /connect dialog against a
// fixture /provider payload matching the fixed server and captures the frame.
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { captureFrame, waitFor } from "../../fixture/frame"
import { createFetch, directory, json } from "../../fixture/tui-sdk"
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
import { RouteProvider } from "../../../src/context/route"
import { LocationProvider } from "../../../src/context/location"
import { EditorContextProvider } from "../../../src/context/editor"
import { DataProvider } from "../../../src/context/data"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { TuiConfigProvider, resolve } from "../../../src/config"
import { PromptRefProvider } from "../../../src/context/prompt"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { ToastProvider } from "../../../src/ui/toast"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { DialogProvider as ConnectProviderDialog } from "../../../src/component/dialog-provider"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { wait } from "../cmd/tui/sync-fixture"

function provider(id: string, name: string) {
  return { id, name, source: id === "tokenharbor" ? "custom" : "api", env: [], options: {}, models: {} }
}

test("connect dialog lists Token Harbor", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const calls = createFetch((url) => {
    if (url.pathname === "/api/agent") {
      return json({
        location: { directory, project: { id: "proj_test", directory } },
        data: [{ id: "build", name: "build", description: "Build agent", permissions: [] }],
      })
    }
    if (url.pathname === "/provider") {
      // Shape verified by the server-side test in
      // packages/opencode/test/server/httpapi-provider.test.ts (#474).
      return json({
        all: [
          provider("opencode", "OpenCode Zen"),
          provider("anthropic", "Anthropic"),
          provider("openai", "OpenAI"),
          provider("tokenharbor", "Token Harbor"),
        ],
        default: {},
        connected: [],
      })
    }
    if (url.pathname === "/provider/auth") return json({})
    if (url.pathname === "/config") return json({})
    if (url.pathname === "/config/providers") return json({ providers: [], default: {} })
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
    const dialog = useDialog()
    onMount(() => {
      sync = s
      dialog.replace(() => <ConnectProviderDialog />)
      done()
    })
    return <></>
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <ArgsProvider yolo={true}>
          <KVProvider>
            <Harness />
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 35 },
  )

  try {
    await ready
    await wait(() => sync.status === "complete")
    let frame = ""
    for (let attempt = 0; attempt < 400; attempt++) {
      await app.renderOnce()
      frame = String(await captureFrame(app))
      if (frame.includes("Token Harbor")) break
      await Bun.sleep(5)
    }
    await Bun.write("/tmp/connect-frame.txt", frame)
    expect(frame).toContain("Connect a provider")
    expect(frame).toContain("Token Harbor")
  } finally {
    app.renderer.destroy()
  }
})
