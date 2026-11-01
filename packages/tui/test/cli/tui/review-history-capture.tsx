/** @jsxImportSource @opentui/solid */
// Standalone live-render capture fixture. Use only synthetic data; see
// docs/review-text-evidence/README.md for the recording procedure.

import { createMemo, For, onCleanup } from "solid-js"
import { render, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
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
import { DialogProvider } from "../../../src/ui/dialog"
import { LocationProvider } from "../../../src/context/location"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { AssistantMessageRow, SessionContext, CaptureUserMessage } from "../../../src/routes/session"
import { computeActivityGroups } from "../../../src/util/activity"
import { waitUntil } from "../../fixture/frame"
import { ReviewReport } from "@opencode-ai/core/review-report"
import FINISH_NUDGE from "../../../../opencode/src/session/prompt/finish-nudge.txt"
import { assistantMessage, userMessage, textPart } from "../../fixture/session-route"

const SESSION = "ses_review_text_runtime"
const BASE = 1_700_000_000_000

type Sync = ReturnType<typeof useSync>
async function mount(options: { entries: { info: Message; parts: Part[] }[] }) {
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
  sync.set("message", SESSION, options.entries.map((entry) => entry.info))
  for (const entry of options.entries) sync.set("part", entry.info.id, entry.parts)
  await Bun.sleep(1800)
  process.exit(0)
}


const which = process.argv[2]
const old = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "Earlier synthetic approval", findings: [] })
const latest = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "needs-fixes", summary: "Later synthetic finding", findings: [] })
const user = userMessage("msg_001", SESSION, { agent: "review" })
const first = assistantMessage("msg_002", SESSION, { agent: "review", mode: "review", parentID: user.id, time: { created: BASE + 1000, completed: BASE + 2000 } })
const nudge = userMessage("msg_003", SESSION, { agent: "review", time: { created: BASE + 5000 } })
const second = assistantMessage("msg_004", SESSION, { agent: "review", mode: "review", parentID: which === "nudge" || which === "separate" ? nudge.id : user.id, time: { created: BASE + 10000, ...(which === "streaming" ? {} : { completed: BASE + 11000 }) } })
const finish = (message: AssistantMessage, result: string): ToolPart => ({ id: `finish_${message.id}`, sessionID: SESSION, messageID: message.id, type: "tool", tool: "finish", callID: `call_${message.id}`, state: { status: "completed", input: { reason: "success", result }, output: result, title: "finish", metadata: {}, time: { start: BASE, end: BASE + 1000 } } })
const entries: { info: Message; parts: Part[] }[] = [
  { info: user, parts: [textPart("request", user, "Synthetic review request")] },
  { info: first, parts: [textPart("first", first, `Earlier analysis.\n${old}`), ...(which === "boundary" ? [finish(first, old)] : [])] },
  ...((which === "nudge" || which === "separate") ? [{ info: nudge, parts: [{ ...textPart("nudge", nudge, which === "nudge" ? FINISH_NUDGE : "A separate synthetic review request"), ...(which === "nudge" ? { synthetic: true } : {}) }] }] : []),
  { info: second, parts: which === "finish" ? [finish(second, `Later analysis.\n${latest}`)] : [textPart("second", second, which === "streaming" ? "Streaming continuation.\n<silvercode-review>{" : which === "malformed" ? "Malformed later report.\n<silvercode-review>{invalid}</silvercode-review>" : `Later analysis.\n${latest}`)] },
]
await mount({ entries })
