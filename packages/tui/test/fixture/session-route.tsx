/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { TuiPluginApi, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import type {
  AssistantMessage,
  Message,
  Part,
  PermissionRequest,
  Provider,
  Session as SessionInfo,
  SessionStatus,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import { tmpdir } from "./fixture"
import { createTuiResolvedConfig } from "./tui-runtime"
import { createEventSource, createFetch, directory, json } from "./tui-sdk"
import { TestTuiContexts } from "./tui-environment"
import { createTuiAttention } from "../../src/attention"
import { TuiConfigProvider, useTuiConfig } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { DataProvider } from "../../src/context/data"
import { EditorContextProvider } from "../../src/context/editor"
import { EpilogueProvider } from "../../src/context/epilogue"
import { useEvent } from "../../src/context/event"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider, useKV } from "../../src/context/kv"
import { LocalProvider } from "../../src/context/local"
import { LocationProvider } from "../../src/context/location"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { PromptRefProvider } from "../../src/context/prompt"
import { RouteProvider, useRoute } from "../../src/context/route"
import { SDKProvider, useSDK } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider, useTheme } from "../../src/context/theme"
import SidebarContext from "../../src/feature-plugins/sidebar/context"
import SidebarFooter from "../../src/feature-plugins/sidebar/footer"
import {
  OpencodeKeymapProvider,
  registerOpencodeKeymap,
  useBindings,
  useOpencodeKeymap,
  type OpenTuiKeymap,
} from "../../src/keymap"
import { createTuiApiAdapters } from "../../src/plugin/adapters"
import { createTuiApi } from "../../src/plugin/api"
import { createPluginRuntime, PluginRuntimeProvider } from "../../src/plugin/runtime"
import { FrecencyProvider } from "../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../src/prompt/history"
import { PromptStashProvider } from "../../src/prompt/stash"
import { Session } from "../../src/routes/session"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider, useToast } from "../../src/ui/toast"

// Mounts the real `<Session />` route inside the app's provider tree and mocks
// nothing but the HTTP boundary, so layout checks measure what users see
// (prompt, status line, sidebar, transcript) rather than isolated components.
// Shared by the #241 layout-state and thinking-theme regressions.

export const BASE = 1_700_000_000_000
export const PROVIDER_ID = "test-provider"
export const MODEL_ID = "test-model"

export type Setup = Awaited<ReturnType<typeof testRender>>

export function sessionInfo(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    slug: id,
    title: `Session ${id}`,
    projectID: "proj_test",
    version: "0.0.0-test",
    directory,
    time: { created: BASE, updated: BASE },
    ...overrides,
  }
}

export function userMessage(id: string, sessionID: string, overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: BASE },
    agent: "build",
    model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
    ...overrides,
  }
}

export function assistantMessage(
  id: string,
  sessionID: string,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: BASE, completed: BASE + 5000 },
    parentID: "msg_user",
    modelID: MODEL_ID,
    providerID: PROVIDER_ID,
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  }
}

export function textPart(id: string, message: Message, text: string): Part {
  return { id, sessionID: message.sessionID, messageID: message.id, type: "text", text }
}

export function provider(context = 200_000): Provider {
  return {
    id: PROVIDER_ID,
    name: "TestProvider",
    source: "config",
    env: [],
    options: {},
    models: {
      [MODEL_ID]: {
        id: MODEL_ID,
        providerID: PROVIDER_ID,
        api: { id: MODEL_ID, url: "http://test", npm: "test" },
        name: "Test Model",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
        limit: { context, output: 8_192 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2026-01-01",
      },
    },
  }
}

export type MountOptions = {
  width: number
  height: number
  // The first session is the routed one.
  sessions: SessionInfo[]
  messages?: Record<string, { info: Message; parts: Part[] }[]>
  providers?: Provider[]
  status?: Record<string, SessionStatus>
  permissions?: Record<string, PermissionRequest[]>
  theme?: string
  kv?: Record<string, unknown>
}

const setups: { app: Setup; dispose: () => Promise<void> }[] = []

export async function disposeSessionRoutes() {
  for (const setup of setups.splice(0)) {
    setup.app.renderer.destroy()
    await setup.dispose()
  }
}

export async function mountSessionRoute(options: MountOptions) {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify(options.kv ?? {}))

  const routed = options.sessions[0]
  const providers = options.providers ?? [provider()]
  const events = createEventSource()
  const calls = createFetch((url) => {
    const session = options.sessions.find((item) => url.pathname === `/session/${item.id}`)
    if (session) return json(session)
    const messages = options.sessions.find((item) => url.pathname === `/session/${item.id}/message`)
    if (messages) return json(options.messages?.[messages.id] ?? [])
    if (/^\/session\/[^/]+\/(todo|diff)$/.test(url.pathname)) return json([])
    if (url.pathname === "/session") return json(options.sessions)
    if (url.pathname === "/session/status") return json(options.status ?? {})
    if (url.pathname === "/config/providers") return json({ providers, default: { [PROVIDER_ID]: MODEL_ID } })
    if (url.pathname === "/provider")
      return json({ all: providers, default: { [PROVIDER_ID]: MODEL_ID }, connected: [PROVIDER_ID] })
    if (url.pathname === "/agent" || url.pathname === "/api/agent") {
      const data = [{ name: "build", mode: "primary", description: "Build agent", permission: {}, options: {} }]
      if (url.pathname === "/agent") return json(data)
      return json({ location: { directory, project: { id: "proj_test", directory } }, data })
    }
    return undefined
  }, events)

  const config = createTuiResolvedConfig(options.theme ? { theme: options.theme } : {})
  const pluginRuntime = createPluginRuntime()
  let keymapRef: OpenTuiKeymap | undefined
  let syncRef: ReturnType<typeof useSync> | undefined

  // Mirrors the plugin host (packages/opencode/src/plugin/tui/runtime.ts): slots
  // only render once the registry exists, and the builtin sidebar plugins own
  // the context bar and footer that the session sidebar displays.
  function Plugins() {
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
    const adapters = createTuiApiAdapters({
      version: "0.0.0-test",
      tuiConfig,
      dialog: useDialog(),
      keymap: useOpencodeKeymap(),
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
    const meta = { id: "test", source: "internal" } as never
    void SidebarContext.tui(api, undefined, meta)
    void SidebarFooter.tui(api, undefined, meta)
    syncRef = useSync()
    return null
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    keymapRef = keymap
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <ClipboardProvider>
        <OpencodeKeymapProvider keymap={keymap}>
          <ToastProvider>
            <RouteProvider initialRoute={{ type: "session", sessionID: routed.id }}>
              <TuiConfigProvider config={config}>
                <PluginRuntimeProvider value={pluginRuntime}>
                  <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <LocationProvider>
                          <EditorContextProvider>
                            <ExitProvider exit={() => {}}>
                              <EpilogueProvider set={() => {}}>
                                <SyncProvider>
                                  <DataProvider>
                                    <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                                      <LocalProvider>
                                        <PromptStashProvider>
                                          <DialogProvider>
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <PromptRefProvider>
                                                  <Plugins />
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
    { width: options.width, height: options.height },
  )

  setups.push({ app, dispose: async () => await tmp[Symbol.asyncDispose]() })

  await waitFor(app, () => (keymapRef && syncRef ? true : undefined))
  // The route is usable once the session row has been hydrated.
  await waitFor(app, () => (syncRef!.session.get(routed.id) ? true : undefined))
  const sync = syncRef!
  if (options.permissions) {
    for (const [sessionID, requests] of Object.entries(options.permissions)) sync.set("permission", sessionID, requests)
  }
  if (options.status) {
    for (const [sessionID, status] of Object.entries(options.status)) sync.set("session_status", sessionID, status)
  }
  await settle(app)

  return { app, events, sync, keymap: () => keymapRef! }
}

export async function waitFor<T>(app: Setup, probe: () => T | undefined, passes = 400): Promise<T> {
  for (let pass = 0; pass <= passes; pass++) {
    await app.renderOnce()
    const value = probe()
    if (value !== undefined) return value
    await Bun.sleep(5)
  }
  throw new Error(`condition never settled:\n${app.captureCharFrame()}`)
}

export async function settle(app: Setup) {
  await Bun.sleep(150)
  await app.renderOnce()
}

export function frameOf(app: Setup) {
  return app.captureCharFrame()
}

// Visual evidence for layout reviews: when LAYOUT_CAPTURE_DIR is set, dump the
// current frame as `<name>.txt` (the before/after renders quoted in specs/).
export async function snapshot(app: Setup, name: string) {
  const dir = process.env.LAYOUT_CAPTURE_DIR
  if (!dir) return
  await mkdir(dir, { recursive: true })
  await Bun.write(path.join(dir, `${name}.txt`), frameOf(app))
}

// Joined span text per row; the streaming markdown/code blocks only show up in
// span captures once the frame settles.
export function spansOf(app: Setup) {
  return app
    .captureSpans()
    .lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n")
}

// Every span whose text includes `needle`, with its colour and attribute bits.
export function spansMatching(app: Setup, needle: string) {
  return app.captureSpans().lines.flatMap((line) => line.spans.filter((span) => span.text.includes(needle)))
}

// Overlap detection on the character grid: a frame row never contains two
// primary controls drawn over each other, so look for words glued together.
export function rows(app: Setup) {
  return frameOf(app).replace(/\n$/, "").split("\n")
}
