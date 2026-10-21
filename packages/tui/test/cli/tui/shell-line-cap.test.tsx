/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createMemo, For, Match, Switch, onCleanup } from "solid-js"
import { testRender, useRenderer, type JSX } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { AssistantMessage, Message, Part, Provider, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
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
import { OPENCODE_BASE_MODE, OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { AssistantMessageRow, SessionContext } from "../../../src/routes/session"
import { computeActivityGroups } from "../../../src/util/activity"
import { MAX_OUTPUT_LINE_LENGTH } from "../../../src/util/cap-lines"
import { waitUntil } from "../../fixture/frame"

const SESSION = "ses_shell_cap"
const BASE = 1_700_000_000_000
const at = (offset: number) => BASE + offset * 1000

let partSeq = 0
const nextPartID = () => `prt_cap_${partSeq++}`

function assistant(id: string): AssistantMessage {
  return {
    id,
    sessionID: SESSION,
    role: "assistant" as const,
    time: { created: at(1), completed: at(2) },
    parentID: "msg_user",
    modelID: "model",
    providerID: "test",
    mode: "work",
    agent: "work",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function shellPart(
  messageID: string,
  metadataOutput: string,
  state: Partial<ToolPart["state"]> = {},
): ToolPart {
  return {
    id: nextPartID(),
    sessionID: SESSION,
    messageID,
    type: "tool",
    callID: "call",
    tool: "bash",
    state: {
      status: "completed",
      input: { command: "emit" },
      output: metadataOutput,
      title: "emit",
      metadata: { output: metadataOutput },
      time: { start: at(1), end: at(2) },
      ...state,
    } as ToolPart["state"],
  }
}

let testSetup: { app: Awaited<ReturnType<typeof testRender>>; dispose: () => Promise<void> } | undefined
type Sync = ReturnType<typeof useSync>

afterEach(async () => {
  await testSetup?.dispose()
  testSetup = undefined
})

function seed(sync: Sync, rows: { message: Message; parts: Part[] }[]) {
  sync.set("message", SESSION, rows.map((row) => row.message))
  for (const row of rows) {
    if (row.parts.length) sync.set("part", row.message.id, row.parts)
  }
}

function frameOf(app: Awaited<ReturnType<typeof testRender>>) {
  return app.captureCharFrame().split("\n").map((line) => line.trimEnd()).join("\n")
}

function rowOf(frame: string, needle: string): number {
  const row = frame.split("\n").findIndex((line) => line.includes(needle))
  if (row === -1) throw new Error(`needle "${needle}" not found in frame:\n${frame}`)
  return row
}

function Transcript() {
  const sync = useSync()
  return (
    <For each={sync.data.message[SESSION] ?? []}>
      {(message) => (
        <Switch>
          <Match when={message.role === "user"}>
            <text>
              {(sync.data.part[message.id] ?? []).filter((part): part is TextPart => part.type === "text")
                .map((part) => part.text)
                .join(" ")}
            </text>
          </Match>
          <Match when={true}>
            <AssistantMessageRow message={message as AssistantMessage} parts={sync.data.part[message.id] ?? []} last={true} />
          </Match>
        </Switch>
      )}
    </For>
  )
}

async function mountSession(options: { height?: number; width?: number } = {}) {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const events = createEventSource()
  const calls = createFetch(undefined, events)

  let sync!: Sync
  let scroll: ScrollBoxRenderable | undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const tui = useTuiConfig()
    const off = registerOpencodeKeymap(keymap, renderer, tui)
    onCleanup(off)

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
        return options.width ?? 100
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
            <scrollbox ref={(r) => (scroll = r)} height={options.height ?? 24} width={options.width ?? 100}>
              <Transcript />
            </scrollbox>
          </LocationProvider>
        </SessionContext.Provider>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts
        directory="/tmp"
        paths={{
          home: "/tmp",
          state,
          worktree: "/tmp",
        }}
      >
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
    { width: options.width ?? 100, height: options.height ?? 24 },
  )

  testSetup = {
    app,
    dispose: async () => {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
  await waitUntil(() => sync !== undefined)
  await app.renderOnce()
  return { app, sync, scroll: () => scroll }
}

describe("bash tool output per-line cap", () => {
  test("caps a single pathological line instead of flooding the expanded view", async () => {
    const { app, sync } = await mountSession({ width: 100, height: 40 })
    try {
      const longLine = "a".repeat(4000)
      const part = shellPart("m1", longLine)
      seed(sync, [{ message: assistant("m1"), parts: [part] }])

      // Collapsed: the preview budget already clips at the terminal width.
      await app.waitForFrame((frame: string) => frame.includes("Click to expand"))
      // Expand: before the fix the <text> renderer wrapped the full 4000-char
      // line into dozens of rows past any per-line bound.
      await app.mockMouse.click(5, rowOf(frameOf(app), "Click to expand"))
      await app.waitForFrame((frame: string) => frame.includes("[+"))

      const frame = frameOf(app)
      expect(frame).toContain("Click to collapse")
      // The raw 4000-char line must not reach the frame unbroken.
      expect(frame).not.toContain("a".repeat(MAX_OUTPUT_LINE_LENGTH))
      // It is rendered with the per-line truncation marker.
      expect(frame).toContain("chars]")
      // The command line still renders.
      expect(frame).toContain("$ emit")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps short lines intact while capping the offending long line", async () => {
    const { app, sync } = await mountSession({ width: 100, height: 40 })
    try {
      const output = ["first short line", "b".repeat(4000), "third short line"].join("\n")
      const part = shellPart("m1", output)
      seed(sync, [{ message: assistant("m1"), parts: [part] }])

      await app.waitForFrame((frame: string) => frame.includes("Click to expand"))
      await app.mockMouse.click(5, rowOf(frameOf(app), "Click to expand"))
      await app.waitForFrame((frame: string) => frame.includes("[+"))

      const frame = frameOf(app)
      expect(frame).toContain("first short line")
      expect(frame).toContain("third short line")
      expect(frame).not.toContain("b".repeat(MAX_OUTPUT_LINE_LENGTH))
    } finally {
      app.renderer.destroy()
    }
  })

  test("does not alter normal bash output below the cap", async () => {
    const { app, sync } = await mountSession({ width: 100 })
    try {
      const output = "file1.txt\nfile2.txt\nfile3.txt"
      const part = shellPart("m1", output)
      seed(sync, [{ message: assistant("m1"), parts: [part] }])

      await app.waitForFrame((frame: string) => frame.includes("file3.txt"))
      const frame = frameOf(app)
      expect(frame).toContain("file1.txt")
      expect(frame).toContain("file2.txt")
      expect(frame).toContain("file3.txt")
      expect(frame).not.toContain("chars]")
    } finally {
      app.renderer.destroy()
    }
  })

  test("caps the long line in the expanded view (the bug: no newlines to fold)", async () => {
    // Edge case behind the bug: a single line with no newlines is invisible to
    // the collapsed-preview line budget (collapseToolOutput counts lines), and
    // its char budget is only enforced while collapsed — expanded output used
    // to render the full line. The per-line cap must bound it regardless.
    const { app, sync } = await mountSession({ width: 100, height: 40 })
    try {
      const part = shellPart("m1", "c".repeat(4000))
      seed(sync, [{ message: assistant("m1"), parts: [part] }])

      await app.waitForFrame((frame: string) => frame.includes("Click to expand"))
      await app.mockMouse.click(5, rowOf(frameOf(app), "Click to expand"))
      await app.waitForFrame((frame: string) => frame.includes("[+"))

      const frame = frameOf(app)
      for (const line of frame.split("\n")) {
        // No rendered row can carry a run of capped-length 'c' characters:
        // the visible prefix is bounded by the per-line cap.
        if (line.includes("c")) expect(line.trim().length).toBeLessThan(MAX_OUTPUT_LINE_LENGTH)
      }
      expect(frame).not.toContain("c".repeat(MAX_OUTPUT_LINE_LENGTH))
    } finally {
      app.renderer.destroy()
    }
  })
})
