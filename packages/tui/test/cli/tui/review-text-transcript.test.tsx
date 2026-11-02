/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { createMemo, For, onCleanup } from "solid-js"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import type { AssistantMessage, Part, Provider, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
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
import { captureSpans, waitUntil } from "../../fixture/frame"
import { ReviewReport } from "@opencode-ai/core/review-report"

const SESSION = "ses_review_text_runtime"
const BASE = 1_700_000_000_000

// Assistant text is rendered by a
// streaming markdown/code block, which is not captured by `captureCharFrame()`
// but IS captured by `captureSpans()` once the frame settles. We join every
// span so partial word-aligned fragments are still detectable.
async function frameOfSpans(app: Awaited<ReturnType<typeof testRender>>) {
  const spans = await captureSpans(app)
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
  while (!(await frameOfSpans(app)).includes(text)) {
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

async function mount(options: { agent: string; completed?: boolean; parts: Part[]; height?: number }) {
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
    { width: 100, height: options.height ?? 24, kittyKeyboard: true },
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
  if (options.parts.some((part) => part.type === "tool" && part.tool === "task")) {
    sync.set("message", "child", [{
      id: "child-message", sessionID: "child", role: "assistant", time: { created: BASE, completed: BASE + 500 },
      parentID: "child-request", modelID: "model", providerID: "test", mode: "review", agent: "review",
      path: { cwd: "/tmp", root: "/tmp" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }])
  }
  sync.set("part", "m1", options.parts)
  await app.renderOnce()
  return setup!
}

function textPart(value: string, id = "prt_text"): TextPart {
  return { id, sessionID: SESSION, messageID: "m1", type: "text", text: value }
}

function completedTool(tool: string, input: Record<string, unknown>, output: string, metadata: Record<string, unknown> = {}): ToolPart {
  return { id: `tool_${tool}`, sessionID: SESSION, messageID: "m1", type: "tool", tool, callID: `call_${tool}`,
    state: { status: "completed", input, output, metadata, title: "Synthetic task", time: { start: BASE, end: BASE + 1000 } } }
}

describe("review assistant text: real transcript fallback", () => {
  test("raw expansion exposes the original long single-message text and earlier envelope", async () => {
    const earlier = ReviewReport.envelope({ version: 1, revision: "old", assessment: "approved", summary: "Earlier original envelope", findings: [] })
    const info = { version: 1 as const, revision: "new", assessment: "needs-fixes" as const, summary: "Latest original envelope", findings: [] }
    const latest = `<silvercode-review>\n${JSON.stringify({ ...info, extension: `${"x".repeat(2600)}-ORIGINAL_RAW_TAIL` })}\n</silvercode-review>`
    const mounted = await mount({ agent: "review", completed: true, height: 80, parts: [textPart(`${earlier}\n${latest}`)] })
    await settleUntilFrame(mounted.app, "Raw review report")
    const frame = await frameOfSpans(mounted.app)
    const row = frame.split("\n").findIndex((line) => line.includes("Raw review report"))
    expect(row).toBeGreaterThanOrEqual(0)
    await mounted.app.mockMouse.click(5, row)
    await settleUntilFrame(mounted.app, "ORIGINAL_RAW_TAIL")
    const expanded = await frameOfSpans(mounted.app)
    expect(expanded).toContain("Earlier original envelope")
    expect(expanded).toContain("ORIGINAL_RAW_TAIL")
  })

  test("raw expansion exposes the complete long foreground task receipt", async () => {
    const info = { version: 1 as const, revision: "synthetic", assessment: "needs-fixes" as const, summary: "Long child verdict", findings: [] }
    const report = `<silvercode-review>\n${JSON.stringify({ ...info, extension: `${"x".repeat(2600)}-FOREGROUND_RAW_TAIL` })}\n</silvercode-review>`
    const output = `<task id="child" state="completed">\n<task_result>\n${report}\n</task_result>\n<termination reason="success"></termination>\n</task>`
    const task = completedTool("task", { description: "Inspect synthetic changes", subagent_type: "review" }, output,
      { sessionId: "child", review: { report: info, sessionId: "child", revision: info.revision }, termination: { reason: "success" } })
    const mounted = await mount({ agent: "work", completed: true, height: 80, parts: [task] })
    await settleUntilFrame(mounted.app, "Raw review report")
    const frame = await frameOfSpans(mounted.app)
    const row = frame.split("\n").findIndex((line) => line.includes("Raw review report"))
    expect(row).toBeGreaterThanOrEqual(0)
    await mounted.app.mockMouse.click(5, row)
    await settleUntilFrame(mounted.app, "FOREGROUND_RAW_TAIL")
    const expanded = await frameOfSpans(mounted.app)
    expect(expanded).toContain('<task id="child" state="completed">')
    expect(expanded).toContain("FOREGROUND_RAW_TAIL")
    expect(expanded).toContain('<termination reason="success"></termination>')
  })

  test("renders a completed multipart review once with its analysis", async () => {
    const report = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "needs-fixes", summary: "Synthetic issue summary", findings: [] })
    const mounted = await mount({ agent: "review", completed: true, parts: [textPart("Synthetic analysis.", "prt_a"), textPart(report, "prt_b")] })
    await settleUntilFrame(mounted.app, "Synthetic issue summary")
    const frame = await frameOfSpans(mounted.app)
    expect(frame).toContain("Synthetic analysis.")
    expect(frame).toContain("Synthetic issue summary")
    expect(frame).toContain("Needs fixes")
    expect(frame).not.toContain("silvercode-review")
    expect(frame.match(/Synthetic issue summary/g)?.length).toBe(1)
  })

  test("switches from ordinary streaming text to a structured completed review", async () => {
    const report = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "Synthetic approval summary", findings: [] })
    const mounted = await mount({ agent: "review", parts: [textPart(`Streaming analysis.\n\n${report}`)] })
    await settleUntilFrame(mounted.app, "Streaming analysis.")
    expect(await frameOfSpans(mounted.app)).not.toContain("✓ Approved")
    mounted.sync.set("message", SESSION, 0, "time", { created: BASE, completed: BASE + 1000 })
    await settleUntilFrame(mounted.app, "✓ Approved")
    const frame = await frameOfSpans(mounted.app)
    expect(frame).toContain("✓ Approved")
    expect(frame).toContain("Synthetic approval summary")
    expect(frame).toContain("Streaming analysis.")
    expect(frame).not.toContain("silvercode-review")
  })

  test("removes earlier duplicate protocol blocks while retaining their analysis", async () => {
    const first = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "Earlier", findings: [] })
    const last = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "needs-fixes", summary: "Final synthetic summary", findings: [] })
    const mounted = await mount({ agent: "review", completed: true, parts: [textPart(`First analysis.\n\n${first}`, "p1"), textPart(`Later analysis.\n\n${last}`, "p2")] })
    await settleUntilFrame(mounted.app, "Final synthetic summary")
    const frame = await frameOfSpans(mounted.app)
    expect(frame).toContain("First analysis.")
    expect(frame).toContain("Later analysis.")
    expect(frame).toContain("Needs fixes")
    expect(frame).not.toContain("silvercode-review")
    expect(frame).not.toContain("✓ Approved")
  })

  test("a same-message finish and text delivery show one report without losing analysis", async () => {
    const report = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "One synthetic verdict", findings: [] })
    const finish = completedTool("finish", { reason: "success", result: `Finish analysis.\n\n${report}` }, `Finish analysis.\n\n${report}`)
    const mounted = await mount({ agent: "review", completed: true, parts: [textPart(`Text analysis.\n\n${report}`), finish] })
    await settleUntilFrame(mounted.app, "One synthetic verdict")
    const frame = await frameOfSpans(mounted.app)
    expect(frame).toContain("Text analysis.")
    expect(frame).toContain("Finish analysis.")
    expect(frame.match(/One synthetic verdict/g)?.length).toBe(1)
    expect(frame.match(/Raw review report/g)?.length).toBe(1)
  })

  test("same-message conflicting text and finish use only the canonical finish verdict", async () => {
    const first = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "Earlier approval", findings: [] })
    const latest = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "needs-fixes", summary: "Latest finding", findings: [] })
    const finish = completedTool("finish", { reason: "success", result: `Finish analysis.\n${latest}` }, `Finish analysis.\n${latest}`)
    const mounted = await mount({ agent: "review", completed: true, parts: [textPart(`Text analysis.\n${first}`), finish] })
    await settleUntilFrame(mounted.app, "Latest finding")
    const frame = await frameOfSpans(mounted.app)
    expect(frame).toContain("Text analysis.")
    expect(frame).toContain("Finish analysis.")
    expect(frame).toContain("✗ Needs fixes")
    expect(frame).not.toContain("✓ Approved")
    expect(frame.match(/Raw review report/g)?.length).toBe(1)
  })

  test("a declined finish cannot turn same-message text into an approval", async () => {
    const report = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "Undelivered report", findings: [] })
    const failed = completedTool("finish", { reason: "failure", result: report }, report)
    const mounted = await mount({ agent: "review", completed: true, parts: [textPart(`Visible analysis.\n\n${report}`), failed] })
    await settleUntilFrame(mounted.app, "Task failed")
    const frame = await frameOfSpans(mounted.app)
    expect(frame).toContain("Visible analysis.")
    expect(frame).toContain("Task failed")
    expect(frame).not.toContain("✓ Approved")
    expect(frame).not.toContain("Raw review report")
  })

  test("a later finish does not repeat an identical prior text review", async () => {
    const report = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "Prior synthetic verdict", findings: [] })
    const mounted = await mount({ agent: "review", completed: true, parts: [textPart(`Prior analysis.\n\n${report}`)] })
    const finish = { ...completedTool("finish", { reason: "success", result: report }, report), messageID: "m2" }
    mounted.sync.set("part", "m2", [finish])
    mounted.sync.set("message", SESSION, (rows) => [...rows, {
      id: "m2", sessionID: SESSION, role: "assistant" as const, time: { created: BASE + 1000, completed: BASE + 2000 },
      parentID: "msg_user", modelID: "model", providerID: "test", mode: "review", agent: "review",
      path: { cwd: "/tmp", root: "/tmp" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }])
    await settleUntilFrame(mounted.app, "Task completed")
    const frame = await frameOfSpans(mounted.app)
    expect(frame.match(/Prior synthetic verdict/g)?.length).toBe(1)
    expect(frame.match(/Raw review report/g)?.length).toBe(1)
    expect(frame).toContain("Prior analysis.")
    expect(frame).toContain("Task completed")
  })

  test("a foreground subagent delivery retains the task row and displays the verified report", async () => {
    const info = { version: 1 as const, revision: "synthetic", assessment: "needs-fixes" as const, summary: "Child synthetic verdict", findings: [] }
    const report = ReviewReport.envelope(info)
    const task = completedTool("task", { description: "Inspect synthetic changes", subagent_type: "review" },
      `<task id="child" state="completed">\n<task_result>\nChild analysis.\n\n${report}\n</task_result>\n<termination reason="success"></termination>\n</task>`,
      { sessionId: "child", review: { report: info, sessionId: "child", revision: info.revision }, termination: { reason: "success" } })
    const mounted = await mount({ agent: "work", completed: true, parts: [task] })
    await settleUntilFrame(mounted.app, "Child synthetic verdict")
    const frame = await frameOfSpans(mounted.app)
    expect(frame).toContain("Inspect synthetic changes")
    expect(frame).toContain("Child synthetic verdict")
    expect(frame).toContain("Child analysis.")
    expect(frame).not.toContain("silvercode-review")
  })

  test("a conflicting task termination stays visible without a review verdict", async () => {
    const info = { version: 1 as const, revision: "synthetic", assessment: "approved" as const, summary: "Untrusted task result", findings: [] }
    const report = ReviewReport.envelope(info)
    const task = completedTool("task", { description: "Inspect synthetic changes", subagent_type: "review" },
      `<task id="child" state="completed">\n<task_result>\n${report}\n</task_result>\n<termination reason="failure">Failed</termination>\n</task>`,
      { sessionId: "child", review: { report: info, sessionId: "child", revision: info.revision }, termination: { reason: "success" } })
    const mounted = await mount({ agent: "work", completed: true, parts: [task] })
    await settleUntilFrame(mounted.app, "Untrusted task result")
    const frame = await frameOfSpans(mounted.app)
    expect(frame).toContain("Inspect synthetic changes")
    expect(frame).toContain("Untrusted task result")
    expect(frame).toContain('reason="failure"')
    expect(frame).not.toContain("✓ Approved")
    expect(frame).not.toContain("Raw review report")
  })

  test("excluded conflicting report remains visible without a structured verdict", async () => {
    const actual = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "Trusted report", findings: [] })
    const excluded = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "needs-fixes", summary: "Ignored conflicting report", findings: [] })
    const ignored = { ...textPart(`Ignored source: \`\`\`xml\n${excluded}\n\`\`\``, "ignored"), ignored: true }
    const mounted = await mount({ agent: "review", completed: true, parts: [textPart(`Trusted analysis.\n\n${actual}`), ignored] })
    await settleUntilFrame(mounted.app, "Ignored conflicting report")
    const frame = await frameOfSpans(mounted.app)
    expect(frame).toContain("Trusted analysis.")
    expect(frame).toContain("Ignored conflicting report")
    expect(frame).not.toContain("✓ Approved")
    expect(frame).not.toContain("Raw review report")
  })

  test("unrelated synthetic prose stays visible beside a structured reviewer report", async () => {
    const actual = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "Trusted report", findings: [] })
    const synthetic = { ...textPart("Unrelated synthetic note.", "synthetic"), synthetic: true }
    const mounted = await mount({ agent: "review", completed: true, parts: [textPart(actual), synthetic] })
    await settleUntilFrame(mounted.app, "Unrelated synthetic note.")
    const frame = await frameOfSpans(mounted.app)
    expect(frame).toContain("Unrelated synthetic note.")
    expect(frame).toContain("✓ Approved")
    expect(frame).toContain("Trusted report")
  })

  test("an incomplete reviewer stream remains visible without a verdict", async () => {
    const mounted = await mount({ agent: "review", parts: [textPart("Streaming analysis remains visible.\n\n<silvercode-review>\n{ incomplete")] })
    const app = mounted.app
    await settleUntilFrame(app, "Streaming analysis remains visible.")
    const frame = await frameOfSpans(app)
    expect(frame).toContain("Streaming analysis remains visible.")
    expect(frame).not.toContain("Approved")
    expect(frame).not.toContain("Needs fixes")
    mounted.sync.set("part", "m1", [textPart("Streaming analysis updated.\n\n<silvercode-review>\n{ incomplete")])
    await settleUntilFrame(app, "Streaming analysis updated.")
    const updated = await frameOfSpans(app)
    expect(updated).toContain("Streaming analysis updated.")
    expect(updated).not.toContain("Approved")
    expect(updated).not.toContain("Needs fixes")
  })

  test("an ordinary completed assistant message remains ordinary text", async () => {
    const app = (await mount({ agent: "work", completed: true, parts: [textPart("Ordinary work response, not a review.")] })).app
    await settleUntilFrame(app, "Ordinary work response, not a review.")
    const frame = await frameOfSpans(app)
    expect(frame).toContain("Ordinary work response, not a review.")
    expect(frame).not.toContain("Approved")
    expect(frame).not.toContain("Needs fixes")
  })

  test("a malformed completed report remains readable and has no verdict", async () => {
    const app = (await mount({ agent: "review", completed: true, parts: [textPart("Malformed review content.\n\n<silvercode-review>\nnot-json\n</silvercode-review>")] })).app
    await settleUntilFrame(app, "not-json")
    const frame = await frameOfSpans(app)
    expect(frame).toContain("Malformed review content.")
    expect(frame).toContain("not-json")
    expect(frame).not.toContain("✓ Approved")
    expect(frame).not.toContain("✗ Needs fixes")
  })

  test("a valid envelope inside a non-review assistant example remains ordinary text", async () => {
    const report = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "Not a review verdict", findings: [] })
    const app = (await mount({ agent: "work", completed: true, parts: [textPart(`An example:\n\n\`\`\`xml\n${report}\n\`\`\``)] })).app
    await settleUntilFrame(app, "Not a review verdict")
    const frame = await frameOfSpans(app)
    expect(frame).toContain("Not a review verdict")
    expect(frame).not.toContain("✓ Approved")
  })

  test("quoted valid protocol examples remain examples for a completed reviewer", async () => {
    const report = ReviewReport.envelope({ version: 1, revision: "synthetic", assessment: "approved", summary: "Example report only", findings: [] })
    const app = (await mount({ agent: "review", completed: true, parts: [textPart(`Example protocol:\n\n\`\`\`xml\n${report}\n\`\`\``)] })).app
    await settleUntilFrame(app, "Example report only")
    const frame = await frameOfSpans(app)
    expect(frame).toContain("Example report only")
    expect(frame).not.toContain("✓ Approved")
  })

})
