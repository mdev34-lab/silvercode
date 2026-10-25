/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createMemo, createSignal, For, Match, Switch, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { testRender, useRenderer, type JSX } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { AssistantMessage, Message, Part, Provider, ReasoningPart, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
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
import { DialogProvider } from "../../../src/ui/dialog"
import { LocationProvider } from "../../../src/context/location"
import { OPENCODE_BASE_MODE, OpencodeKeymapProvider, registerOpencodeKeymap, useBindings } from "../../../src/keymap"
import { ActivityGroup, AssistantMessageRow, SessionContext } from "../../../src/routes/session"
import { computeActivityGroups, resolveActivityExpanded, toggleActivityOverride } from "../../../src/util/activity"
import { captureFrame, waitFor, waitUntil } from "../../fixture/frame"

const SESSION = "ses_activity_ui"
const BASE = 1_700_000_000_000
const at = (offset: number) => BASE + offset * 1000

// Tool rows render the path with platform-native separators (path.relative
// yields backslashes on win32), so row-text expectations must join with the
// platform separator instead of hardcoding "/" (#318).
const readRow = (rel: string) => `Read ${rel.split("/").join(path.sep)}`

let partCounter = 0
const nextPartID = () => `prt_${String(++partCounter).padStart(3, "0")}`

function assistant(id: string, created: number) {
  return {
    id,
    sessionID: SESSION,
    role: "assistant" as const,
    time: { created, completed: created + 1000 },
    parentID: "msg_user",
    modelID: "model",
    providerID: "test",
    mode: "work",
    agent: "work",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "tool-calls",
  }
}

function textPart(messageID: string, value: string): TextPart {
  return { id: nextPartID(), sessionID: SESSION, messageID, type: "text", text: value }
}

function reasoningPart(messageID: string, value: string): ReasoningPart {
  return { id: nextPartID(), sessionID: SESSION, messageID, type: "reasoning", text: value, time: { start: at(0) } }
}

function toolPart(messageID: string, tool: string, input: Record<string, unknown>, state: ToolPart["state"]): ToolPart {
  return { id: nextPartID(), sessionID: SESSION, messageID, type: "tool", callID: "call", tool, state }
}

function running(messageID: string, tool: string, input: Record<string, unknown>, start: number): ToolPart {
  return toolPart(messageID, tool, input, { status: "running", input, time: { start } })
}

function completed(part: ToolPart, start: number, end: number): ToolPart {
  return {
    ...part,
    state: { status: "completed", input: part.state.input, output: "", title: "", metadata: {}, time: { start, end } },
  }
}

// A settled to-do call renders as its own "# Todos" block in the transcript.
function todoBlock(messageID: string, content: string, start: number, end: number): ToolPart {
  const todos = [{ content, status: "pending" }]
  return toolPart(
    messageID,
    "todowrite",
    { todos },
    {
      status: "completed",
      input: { todos },
      output: "",
      title: "",
      metadata: { todos },
      time: { start, end },
    },
  )
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

function reseedParts(sync: Sync, partsByMessage: Record<string, Part[]>) {
  for (const [messageID, parts] of Object.entries(partsByMessage)) sync.set("part", messageID, parts)
}

async function frameOf(app: Awaited<ReturnType<typeof testRender>>) {
  return (await captureFrame(app)).split("\n").map((line) => line.trimEnd()).join("\n")
}

// app.waitForFrame budgets 20 renderer passes with no wall-clock floor: on a
// busy runner an idle renderer burns all 20 passes in milliseconds, before
// the reactive render of seeded/clicked state lands (#552, reproduced under
// CPU contention with the exact CI failure). This wrapper pumps a frame per
// pass and polls the captured frame with a 5ms wall-clock pad between passes
// (the fixture waitFor), so the predicate is judged against real elapsed
// time, not scheduler luck. Assertions and pass intent are unchanged.
async function waitFrame(
  app: Awaited<ReturnType<typeof testRender>>,
  predicate: (frame: string) => boolean,
): Promise<string> {
  // Raw captureCharFrame is safe here: the fixture waitFor swallows a busy
  // output buffer (OutputBusy) and retries on the next pumped pass.
  return waitFor(app, () => {
    const frame = app.captureCharFrame()
    return predicate(frame) ? frame : undefined
  })
}

function rowOf(frame: string, needle: string): number {
  const row = frame.split("\n").findIndex((line) => line.includes(needle))
  if (row === -1) throw new Error(`needle "${needle}" not found in frame:\n${frame}`)
  return row
}

function rowOfNth(frame: string, needle: string, occurrence: number): number {
  let seen = 0
  const rows = frame.split("\n")
  for (let index = 0; index < rows.length; index++) {
    if (!rows[index].includes(needle)) continue
    if (seen++ === occurrence - 1) return index
  }
  throw new Error(`needle "${needle}" found ${seen} of ${occurrence} times in frame:\n${frame}`)
}

function countOf(frame: string, needle: string): number {
  return frame.split("\n").filter((line) => line.includes(needle)).length
}

function findGroup(sync: Sync): string | undefined {
  const rows = (sync.data.message[SESSION] ?? []).map((message) => ({
    message,
    parts: sync.data.part[message.id] ?? [],
  }))
  return [...computeActivityGroups(rows).byID.values()].find((group) => group.items.length > 1)?.id
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
            <AssistantMessageRow
              message={message as AssistantMessage}
              parts={sync.data.part[message.id] ?? []}
              last={false}
            />
          </Match>
        </Switch>
      )}
    </For>
  )
}

async function mountActivity(options: {
  height?: number
  width?: number
  render?: (sync: Sync) => JSX.Element
} = {}) {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const events = createEventSource()
  const calls = createFetch(undefined, events)

  let sync!: Sync
  let scroll: ScrollBoxRenderable | undefined
  const [allExpanded, setAllExpanded] = createSignal(false)
  const [overrides, setOverrides] = createStore<Record<string, boolean | undefined>>({})
  const isExpanded = (groupID: string) => resolveActivityExpanded(overrides[groupID], allExpanded())

  function KeymapBindings() {
    const tui = useTuiConfig()
    useBindings(() => ({
      commands: [
        {
          namespace: "palette",
          name: "session.toggle.activity",
          title: "Expand tool activity",
          run: () => {
            setAllExpanded((value) => !value)
            // setStore merges, so clearing requires removing every key.
            for (const key of Object.keys(overrides)) setOverrides(key, undefined)
          },
        },
      ],
    }))
    useBindings(() => ({
      mode: OPENCODE_BASE_MODE,
      bindings: tui.keybinds.gather("session", ["session.toggle.activity"]),
    }))
    return <></>
  }

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
      activityAllExpanded: () => allExpanded(),
      activityExpanded: isExpanded,
      toggleActivity: (groupID: string) =>
        setOverrides(groupID, toggleActivityOverride(overrides[groupID], allExpanded())),
    }
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <KeymapBindings />
        <DialogProvider>
          <SessionContext.Provider value={ctxValue}>
            <LocationProvider location={{ directory: "/tmp", workspaceID: undefined }}>
              <scrollbox ref={(r) => (scroll = r)} height={options.height ?? 24} width={options.width ?? 100}>
                {options.render ? options.render(storeSync) : <Transcript />}
              </scrollbox>
            </LocationProvider>
          </SessionContext.Provider>
        </DialogProvider>
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
    { width: options.width ?? 100, height: options.height ?? 24, kittyKeyboard: true },
  )

  testSetup = { app, dispose: async () => { await tmp[Symbol.asyncDispose]() } }
  // The KV provider renders its children only once KV state has loaded, so
  // wait until the harness (and its sync handle) has actually mounted.
  await waitUntil(() => sync !== undefined)
  await app.renderOnce()
  return {
    app,
    sync,
    scroll: () => scroll,
  }
}

function twoRunningTools() {
  const m1 = assistant("m1", at(1))
  const m2 = assistant("m2", at(2))
  const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
  const t2 = running(m2.id, "grep", { pattern: "todo" }, 1100)
  return { m1, m2, t1, t2 }
}

describe("activity group TUI", () => {
  test("shows a compact working header for a run of tool calls", async () => {
    const { app, sync } = await mountActivity()
    try {
      const { m1, m2, t1, t2 } = twoRunningTools()
      seed(sync, [
        { message: m1, parts: [textPart(m1.id, "I will investigate this."), t1] },
        { message: m2, parts: [t2] },
      ])
      await waitFrame(app, (frame: string) => frame.includes("Exploring files..."))

      const frame = await frameOf(app)
      expect(frame).toContain("Exploring files...")
      expect(frame).toMatch(/\+ . Exploring files\.\.\./)
      // Collapsed: no tool detail rows leak into the conversation.
      expect(frame).not.toContain(readRow("src/a.ts"))
      expect(frame).not.toContain("Grep")
    } finally {
      app.renderer.destroy()
    }
  })

  test("streams new tool calls into the same group", async () => {
    const { app, sync } = await mountActivity()
    try {
      const { m1, m2, t1, t2 } = twoRunningTools()
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
      ])
      await waitFrame(app, (frame: string) => frame.includes("Exploring files..."))

      const t3 = running(m2.id, "bash", { command: "bun test" }, 1200)
      reseedParts(sync, { [m2.id]: [t2, t3] })
      await waitFrame(app, (frame: string) => frame.includes("Running command..."))
      const frame = await frameOf(app)
      // Same activity group, one block per kind: explore + bash.
      expect(frame).toContain("Exploring files...")
      expect(frame).toContain("Running command...")
    } finally {
      app.renderer.destroy()
    }
  })

  test("click expands the group to native tool rows and collapses again", async () => {
    const { app, sync } = await mountActivity()
    try {
      const { m1, m2, t1, t2 } = twoRunningTools()
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
      ])
      await waitFrame(app, (frame: string) => frame.includes("Exploring files..."))

      const row = rowOf(await frameOf(app), "Exploring files...")
      await app.mockMouse.click(5, row)
      await waitFrame(app, (frame: string) => frame.includes(readRow("src/a.ts")) && frame.includes('Grep "todo"'))
      expect(await frameOf(app)).toMatch(/− . Exploring files\.\.\./)

      await app.mockMouse.click(5, rowOf(await frameOf(app), "Exploring files..."))
      await waitFrame(app, (frame: string) => !frame.includes(readRow("src/a.ts")))
      expect(await frameOf(app)).toMatch(/\+ . Exploring files\.\.\./)
    } finally {
      app.renderer.destroy()
    }
  })

  test("shows a completed summary with duration and count", async () => {
    const { app, sync } = await mountActivity()
    try {
      const { m1, m2, t1, t2 } = twoRunningTools()
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
      ])
      await waitFrame(app, (frame: string) => frame.includes("Exploring files..."))

      reseedParts(sync, { [m1.id]: [completed(t1, 1000, 4200)], [m2.id]: [completed(t2, 1100, 5200)] })
      await waitFrame(app, (frame: string) => frame.includes("Explored 2 files · 4.2s"))
      expect(await frameOf(app)).not.toContain("Exploring files...")
    } finally {
      app.renderer.destroy()
    }
  })

  test("flags failing tools in the collapsed header and reveals them when expanded", async () => {
    const { app, sync } = await mountActivity()
    try {
      const { m1, m2, t1 } = twoRunningTools()
      const t2: ToolPart = {
        id: nextPartID(),
        sessionID: SESSION,
        messageID: m2.id,
        type: "tool",
        callID: "call",
        tool: "bash",
        state: { status: "error", input: { command: "bun test" }, error: "command not found", time: { start: 1100, end: 1500 } },
      }
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
      ])
      // The failed bash call settles its own block at once; the still-running
      // read keeps the explore block working, and only the bash block flags.
      await waitFrame(app, (frame: string) => frame.includes("Exploring files...") && frame.includes("Ran 1 command") && frame.includes("1 failed"))
      let frame = await frameOf(app)
      expect(rowOf(frame, "1 failed")).toBe(rowOf(frame, "Ran 1 command"))
      expect(rowOf(frame, "Exploring files...")).not.toBe(rowOf(frame, "1 failed"))

      // Complete the remaining tool; the failure stays visible in the summary.
      reseedParts(sync, { [m1.id]: [completed(t1, 1000, 1400)] })
      await waitFrame(app, (frame: string) => frame.includes("Explored 1 file") && frame.includes("1 failed"))

      // Expand the failing block, then the failing row, to reach the error detail.
      const row = rowOf(await frameOf(app), "1 failed")
      await app.mockMouse.click(5, row)
      await waitFrame(app, (frame: string) => frame.includes("bun test"))
      await app.mockMouse.click(5, rowOf(await frameOf(app), "bun test"))
      await waitFrame(app, (frame: string) => frame.includes("command not found"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("ctrl+o expands every group and collapses them again", async () => {
    const { app, sync } = await mountActivity()
    try {
      const { m1, m2, t1, t2 } = twoRunningTools()
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
      ])
      await waitFrame(app, (frame: string) => frame.includes("Exploring files..."))
      expect(await frameOf(app)).not.toContain(readRow("src/a.ts"))

      app.mockInput.pressKey("o", { ctrl: true })
      await waitFrame(app, (frame: string) => frame.includes(readRow("src/a.ts")))
      expect(await frameOf(app)).toMatch(/− . Exploring files\.\.\./)

      app.mockInput.pressKey("o", { ctrl: true })
      await waitFrame(app, (frame: string) => !frame.includes(readRow("src/a.ts")))
      expect(await frameOf(app)).toMatch(/\+ . Exploring files\.\.\./)
    } finally {
      app.renderer.destroy()
    }
  })

  test("ctrl+o clears individually expanded groups", async () => {
    const { app, sync } = await mountActivity({ height: 30 })
    try {
      const m1 = assistant("m1", at(1))
      const m2 = assistant("m2", at(2))
      const m3 = assistant("m3", at(3))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      const t2 = running(m2.id, "read", { filePath: "src/b.ts" }, 1100)
      // Created before t3/t4 so its part id sorts ahead of them in the store.
      const note = textPart(m3.id, "In between.")
      const t3 = running(m3.id, "read", { filePath: "src/c.ts" }, 1200)
      const t4 = running(m3.id, "read", { filePath: "src/d.ts" }, 1300)
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
        { message: m3, parts: [note] },
      ])
      reseedParts(sync, { [m3.id]: [note, t3, t4] })
      await waitFrame(app, 
        (frame: string) => frame.includes("In between.") && frame.match(/Exploring files\.\.\./g)?.length === 2,
      )

      // Expand only the first group, individually.
      const firstRow = rowOf(await frameOf(app), "Exploring files...")
      await app.mockMouse.click(5, firstRow)
      await waitFrame(app, (frame: string) => frame.includes(readRow("src/a.ts")))
      expect(await frameOf(app)).not.toContain(readRow("src/c.ts"))

      // Toggle the global state on...
      app.mockInput.pressKey("o", { ctrl: true })
      await waitFrame(app, (frame: string) => frame.includes(readRow("src/c.ts")))

      // ...and off again: everything must end up collapsed, including the
      // group that was expanded individually.
      app.mockInput.pressKey("o", { ctrl: true })
      await waitFrame(app, 
        (frame: string) => !frame.includes(readRow("src/a.ts")) && !frame.includes(readRow("src/c.ts")),
      )
      const frame = await frameOf(app)
      expect(frame.match(/\+ . Exploring files\.\.\./g)?.length).toBe(2)
      expect(frame).not.toMatch(/− . Exploring files\.\.\./)
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps groups separated by assistant text independent", async () => {
    const { app, sync } = await mountActivity({ height: 30 })
    try {
      const m1 = assistant("m1", at(1))
      const m2 = assistant("m2", at(2))
      const m3 = assistant("m3", at(3))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      const t2 = running(m2.id, "read", { filePath: "src/b.ts" }, 1100)
      // Created before t3/t4 so its part id sorts ahead of them in the store.
      const note = textPart(m3.id, "Interim note.")
      const t3 = running(m3.id, "bash", { command: "ls" }, 1200)
      const t4 = running(m3.id, "bash", { command: "pwd" }, 1300)
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
        { message: m3, parts: [note] },
      ])
      reseedParts(sync, { [m3.id]: [note, t3, t4] })
      await waitFrame(app, 
        (frame: string) =>
          frame.includes("Interim note.") && frame.includes("Exploring files...") && frame.includes("Running command..."),
      )

      const frame = await frameOf(app)
      expect(frame).toContain("Interim note.")
      // Both groups are collapsed: no command details leak out.
      expect(frame).not.toContain("pwd")

      // Expand only the first group.
      const firstRow = rowOf(frame, "Exploring files...")
      await app.mockMouse.click(5, firstRow)
      await waitFrame(app, (frame: string) => frame.includes(readRow("src/a.ts")))
      const expanded = await frameOf(app)
      expect(expanded).toContain(readRow("src/a.ts"))
      expect(expanded).toContain(readRow("src/b.ts"))
      expect(expanded).not.toContain("pwd")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps one Working group across per-turn reasoning interleaved with tool calls", async () => {
    const { app, sync } = await mountActivity({ height: 30 })
    try {
      const m1 = assistant("m1", at(1))
      const m2 = assistant("m2", at(2))
      const m3 = assistant("m3", at(3))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      const t2 = running(m2.id, "grep", { pattern: "todo" }, 1100)
      const t3 = running(m3.id, "bash", { command: "ls" }, 1200)
      seed(sync, [
        { message: m1, parts: [textPart(m1.id, ""), t1] },
        { message: m2, parts: [textPart(m2.id, ""), reasoningPart(m2.id, "thinking"), t2] },
        { message: m3, parts: [textPart(m3.id, ""), reasoningPart(m3.id, "thinking again"), t3] },
      ])
      const frame = async () => frameOf(app)
      // One activity group, two kind blocks (explore, bash); the interleaved
      // reasoning stays hidden inside the collapsed blocks.
      await waitFrame(app, (f) => f.includes("Exploring files...") && f.includes("Running command..."))
      expect(await frame()).not.toContain("Working...")
      expect(await frame()).not.toContain("Thinking")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps one working block across blank text artifacts, batches, and thinking", async () => {
    const { app, sync } = await mountActivity({ height: 40 })
    try {
      const settledTool = (
        messageID: string,
        tool: string,
        input: Record<string, unknown>,
        start: number,
        end: number,
      ) => completed(toolPart(messageID, tool, input, { status: "running", input, time: { start } }), start, end)
      const m1 = assistant("w1", at(1))
      const m2 = assistant("w2", at(2))
      const m3 = assistant("w3", at(3))
      const m4 = assistant("w4", at(4))
      const m5 = assistant("w5", at(5))
      const m6 = assistant("w6", at(6))
      seed(sync, [
        {
          message: m1,
          parts: [
            settledTool(m1.id, "read", { filePath: "src/a.ts" }, 1000, 1100),
            settledTool(m1.id, "read", { filePath: "src/b.ts" }, 1000, 1200),
          ],
        },
        {
          message: m2,
          parts: [
            textPart(m2.id, ""),
            settledTool(m2.id, "grep", { pattern: "alpha" }, 1300, 1400),
            settledTool(m2.id, "grep", { pattern: "beta" }, 1300, 1500),
          ],
        },
        { message: m3, parts: [reasoningPart(m3.id, "thinking A")] },
        {
          message: m4,
          parts: [
            settledTool(m4.id, "read", { filePath: "src/e.ts" }, 1600, 1700),
            settledTool(m4.id, "read", { filePath: "src/f.ts" }, 1600, 1800),
          ],
        },
        { message: m5, parts: [reasoningPart(m5.id, "thinking B")] },
        {
          message: m6,
          parts: [textPart(m6.id, " \n"), settledTool(m6.id, "read", { filePath: "src/g.ts" }, 1900, 2000)],
        },
      ])
      // Tool titles render platform path separators; normalize so the
      // membership assertions below read the same everywhere.
      const frame = async () => (await frameOf(app)).replace(/\\/g, "/")
      // One container for the whole sequence, not one per batch: every call
      // here is an explore call, so the single block is an Explored summary
      // over the 7 distinct targets.
      await waitFrame(app, (f: string) => f.includes("Explored 7 files"))
      expect(countOf(await frame(), "Explored 7 files")).toBe(1)
      expect(await frame()).not.toContain("Read src/a.ts")

      // State and render agree: every part belongs to the same group.
      const rows = (sync.data.message[SESSION] ?? []).map((message) => ({
        message,
        parts: sync.data.part[message.id] ?? [],
      }))
      expect(computeActivityGroups(rows).byID.size).toBe(1)

      // Expanding nests the whole sequence under that container...
      app.mockInput.pressKey("o", { ctrl: true })
      await waitFrame(app, (f: string) => f.replace(/\\/g, "/").includes("Read src/g.ts"))
      const expanded = await frame()
      for (const title of [
        "Read src/a.ts",
        "Read src/b.ts",
        'Grep "alpha"',
        'Grep "beta"',
        "Read src/e.ts",
        "Read src/f.ts",
        "Read src/g.ts",
      ]) {
        expect(expanded).toContain(title)
      }
      expect(countOf(expanded, "Explored 7 files")).toBe(1)

      // ...and a genuine text boundary still closes the activity: the tool
      // after it stands alone instead of joining the block.
      const m7 = assistant("w7", at(7))
      const note = textPart(m7.id, "Summarizing now.")
      const lone = settledTool(m7.id, "read", { filePath: "src/h.ts" }, 2100, 2200)
      sync.set("message", SESSION, [...(sync.data.message[SESSION] ?? []), m7])
      sync.set("part", m7.id, [note, lone])
      await waitFrame(app, (f: string) => f.includes("Summarizing now."))
      const after = await frame()
      expect(after).toContain("Summarizing now.")
      expect(after).toContain("Read src/h.ts")
      expect(countOf(after, "Explored 7 files")).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps trailing reasoning inside the collapsed activity and reveals it when expanded", async () => {
    const { app, sync } = await mountActivity({ height: 30 })
    try {
      const { m1, m2, t1, t2 } = twoRunningTools()
      const m3 = assistant("m3", at(3))
      const r1 = {
        ...reasoningPart(m3.id, "**Inspecting grouping**\n\nFirst reasoning body."),
        time: { start: 1200, end: 1700 },
      }
      const r2 = {
        ...reasoningPart(m3.id, "**Verifying rendering**\n\nSecond reasoning body."),
        time: { start: 1800, end: 2400 },
      }
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
        { message: m3, parts: [r1, r2] },
      ])
      await waitFrame(app, (frame) => frame.includes("Exploring files..."))

      const collapsed = await frameOf(app)
      expect(collapsed).not.toContain("Inspecting grouping")
      expect(collapsed).not.toContain("Verifying rendering")

      await app.mockMouse.click(5, rowOf(collapsed, "Exploring files..."))
      await waitFrame(app, 
        (frame) => frame.includes("Inspecting grouping") && frame.includes("Verifying rendering"),
      )
      const expanded = await frameOf(app)
      expect(rowOf(expanded, readRow("src/a.ts"))).toBeLessThan(rowOf(expanded, 'Grep "todo"'))
      expect(rowOf(expanded, 'Grep "todo"')).toBeLessThan(rowOf(expanded, "Inspecting grouping"))
      expect(rowOf(expanded, "Inspecting grouping")).toBeLessThan(rowOf(expanded, "Verifying rendering"))

      await app.mockMouse.click(5, rowOf(expanded, "Exploring files..."))
      await waitFrame(app, (frame) => !frame.includes("Inspecting grouping") && !frame.includes("Verifying rendering"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders a lone tool call natively without a group header", async () => {
    const { app, sync } = await mountActivity()
    try {
      const m1 = assistant("m1", at(1))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      seed(sync, [{ message: m1, parts: [textPart(m1.id, "One file."), t1] }])
      await waitFrame(app, (frame: string) => frame.includes(readRow("src/a.ts")))
      const frame = await frameOf(app)
      expect(frame).not.toContain("Working...")
      expect(frame).not.toContain("Worked for")
    } finally {
      app.renderer.destroy()
    }
  })

  test("excluded orchestration tools do not count and render outside the group", async () => {
    const { app, sync } = await mountActivity()
    try {
      const m1 = assistant("m1", at(1))
      const t1 = running(m1.id, "bash", { command: "bun test" }, 1000)
      const t2 = running(m1.id, "read", { filePath: "src/a.ts" }, 1100)
      const t3 = running(m1.id, "finish", { reason: "complete" }, 1200)
      const t4 = running(m1.id, "todowrite", { todos: [] }, 1300)
      seed(sync, [{ message: m1, parts: [t1, t2, t3, t4] }])
      await waitFrame(app, (frame: string) => frame.includes("Running command...") && frame.includes("Exploring files..."))

      const frame = await frameOf(app)
      // Only the concrete tools (bash, read) form blocks: one per kind.
      expect(frame).toContain("Running command...")
      expect(frame).toContain("Exploring files...")
      expect(frame).not.toContain("Working...")
      // The excluded orchestration calls stay available as their own rows
      // below the block they closed, even while the group is collapsed.
      expect(frame).toContain("Completing task...")
      expect(frame).toContain("Updating todos...")
      expect(rowOf(frame, "Exploring files...")).toBeLessThan(rowOf(frame, "Completing task..."))
      expect(rowOf(frame, "Completing task...")).toBeLessThan(rowOf(frame, "Updating todos..."))
      // The included tools are hidden behind the collapsed blocks.
      expect(frame).not.toContain("bun test")
      expect(frame).not.toContain(readRow("src/a.ts"))

      // Expanding both blocks reveals only the included tools; the
      // orchestration rows remain separate and visible.
      // Expanding the first block inserts a row and shifts the second block
      // down. Clicking the second at a pre-expansion row races that render and
      // lands on the wrong row under load (#552, reproduced): settle the first
      // expansion before reading the second block's row.
      await app.mockMouse.click(5, rowOf(frame, "Running command..."))
      await waitFrame(app, (frame: string) => frame.includes("bun test"))
      await app.mockMouse.click(5, rowOf(await frameOf(app), "Exploring files..."))
      await waitFrame(app, (frame: string) => frame.includes(readRow("src/a.ts")) && frame.includes("bun test"))
      const expanded = await frameOf(app)
      expect(expanded).toContain("bun test")
      expect(expanded).toContain(readRow("src/a.ts"))
      expect(expanded).toContain("Completing task...")
      expect(expanded).toContain("Updating todos...")
      // Neither orchestration call is nested inside the blocks: both render
      // below the blocks' own rows.
      expect(rowOf(expanded, readRow("src/a.ts"))).toBeLessThan(rowOf(expanded, "Completing task..."))
    } finally {
      app.renderer.destroy()
    }
  })

  test("closes the Working block at a subagent delegation and opens a new one after it", async () => {
    const { app, sync } = await mountActivity({ height: 30 })
    try {
      const m1 = assistant("m1", at(1))
      const m2 = assistant("m2", at(2))
      const m3 = assistant("m3", at(3))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      const t2 = running(m1.id, "grep", { pattern: "alpha" }, 1100)
      const delegation = running(m2.id, "task", { description: "Investigate the failure", subagent_type: "code" }, 1200)
      const t3 = running(m3.id, "bash", { command: "bun test" }, 1400)
      const t4 = running(m3.id, "edit", { filePath: "src/b.ts" }, 1500)
      // Without the delegation all four tool calls stream into one working run.
      seed(sync, [
        { message: m1, parts: [t1, t2] },
        { message: m2, parts: [] },
        { message: m3, parts: [t3, t4] },
      ])
      await waitFrame(app, 
        (frame: string) =>
          frame.includes("Exploring files...") && frame.includes("Running command...") && frame.includes("Editing files..."),
      )

      // The delegation lands inside that run: it ends the block above it and the
      // work after it opens a fresh block instead of resuming the old one.
      reseedParts(sync, { [m2.id]: [delegation] })
      await waitFrame(app, 
        (frame: string) =>
          countOf(frame, "Exploring files...") === 1 &&
          countOf(frame, "Running command...") === 1 &&
          frame.includes("Code Task — Investigate the failure"),
      )
      const frame = await frameOf(app)
      // The post-delegation run (bash + edit) renders its own two kind blocks.
      expect(countOf(frame, "Editing files...")).toBe(1)
      // The subagent renders as its own top-level block between the two runs,
      // not nested inside the block that was open around it.
      expect(rowOf(frame, "Exploring files...")).toBeLessThan(rowOf(frame, "Code Task — Investigate the failure"))
      expect(rowOf(frame, "Code Task — Investigate the failure")).toBeLessThan(rowOf(frame, "Running command..."))
      expect(rowOf(frame, "Running command...")).toBeLessThan(rowOf(frame, "Editing files..."))
      // Both blocks keep the usual collapsed behaviour.
      expect(frame).not.toContain(readRow("src/a.ts"))
      expect(frame).not.toContain("bun test")

      // The block closed by the delegation finalizes on its own timing: neither
      // the delegation nor the continued work stretches it.
      reseedParts(sync, { [m1.id]: [completed(t1, 1000, 2400), completed(t2, 1100, 2400)] })
      await waitFrame(app, (frame: string) => frame.includes("Explored 2 files · 1.4s"))
      const done = await frameOf(app)
      expect(done).toContain("Running command...")
      expect(done).not.toContain("Explored 4 files")
      expect(rowOf(done, "Explored 2 files · 1.4s")).toBeLessThan(rowOf(done, "Code Task — Investigate the failure"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("closes the Working block at a finish call and opens a new one after it", async () => {
    const { app, sync } = await mountActivity({ height: 30 })
    try {
      const m1 = assistant("m1", at(1))
      const m2 = assistant("m2", at(2))
      const m3 = assistant("m3", at(3))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      const t2 = running(m1.id, "grep", { pattern: "alpha" }, 1100)
      const finish = running(m2.id, "finish", { result: "first pass complete" }, 1200)
      const t3 = running(m3.id, "bash", { command: "bun test" }, 1400)
      const t4 = running(m3.id, "edit", { filePath: "src/b.ts" }, 1500)
      // Without the finish call all four tool calls stream into one working run.
      seed(sync, [
        { message: m1, parts: [t1, t2] },
        { message: m2, parts: [] },
        { message: m3, parts: [t3, t4] },
      ])
      await waitFrame(app, 
        (frame: string) =>
          frame.includes("Exploring files...") && frame.includes("Running command...") && frame.includes("Editing files..."),
      )

      // The turn completion is a transcript row of its own, so it ends the run
      // it lands in and the work that follows opens a fresh block.
      reseedParts(sync, { [m2.id]: [finish] })
      await waitFrame(app, 
        (frame: string) =>
          countOf(frame, "Exploring files...") === 1 &&
          countOf(frame, "Running command...") === 1 &&
          frame.includes("Completing task..."),
      )
      const frame = await frameOf(app)
      expect(countOf(frame, "Editing files...")).toBe(1)
      expect(rowOf(frame, "Exploring files...")).toBeLessThan(rowOf(frame, "Completing task..."))
      expect(rowOf(frame, "Completing task...")).toBeLessThan(rowOf(frame, "Running command..."))
      expect(rowOf(frame, "Running command...")).toBeLessThan(rowOf(frame, "Editing files..."))
      expect(frame).not.toContain(readRow("src/a.ts"))
      expect(frame).not.toContain("bun test")
    } finally {
      app.renderer.destroy()
    }
  })

  test("does not render an activity header for an all-excluded sequence", async () => {
    const { app, sync } = await mountActivity()
    try {
      const m1 = assistant("m1", at(1))
      const t1 = running(m1.id, "todowrite", { todos: [] }, 1000)
      const t2 = running(m1.id, "finish", { reason: "complete" }, 1100)
      seed(sync, [{ message: m1, parts: [t1, t2] }])
      await waitFrame(app, (frame: string) => frame.includes("Completing task..."))

      const frame = await frameOf(app)
      expect(frame).not.toContain("Working...")
      expect(frame).not.toContain("Worked for")
      // The excluded calls render as their own native rows regardless.
      expect(frame).toContain("Completing task...")
      expect(frame).toContain("Updating todos...")
    } finally {
      app.renderer.destroy()
    }
  })

  test("closes the Working block at a to-do call and opens a new one after it", async () => {
    const { app, sync } = await mountActivity({ height: 30 })
    try {
      const m1 = assistant("m1", at(1))
      const m2 = assistant("m2", at(2))
      const m3 = assistant("m3", at(3))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      const t2 = running(m2.id, "grep", { pattern: "alpha" }, 1100)
      const todo = todoBlock(m2.id, "Plan the fix", 1300, 1400)
      const t3 = running(m3.id, "bash", { command: "bun test" }, 1600)
      const t4 = running(m3.id, "edit", { filePath: "src/b.ts" }, 1700)
      // Without the to-do call all four tool calls stream into one working run.
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
        { message: m3, parts: [t3, t4] },
      ])
      await waitFrame(app, 
        (frame: string) =>
          frame.includes("Exploring files...") && frame.includes("Running command...") && frame.includes("Editing files..."),
      )

      // The to-do call lands inside that run: it ends the block above it and the
      // work after it opens a fresh block instead of resuming the old one.
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2, todo] },
        { message: m3, parts: [t3, t4] },
      ])
      await waitFrame(app, 
        (frame: string) =>
          countOf(frame, "Exploring files...") === 1 &&
          countOf(frame, "Running command...") === 1 &&
          frame.includes("Plan the fix"),
      )
      const frame = await frameOf(app)
      // The to-do renders as its own top-level block, between the two runs.
      expect(rowOf(frame, "Exploring files...")).toBeLessThan(rowOf(frame, "# Todos"))
      expect(rowOf(frame, "# Todos")).toBeLessThan(rowOf(frame, "Running command..."))
      // Both blocks keep the usual collapsed behaviour.
      expect(frame).not.toContain(readRow("src/a.ts"))
      expect(frame).not.toContain("bun test")

      // The block closed by the to-do call finalizes on its own timing: neither
      // the to-do call nor the continued work stretches it.
      reseedParts(sync, {
        [m1.id]: [completed(t1, 1000, 2400)],
        [m2.id]: [completed(t2, 1100, 2400), todo],
      })
      await waitFrame(app, (frame: string) => frame.includes("Explored 2 files · 1.4s"))
      const done = await frameOf(app)
      expect(done).toContain("Running command...")
      expect(done).not.toContain("Explored 4 files")
      expect(rowOf(done, "Explored 2 files · 1.4s")).toBeLessThan(rowOf(done, "# Todos"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("does not resume a streaming Working block when a to-do call lands", async () => {
    const { app, sync } = await mountActivity({ height: 30 })
    try {
      const m1 = assistant("m1", at(1))
      const m2 = assistant("m2", at(2))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      const t2 = running(m1.id, "grep", { pattern: "alpha" }, 1100)
      const todo = running(m1.id, "todowrite", { todos: [] }, 1200)
      const t3 = running(m2.id, "bash", { command: "bun test" }, 1300)
      const t4 = running(m2.id, "edit", { filePath: "src/b.ts" }, 1400)
      seed(sync, [{ message: m1, parts: [t1, t2] }])
      await waitFrame(app, (frame: string) => frame.includes("Exploring files..."))

      // A to-do call that is still running closes the open block right away: it
      // never joins the block and does not wait for its own settlement.
      reseedParts(sync, { [m1.id]: [t1, t2, todo] })
      await waitFrame(app, (frame: string) => frame.includes("Updating todos..."))
      expect(countOf(await frameOf(app), "Exploring files...")).toBe(1)

      seed(sync, [
        { message: m1, parts: [t1, t2, todo] },
        { message: m2, parts: [t3, t4] },
      ])
      await waitFrame(app, 
        (frame: string) => frame.includes("Running command...") && frame.includes("Editing files..."),
      )
      const frame = await frameOf(app)
      expect(countOf(frame, "Exploring files...")).toBe(1)
      expect(rowOf(frame, "Exploring files...")).toBeLessThan(rowOf(frame, "Updating todos..."))
      expect(rowOf(frame, "Updating todos...")).toBeLessThan(rowOf(frame, "Running command..."))
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders sequential to-do calls as separate top-level blocks", async () => {
    const { app, sync } = await mountActivity({ height: 34 })
    try {
      const m1 = assistant("m1", at(1))
      const m2 = assistant("m2", at(2))
      const m3 = assistant("m3", at(3))
      const m4 = assistant("m4", at(4))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      const t2 = running(m1.id, "grep", { pattern: "alpha" }, 1100)
      const first = todoBlock(m2.id, "First list", 1200, 1300)
      const second = todoBlock(m3.id, "Second list", 1400, 1500)
      const t3 = running(m4.id, "bash", { command: "bun test" }, 1600)
      const t4 = running(m4.id, "edit", { filePath: "src/b.ts" }, 1700)
      seed(sync, [
        { message: m1, parts: [t1, t2] },
        { message: m2, parts: [first] },
        { message: m3, parts: [second] },
        { message: m4, parts: [t3, t4] },
      ])
      await waitFrame(app, (frame: string) => countOf(frame, "# Todos") === 2)
      const frame = await frameOf(app)
      // Back-to-back to-do calls form no run of their own and leave exactly the
      // two work runs on either side of them (explore before, bash+edit after).
      expect(countOf(frame, "Exploring files...")).toBe(1)
      expect(countOf(frame, "Running command...")).toBe(1)
      expect(countOf(frame, "Editing files...")).toBe(1)
      expect(rowOf(frame, "Exploring files...")).toBeLessThan(rowOfNth(frame, "# Todos", 1))
      expect(rowOfNth(frame, "# Todos", 1)).toBeLessThan(rowOfNth(frame, "# Todos", 2))
      expect(rowOfNth(frame, "# Todos", 2)).toBeLessThan(rowOf(frame, "Running command..."))
      expect(frame).toContain("First list")
      expect(frame).toContain("Second list")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps the Working blocks around a to-do call independently collapsible", async () => {
    const { app, sync } = await mountActivity({ height: 34 })
    try {
      const m1 = assistant("m1", at(1))
      const m2 = assistant("m2", at(2))
      const m3 = assistant("m3", at(3))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      const t2 = running(m2.id, "grep", { pattern: "alpha" }, 1100)
      const todo = todoBlock(m2.id, "Plan the fix", 1300, 1400)
      const t3 = running(m3.id, "bash", { command: "bun test" }, 1600)
      const t4 = running(m3.id, "edit", { filePath: "src/b.ts" }, 1700)
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2, todo] },
        { message: m3, parts: [t3, t4] },
      ])
      await waitFrame(app, 
        (frame: string) => frame.includes("Exploring files...") && frame.includes("Running command..."),
      )

      // Expanding the first block reveals only its own rows, and the to-do
      // block stays a top-level sibling below them instead of being nested.
      await app.mockMouse.click(5, rowOf(await frameOf(app), "Exploring files..."))
      await waitFrame(app, (frame: string) => frame.includes(readRow("src/a.ts")))
      const expanded = await frameOf(app)
      expect(expanded).toContain('Grep "alpha"')
      expect(expanded).not.toContain("bun test")
      expect(rowOf(expanded, 'Grep "alpha"')).toBeLessThan(rowOf(expanded, "# Todos"))
      expect(rowOf(expanded, "# Todos")).toBeLessThan(rowOf(expanded, "Running command..."))

      await app.mockMouse.click(5, rowOf(await frameOf(app), "Running command..."))
      await waitFrame(app, (frame: string) => frame.includes("bun test"))
      expect(await frameOf(app)).toContain(readRow("src/a.ts"))

      // Collapsing the first block leaves the second one open: the blocks own
      // separate activity state because they are separate groups.
      await app.mockMouse.click(5, rowOf(await frameOf(app), "Exploring files..."))
      await waitFrame(app, (frame: string) => !frame.includes(readRow("src/a.ts")))
      const final = await frameOf(app)
      expect(final).not.toContain(readRow("src/a.ts"))
      expect(final).toContain("bun test")
      expect(final).toContain("# Todos")
      expect(countOf(final, "Running command...")).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("expanding and collapsing keeps the scroll position", async () => {
    const { app, sync, scroll } = await mountActivity({ height: 6, width: 60 })
    try {
      // A run of six tool calls (one group) sandwiched between filler text,
      // so the group header is mid-transcript and the expanded rows appear in
      // the viewport instead of below it.
      const top = assistant("m0", at(0))
      const topText = "filler a1\nfiller a2\nfiller a3\nfiller a4"
      const rows: { message: Message; parts: Part[] }[] = [
        { message: top, parts: [textPart(top.id, topText)] },
      ]
      for (let index = 0; index < 6; index++) {
        const message = assistant(`m${index + 1}`, at(index + 1))
        const part = running(message.id, "read", { filePath: `src/file${index}.ts` }, 1000 + index * 100)
        rows.push({ message, parts: [part] })
      }
      const bottom = assistant("m7", at(7))
      const bottomText = Array.from({ length: 12 }, (_, index) => `filler line ${index + 1}`).join("\n")
      rows.push({ message: bottom, parts: [textPart(bottom.id, bottomText)] })
      seed(sync, rows)

      const box = scroll()
      if (!box) throw new Error("scrollbox not found")
      // Wait until the content overflows the viewport, then bring the
      // (collapsed) group header into view without being at the top.
      let pass = 0
      while ((box.scrollHeight ?? 0) <= box.height && pass++ < 100) await app.renderOnce()
      if ((box.scrollHeight ?? 0) <= box.height) throw new Error("content did not overflow the viewport")
      box.scrollTo(3)
      await app.renderOnce()
      await waitFrame(app, (frame: string) => frame.includes("Exploring files..."))
      const before = box.scrollTop
      if (before === 0) throw new Error("expected a non-zero scroll offset")

      const row = rowOf(await frameOf(app), "Exploring files...")
      await app.mockMouse.click(5, row)
      await waitFrame(app, (frame: string) => frame.includes(readRow("src/file0.ts")))
      expect(box.scrollTop).toBe(before)

      await app.mockMouse.click(5, rowOf(await frameOf(app), "Exploring files..."))
      await waitFrame(app, (frame: string) => !frame.includes(readRow("src/file0.ts")))
      expect(box.scrollTop).toBe(before)
    } finally {
      app.renderer.destroy()
    }
  })

  test("ActivityGroup renders its header state directly", async () => {
    const { app, sync } = await mountActivity({
      render: (storeSync) => {
        const group = findGroup(storeSync)
        if (!group) return <text>waiting</text>
        return <ActivityGroup groupID={group} />
      },
    })
    try {
      const m1 = assistant("m1", at(1))
      const t1: ToolPart = {
        id: nextPartID(),
        sessionID: SESSION,
        messageID: m1.id,
        type: "tool",
        callID: "call",
        tool: "read",
        state: { status: "completed", input: { filePath: "src/a.ts" }, output: "", title: "", metadata: {}, time: { start: 1000, end: 1420 } },
      }
      const t2: ToolPart = {
        id: nextPartID(),
        sessionID: SESSION,
        messageID: m1.id,
        type: "tool",
        callID: "call",
        tool: "grep",
        state: { status: "completed", input: { pattern: "todo" }, output: "", title: "", metadata: {}, time: { start: 1200, end: 2420 } },
      }
      seed(sync, [{ message: m1, parts: [t1, t2] }])
      await waitFrame(app, (frame: string) => frame.includes("Explored 2 files · 1.4s"))
      const frame = await frameOf(app)
      expect(frame).toContain("Explored 2 files · 1.4s")
      expect(frame).toContain("+ Explored")
    } finally {
      app.renderer.destroy()
    }
  })

  for (const scenario of [
    "success",
    "synthetic",
    "new-request",
    "missing-parts",
    "waiting",
    "error",
    "ordinary",
  ] as const) {
    test(`last Work footer duration after ${scenario} tool call`, async () => {
      const { app, sync } = await mountActivity({
        render: (store) => {
          const message = store.data.message[SESSION]?.find((m) => m.role === "assistant") as AssistantMessage
          return message ? (
            <AssistantMessageRow message={message} parts={store.data.part[message.id] ?? []} last={true} />
          ) : (
            <text />
          )
        },
      })
      try {
        const message = {
          ...assistant("duration-final", at(9)),
          parentID: ["synthetic", "new-request", "missing-parts"].includes(scenario) ? "synthetic-parent" : "msg_user",
          time: { created: at(9), completed: at(12) },
        }
        const user = {
          id: "msg_user",
          sessionID: SESSION,
          role: "user" as const,
          time: { created: at(0) },
          agent: "work",
          model: { providerID: "test", modelID: "model" },
        }
        const input = { reason: scenario === "waiting" ? "waiting_for_subagent" : "success", result: "Done" }
        let tool = completed(
          running(message.id, scenario === "ordinary" ? "read" : "finish", input, at(10)),
          at(10),
          at(12),
        )
        if (scenario === "waiting" && tool.state.status === "completed")
          tool = { ...tool, state: { ...tool.state, metadata: { waiting: true } } }
        if (scenario === "error")
          tool = {
            ...tool,
            state: { status: "error", input, error: "invalid finish", time: { start: at(10), end: at(12) } },
          }
        seed(sync, [
          { message: user, parts: [textPart(user.id, "Build tasklog")] },
          ...(scenario === "new-request"
            ? [
                {
                  message: { ...user, id: "new-request", time: { created: at(5) } },
                  parts: [textPart("new-request", "Now change the output")],
                },
              ]
            : []),
          ...(scenario === "synthetic"
            ? [
                {
                  message: { ...user, id: "background-delivery", time: { created: at(4) } },
                  parts: [{ ...textPart("background-delivery", "Code completed"), synthetic: true }],
                },
              ]
            : []),
          ...(["synthetic", "new-request", "missing-parts"].includes(scenario)
            ? [
                {
                  message: { ...user, id: "synthetic-parent", time: { created: at(10) } },
                  parts:
                    scenario === "missing-parts"
                      ? []
                      : [{ ...textPart("synthetic-parent", "Continue after finish error"), synthetic: true }],
                },
              ]
            : []),
          { message, parts: [reasoningPart(message.id, "Ready to finish"), tool] },
          // A later human message must not change a historical row's boundary.
          {
            message: { ...user, id: "later-user", time: { created: at(20) } },
            parts: [textPart("later-user", "Unrelated next request")],
          },
        ])
        await waitFrame(app, (frame: string) => frame.includes("Work · model"))
        const frame = await frameOf(app)
        const footer = frame.split("\n").find((line: string) => line.includes("Work · model")) ?? ""
        if (scenario === "success" || scenario === "synthetic") expect(footer).toContain("12.0s")
        else if (scenario === "new-request") expect(footer).toContain("7.0s")
        else expect(footer).not.toMatch(/ · [0-9.]+s/)
      } finally {
        app.renderer.destroy()
      }
    })
  }

  test("does not render a second model footer for a finish-only turn", async () => {
    const { app, sync } = await mountActivity({
      render: (storeSync) => {
        const messages = storeSync.data.message[SESSION] ?? []
        const lastId = messages[messages.length - 1]?.id
        return (
          <For each={messages}>
            {(message) => {
              const isLast = message.id === lastId
              return (
                <Switch>
                  <Match when={message.role === "user"}>
                    <text>
                      {(storeSync.data.part[message.id] ?? [])
                        .filter((part): part is TextPart => part.type === "text")
                        .map((part) => part.text)
                        .join(" ")}
                    </text>
                  </Match>
                  <Match when={true}>
                    <AssistantMessageRow
                      message={message as AssistantMessage}
                      parts={storeSync.data.part[message.id] ?? []}
                      last={isLast}
                    />
                  </Match>
                </Switch>
              )
            }}
          </For>
        )
      },
    })
    try {
      const mainMsg = assistant("m_main", at(1))
      const finishOnlyMsg = assistant("m_finish", at(2))
      const mainText = textPart(mainMsg.id, "I will investigate this.")
      const finishTool = running(finishOnlyMsg.id, "finish", { reason: "complete" }, 1100)
      const userMsg = {
        id: "msg_user",
        sessionID: SESSION,
        role: "user" as const,
        time: { created: at(0) },
        parentID: "",
        model: { providerID: "test", modelID: "model" },
        modelID: "model",
        providerID: "test",
        mode: "work",
        agent: "work",
        path: { cwd: "/tmp", root: "/tmp" },
      }
      // main turn gets finish:"stop" so it is the substantive turn with a footer
      seed(sync, [
        { message: userMsg, parts: [] },
        { message: { ...mainMsg, finish: "stop" }, parts: [mainText] },
        { message: finishOnlyMsg, parts: [finishTool] },
      ])
      await waitFrame(app, (frame: string) => frame.includes("Work · model"))
      const frame = await frameOf(app)
      // Exactly one footer marker: the substantive turn's footer.
      // The finish-only turn must not produce a second standalone footer.
      const footerMarkers = (frame.match(/▣/g) || []).length
      expect(footerMarkers).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("genuine separate model turns each render their own footer", async () => {
    const { app, sync } = await mountActivity({
      render: (storeSync) => {
        const messages = storeSync.data.message[SESSION] ?? []
        const lastId = messages[messages.length - 1]?.id
        return (
          <For each={messages}>
            {(message) => {
              const isLast = message.id === lastId
              return (
                <Switch>
                  <Match when={message.role === "user"}>
                    <text>
                      {(storeSync.data.part[message.id] ?? [])
                        .filter((part): part is TextPart => part.type === "text")
                        .map((part) => part.text)
                        .join(" ")}
                    </text>
                  </Match>
                  <Match when={true}>
                    <AssistantMessageRow
                      message={message as AssistantMessage}
                      parts={storeSync.data.part[message.id] ?? []}
                      last={isLast}
                    />
                  </Match>
                </Switch>
              )
            }}
          </For>
        )
      },
    })
    try {
      const m1 = assistant("m1", at(1))
      const m2 = assistant("m2", at(2))
      const m3 = assistant("m3", at(3))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      const t2 = running(m2.id, "grep", { pattern: "todo" }, 1100)
      const t3 = running(m3.id, "bash", { command: "ls" }, 1200)
      const userMsg = {
        id: "msg_user",
        sessionID: SESSION,
        role: "user" as const,
        time: { created: at(0) },
        parentID: "",
        model: { providerID: "test", modelID: "model" },
        modelID: "model",
        providerID: "test",
        mode: "work",
        agent: "work",
        path: { cwd: "/tmp", root: "/tmp" },
      }
      seed(sync, [
        { message: userMsg, parts: [] },
        { message: { ...m1, finish: "stop" }, parts: [textPart(m1.id, "Step one."), t1] },
        { message: { ...m2, finish: "stop" }, parts: [textPart(m2.id, "Step two."), t2] },
        { message: { ...m3, finish: "stop" }, parts: [textPart(m3.id, "Done."), t3] },
      ])
      await waitFrame(app, (frame: string) => frame.includes("Work · model"))
      const frame = await frameOf(app)
      // Three substantive turns, each with content, each gets its own footer
      const footerMarkers = (frame.match(/▣/g) || []).length
      expect(footerMarkers).toBe(3)
    } finally {
      app.renderer.destroy()
    }
  })

  test("collapsing an expanded group keeps it collapsed across live updates", async () => {
    const { app, sync } = await mountActivity()
    try {
      const { m1, m2, t1, t2 } = twoRunningTools()
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
      ])
      await waitFrame(app, (frame: string) => frame.includes("Exploring files..."))
      expect(await frameOf(app)).toMatch(/\+ . Exploring files\.\.\./)

      // collapsed -> expanded
      await app.mockMouse.click(5, rowOf(await frameOf(app), "Exploring files..."))
      await waitFrame(app, (frame: string) => frame.includes(readRow("src/a.ts")))
      expect(await frameOf(app)).toMatch(/− . Exploring files\.\.\./)

      // expanded -> collapsed
      await app.mockMouse.click(5, rowOf(await frameOf(app), "Exploring files..."))
      await waitFrame(app, (frame: string) => !frame.includes(readRow("src/a.ts")))
      expect(await frameOf(app)).toMatch(/\+ . Exploring files\.\.\./)

      // Live updates must not reopen a collapsed block - including a new kind
      // block (bash) streaming into the same group.
      const t3 = running(m2.id, "bash", { command: "bun test" }, 1200)
      reseedParts(sync, { [m1.id]: [completed(t1, 1000, 1400)], [m2.id]: [t2, t3] })
      await waitFrame(app, (frame: string) => frame.includes("Running command..."))
      const collapsed = await frameOf(app)
      expect(collapsed).toMatch(/\+ . Exploring files\.\.\./)
      expect(collapsed).not.toMatch(/− . Exploring files\.\.\./)
      expect(collapsed).not.toContain(readRow("src/a.ts"))
      expect(collapsed).not.toContain("bun test")

      // The toggle still works after updates.
      await app.mockMouse.click(5, rowOf(collapsed, "Running command..."))
      await waitFrame(app, (frame: string) => frame.includes("bun test"))
      expect(await frameOf(app)).not.toContain(readRow("src/a.ts"))
      await app.mockMouse.click(5, rowOf(await frameOf(app), "Exploring files..."))
      await waitFrame(app, (frame: string) => frame.includes(readRow("src/a.ts")))
      expect(await frameOf(app)).toMatch(/− . Exploring files\.\.\./)
    } finally {
      app.renderer.destroy()
    }
  })

  test("toggles each group independently while live updates stream in", async () => {
    const { app, sync } = await mountActivity({ height: 30 })
    try {
      const m1 = assistant("m1", at(1))
      const m2 = assistant("m2", at(2))
      const m3 = assistant("m3", at(3))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      const t2 = running(m2.id, "read", { filePath: "src/b.ts" }, 1100)
      // Created before t3/t4 so its part id sorts ahead of them in the store.
      const note = textPart(m3.id, "In between.")
      const t3 = running(m3.id, "read", { filePath: "src/c.ts" }, 1200)
      const t4 = running(m3.id, "read", { filePath: "src/d.ts" }, 1300)
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
        { message: m3, parts: [note, t3, t4] },
      ])
      await waitFrame(app, 
        (frame: string) => frame.includes("In between.") && frame.match(/Exploring files\.\.\./g)?.length === 2,
      )

      // Expand only the first group.
      await app.mockMouse.click(5, rowOfNth(await frameOf(app), "Exploring files...", 1))
      await waitFrame(app, (frame: string) => frame.includes(readRow("src/a.ts")))
      expect(await frameOf(app)).not.toContain(readRow("src/c.ts"))

      // Updates to both groups preserve each toggle state.
      const t5 = running(m3.id, "read", { filePath: "src/e.ts" }, 1400)
      reseedParts(sync, { [m1.id]: [completed(t1, 1000, 1500)], [m3.id]: [note, t3, t4, t5] })
      await waitFrame(app, (frame: string) => frame.match(/Exploring files\.\.\./g)?.length === 2)
      const afterUpdate = await frameOf(app)
      expect(afterUpdate).toContain(readRow("src/a.ts"))
      expect(afterUpdate).toContain(readRow("src/b.ts"))
      expect(afterUpdate).not.toContain(readRow("src/c.ts"))
      expect(afterUpdate).not.toContain(readRow("src/e.ts"))

      // Expanding the second group leaves the first expanded.
      await app.mockMouse.click(5, rowOfNth(await frameOf(app), "Exploring files...", 2))
      await waitFrame(app, (frame: string) => frame.includes(readRow("src/c.ts")) && frame.includes(readRow("src/e.ts")))
      expect(await frameOf(app)).toContain(readRow("src/a.ts"))

      // Collapsing the first group leaves the second expanded.
      await app.mockMouse.click(5, rowOfNth(await frameOf(app), "Exploring files...", 1))
      await waitFrame(app, (frame: string) => !frame.includes(readRow("src/a.ts")))
      const final = await frameOf(app)
      expect(final).not.toContain(readRow("src/b.ts"))
      expect(final).toContain(readRow("src/c.ts"))
      expect(final).toContain(readRow("src/e.ts"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("collapses one group while all groups are expanded", async () => {
    const { app, sync } = await mountActivity({ height: 30 })
    try {
      const m1 = assistant("m1", at(1))
      const m2 = assistant("m2", at(2))
      const m3 = assistant("m3", at(3))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      const t2 = running(m2.id, "read", { filePath: "src/b.ts" }, 1100)
      // Created before t3/t4 so its part id sorts ahead of them in the store.
      const note = textPart(m3.id, "In between.")
      const t3 = running(m3.id, "read", { filePath: "src/c.ts" }, 1200)
      const t4 = running(m3.id, "read", { filePath: "src/d.ts" }, 1300)
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
        { message: m3, parts: [note, t3, t4] },
      ])
      await waitFrame(app, 
        (frame: string) => frame.includes("In between.") && frame.match(/Exploring files\.\.\./g)?.length === 2,
      )

      // Expand everything globally.
      app.mockInput.pressKey("o", { ctrl: true })
      await waitFrame(app, (frame: string) => frame.includes(readRow("src/a.ts")) && frame.includes(readRow("src/c.ts")))
      expect((await frameOf(app)).match(/− . Exploring files\.\.\./g)?.length).toBe(2)

      // Clicking one group collapses only that group.
      await app.mockMouse.click(5, rowOfNth(await frameOf(app), "Exploring files...", 1))
      await waitFrame(app, (frame: string) => !frame.includes(readRow("src/a.ts")))
      const oneCollapsed = await frameOf(app)
      expect(oneCollapsed).not.toContain(readRow("src/b.ts"))
      expect(oneCollapsed).toContain(readRow("src/c.ts"))
      expect(oneCollapsed).toContain(readRow("src/d.ts"))
      expect(oneCollapsed.match(/\+ . Exploring files\.\.\./g)?.length).toBe(1)
      expect(oneCollapsed.match(/− . Exploring files\.\.\./g)?.length).toBe(1)

      // Clicking it again re-expands it.
      await app.mockMouse.click(5, rowOfNth(oneCollapsed, "Exploring files...", 1))
      await waitFrame(app, (frame: string) => frame.includes(readRow("src/a.ts")) && frame.includes(readRow("src/c.ts")))
      expect((await frameOf(app)).match(/− . Exploring files\.\.\./g)?.length).toBe(2)
    } finally {
      app.renderer.destroy()
    }
  })

  test("splits a mixed run into per-kind blocks in first-appearance order", async () => {
    const { app, sync } = await mountActivity({ height: 30 })
    try {
      const m1 = assistant("m1", at(1))
      const t1 = running(m1.id, "bash", { command: "bun test" }, 1000)
      const t2 = running(m1.id, "read", { filePath: "src/a.ts" }, 1100)
      const t3 = running(m1.id, "edit", { filePath: "src/b.ts" }, 1200)
      const t4 = running(m1.id, "read", { filePath: "src/c.ts" }, 1300)
      const t5 = running(m1.id, "webfetch", { url: "https://example.com" }, 1400)
      seed(sync, [{ message: m1, parts: [t1, t2, t3, t4, t5] }])
      await waitFrame(app, (frame: string) => frame.includes("Working... 1 tool call"))

      const frame = await frameOf(app)
      // Interleaved kinds merge: the two reads share one Explored block, and
      // the webfetch call lands in the unchanged misc Working block.
      expect(countOf(frame, "Exploring files...")).toBe(1)
      expect(countOf(frame, "Running command...")).toBe(1)
      expect(countOf(frame, "Editing files...")).toBe(1)
      expect(frame).toContain("Working... 1 tool call")
      expect(rowOf(frame, "Running command...")).toBeLessThan(rowOf(frame, "Exploring files..."))
      expect(rowOf(frame, "Exploring files...")).toBeLessThan(rowOf(frame, "Editing files..."))
      expect(rowOf(frame, "Editing files...")).toBeLessThan(rowOf(frame, "Working... 1 tool call"))

      // Each block expands to exactly its own native rows.
      await app.mockMouse.click(5, rowOf(frame, "Exploring files..."))
      await waitFrame(app, (f: string) => f.includes(readRow("src/a.ts")))
      const expanded = await frameOf(app)
      expect(expanded).toContain(readRow("src/a.ts"))
      expect(expanded).toContain(readRow("src/c.ts"))
      expect(expanded).not.toContain("bun test")
      expect(expanded).not.toContain("example.com")
    } finally {
      app.renderer.destroy()
    }
  })

  test("counts distinct targets in Explored and Edited summaries", async () => {
    const { app, sync } = await mountActivity({ height: 30 })
    try {
      const m1 = assistant("m1", at(1))
      const settle = (tool: string, input: Record<string, unknown>, start: number, end: number) =>
        completed(toolPart(m1.id, tool, input, { status: "running", input, time: { start } }), start, end)
      seed(sync, [
        {
          message: m1,
          parts: [
            settle("read", { filePath: "src/a.ts" }, 1000, 1100),
            settle("read", { filePath: "src/a.ts" }, 1100, 1200),
            settle("read", { filePath: "src/b.ts" }, 1200, 1300),
            settle("edit", { filePath: "src/c.ts" }, 1300, 1400),
            settle("edit", { filePath: "src/c.ts" }, 1400, 1500),
          ],
        },
      ])
      await waitFrame(app, (frame: string) => frame.includes("Explored 2 files") && frame.includes("Edited 1 file"))
      const frame = await frameOf(app)
      expect(frame).toContain("Explored 2 files · 300ms")
      expect(frame).toContain("Edited 1 file · 200ms")
      expect(frame).not.toContain("Explored 3 files")
      expect(frame).not.toContain("Edited 2 files")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps the misc Working block for tools without a kind", async () => {
    const { app, sync } = await mountActivity()
    try {
      const m1 = assistant("m1", at(1))
      const t1 = running(m1.id, "webfetch", { url: "https://a.example.com" }, 1000)
      const t2 = running(m1.id, "webfetch", { url: "https://b.example.com" }, 1100)
      seed(sync, [{ message: m1, parts: [t1, t2] }])
      await waitFrame(app, (frame: string) => frame.includes("Working... 2 tool calls"))
      const frame = await frameOf(app)
      expect(frame).toMatch(/\+ . Working\.\.\./)
      expect(frame).not.toContain("Exploring files...")
    } finally {
      app.renderer.destroy()
    }
  })
})
