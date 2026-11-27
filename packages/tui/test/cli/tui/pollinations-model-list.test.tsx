/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount, type JSX } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { captureFrame, waitFor, waitUntil } from "../../fixture/frame"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { TuiConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { DataProvider } from "../../../src/context/data"
import { DialogModel } from "../../../src/component/dialog-model"
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
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { Toast, ToastProvider } from "../../../src/ui/toast"

type Setup = Awaited<ReturnType<typeof testRender>>

// Model rows mirror what `GET /config/providers` returns for the Pollinations
// provider after `parseModelList`: names carry the `community` and `free`
// labels, and prices are per million tokens. Free rows declare no positive
// price, as the live catalog does. Chat-capable LLM entries sampled
// from the live `gen.pollinations.ai/v1/models` catalog are used as the source.
function pollinationsModel(input: {
  id: string
  name: string
  input: number
  output: number
  attachment?: boolean
  tools?: boolean
  reasoning?: boolean
  context: number
}) {
  return {
    id: input.id,
    providerID: "pollinations",
    name: input.name,
    family: "",
    api: { id: input.id, url: "https://gen.pollinations.ai/v1", npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: input.input, output: input.output, cache: { read: 0, write: 0 } },
    limit: { context: input.context, output: 16_384 },
    capabilities: {
      temperature: true,
      reasoning: input.reasoning ?? false,
      attachment: input.attachment ?? false,
      toolcall: input.tools ?? false,
      input: { text: true, audio: false, image: input.attachment ?? false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

const pollinationsModels = Object.fromEntries(
  [
    pollinationsModel({
      id: "openai/gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      input: 0.15,
      output: 0.9,
      attachment: true,
      tools: true,
      reasoning: true,
      context: 1_050_000,
    }),
    pollinationsModel({
      id: "openai/gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      input: 3,
      output: 15,
      attachment: true,
      tools: true,
      reasoning: true,
      context: 1_050_000,
    }),
    pollinationsModel({
      id: "anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      input: 2,
      output: 10,
      attachment: true,
      tools: true,
      context: 1_000_000,
    }),
    pollinationsModel({
      id: "moonshotai/kimi-k2.7-code",
      name: "Kimi K2.7 Code",
      input: 0.633,
      output: 3.6925,
      attachment: true,
      tools: true,
      reasoning: true,
      context: 262_144,
    }),
    pollinationsModel({
      id: "community/xiaotian1171/atrium-concierge",
      name: "Atrium Concierge (community)",
      input: 0.15,
      output: 0.6,
      attachment: true,
      tools: true,
      reasoning: true,
      context: 1_048_576,
    }),
    pollinationsModel({
      id: "community/MarcosFRG/glm-5.3-flash",
      name: "GLM 5.3 Flash (community)",
      input: 0.06,
      output: 0.18,
      attachment: true,
      tools: true,
      reasoning: true,
      context: 1_048_576,
    }),
    pollinationsModel({
      id: "qwen/qwen3guard-gen-8b",
      name: "Qwen3Guard 8B (free)",
      input: 0,
      output: 0,
      context: 128_000,
    }),
    pollinationsModel({
      id: "community/YoannDev90/vercel-nemotron-3.5-lightning:free",
      name: "Nemotron 3.5 Lightning (community, free)",
      input: 0,
      output: 0,
      tools: true,
      context: 128_000,
    }),
    pollinationsModel({
      id: "community/vendouple/muse-glimmer-30b:free",
      name: "Muse Glimmer (Free) (community, free)",
      input: 0,
      output: 0,
      context: 128_000,
    }),
    pollinationsModel({
      id: "community/tomdacatto/llama-3.1-8B",
      name: "ULTRAFAST llama 3.1 8B (community)",
      input: 0.1,
      output: 0.1,
      tools: false,
      context: 128_000,
    }),
  ].map((model) => [model.id, model]),
)

const providersPayload = {
  providers: [
    {
      id: "pollinations",
      name: "Pollinations",
      source: "env",
      env: ["POLLINATIONS_API_KEY"],
      options: {},
      models: pollinationsModels,
    },
  ],
  default: {},
}

function createHarnessFetch() {
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/config") return json({})
    if (url.pathname === "/config/providers") return json(providersPayload)
    if (url.pathname === "/agent") return json([])
    if (url.pathname === "/api/agent")
      return json({ location: { directory, project: { id: "proj_test", directory } }, data: [] })
    if (url.pathname === "/session") return json([])
    return undefined
  }, events)
  return { events, fetch: calls.fetch }
}

type Harness = {
  app: Setup
  dialog: ReturnType<typeof useDialog>
  dispose: () => Promise<void>
}

async function mountModelDialog(width: number, height: number): Promise<Harness> {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { events, fetch } = createHarnessFetch()
  const config = createTuiResolvedConfig({})
  let captured: Pick<Harness, "dialog"> | undefined
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Capture() {
    const dialog = useDialog()
    onMount(() => {
      captured = { dialog }
      done()
    })
    return null
  }

  function Harness(props: { children: () => JSX.Element }) {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <ClipboardProvider>
        <OpencodeKeymapProvider keymap={keymap}>
          <ToastProvider>
            <RouteProvider initialRoute={{ type: "home" }}>
              <TuiConfigProvider config={config}>
                <PluginRuntimeProvider value={createPluginRuntime()}>
                  <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
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
                                            <Capture />
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <PromptRefProvider>{props.children()}</PromptRefProvider>
                                              </PromptHistoryProvider>
                                            </FrecencyProvider>
                                          </DialogProvider>
                                        </PromptStashProvider>
                                      </LocalProvider>
                                      <Toast />
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
            <Harness>{() => <></>}</Harness>
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ),
    { width, height, kittyKeyboard: true },
  )
  await ready
  await waitUntil(() => captured !== undefined)
  if (!captured) throw new Error("model dialog was not captured")
  return {
    app,
    dialog: captured.dialog,
    async dispose() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

describe("pollinations model list in the TUI", () => {
  test("renders Pollinations LLMs with community labels in the model dialog", async () => {
    const harness = await mountModelDialog(140, 40)
    harness.dialog.replace(() => <DialogModel />)
    const frame = await waitFor(harness.app, () => {
      const text: string = harness.app.captureCharFrame()
      return text.includes("GPT-5.6 Luna") ? text : undefined
    })
    expect(frame).toContain("Atrium Concierge (community)")
    expect(frame).toContain("GLM 5.3 Flash (community)")
    expect(frame).not.toContain("gpt-image")
    expect(await captureFrame(harness.app)).toContain("Select model")
    await harness.dispose()
  })
})
