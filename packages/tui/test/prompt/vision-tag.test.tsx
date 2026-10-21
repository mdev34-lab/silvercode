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
import { LocalProvider, useLocal } from "../../src/context/local"
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

describe("prompt vision tag", () => {
  function agentPayload() {
    return [
      {
        name: "build",
        mode: "primary",
        description: "Build agent",
        permission: {},
        options: {},
      },
    ]
  }

  function createProvidersPayload() {
    return {
      providers: [
        {
          id: "test-provider",
          name: "TestProvider",
          source: "config",
          env: [],
          options: {},
          models: {
            "vision-model": {
              id: "vision-model",
              providerID: "test-provider",
              name: "VisionCapableModel",
              capabilities: {
                temperature: true,
                reasoning: false,
                attachment: true,
                toolcall: true,
                input: { text: true, audio: false, image: true, video: false, pdf: false },
                output: { text: true, audio: false, image: false, video: false, pdf: false },
                interleaved: false,
              },
              cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
              limit: { context: 100_000, output: 8_192 },
              status: "active",
              options: {},
              headers: {},
              release_date: "2026-01-01",
              variants: {
                high: { reasoning_effort: "high" },
                medium: { reasoning_effort: "medium" },
              },
            },
            "text-model": {
              id: "text-model",
              providerID: "test-provider",
              name: "TextOnlyModel",
              capabilities: {
                temperature: true,
                reasoning: false,
                attachment: false,
                toolcall: true,
                input: { text: true, audio: false, image: false, video: false, pdf: false },
                output: { text: true, audio: false, image: false, video: false, pdf: false },
                interleaved: false,
              },
              cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
              limit: { context: 100_000, output: 8_192 },
              status: "active",
              options: {},
              headers: {},
              release_date: "2026-01-01",
              variants: {
                medium: { reasoning_effort: "medium" },
              },
            },
            "unknown-caps-model": {
              id: "unknown-caps-model",
              providerID: "test-provider",
              name: "UnknownCapsModel",
              capabilities: {} as any,
              cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
              limit: { context: 100_000, output: 8_192 },
              status: "active",
              options: {},
              headers: {},
              release_date: "2026-01-01",
            },
          },
        },
      ],
      default: { "test-provider": "vision-model" },
    }
  }

  function setupHarness(providersPayload?: {
    providers: any[]
    default: Record<string, string>
  }) {
    const providers = providersPayload ?? createProvidersPayload()
    const calls = createFetch((url) => {
      if (url.pathname === "/agent") {
        return json(agentPayload())
      }
      if (url.pathname === "/api/agent") {
        return json({
          location: { directory, project: { id: "proj_test", directory } },
          data: agentPayload(),
        })
      }
      if (url.pathname === "/config/providers") {
        return json(providers)
      }
      return undefined
    })

    const config = resolve({}, { terminalSuspend: true })
    const pluginRuntime = createPluginRuntime()

    let sync!: ReturnType<typeof useSync>
    let local!: ReturnType<typeof useLocal>
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
      const l = useLocal()
      onMount(() => {
        sync = s
        local = l
        done()
      })
      return <Prompt />
    }

    return {
      Harness,
      getSync: () => sync,
      getLocal: () => local,
      ready,
    }
  }

  test("shows vision tag when active model supports vision", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const setup = setupHarness()

    const app = await testRender(() => (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <ArgsProvider model="test-provider/vision-model">
          <KVProvider>
            <setup.Harness />
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ))

    try {
      await setup.ready
      await wait(() => setup.getSync().status === "complete")
      await app.renderOnce()
      const frame = await captureFrame(app)
      expect(frame).toContain("vision")
      expect(frame).toContain("VisionCapableModel")
      expect(setup.getLocal().model.parsed().vision).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })

  test("does not show vision tag for text-only models", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const setup = setupHarness()

    const app = await testRender(() => (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <ArgsProvider model="test-provider/text-model">
          <KVProvider>
            <setup.Harness />
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ))

    try {
      await setup.ready
      await wait(() => setup.getSync().status === "complete")
      await app.renderOnce()
      const frame = await captureFrame(app)
      expect(frame).toContain("TextOnlyModel")
      expect(frame).not.toContain("vision")
      expect(setup.getLocal().model.parsed().vision).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })

  test("does not show vision tag when capability metadata is missing or unknown", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const setup = setupHarness()

    const app = await testRender(() => (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <ArgsProvider model="test-provider/unknown-caps-model">
          <KVProvider>
            <setup.Harness />
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ))

    try {
      await setup.ready
      await wait(() => setup.getSync().status === "complete")
      await app.renderOnce()
      const frame = await captureFrame(app)
      expect(frame).toContain("UnknownCapsModel")
      expect(frame).not.toContain("vision")
      expect(setup.getLocal().model.parsed().vision).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })

  test("does not show vision tag when no provider or model is selected", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const setup = setupHarness({
      providers: [],
      default: {},
    })

    const app = await testRender(() => (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <ArgsProvider>
          <KVProvider>
            <setup.Harness />
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ))

    try {
      await setup.ready
      await wait(() => setup.getSync().status === "complete")
      await app.renderOnce()
      const frame = await captureFrame(app)
      expect(frame).toContain("No provider selected")
      expect(frame).not.toContain("vision")
      expect(setup.getLocal().model.parsed().vision).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })

  test("dynamically updates vision tag on model switching", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const setup = setupHarness()

    const app = await testRender(() => (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <ArgsProvider model="test-provider/vision-model">
          <KVProvider>
            <setup.Harness />
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ))

    try {
      await setup.ready
      await wait(() => setup.getSync().status === "complete")
      await app.renderOnce()

      // Model A (vision) -> vision tag visible
      let frame = await captureFrame(app)
      expect(frame).toContain("VisionCapableModel")
      expect(frame).toContain("vision")
      expect(setup.getLocal().model.parsed().vision).toBe(true)

      // Switch to Model B (text-only) -> vision tag disappears
      setup.getLocal().model.set({ providerID: "test-provider", modelID: "text-model" })
      await app.renderOnce()
      frame = await captureFrame(app)
      expect(frame).toContain("TextOnlyModel")
      expect(frame).not.toContain("vision")
      expect(setup.getLocal().model.parsed().vision).toBe(false)

      // Switch back to Model C / Model A (vision) -> vision tag visible again
      setup.getLocal().model.set({ providerID: "test-provider", modelID: "vision-model" })
      await app.renderOnce()
      frame = await captureFrame(app)
      expect(frame).toContain("VisionCapableModel")
      expect(frame).toContain("vision")
      expect(setup.getLocal().model.parsed().vision).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })

  test("preserves thinking-effort and vision tags independently", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const setup = setupHarness()

    const app = await testRender(() => (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <ArgsProvider model="test-provider/vision-model">
          <KVProvider>
            <setup.Harness />
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ))

    try {
      await setup.ready
      await wait(() => setup.getSync().status === "complete" && setup.getLocal().model.ready)

      // Set variant to "high" on vision model -> both "high" and "vision" visible
      setup.getLocal().model.variant.set("high")
      await new Promise((r) => setTimeout(r, 50))
      await app.renderOnce()
      let frame = await captureFrame(app)
      expect(frame).toContain("VisionCapableModel")
      expect(frame).toContain("high")
      expect(frame).toContain("vision")

      // Check structural ordering: Model -> Provider -> high -> vision
      const modelIdx = frame.indexOf("VisionCapableModel")
      const providerIdx = frame.indexOf("TestProvider")
      const highIdx = frame.indexOf("high")
      const visionIdx = frame.indexOf("vision")
      expect(modelIdx).toBeGreaterThanOrEqual(0)
      expect(providerIdx).toBeGreaterThan(modelIdx)
      expect(highIdx).toBeGreaterThan(providerIdx)
      expect(visionIdx).toBeGreaterThan(highIdx)

      // The process-effort label (medium by default) is a separate label on
      // the same meta row: effort and explicit HIGH thinking are both shown
      // and stay distinct.
      const highRow = frame.split("\n").find((line) => line.includes("VisionCapableModel")) ?? ""
      expect(highRow).toContain("medium · high")
      expect(highRow).toContain("· high")

      // Set variant to "medium" on text-only model -> "medium" visible, "vision" absent
      setup.getLocal().model.set({ providerID: "test-provider", modelID: "text-model" })
      setup.getLocal().model.variant.set("medium")
      await new Promise((r) => setTimeout(r, 50))
      await app.renderOnce()
      frame = await captureFrame(app)
      expect(frame).toContain("TextOnlyModel")
      expect(frame).toContain("medium")
      expect(frame).not.toContain("vision")
      // Effort and thinking both read "medium" on this row: two distinct
      // labels are present even though the words match.
      const textRow = frame.split("\n").find((line) => line.includes("TextOnlyModel")) ?? ""
      expect(textRow.match(/medium/g)?.length).toBe(2)

      const textModelIdx = frame.indexOf("TextOnlyModel")
      const textProvIdx = frame.indexOf("TestProvider")
      const mediumIdx = frame.indexOf("medium")
      expect(textModelIdx).toBeGreaterThanOrEqual(0)
      expect(textProvIdx).toBeGreaterThan(textModelIdx)
      expect(mediumIdx).toBeGreaterThan(textProvIdx)

      // Clear variant on vision model -> "vision" visible, variant absent
      setup.getLocal().model.set({ providerID: "test-provider", modelID: "vision-model" })
      setup.getLocal().model.variant.set(undefined)
      await new Promise((r) => setTimeout(r, 50))
      await app.renderOnce()
      frame = await captureFrame(app)
      expect(frame).toContain("VisionCapableModel")
      expect(frame).toContain("vision")
      expect(frame).not.toContain("high")
      // Only the separate process-effort label still reads "medium": the
      // thinking tag itself is gone from the row (a leaked variant label
      // would make the row carry "medium" twice).
      const clearedRow = frame.split("\n").find((line) => line.includes("VisionCapableModel")) ?? ""
      expect(clearedRow.match(/medium/g)?.length).toBe(1)

      const visionModelIdx = frame.indexOf("VisionCapableModel")
      const visionProvIdx = frame.indexOf("TestProvider")
      const visionOnlyIdx = frame.indexOf("vision")
      expect(visionModelIdx).toBeGreaterThanOrEqual(0)
      expect(visionProvIdx).toBeGreaterThan(visionModelIdx)
      expect(visionOnlyIdx).toBeGreaterThan(visionProvIdx)
    } finally {
      app.renderer.destroy()
    }
  })
})
