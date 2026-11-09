/** @jsxImportSource @opentui/solid */
// Standalone live-render capture fixture. Use only synthetic data; see
// docs/review-text-evidence/README.md for the recording procedure.

import { createMemo, For, onCleanup } from "solid-js"
import { render, useRenderer } from "@opentui/solid"
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
import { DialogProvider } from "../../../src/ui/dialog"
import { LocationProvider } from "../../../src/context/location"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { AssistantMessageRow, SessionContext } from "../../../src/routes/session"
import { computeActivityGroups } from "../../../src/util/activity"
import { waitUntil } from "../../fixture/frame"
import { ReviewReport } from "@opencode-ai/core/review-report"

const SESSION = "ses_review_text_runtime"
const BASE = 1_700_000_000_000

type Sync = ReturnType<typeof useSync>
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
        <DialogProvider>
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
  await Bun.sleep(1800)
  process.exit(0)
}


const which = process.argv[2]
const info = { version: 1 as const, revision: "synthetic", assessment: "needs-fixes" as const, summary: "Synthetic issue summary", findings: [{ severity: "important" as const, title: "Synthetic finding", file: "src/example.ts", line: 12 }] }
const env = ReviewReport.envelope(info)
const text = (value: string, id: string): TextPart => ({ id, sessionID: SESSION, messageID: "m1", type: "text", text: value })
const opts = which === "streaming"
 ? { agent: "review", parts: [text("Streaming analysis remains visible.\n\n<silvercode-review>\n{ incomplete", "p1")] }
 : which === "ordinary"
 ? { agent: "work", completed: true, parts: [text("Ordinary work response, not a review.", "p1")] }
 : which === "multipart"
 ? { agent: "review", completed: true, parts: [text("Synthetic analysis across text parts.", "p1"), text(env, "p2")] }
 : { agent: "review", completed: true, parts: [text(`Synthetic review analysis.\n\n${env}`, "p1")] }
await mount(opts)
