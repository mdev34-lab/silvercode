/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import type { TuiPluginApi, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import { tmpdir } from "../../fixture/fixture"
import { waitFor } from "../../fixture/frame"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ArgsProvider } from "../../../src/context/args"
import { KVProvider, useKV } from "../../../src/context/kv"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider, useSDK } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { PermissionProvider } from "../../../src/context/permission"
import { LocalProvider } from "../../../src/context/local"
import { ExitProvider } from "../../../src/context/exit"
import { ThemeProvider, useTheme } from "../../../src/context/theme"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { LocationProvider } from "../../../src/context/location"
import { EditorContextProvider } from "../../../src/context/editor"
import { DataProvider } from "../../../src/context/data"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { TuiConfigProvider, useTuiConfig } from "../../../src/config"
import { PromptRefProvider } from "../../../src/context/prompt"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { ToastProvider, useToast } from "../../../src/ui/toast"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings, useOpencodeKeymap } from "../../../src/keymap"
import { useEvent } from "../../../src/context/event"
import { Home } from "../../../src/routes/home"
import { createTuiAttention } from "../../../src/attention"
import { createTuiApi } from "../../../src/plugin/api"
import { createTuiApiAdapters } from "../../../src/plugin/adapters"
import HomeFooter from "../../../src/feature-plugins/home/footer"
import HomeTips from "../../../src/feature-plugins/home/tips"

/**
 * Home screen layout regressions. Renders the production `Home` route with the
 * app's provider tree and the builtin home footer and tips plugins registered
 * through the real plugin slot host, then asserts on the rendered frame.
 */

const SESSION_ID = "ses_home_layout"
const VERSION = "0.0.0-test"
// Tip rotation interval in routes/home.tsx.
const ROTATE_MS = 10_000

type Options = { width: number; connected?: boolean; sessions?: boolean; tipsHidden?: boolean }
type Setup = Awaited<ReturnType<typeof testRender>>

function providersPayload(connected: boolean) {
  const cost = connected ? 1 : 0
  const providerID = connected ? "test" : "opencode"
  const modelID = connected ? "test-model" : "free-model"
  const model = {
    id: modelID,
    providerID,
    api: { id: modelID, url: "http://test", npm: "@ai-sdk/test" },
    name: modelID,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: cost, output: cost, cache: { read: 0, write: 0 } },
    limit: { context: 100_000, output: 8_192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
  return {
    providers: [
      { id: providerID, name: providerID, source: "config", env: [], options: {}, models: { [modelID]: model } },
    ],
    default: { [providerID]: modelID },
  }
}

function sessionPayload() {
  return {
    id: SESSION_ID,
    slug: "home-layout",
    title: "Home layout",
    projectID: "proj_test",
    version: VERSION,
    directory,
    time: { created: 0, updated: 0 },
  }
}

function createHomeFetch(options: Options) {
  const connected = options.connected ?? true
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/config/providers") return json(providersPayload(connected))
    if (url.pathname === "/provider")
      return json({
        all: providersPayload(connected).providers,
        default: providersPayload(connected).default,
        connected: [connected ? "test" : "opencode"],
      })
    if (url.pathname === "/session") return json(options.sessions ? [sessionPayload()] : [])
    return undefined
  }, events)
  return { events, fetch: calls.fetch }
}

async function untilFrame(app: Setup, predicate: (frame: string) => boolean, maxPasses = 600) {
  return waitFor(
    app,
    () => {
      const frame = app.captureCharFrame()
      return predicate(frame) ? frame : undefined
    },
    maxPasses,
    `frame predicate not satisfied after ${maxPasses} passes`,
  )
}

async function renderHome(options: Options) {
  const { events, fetch } = createHomeFetch(options)
  const config = createTuiResolvedConfig({})
  const pluginRuntime = createPluginRuntime()

  function Plugins() {
    // app.tsx registers these commands; the home shortcut row reads their bindings.
    const tuiConfig = useTuiConfig()
    useBindings(() => ({
      commands: [{ name: "agent.cycle", title: "Agent cycle", category: "Agent", hidden: true, run() {} }],
      bindings: tuiConfig.keybinds.get("agent.cycle"),
    }))
    useBindings(() => ({
      commands: [{ name: "command.palette.show", title: "Commands", category: "System", run() {} }],
      bindings: tuiConfig.keybinds.get("command.palette.show"),
    }))

    const renderer = useRenderer()
    const keymap = useOpencodeKeymap()
    const adapters = createTuiApiAdapters({
      version: VERSION,
      tuiConfig,
      dialog: useDialog(),
      keymap,
      kv: useKV(),
      route: useRoute(),
      routes: pluginRuntime.routes,
      event: useEvent(),
      sdk: useSDK(),
      sync: useSync(),
      theme: useTheme(),
      toast: useToast(),
      renderer,
      attention: createTuiAttention({ renderer, config: tuiConfig, kv: useKV() }),
      Slot: pluginRuntime.Slot,
    })
    // Mirrors the plugin host (packages/opencode/src/plugin/tui/runtime.ts): every slot
    // registration gets a host-assigned plugin id.
    const host = pluginRuntime.setupSlots(createTuiApi(adapters))
    let count = 0
    const slots: TuiPluginApi["slots"] = {
      register(plugin: TuiSlotPlugin) {
        count += 1
        const id = `test:${count}`
        host.register({ ...plugin, id } as Parameters<typeof host.register>[0])
        return id
      },
    }
    const api = createTuiApi({ ...adapters, slots })
    // Builtin home plugins ignore options and meta; a full TuiPluginMeta fixture adds nothing here.
    const meta = { id: "test", source: "internal" } as never
    void HomeFooter.tui(api, undefined, meta)
    void HomeTips.tui(api, undefined, meta)
    return null
  }

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
                  <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
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
                                                <Plugins />
                                                <Home />
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

  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ tips_hidden: options.tipsHidden ?? false }))
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
    { width: options.width, height: 40 },
  )
  await untilFrame(app, (frame) => frame.includes("tab") && frame.includes(VERSION))
  await untilFrame(app, () => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  return app
}

function lines(frame: string) {
  return frame.split("\n")
}

/** Columns of blank space before and after the text in a rendered row. */
function margins(row: string, width: number) {
  const left = row.search(/\S/)
  const right = width - row.trimEnd().length
  return { left, right }
}

function footerRow(frame: string) {
  return lines(frame).find((row) => row.includes(`· ${VERSION}`)) ?? ""
}

function shortcutRow(frame: string) {
  return lines(frame).find((row) => row.includes("agents") && row.includes("commands")) ?? ""
}

/** Rows that belong to the prompt box (left border glyphs). */
function promptRows(frame: string) {
  return lines(frame).filter((row) => row.includes("┃") || row.includes("╹")).length
}

function placeholderRow(frame: string) {
  return lines(frame).find((row) => row.includes("┃") && row.trim() !== "┃") ?? ""
}

function hasPlaceholder(row: string) {
  return row.replace(/[┃\s]/g, "").length > 0
}

describe("home layout", () => {
  test.each([120, 60])("centers the path and version as one footer text at width %i", async (width) => {
    const app = await renderHome({ width })
    try {
      const frame = app.captureCharFrame()
      const row = footerRow(frame)
      const path = row.trim().split(" · ")[0]
      expect(path).toContain("/tmp/opencode/packages/tui")
      expect(row.trim().split(" · ")).toHaveLength(2)
      const { left, right } = margins(row, width)
      expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
      expect(frame).not.toContain("● Tip")
    } finally {
      app.renderer.destroy()
    }
  })

  test.each([120, 60])("centers the agents and commands shortcut row at width %i", async (width) => {
    const app = await renderHome({ width })
    try {
      const frame = app.captureCharFrame()
      const row = shortcutRow(frame)
      expect(row).toContain("tab agents")
      expect(row).toContain("ctrl+p commands")
      const { left, right } = margins(row, width)
      expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("shows a single-line tip as the prompt placeholder instead of a separate tip row", async () => {
    const app = await renderHome({ width: 120, connected: true, sessions: true })
    try {
      const frame = await untilFrame(app, (value) => hasPlaceholder(placeholderRow(value)))
      expect(placeholderRow(frame)).not.toContain("Ask anything")
      expect(frame).not.toContain("● Tip")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps the example placeholder when tips are hidden", async () => {
    const app = await renderHome({ width: 120, connected: true, sessions: true, tipsHidden: true })
    try {
      const frame = await untilFrame(app, (value) => value.includes("Ask anything"))
      expect(frame).not.toContain("● Tip")
    } finally {
      app.renderer.destroy()
    }
  })

  test("rotates the placeholder without changing the prompt size or interrupting typing", async () => {
    const app = await renderHome({ width: 60, connected: true, sessions: true })
    try {
      const before = await untilFrame(app, (value) => hasPlaceholder(placeholderRow(value)))
      const rows = promptRows(before)
      const first = placeholderRow(before)

      await Bun.sleep(ROTATE_MS + 500)
      await app.renderOnce()
      const rotated = app.captureCharFrame()
      expect(placeholderRow(rotated)).not.toEqual(first)
      expect(promptRows(rotated)).toBe(rows)

      app.mockInput.typeText("draft")
      await untilFrame(app, (value) => value.includes("draft"))
      await Bun.sleep(ROTATE_MS + 500)
      await app.renderOnce()
      const typed = app.captureCharFrame()
      expect(placeholderRow(typed)).toContain("draft")
      expect(promptRows(typed)).toBe(rows)
    } finally {
      app.renderer.destroy()
    }
  }, 60_000)
})
