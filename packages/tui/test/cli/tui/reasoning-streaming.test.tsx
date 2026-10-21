/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { createMemo, For, onCleanup } from "solid-js"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import type { AssistantMessage, GlobalEvent, Part, Provider, ReasoningPart, TextPart } from "@opencode-ai/sdk/v2"
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
import { waitUntil } from "../../fixture/frame"

const SESSION = "ses_reason_stream"
const BASE = 1_700_000_000_000
const BODY = "Let me investigate the bug"

// A frame with the reasoning body drawn. The reasoning body is rendered by a
// streaming markdown/code block, which is not captured by `captureCharFrame()`
// but IS captured by `captureSpans()` once the frame settles. We join every
// span so partial word-aligned fragments are still detectable.
function frameOfSpans(app: Awaited<ReturnType<typeof testRender>>) {
  const spans = app.captureSpans()
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
  while (!frameOfSpans(app).includes(text)) {
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

async function mount(options: { thinkingMode: "show" | "hide"; parts: Part[] }) {
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
      thinkingMode: () => options.thinkingMode,
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
      time: { created: BASE },
      parentID: "msg_user",
      modelID: "model",
      providerID: "test",
      mode: "work" as const,
      agent: "work",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ])
  sync.set("part", "m1", options.parts)
  await app.renderOnce()
  return setup!
}

function app() {
  return setup!.app
}

function globalEvent(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp", project: "proj_test", payload }
}

function deltaEvent(sessionID: string, messageID: string, partID: string, delta: string, id: number): GlobalEvent {
  return globalEvent({
    id: `evt_delta_${id}`,
    type: "message.part.delta",
    properties: { sessionID, messageID, partID, field: "text", delta },
  })
}

function updatedEvent(sessionID: string, messageID: string, part: Part, id: number): GlobalEvent {
  return globalEvent({
    id: `evt_updated_${id}`,
    type: "message.part.updated",
    properties: { sessionID, time: id, part },
  })
}

function reasoningPart(messageID: string, text: string, end?: number): ReasoningPart {
  return {
    id: "prt_reason",
    sessionID: SESSION,
    messageID,
    type: "reasoning",
    text,
    time: { start: BASE, ...(end !== undefined ? { end } : {}) },
  }
}

describe("reasoning streaming lifecycle", () => {
  test("hide mode: the Thinking body stays open while deltas stream and only collapses when the stream ends", async () => {
    // Regression: in hide mode the reasoning body was gated by
    // `!inMinimal() || expanded()`, which collapsed the body the instant the
    // block was considered "streaming" (no terminal time.end set), so the
    // chain-of-thought was invisible until the whole chunk finished.
    await mount({ thinkingMode: "hide", parts: [reasoningPart("m1", "")] })

    // Stream deltas; no terminal snapshot yet (time.end undefined).
    setup!.events.emit(deltaEvent(SESSION, "m1", "prt_reason", "Let me ", 0))
    setup!.events.emit(deltaEvent(SESSION, "m1", "prt_reason", "investigate", 1))
    // A stale non-terminal durable row (empty streamed text) must not close it.
    setup!.events.emit(updatedEvent(SESSION, "m1", reasoningPart("m1", ""), 2))

    const part = setup!.sync.data.part["m1"].find((item) => item.id === "prt_reason") as ReasoningPart
    await waitUntil(() => part.text === "Let me investigate")
    await settleUntilFrame(app(), "Let me investigate")

    // The streamed body is readable while reasoning is still active.
    expect(frameOfSpans(app())).toContain("Let me investigate")
    expect(frameOfSpans(app())).toContain("Thinking")

    // Now the reasoning stream actually ends (terminal snapshot with time.end).
    setup!.events.emit(updatedEvent(SESSION, "m1", reasoningPart("m1", "Let me investigate", BASE + 5000), 3))
    await waitUntil(() => part.time.end !== undefined)
    await settle(app())

    // Once done, hide mode collapses the body to a one-line summary.
    const frame = frameOfSpans(app())
    expect(frame).toContain("Thought")
    expect(frame).toContain("5.0s")
  })

  test("show mode: the Thinking body stays open even after the reasoning stream ends", async () => {
    await mount({ thinkingMode: "show", parts: [reasoningPart("m1", BODY, BASE + 5000)] })
    await settleUntilFrame(app(), "Let me investigate")

    const frame = frameOfSpans(app())
    expect(frame).toContain("Thought")
    expect(frame).toContain("Let me investigate")
  })

  test("incremental reasoning deltas accumulate text without truncation", async () => {
    await mount({ thinkingMode: "show", parts: [reasoningPart("m1", "")] })

    setup!.events.emit(deltaEvent(SESSION, "m1", "prt_reason", "one ", 0))
    setup!.events.emit(deltaEvent(SESSION, "m1", "prt_reason", "two ", 1))
    setup!.events.emit(deltaEvent(SESSION, "m1", "prt_reason", "three", 2))
    // A stale partial durable row (missing the last delta) replaying mid-stream
    // must not truncate what has already streamed.
    setup!.events.emit(updatedEvent(SESSION, "m1", reasoningPart("m1", "one "), 3))

    const part = setup!.sync.data.part["m1"].find((item) => item.id === "prt_reason") as ReasoningPart
    await waitUntil(() => part.text === "one two three")
    await settle(app())

    expect(part.text).toBe("one two three")
  })

  test("normal assistant text parts still stream alongside a reasoning block", async () => {
    await mount({
      thinkingMode: "show",
      parts: [reasoningPart("m1", BODY), { id: "prt_text", sessionID: SESSION, messageID: "m1", type: "text", text: "" } as TextPart],
    })

    setup!.events.emit(deltaEvent(SESSION, "m1", "prt_text", "Here", 0))
    setup!.events.emit(deltaEvent(SESSION, "m1", "prt_text", " is the answer.", 1))

    const textPart = setup!.sync.data.part["m1"].find((item) => item.id === "prt_text") as TextPart
    await waitUntil(() => textPart.text === "Here is the answer.")
    await settle(app())

    // The reasoning block is untouched by the text streaming.
    const reasoning = setup!.sync.data.part["m1"].find((item) => item.id === "prt_reason") as ReasoningPart
    expect(reasoning.text).toBe(BODY)
    expect(textPart.text).toBe("Here is the answer.")
  })
})
