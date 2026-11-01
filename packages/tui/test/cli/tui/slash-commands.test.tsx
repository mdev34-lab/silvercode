/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { captureFrame } from "../../fixture/frame"
import path from "node:path"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import type { AssistantMessage, Message, Part, ReasoningPart, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../fixture/fixture"
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
import {
  OpencodeKeymapProvider,
  registerOpencodeKeymap,
  useCommandSlashes,
  useOpencodeKeymap,
  type OpenTuiKeymap,
} from "../../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { Session } from "../../../src/routes/session"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"

// Tool rows render the path with platform-native separators (path.relative
// yields backslashes on win32), so row-text expectations must join with the
// platform separator instead of hardcoding "/" (#318).
const readRow = (rel: string) => `Read ${rel.split("/").join(path.sep)}`

const SESSION_ID = "ses_slash_commands"
const BASE = 1_700_000_000_000

type Setup = Awaited<ReturnType<typeof testRender>>

function assistantInfo(id: string, index: number, finish: "stop" | "tool-calls" = "tool-calls"): AssistantMessage {
  return {
    id,
    sessionID: SESSION_ID,
    role: "assistant",
    time: { created: BASE + index * 1000, completed: BASE + index * 1000 + 1000 },
    parentID: "msg_user",
    modelID: "test",
    providerID: "test",
    mode: "work",
    agent: "work",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish,
  }
}

function textPart(message: AssistantMessage, name: string, text: string): TextPart {
  return { id: `prt_${name}`, sessionID: SESSION_ID, messageID: message.id, type: "text", text }
}

function toolPart(message: AssistantMessage, name: string, tool: string, input: Record<string, unknown>): ToolPart {
  return {
    id: `prt_${name}`,
    sessionID: SESSION_ID,
    messageID: message.id,
    type: "tool",
    callID: `call_${name}`,
    tool,
    state: { status: "running", input, time: { start: BASE } },
  }
}

function messagesPayload(): { info: Message; parts: Part[] }[] {
  const thoughtMessage = assistantInfo("msg_thought", 0, "stop")
  const answerMessage = assistantInfo("msg_answer", 1, "stop")
  const firstRead = assistantInfo("msg_read_a", 2)
  const firstGrep = assistantInfo("msg_grep", 3)
  const summaryMessage = assistantInfo("msg_summary", 4, "stop")
  const secondRead = assistantInfo("msg_read_b", 5)
  const thirdRead = assistantInfo("msg_read_c", 6)

  return [
    {
      info: thoughtMessage,
      parts: [
        {
          id: "prt_thought",
          sessionID: SESSION_ID,
          messageID: thoughtMessage.id,
          type: "reasoning",
          text: "**Planning**\n\nPrivate reasoning body.",
          time: { start: BASE, end: BASE + 1000 },
        } satisfies ReasoningPart,
      ],
    },
    { info: answerMessage, parts: [textPart(answerMessage, "answer", "Assistant answer remains visible.")] },
    { info: firstRead, parts: [toolPart(firstRead, "read_a", "read", { filePath: "src/a.ts" })] },
    { info: firstGrep, parts: [toolPart(firstGrep, "grep", "grep", { pattern: "todo" })] },
    { info: summaryMessage, parts: [textPart(summaryMessage, "summary", "Another ordinary assistant output.")] },
    { info: secondRead, parts: [toolPart(secondRead, "read_b", "read", { filePath: "src/b.ts" })] },
    { info: thirdRead, parts: [toolPart(thirdRead, "read_c", "read", { filePath: "src/c.ts" })] },
  ]
}
type Harness = {
  app: Setup
  keymap: OpenTuiKeymap
  slashes: ReturnType<typeof useCommandSlashes>
}

const setups: { app: Setup; dispose: () => Promise<void> }[] = []

afterEach(async () => {
  for (const setup of setups.splice(0)) {
    setup.app.renderer.destroy()
    await setup.dispose()
  }
})

async function mountSlashHarness(): Promise<Harness> {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === `/session/${SESSION_ID}`) {
      return json({
        id: SESSION_ID,
        slug: "slash-commands",
        title: "Slash commands",
        projectID: "proj_test",
        version: "0.0.0-test",
        directory,
        time: { created: 0, updated: 0 },
        // A share url and revert keep /unshare and /redo enabled so the
        // inventory below covers the full registered surface, not just the
        // commands that happen to be enabled on a fresh session.
        share: { url: "https://test.share/ses_slash_commands" },
        revert: { messageID: "msg_reverted" },
      })
    }
    if (url.pathname === `/session/${SESSION_ID}/message`) return json(messagesPayload())
    if (["todo", "diff"].some((suffix) => url.pathname === `/session/${SESSION_ID}/${suffix}`)) {
      return json([])
    }
    return undefined
  }, events)

  const config = createTuiResolvedConfig({})
  let captured: Pick<Harness, "keymap" | "slashes"> | undefined

  function Capture() {
    captured = { keymap: useOpencodeKeymap(), slashes: useCommandSlashes() }
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
          <Capture />
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

  for (let pass = 0; pass < 400; pass++) {
    await app.renderOnce()
    if (captured && captured.slashes().length > 0) return { app, ...captured }
    await Bun.sleep(5)
  }
  throw new Error("slash surface never populated")
}

const expectedSlashes = [
  ["/share"],
  ["/rename"],
  ["/timeline"],
  ["/fork"],
  ["/compact", "/summarize"],
  ["/unshare"],
  ["/undo"],
  ["/redo"],
  ["/timestamps", "/toggle-timestamps"],
  ["/thinking", "/toggle-thinking"],
  ["/details"],
  ["/working", "/activity"],
  ["/copy"],
  ["/export"],
] as const

describe("session slash commands", () => {
  test("registers the complete intended built-in slash surface", async () => {
    const harness = await mountSlashHarness()
    const actual = harness
      .slashes()
      .map((entry) => [entry.display, ...(entry.aliases ?? [])].sort().join(" "))
      .sort()

    const expected = expectedSlashes.map((entry) => [...entry].sort().join(" ")).sort()
    expect(actual).toEqual(expected)
  })

  test("dispatches /details and globally toggles /working without affecting assistant text or thinking", async () => {
    const harness = await mountSlashHarness()
    const entries = harness.slashes()
    const frame = () => captureFrame(harness.app)

    const details = entries.find((entry) => entry.display === "/details")
    const working = entries.find((entry) => entry.display === "/working")
    expect(details).toBeDefined()
    expect(working?.aliases).toContain("/activity")

    await harness.app.waitForFrame(
      (value: string) =>
        value.split("\n").filter((line) => line.includes("Exploring files...")).length === 2 &&
        value.includes("Assistant answer remains visible.") &&
        value.includes("Another ordinary assistant output.") &&
        value.includes("Thought: Planning"),
    )
    const collapsed = await frame()
    expect(collapsed).not.toContain(readRow("src/a.ts"))
    expect(collapsed).not.toContain('Grep "todo"')
    expect(collapsed).not.toContain(readRow("src/c.ts"))
    expect(collapsed).not.toContain("Private reasoning body.")

    const commandTitle = (name: string) => harness.keymap.getCommands().find((command) => command.name === name)?.title

    expect(commandTitle("session.toggle.actions")).toBe("Hide tool details")
    details?.onSelect()
    await harness.app.renderOnce()
    expect(commandTitle("session.toggle.actions")).toBe("Show tool details")

    expect(commandTitle("session.toggle.activity")).toBe("Expand working blocks")
    working?.onSelect()
    await harness.app.waitForFrame(
      (value: string) =>
        value.includes(readRow("src/a.ts")) && value.includes('Grep "todo"') && value.includes(readRow("src/c.ts")),
    )
    expect(commandTitle("session.toggle.activity")).toBe("Collapse working blocks")
    const expanded = await frame()
    expect(expanded).toContain(readRow("src/a.ts"))
    expect(expanded).toContain('Grep "todo"')
    expect(expanded).toContain(readRow("src/c.ts"))
    expect(expanded).toContain("Assistant answer remains visible.")
    expect(expanded).toContain("Another ordinary assistant output.")
    expect(expanded).toContain("Thought: Planning")
    expect(expanded).not.toContain("Private reasoning body.")

    working?.onSelect()
    await harness.app.waitForFrame(
      (value: string) => !value.includes(readRow("src/a.ts")) && !value.includes(readRow("src/c.ts")),
    )
    expect(commandTitle("session.toggle.activity")).toBe("Expand working blocks")
    expect(await frame()).not.toContain('Grep "todo"')
    expect(await frame()).toContain("Assistant answer remains visible.")
    expect(await frame()).toContain("Another ordinary assistant output.")
    expect(await frame()).toContain("Thought: Planning")
    expect(await frame()).not.toContain("Private reasoning body.")
  })
})
