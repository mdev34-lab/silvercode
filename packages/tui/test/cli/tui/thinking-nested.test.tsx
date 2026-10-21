/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import type { AssistantMessage, GlobalEvent, Message, Part, ReasoningPart, ToolPart } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../fixture/fixture"
import { captureFrame, waitFor } from "../../fixture/frame"
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
import { OpencodeKeymapProvider, registerOpencodeKeymap, type OpenTuiKeymap } from "../../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { Session } from "../../../src/routes/session"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"

// Regression coverage for `/thinking` on chain-of-thought nested inside a
// Working block. The harness mounts the real `<Session />` route (same
// provider tree as sidebar-placement.test.tsx) and drives the real
// `session.toggle.thinking` command through the keymap, so the assertions
// cover the exact path the slash command takes.
//
// Nested thoughts must behave like top-level ones: in hide mode they render
// collapsed (`+ Thought`), `/thinking expand` reveals the CoT body for blocks
// already on screen and for ones that stream in afterwards, and `/thinking`
// again collapses them. The last test also pins row stability: expanding a
// nested thought must survive the streaming updates that constantly recompute
// the activity groups, matching how top-level blocks behave.

const SESSION_ID = "ses_thinking_nested"
const MESSAGE_ID = "msg_user"
const BASE = 1_700_000_000_000
const COT_BODY = "Step one: inspect the files carefully."
const STREAMED_BODY = "Second pass: verify the diff end to end."

type Setup = Awaited<ReturnType<typeof testRender>>

const setups: { app: Setup; dispose: () => Promise<void> }[] = []

afterEach(async () => {
  for (const setup of setups.splice(0)) {
    setup.app.renderer.destroy()
    await setup.dispose()
  }
})

function sessionPayload() {
  return {
    id: SESSION_ID,
    slug: "thinking-nested",
    title: "Thinking nested",
    projectID: "proj_test",
    version: "0.0.0-test",
    directory,
    time: { created: 0, updated: 0 },
  }
}

function reasoningPart(): ReasoningPart {
  return {
    id: "prt_reason",
    sessionID: SESSION_ID,
    messageID: MESSAGE_ID,
    type: "reasoning",
    text: `**Planning the work**\n\n${COT_BODY}`,
    time: { start: BASE, end: BASE + 2000 },
  }
}

function toolPart(id: string, end = BASE + 100): ToolPart {
  return {
    id,
    sessionID: SESSION_ID,
    messageID: MESSAGE_ID,
    type: "tool",
    callID: id,
    tool: "bash",
    state: {
      status: "completed",
      input: { command: "ls" },
      output: "ok",
      title: "",
      metadata: {},
      time: { start: BASE, end },
    },
  }
}

function assistantInfo(): AssistantMessage {
  return {
    id: MESSAGE_ID,
    sessionID: SESSION_ID,
    role: "assistant",
    time: { created: BASE, completed: BASE + 5000 },
    parentID: "msg_parent",
    modelID: "model",
    providerID: "test",
    mode: "work",
    agent: "work",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  }
}

function messagesPayload(parts: Part[]) {
  const rows: { info: Message; parts: Part[] }[] = [{ info: assistantInfo(), parts }]
  return rows
}

async function mountSession(seedParts: Part[]) {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === `/session/${SESSION_ID}`) return json(sessionPayload())
    if (url.pathname === `/session/${SESSION_ID}/message`) return json(messagesPayload(seedParts))
    if (url.pathname === `/session/${SESSION_ID}/todo`) return json([])
    if (url.pathname === `/session/${SESSION_ID}/diff`) return json([])
    return undefined
  }, events)

  const config = createTuiResolvedConfig({})
  let keymapRef: OpenTuiKeymap | undefined

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
    { width: 120, height: 40 },
  )

  setups.push({ app, dispose: async () => await tmp[Symbol.asyncDispose]() })

  await waitFor(app, () => (keymapRef ? keymapRef : undefined))
  return { app, events, keymap: () => keymapRef! }
}

async function frameOf(app: Setup) {
  return captureFrame(app)
}

// The reasoning body renders through the streaming markdown/code block, which
// settles a frame or two after the store change, so read spans for it.
function spansOf(app: Setup) {
  const spans = app.captureSpans()
  return spans.lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n")
}

async function settle(app: Setup) {
  await Bun.sleep(150)
  await app.renderOnce()
}

function globalEvent(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

function updatedEvent(part: Part, id: number): GlobalEvent {
  return globalEvent({
    id: `evt_updated_${id}`,
    type: "message.part.updated",
    properties: { sessionID: SESSION_ID, time: id, part },
  })
}

function deltaEvent(partID: string, delta: string, id: number): GlobalEvent {
  return globalEvent({
    id: `evt_delta_${id}`,
    type: "message.part.delta",
    properties: { sessionID: SESSION_ID, messageID: MESSAGE_ID, partID, field: "text", delta },
  })
}

// Two completed tool calls put the reasoning inside a Working block; expand it
// through the real header click so nested rows are on screen.
async function expandWorkingBlock(app: Setup, keymap: () => OpenTuiKeymap) {
  await waitFor(app, () => (app.captureCharFrame().includes("tool call") ? app.captureCharFrame() : undefined))
  keymap().dispatchCommand("session.toggle.activity")
  await settle(app)
}

describe("thinking toggle on CoT nested inside a Working block", () => {
  test("/thinking expand reveals the nested CoT and /thinking again collapses it", async () => {
    const { app, keymap } = await mountSession([reasoningPart(), toolPart("prt_tool_a"), toolPart("prt_tool_b")])
    await expandWorkingBlock(app, keymap)

    // Hide mode keeps the nested block collapsed to its header.
    const collapsed = spansOf(app)
    expect(collapsed).toContain("+ Thought")
    expect(collapsed).not.toContain(COT_BODY)

    // /thinking expand must reveal the CoT of the already-rendered block.
    keymap().dispatchCommand("session.toggle.thinking")
    await settle(app)
    const expanded = spansOf(app)
    expect(expanded).toContain(COT_BODY)
    expect(expanded).not.toContain("+ Thought")

    // And /thinking again restores the collapsed header.
    keymap().dispatchCommand("session.toggle.thinking")
    await settle(app)
    const restored = spansOf(app)
    expect(restored).toContain("+ Thought")
    expect(restored).not.toContain(COT_BODY)
  })

  test("/thinking expand applies to a nested CoT that streams in afterwards", async () => {
    // The Working block forms from two completed tools; the thought arrives later.
    const { app, events, keymap } = await mountSession([toolPart("prt_tool_a"), toolPart("prt_tool_b")])
    await expandWorkingBlock(app, keymap)

    // The nested thought streams in after the flip: a snapshot without time.end.
    events.emit(
      updatedEvent(
        {
          id: "prt_late",
          sessionID: SESSION_ID,
          messageID: MESSAGE_ID,
          type: "reasoning",
          text: "",
          time: { start: BASE + 9000 },
        },
        0,
      ),
    )
    events.emit(deltaEvent("prt_late", STREAMED_BODY, 1))
    await settle(app)
    // The stream is still open, so the body is readable regardless of mode.
    expect(spansOf(app)).toContain(STREAMED_BODY)

    // The reasoning stream ends; hide mode collapses the completed block.
    events.emit(
      updatedEvent(
        {
          id: "prt_late",
          sessionID: SESSION_ID,
          messageID: MESSAGE_ID,
          type: "reasoning",
          text: STREAMED_BODY,
          time: { start: BASE + 9000, end: BASE + 11000 },
        },
        2,
      ),
    )
    await settle(app)
    expect(spansOf(app)).not.toContain(STREAMED_BODY)

    // The command's expanded state reaches the subsequently-rendered block.
    keymap().dispatchCommand("session.toggle.thinking")
    await settle(app)
    expect(spansOf(app)).toContain(STREAMED_BODY)
  })

  test("a manually expanded nested thought stays open across streaming updates", async () => {
    const { app, events, keymap } = await mountSession([reasoningPart(), toolPart("prt_tool_a"), toolPart("prt_tool_b")])
    await expandWorkingBlock(app, keymap)

    // Click-open the collapsed nested thought, like a user reading the CoT
    // while the rest of the run keeps streaming in.
    const frame = await frameOf(app)
    const row = frame.split("\n").findIndex((line) => line.includes("+ Thought"))
    expect(row).toBeGreaterThan(-1)
    await app.mockMouse.click(8, row)
    await settle(app)
    expect(spansOf(app)).toContain(COT_BODY)

    // The next part of the run arrives: the activity groups recompute. The
    // expansion must survive it (top-level blocks already behave this way).
    events.emit(updatedEvent(toolPart("prt_tool_c", BASE + 300), 3))
    await settle(app)
    expect(spansOf(app)).toContain(COT_BODY)
    expect(await frameOf(app)).toContain("- Thought")
  })
})
