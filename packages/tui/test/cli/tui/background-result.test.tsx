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
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"

/**
 * A background subagent result reaches the parent session as a synthetic text
 * part carrying the task delivery markup. The harness seeds exactly that
 * persisted transcript state — the same shape the task tool's injection
 * produces — and asserts the history renders a distinct indicator for it
 * instead of resuming silently.
 */

const SESSION_ID = "ses_background_result"
const HEIGHT = 40

type Setup = Awaited<ReturnType<typeof testRender>>

const setups: { app: Setup; dispose: () => Promise<void> }[] = []

afterEach(async () => {
  for (const setup of setups.splice(0)) {
    setup.app.renderer.destroy()
    await setup.dispose()
  }
})

function backgroundPart(messageID: string, state: "completed" | "error", summary: string): TextPart {
  return {
    id: `prt_bg_${state}`,
    sessionID: SESSION_ID,
    messageID,
    type: "text",
    synthetic: true,
    text: [
      `<task id="ses_worker" state="${state}">`,
      `<summary>${summary}</summary>`,
      state === "completed" ? "<task_result>Two findings.</task_result>" : "<task_error>Worker crashed.</task_error>",
      "</task>",
    ].join("\n"),
  }
}

function backgroundMessage(messageID: string, state: "completed" | "error", summary: string) {
  const info: Message = {
    id: messageID,
    sessionID: SESSION_ID,
    role: "user",
    time: { created: 1_700_000_000_000 },
    agent: "work",
    model: { providerID: "test", modelID: "model" },
  }
  return { info, parts: [backgroundPart(messageID, state, summary)] satisfies Part[] }
}

async function mountSession() {
  // Disposal is owned by `setups` so the tempdir outlives this function.
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === `/session/${SESSION_ID}`) {
      return json({
        id: SESSION_ID,
        slug: "background-result",
        title: "Background result",
        projectID: "proj_test",
        version: "0.0.0-test",
        directory,
        time: { created: 0, updated: 0 },
      })
    }
    if (url.pathname === `/session/${SESSION_ID}/message`) {
      return json([
        backgroundMessage("msg_bg_done", "completed", "Background task completed: Review cache fix"),
        backgroundMessage("msg_bg_failed", "error", "Background task failed: Typecheck"),
      ])
    }
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
    { width: 160, height: HEIGHT },
  )

  setups.push({ app, dispose: async () => await tmp[Symbol.asyncDispose]() })
  return app
}

describe("background subagent result indicator", () => {
  test("renders a distinct history entry for each delivered background result", async () => {
    const app = await mountSession()

    const frame = await waitFor(app, () => {
      const current = app.captureCharFrame()
      return current.includes("Background subagent completed") && current.includes("Background subagent failed")
        ? current
        : undefined
    })

    // Both delivery states surface with their summaries; the raw delivery
    // markup never leaks into the transcript as user text.
    expect(frame).toContain("Background task completed: Review cache fix")
    expect(frame).toContain("Background task failed: Typecheck")
    expect(frame).toContain("result delivered to the main agent")
    expect(frame).not.toContain("<task id=")
  })
})
