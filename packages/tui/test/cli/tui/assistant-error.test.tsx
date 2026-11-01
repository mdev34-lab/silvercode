/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createMemo, createSignal, For, Match, Switch, onCleanup } from "solid-js"
import { testRender, useRenderer, type JSX } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { AssistantMessage, Message, Part, Provider, TextPart } from "@opencode-ai/sdk/v2"
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
import { captureFrame, waitUntil } from "../../fixture/frame"

const SESSION = "ses_error_ui"
const BASE = 1_700_000_000_000
const at = (offset: number) => BASE + offset * 1000

function assistant(id: string, error?: unknown): AssistantMessage {
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
    finish: "error",
    error: error as any,
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

async function frameOf(app: Awaited<ReturnType<typeof testRender>>) {
  return (await captureFrame(app)).split("\n").map((line) => line.trimEnd()).join("\n")
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
            <AssistantMessageRow
              message={message as AssistantMessage}
              parts={sync.data.part[message.id] ?? []}
              last={true}
            />
          </Match>
        </Switch>
      )}
    </For>
  )
}

async function mountSession(options: {
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
              {options.render ? options.render(storeSync) : <Transcript />}
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

describe("AssistantMessageError rendering and truncation", () => {
  test("renders short errors in full without truncation or expand affordance", async () => {
    const { app, sync } = await mountSession()
    try {
      const errorMsg = "API error: Rate limit exceeded. Try again in 5s."
      const msg = assistant("m1", {
        name: "APIError",
        data: { message: errorMsg, isRetryable: true },
      })
      seed(sync, [{ message: msg, parts: [] }])

      await app.waitForFrame((frame: string) => frame.includes(errorMsg))
      const frame = await frameOf(app)
      expect(frame).toContain(errorMsg)
      expect(frame).not.toContain("Click to expand")
      expect(frame).not.toContain("Click to collapse")
      expect(frame).not.toContain("…")
    } finally {
      app.renderer.destroy()
    }
  })

  test("truncates multiline errors to preview lines and shows click to expand", async () => {
    const { app, sync } = await mountSession()
    try {
      const multilineError = [
        "API error: Internal Server Error (500)",
        "Error Code: WORKER_CRASHED",
        "Request ID: req_12345abcdef",
        "Stack trace line 1: at handleRequest (server.ts:42)",
        "Stack trace line 2: at dispatch (router.ts:108)",
        "Additional debug context: payload corrupted",
      ].join("\n")

      const msg = assistant("m1", {
        name: "APIError",
        data: { message: multilineError, isRetryable: false },
      })
      seed(sync, [{ message: msg, parts: [] }])

      await app.waitForFrame((frame: string) => frame.includes("Click to expand"))
      const frame = await frameOf(app)
      // Preview should contain first 3 lines
      expect(frame).toContain("API error: Internal Server Error (500)")
      expect(frame).toContain("Error Code: WORKER_CRASHED")
      expect(frame).toContain("Request ID: req_12345abcdef")
      expect(frame).toContain("…")
      expect(frame).toContain("Click to expand")
      // Should not contain lines beyond preview limit when collapsed
      expect(frame).not.toContain("Additional debug context: payload corrupted")
    } finally {
      app.renderer.destroy()
    }
  })

  test("truncates extremely long single-line errors bounded to character budget", async () => {
    const { app, sync } = await mountSession({ width: 80 })
    try {
      const longPayload = "API error: request failed with unhandled upstream payload: " + "A".repeat(400)
      const msg = assistant("m1", {
        name: "APIError",
        data: { message: longPayload, isRetryable: false },
      })
      seed(sync, [{ message: msg, parts: [] }])

      await app.waitForFrame((frame: string) => frame.includes("Click to expand"))
      const frame = await frameOf(app)
      expect(frame).toContain("API error: request failed")
      expect(frame).toContain("…")
      expect(frame).toContain("Click to expand")
      // Full unbroken 400-char string must not be present in the collapsed frame
      expect(frame).not.toContain("A".repeat(300))
    } finally {
      app.renderer.destroy()
    }
  })

  test("expands full error on click and collapses on second click", async () => {
    const { app, sync } = await mountSession()
    try {
      const multilineError = [
        "API error: failed upstream call",
        "Detail row 1: service unavailable",
        "Detail row 2: gateway timeout",
        "Detail row 3: trace ID #998877",
        "Detail row 4: extra diagnostics not visible in collapsed state",
      ].join("\n")

      const msg = assistant("m1", {
        name: "APIError",
        data: { message: multilineError, isRetryable: false },
      })
      seed(sync, [{ message: msg, parts: [] }])

      await app.waitForFrame((frame: string) => frame.includes("Click to expand"))
      expect(await frameOf(app)).not.toContain("Detail row 4: extra diagnostics")

      // Click on the error block
      const row = rowOf(await frameOf(app), "Click to expand")
      await app.mockMouse.click(5, row)

      // Should expand to show all lines and "Click to collapse"
      await app.waitForFrame((frame: string) => frame.includes("Click to collapse"))
      const expandedFrame = await frameOf(app)
      expect(expandedFrame).toContain("Detail row 4: extra diagnostics not visible in collapsed state")
      expect(expandedFrame).toContain("Click to collapse")

      // Click again to collapse. 0.6 counts a second click inside the double-click window as a
      // text selection, and the block ignores clicks that end one, so give the toggle some space.
      await Bun.sleep(600)
      const collapseRow = rowOf(await frameOf(app), "Click to collapse")
      await app.mockMouse.click(5, collapseRow)

      // Should return to collapsed state
      await app.waitForFrame((frame: string) => frame.includes("Click to expand"))
      const collapsedAgain = await frameOf(app)
      expect(collapsedAgain).toContain("Click to expand")
      expect(collapsedAgain).not.toContain("Detail row 4: extra diagnostics")
    } finally {
      app.renderer.destroy()
    }
  })

  test("handles narrow terminal widths with properly constrained character bounds", async () => {
    const { app, sync } = await mountSession({ width: 30 })
    try {
      const errorMsg =
        "Provider returned unexpected response: 502 Bad Gateway from cloud edge with details: upstream connection refused"
      const msg = assistant("m1", {
        name: "APIError",
        data: { message: errorMsg, isRetryable: true },
      })
      seed(sync, [{ message: msg, parts: [] }])

      await app.waitForFrame((frame: string) => frame.includes("Click to expand"))
      const frame = await frameOf(app)
      expect(frame).toContain("…")
      expect(frame).toContain("Click to expand")

      // Click to expand on narrow terminal
      const row = rowOf(await frameOf(app), "Click to expand")
      await app.mockMouse.click(2, row)

      await app.waitForFrame((frame: string) => frame.includes("Click to collapse"))
      // Line breaks are decided by the native layout, so compare the reflowed text.
      expect((await frameOf(app)).replace(/[\u2502\u2503]/g, " ").replace(/\s+/g, " ")).toContain("upstream connection refused")
    } finally {
      app.renderer.destroy()
    }
  })
})
