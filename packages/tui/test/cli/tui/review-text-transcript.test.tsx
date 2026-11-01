/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { createMemo, For, onCleanup } from "solid-js"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import type { AssistantMessage, Part, Provider, TextPart } from "@opencode-ai/sdk/v2"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ArgsProvider } from "../../../src/context/args"
import { KVProvider } from "../../../src/context/kv"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { PermissionProvider } from "../../../src/context/permission"
import { ExitProvider } from "../../../src/context/exit"
import { RouteProvider } from "../../../src/context/route"
import { LocalProvider } from "../../../src/context/local"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider, useTuiConfig } from "../../../src/config"
import { ToastProvider } from "../../../src/ui/toast"
import { LocationProvider } from "../../../src/context/location"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { AssistantMessageRow, SessionContext } from "../../../src/routes/session"
import { computeActivityGroups } from "../../../src/util/activity"
import { captureSpans, waitUntil } from "../../fixture/frame"
import { ReviewReport } from "@opencode-ai/core/review-report"

const SESSION = "ses_review_text_runtime"
const BASE = 1_700_000_000_000

// Assistant text is rendered by a
// streaming markdown/code block, which is not captured by `captureCharFrame()`
// but IS captured by `captureSpans()` once the frame settles. We join every
// span so partial word-aligned fragments are still detectable.
async function frameOfSpans(app: Awaited<ReturnType<typeof testRender>>) {
  const spans = await captureSpans(app)
  return spans.lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n")
}

async function settle(app: Awaited<ReturnType<typeof testRender>>) {
  // Give the streaming markdown/code renderer a couple of ticks to draw the
  // body content, then flush a fresh frame.
  await Bun.sleep(150)
  await app.renderOnce()
}

// The markdown/code renderer draws the body asynchronously (tree-sitter load is
// slow on cold CI runners), so poll until the text is drawn instead of trusting
// one fixed delay. The assertions that follow still check the same content.
async function settleUntilFrame(app: Awaited<ReturnType<typeof testRender>>, text: string, timeout = 8000) {
  const start = Date.now()
  await settle(app)
  while (!(await frameOfSpans(app)).includes(text)) {
    if (Date.now() - start > timeout) return
    await settle(app)
  }
}

type Setup = Awaited<ReturnType<typeof testRender>>
type Sync = ReturnType<typeof useSync>

let setup: { app: Setup; dispose: () => Promise<void>; events: ReturnType<typeof createEventSource>; sync: Sync } | undefined

afterEach(async () => {
  await setup?.dispose()
  setup = undefined
})

async function mount(options: { agent: string; completed?: boolean; parts: Part[] }) {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const events = createEventSource()
  const calls = createFetch(undefined, events)

  let sync!: Sync

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const tui = useTuiConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, tui))

    const storeSync = useSync()
    sync = storeSync
    const activity = createMemo(() =>
      computeActivityGroups(
        (storeSync.data.message[SESSION] ?? []).map((message) => ({
          message,
          parts: storeSync.data.part[message.id] ?? [],
        })),
      ),
    )
    const ctxValue = {
      get width() {
        return 100
      },
      sessionID: SESSION,
      conceal: () => true,
      thinkingMode: () => "hide" as const,
      showThinking: () => true,
      showTimestamps: () => false,
      showDetails: () => true,
      showGenericToolOutput: () => false,
      diffWrapMode: () => "word" as const,
      providers: () => new Map<string, Provider>(),
      sync: storeSync,
      tui,
      activity: () => activity(),
      activityAllExpanded: () => false,
      activityExpanded: () => false,
      toggleActivity: () => {},
    }
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <SessionContext.Provider value={ctxValue}>
          <LocationProvider location={{ directory: "/tmp", workspaceID: undefined }}>
            <For each={storeSync.data.message[SESSION] ?? []}>
              {(message) => (
                <AssistantMessageRow
                  message={message as AssistantMessage}
                  parts={storeSync.data.part[message.id] ?? []}
                  last={false}
                />
              )}
            </For>
          </LocationProvider>
        </SessionContext.Provider>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory="/tmp" paths={{ home: "/tmp", state, worktree: "/tmp" }}>
        <ExitProvider exit={() => {}}>
          <ArgsProvider>
            <KVProvider>
              <ToastProvider>
                <RouteProvider initialRoute={{ type: "session", sessionID: SESSION }}>
                  <TuiConfigProvider config={createTuiResolvedConfig()}>
                    <SDKProvider url="http://test" directory="/tmp" fetch={calls.fetch} events={events.source}>
                      <PermissionProvider>
                        <ProjectProvider>
                          <SyncProvider>
                            <ThemeProvider mode="dark">
                              <LocalProvider>
                                <Harness />
                              </LocalProvider>
                            </ThemeProvider>
                          </SyncProvider>
                        </ProjectProvider>
                      </PermissionProvider>
                    </SDKProvider>
                  </TuiConfigProvider>
                </RouteProvider>
              </ToastProvider>
            </KVProvider>
          </ArgsProvider>
        </ExitProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 24, kittyKeyboard: true },
  )

  await waitUntil(() => sync !== undefined)
  setup = {
    app,
    events,
    sync,
    dispose: async () => {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }

  sync.set("message", SESSION, [
    {
      id: "m1",
      sessionID: SESSION,
      role: "assistant" as const,
      time: { created: BASE, ...(options.completed ? { completed: BASE + 1000 } : {}) },
      parentID: "msg_user",
      modelID: "model",
      providerID: "test",
      mode: options.agent,
      agent: options.agent,
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ])
  sync.set("part", "m1", options.parts)
  await app.renderOnce()
  return setup!
}

function textPart(value: string, id = "prt_text"): TextPart {
  return { id, sessionID: SESSION, messageID: "m1", type: "text", text: value }
}

describe("review assistant text: real transcript fallback", () => {
  test("an incomplete reviewer stream remains visible without a verdict", async () => {
    const mounted = await mount({ agent: "review", parts: [textPart("Streaming analysis remains visible.\n\n<silvercode-review>\n{ incomplete")] })
    const app = mounted.app
    await settleUntilFrame(app, "Streaming analysis remains visible.")
    const frame = await frameOfSpans(app)
    expect(frame).toContain("Streaming analysis remains visible.")
    expect(frame).not.toContain("Approved")
    expect(frame).not.toContain("Needs fixes")
    mounted.sync.set("part", "m1", [textPart("Streaming analysis updated.\n\n<silvercode-review>\n{ incomplete")])
    await settleUntilFrame(app, "Streaming analysis updated.")
    const updated = await frameOfSpans(app)
    expect(updated).toContain("Streaming analysis updated.")
    expect(updated).not.toContain("Approved")
    expect(updated).not.toContain("Needs fixes")
  })

  test("an ordinary completed assistant message remains ordinary text", async () => {
    const app = (await mount({ agent: "work", completed: true, parts: [textPart("Ordinary work response, not a review.")] })).app
    await settleUntilFrame(app, "Ordinary work response, not a review.")
    const frame = await frameOfSpans(app)
    expect(frame).toContain("Ordinary work response, not a review.")
    expect(frame).not.toContain("Approved")
    expect(frame).not.toContain("Needs fixes")
  })

  test("quoted valid protocol examples remain examples for a completed reviewer", async () => {
    const report = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "Example report only", findings: [] })
    const app = (await mount({ agent: "review", completed: true, parts: [textPart(`Example protocol:\n\n\`\`\`xml\n${report}\n\`\`\``)] })).app
    await settleUntilFrame(app, "Example report only")
    const frame = await frameOfSpans(app)
    expect(frame).toContain("Example report only")
    expect(frame).not.toContain("✓ Approved")
  })

})
