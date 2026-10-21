/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { testRender } from "@opentui/solid"
import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../fixture/fixture"
import { captureFrame } from "../../fixture/frame"
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
import { TuiConfigProvider } from "../../../src/config"
import { ToastProvider } from "../../../src/ui/toast"
import { DialogProvider } from "../../../src/ui/dialog"
import { Footer } from "../../../src/routes/session/footer"

// The two terminations #233 added. Both are non-approvals, so the footer has to
// name them distinctly and in the warning colour: `review-blocked` means review
// could not run and only an honest failure ended the turn, `review-pending`
// means a depth-limited child handed unreviewed writes up to this session.
const CASES = [
  {
    termination: "review-blocked" as const,
    label: "blocked",
    unavailable: "permission-denied" as const,
  },
  {
    termination: "review-pending" as const,
    label: "unreviewed",
    unavailable: "subagent-depth" as const,
  },
]

const SESSION = "ses_footer_review"
const WIDTHS = [100, 60] as const

let testSetup: { app: Awaited<ReturnType<typeof testRender>>; dispose: () => Promise<void> } | undefined
type Sync = ReturnType<typeof useSync>

afterEach(async () => {
  await testSetup?.dispose()
  testSetup = undefined
})

function userMessage(): Message {
  return {
    id: "msg_user",
    sessionID: SESSION,
    role: "user" as const,
    time: { created: 1_700_000_000_000 },
    model: { providerID: "test", modelID: "model" },
    modelID: "model",
    providerID: "test",
    path: { cwd: "/tmp", root: "/tmp" },
  } as unknown as Message
}

function assistantMessage(): Message {
  return {
    id: "msg_assistant",
    sessionID: SESSION,
    role: "assistant" as const,
    parentID: "msg_user",
    time: { created: 1_700_000_001_000, completed: 1_700_000_002_000 },
    modelID: "model",
    providerID: "test",
    mode: "work",
    agent: "work",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "tool-calls",
  } as unknown as Message
}

// The turn the footer is reading: file-writing work, then a finish that
// recorded one of the new terminations. `reviews` stays 0 because neither
// outcome is a delivered review - which is exactly what the footer must show.
function seedParts(termination: string, unavailable: string): Part[] {
  const start = 1_700_000_001_000
  const end = 1_700_000_002_000
  const edit: ToolPart = {
    id: "prt_edit",
    sessionID: SESSION,
    messageID: "msg_assistant",
    type: "tool",
    callID: "call_edit",
    tool: "edit",
    state: {
      status: "completed",
      input: { filePath: "src/scene.ts" },
      output: "",
      title: "",
      metadata: { reviewLoop: { writesFiles: true } },
      time: { start, end },
    },
  } as ToolPart
  const finish: ToolPart = {
    id: "prt_finish",
    sessionID: SESSION,
    messageID: "msg_assistant",
    type: "tool",
    callID: "call_finish",
    tool: "finish",
    state: {
      status: "completed",
      input: { reason: termination === "review-pending" ? "success" : "failure", result: "recorded" },
      output: "",
      title: "",
      metadata: {
        review: {
          verdict: "pending",
          reviews: 0,
          maxIterations: 5,
          termination,
          unavailable,
        },
      },
      time: { start, end },
    },
  } as ToolPart
  return [edit, finish]
}

async function mountFooter(width: number) {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const events = createEventSource()
  const calls = createFetch(undefined, events)

  let sync!: Sync

  function Harness() {
    sync = useSync()
    return <Footer />
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
    { width, height: 3, kittyKeyboard: true },
  )

  testSetup = {
    app,
    dispose: async () => {
      await tmp[Symbol.asyncDispose]()
    },
  }
  const start = Date.now()
  while (sync === undefined) {
    if (Date.now() - start > 10_000) throw new Error("timed out waiting for the sync handle")
    await Bun.sleep(10)
  }
  await app.renderOnce()
  return { app, sync }
}

function reviewSegment(frame: string) {
  const line = frame.split("\n").find((row) => row.includes("Review "))
  if (!line) throw new Error(`no review segment in frame:\n${frame}`)
  return line.trim()
}

describe("session footer review status", () => {
  for (const width of WIDTHS) {
    for (const testCase of CASES) {
      test(`renders ${testCase.termination} as "${testCase.label}" at ${width} columns`, async () => {
        const { app, sync } = await mountFooter(width)
        sync.set("message", SESSION, [userMessage(), assistantMessage()])
        sync.set("part", "msg_assistant", seedParts(testCase.termination, testCase.unavailable))
        await app.renderOnce()
        await app.renderOnce()

        const frame = await captureFrame(app)
        const segment = reviewSegment(frame)

        // The whole rendered line, not a substring: at 60 columns the footer
        // has to keep this segment intact rather than truncating the verdict.
        expect(segment).toContain(`Review 0/5 · ${testCase.label}`)
        expect(segment).not.toContain("approved")
        expect(segment).not.toContain("unavailable")
        expect(segment).not.toContain("skipped")
        // Neither new outcome may render as the raw termination string.
        expect(segment).not.toContain("review-blocked")
        expect(segment).not.toContain("review-pending")
      })
    }
  }
})
