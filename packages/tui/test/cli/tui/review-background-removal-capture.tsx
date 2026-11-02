/** @jsxImportSource @opentui/solid */
// Standalone live-render background removal capture. Use only synthetic data; see
// docs/review-text-evidence/README.md for the recording procedure.

import { createMemo, For, onCleanup } from "solid-js"
import { render, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import type { AssistantMessage, Message, Part, Provider, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, json } from "../../fixture/tui-sdk"
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
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { AssistantMessageRow, SessionContext, CaptureUserMessage } from "../../../src/routes/session"
import { createExecutionReviewIndex } from "../../../src/routes/session/review-execution"
import { computeActivityGroups } from "../../../src/util/activity"
import { waitUntil } from "../../fixture/frame"
import { ReviewReport } from "@opencode-ai/core/review-report"
import { assistantMessage, userMessage, textPart, sessionInfo } from "../../fixture/session-route"

const SESSION = "ses_review_text_runtime"
const BASE = 1_700_000_000_000

type Sync = ReturnType<typeof useSync>
async function mount(options: { entries: { info: Message; parts: Part[] }[]; after: boolean }) {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const events = createEventSource()
  let persisted = options.entries
  const calls = createFetch((url) => {
    if (url.pathname === `/session/${SESSION}/message`) return json(persisted)
    if (url.pathname === "/session/ses_synthetic_child") return json(sessionInfo("ses_synthetic_child", { parentID: SESSION, agent: "review" }))
    if (/^\/session\/ses_synthetic_child\/(message|todo|diff)$/.test(url.pathname)) return json([])
    return undefined
  }, events)

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
    const reviewExecution = createMemo(() => createExecutionReviewIndex(storeSync.data.message[SESSION] ?? [], storeSync.data.part))
    const ctxValue = {
      get width() {
        return 120
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
      reviewExecution,
      activityAllExpanded: () => false,
      activityExpanded: () => false,
      toggleActivity: () => {},
    }
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <DialogProvider>
        <SessionContext.Provider value={ctxValue}>
          <LocationProvider location={{ directory: "/tmp", workspaceID: undefined }}>
            <For each={storeSync.data.message[SESSION] ?? []}>
              {(message, index) => message.role === "assistant" ? (
                <AssistantMessageRow message={message as AssistantMessage} parts={storeSync.data.part[message.id] ?? []} last={false} />
              ) : (
                <CaptureUserMessage message={message} parts={storeSync.data.part[message.id] ?? []} index={index()} onMouseUp={() => {}} />
              )}
            </For>
          </LocationProvider>
        </SessionContext.Provider>
        </DialogProvider>
      </OpencodeKeymapProvider>
    )
  }

  await render(
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
    { screenMode: "alternate-screen", exitOnCtrlC: false },
  )

  await waitUntil(() => sync !== undefined)
  sync.set("session", [sessionInfo(SESSION), sessionInfo("ses_synthetic_child", { parentID: SESSION, agent: "review" })])
  sync.set("message", SESSION, options.entries.map((entry) => entry.info))
  for (const entry of options.entries) sync.set("part", entry.info.id, entry.parts)
  await Bun.sleep(1800)
  if (options.after) {
    persisted = options.entries.map((entry) => entry.info.id === "msg_002" ? { ...entry, parts: [] } : entry)
    events.emit({ directory: "/tmp", payload: { id: "evt_synthetic_removed", type: "message.part.removed", properties: { sessionID: SESSION, messageID: "msg_002", partID: "launch" } } })
    await Bun.sleep(1200)
  }
  process.exit(0)
}


const child = "ses_synthetic_child"
const run = `${child}@1700000000001`
const user = userMessage("msg_001", SESSION, { agent: "work" })
const launch = assistantMessage("msg_002", SESSION, { agent: "work", parentID: user.id, time: { created: BASE + 1000, completed: BASE + 2000 } })
const notification = userMessage("msg_003", SESSION, { agent: "work", time: { created: BASE + 5000 } })
const report = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "needs-fixes", summary: "Synthetic background finding", findings: [] })
const task: ToolPart = { id: "launch", sessionID: SESSION, messageID: launch.id, type: "tool", tool: "task", callID: "call_synthetic", state: {
  status: "completed", title: "Synthetic review", input: { description: "Synthetic review", subagent_type: "review", background: true },
  metadata: { parentSessionId: SESSION, sessionId: child, background: true, jobId: child, runId: run },
  output: `<task id="${child}" state="running">\n<summary>Background task started</summary>\n<task_result>\nBackground task started\n</task_result>\n</task>`, time: { start: BASE, end: BASE + 1000 },
} }
const receipt: TextPart = { id: "receipt", sessionID: SESSION, messageID: notification.id, type: "text", synthetic: true,
  text: `<task id="${child}" run="${run}" state="completed">\n<summary>Background task completed: Synthetic review</summary>\n<task_result>\n${report}\n</task_result>\n<termination reason="success"></termination>\n</task>` }
await mount({ after: process.argv[2] === "removed", entries: [
  { info: user, parts: [textPart("request", user, "Synthetic review request")] },
  { info: launch, parts: [task] },
  { info: notification, parts: [receipt] },
] })
