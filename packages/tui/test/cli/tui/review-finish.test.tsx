/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { createMemo, createSignal, onCleanup } from "solid-js"
import { Dynamic } from "solid-js/web"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
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
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { computeActivityGroups, type ActivityGroups } from "../../../src/util/activity"
import { SessionContext, parseReviewReport, reviewFindingLocation, sortReviewFindings, toolRenderer } from "../../../src/routes/session"
import { ReviewReport } from "@opencode-ai/core/review-report"
import type { Provider, ToolPart } from "@opencode-ai/sdk/v2"
import { captureFrame, waitUntil } from "../../fixture/frame"

const SESSION = "ses_review_finish"
const BASE = 1_700_000_000_000
const at = (offset: number) => BASE + offset * 1000

let partSeq = 0
const nextPartID = () => `prt_review_${partSeq++}`

function envelope(report: Record<string, unknown>): string {
  return `<silvercode-review>\n${JSON.stringify(report, null, 2)}\n</silvercode-review>`
}

const ANALYSIS = "## Review\n\nI checked the diff against the brief.\n\n### Assessment\n\nAssessment: Needs fixes\n\nReasoning: Two issues need attention before merge.\n"

function reviewResult(overrides: { assessment?: "approved" | "needs-fixes"; revision?: string; summary?: string } = {}) {
  const report = {
    version: 1,
    revision: "uncommitted",
    assessment: "needs-fixes",
    summary: "Two issues need attention before merge.",
    findings: [
      {
        severity: "minor",
        title: "Unused variable",
        file: "src/util.ts",
        line: 10,
        detail: "Remove the variable and its import.",
      },
      { severity: "critical", title: "SQL injection risk", file: "src/db.ts", line: 42, detail: "Use parameterized queries." },
      { severity: "important", title: "Race condition", detail: "Guard the counter with a lock." },
    ],
    ...overrides,
  }
  return `${ANALYSIS}\n${envelope(report)}`
}

function finishPart(
  state:
    | { status: "completed"; result: string }
    | { status: "running"; result: string }
    | { status: "error"; result: string; error: string },
): ToolPart {
  return {
    id: nextPartID(),
    sessionID: SESSION,
    messageID: "m1",
    type: "tool",
    callID: "call",
    tool: "finish",
    state:
      state.status === "completed"
        ? ({
            status: "completed",
            input: { reason: "success", result: state.result },
            output: state.result,
            title: "Task completed",
            metadata: {},
            time: { start: at(1), end: at(2) },
          } as ToolPart["state"])
        : state.status === "running"
          ? ({
              status: "running",
              input: { reason: "success", result: state.result },
              time: { start: at(1) },
            } as ToolPart["state"])
          : ({
              status: "error",
              input: { reason: "success", result: state.result },
              error: state.error,
              metadata: {},
              time: { start: at(1), end: at(2) },
            } as ToolPart["state"]),
  }
}

// ---------------------------------------------------------------------------
// Pure parsing helpers
// ---------------------------------------------------------------------------

describe("review finish parsing", () => {
  test("extracts the structured report and preserves the analysis", () => {
    const parsed = parseReviewReport(reviewResult())
    expect(parsed).toBeDefined()
    expect(parsed?.report.assessment).toBe("needs-fixes")
    expect(parsed?.report.summary).toBe("Two issues need attention before merge.")
    expect(parsed?.report.findings).toHaveLength(3)
    expect(parsed?.analysis).toContain("## Review")
    expect(parsed?.analysis).not.toContain("silvercode-review")
  })

  test("leaves plain finish results untouched", () => {
    expect(parseReviewReport(undefined)).toBeUndefined()
    expect(parseReviewReport("")).toBeUndefined()
    expect(parseReviewReport("Implemented the feature and verified tests.")).toBeUndefined()
  })

  test("rejects truncated, malformed, and unsupported envelopes", () => {
    expect(parseReviewReport("analysis\n<silvercode-review>\n{ truncated")).toBeUndefined()
    expect(
      parseReviewReport(envelope({ version: 2, revision: "uncommitted", assessment: "approved", summary: "s", findings: [] })),
    ).toBeUndefined()
    expect(
      parseReviewReport(envelope({ version: 1, revision: "uncommitted", assessment: "maybe", summary: "s", findings: [] })),
    ).toBeUndefined()
    expect(parseReviewReport("not json at all\n<silvercode-review>\nnot json\n</silvercode-review>")).toBeUndefined()
  })

  test("the last complete envelope wins", () => {
    const first = envelope({ version: 1, revision: "uncommitted", assessment: "approved", summary: "first", findings: [] })
    const second = envelope({ version: 1, revision: "uncommitted", assessment: "needs-fixes", summary: "second", findings: [] })
    const parsed = parseReviewReport(`${ANALYSIS}\n${first}\n${second}`)
    expect(parsed?.report.summary).toBe("second")
  })

  test("orders findings by severity, stably", () => {
    // c2 precedes c1 in the input, so the stable sort keeps c2 first.
    const findings = [
      { severity: "minor" as const, title: "m1" },
      { severity: "critical" as const, title: "c2" },
      { severity: "important" as const, title: "i3" },
      { severity: "critical" as const, title: "c1" },
    ]
    expect(sortReviewFindings(findings).map((finding) => finding.title)).toEqual(["c2", "c1", "i3", "m1"])
  })

  test("formats finding locations", () => {
    expect(reviewFindingLocation({ severity: "minor", title: "t", file: "src/a.ts", line: 42 })).toBe("src/a.ts:42")
    expect(reviewFindingLocation({ severity: "minor", title: "t", file: "src/a.ts" })).toBe("src/a.ts")
    // A line without a file would render as a bare ":7", so it is dropped.
    expect(reviewFindingLocation({ severity: "minor", title: "t", line: 7 })).toBeUndefined()
    expect(reviewFindingLocation({ severity: "minor", title: "t" })).toBeUndefined()
    expect(reviewFindingLocation({ severity: "minor", title: "t", file: "  " })).toBeUndefined()
    expect(reviewFindingLocation({ severity: "minor", title: "t", file: "src/a.ts", line: 0 })).toBe("src/a.ts")
  })
})

// ---------------------------------------------------------------------------
// Rendered frames
// ---------------------------------------------------------------------------

let testSetup: { app: Awaited<ReturnType<typeof testRender>>; dispose: () => Promise<void> } | undefined
type Sync = ReturnType<typeof useSync>

afterEach(async () => {
  await testSetup?.dispose()
  testSetup = undefined
})

async function frameOf(app: Awaited<ReturnType<typeof testRender>>) {
  return (await captureFrame(app)).split("\n").map((line) => line.trimEnd()).join("\n")
}

function rowOf(frame: string, needle: string): number {
  const row = frame.split("\n").findIndex((line) => line.includes(needle))
  if (row === -1) throw new Error(`needle "${needle}" not found in frame:\n${frame}`)
  return row
}

function FinishPart(props: { part: ToolPart }) {
  const renderer = toolRenderer("finish")
  return (
    <Dynamic
      component={renderer}
      input={(props.part.state.input ?? {}) as Record<string, unknown>}
      metadata={props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})}
      tool={props.part.tool}
      output={props.part.state.status === "completed" ? props.part.state.output : undefined}
      part={props.part}
    />
  )
}

async function mountSession(part: ToolPart, options: { width?: number; height?: number } = {}) {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const events = createEventSource()
  const calls = createFetch(undefined, events)

  let sync!: Sync
  // Drives the rendered part so a test can push an updated part (same id,
  // new state) through the same reactive prop path the transcript uses.
  const [currentPart, setPart] = createSignal(part)

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const tui = useTuiConfig()
    const off = registerOpencodeKeymap(keymap, renderer, tui)
    onCleanup(off)

    const storeSync = useSync()
    sync = storeSync
    const activity = createMemo<ActivityGroups>(() => computeActivityGroups([]))
    const ctxValue = {
      get width() {
        return options.width ?? 72
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
            {/* Tool output renders inside the transcript scrollbox in the
                session route. Mirror that scrollable container here so overflow
                is clipped by the scrollbox instead of corrupting the frame;
                plain height/width (no sticky props) keeps the mouse grid in
                sync with the captured frame, matching activity-group tests. */}
            <scrollbox height={options.height ?? 40} width={options.width ?? 72}>
              <FinishPart part={currentPart()} />
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
    { width: options.width ?? 72, height: options.height ?? 40 },
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
  return { app, setPart }
}

describe("review finish rendering", () => {
  test("renders a completed review finish as a structured report, not raw JSON", async () => {
    const { app } = await mountSession(finishPart({ status: "completed", result: reviewResult() }), { height: 30 })
    await app.waitForFrame((frame: string) => frame.includes("Needs fixes"))
    const frame = await frameOf(app)
    // Structured verdict, summary, and per-finding rows...
    expect(frame).toContain("Needs fixes")
    expect(frame).toContain("3 findings")
    expect(frame).toContain("Two issues need attention before merge.")
    expect(frame).toContain("SQL injection risk")
    expect(frame).toContain("src/db.ts:42")
    expect(frame).toContain("Race condition")
    expect(frame).toContain("Unused variable")
    expect(frame).toContain("src/util.ts:10")
    expect(frame).toContain("Raw review report")
    // ...instead of the raw envelope dump.
    expect(frame).not.toContain("silvercode-review")
    expect(frame).not.toContain('"assessment"')
    expect(frame).not.toContain("Task completed")
    // The block above can only appear if Finish's <Show> callback child
    // ({(item) => <ReviewFinish .../>}) is actually invoked with the report
    // accessor; a function rendered as text would show up here instead.
    expect(frame).not.toContain("[object Function]")
  })

  test("orders findings critical first and keeps the approved verdict", async () => {
    const { app } = await mountSession(
      finishPart({ status: "completed", result: reviewResult({ assessment: "approved" }) }),
      { height: 30 },
    )
    await app.waitForFrame((frame: string) => frame.includes("Approved"))
    const frame = await frameOf(app)
    expect(frame).toContain("Approved")
    const critical = rowOf(frame, "SQL injection risk")
    const important = rowOf(frame, "Race condition")
    const minor = rowOf(frame, "Unused variable")
    expect(critical).toBeLessThan(important)
    expect(important).toBeLessThan(minor)
    // No raw JSON in the default view.
    expect(frame).not.toContain("silvercode-review")
  })

  test("keeps finding details collapsed until the block is expanded", async () => {
    const { app } = await mountSession(finishPart({ status: "completed", result: reviewResult() }), { height: 36 })
    await app.waitForFrame((frame: string) => frame.includes("Click to expand"))
    const collapsed = await frameOf(app)
    expect(collapsed).toContain("Click to expand")
    // Details stay hidden while collapsed...
    expect(collapsed).not.toContain("Use parameterized queries.")
    expect(collapsed).not.toContain("Guard the counter")

    await app.mockMouse.click(5, rowOf(collapsed, "Click to expand"))
    await app.waitForFrame((frame: string) => frame.includes("Click to collapse"))
    const expanded = await frameOf(app)
    expect(expanded).toContain("Use parameterized queries.")
    expect(expanded).toContain("Guard the counter")
    expect(expanded).toContain("Remove the variable")
  })

  test("shows the exact report envelope on demand and hides it again", async () => {
    // Tall enough viewport that the full report (block + envelope) stays
    // visible without scrolling.
    const { app } = await mountSession(finishPart({ status: "completed", result: reviewResult() }), { height: 56 })
    await app.waitForFrame((frame: string) => frame.includes("Raw review report"))
    expect(await frameOf(app)).not.toContain(ReviewReport.TAG)

    await app.mockMouse.click(5, rowOf(await frameOf(app), "Raw review report"))
    await app.waitForFrame((frame: string) => frame.includes(ReviewReport.TAG))
    const frame = await frameOf(app)
    expect(frame).toContain(`<${ReviewReport.TAG}>`)
    expect(frame).toContain('"assessment": "needs-fixes"')

    // 0.6 counts a second click inside the double-click window as a text selection,
    // and these blocks ignore clicks that end one, so give the toggle some space.
    await Bun.sleep(600)
    await app.mockMouse.click(5, rowOf(frame, "Click to hide the raw report"))
    await app.waitForFrame((frame: string) => !frame.includes(ReviewReport.TAG))
    expect(await frameOf(app)).toContain("Raw review report")
  })

  test("re-renders with the updated report when the finished part changes", async () => {
    // The same part id is updated in place with a different (approved) report.
    // The block must reflect the new verdict and summary, not the stale first
    // report, even though the unkeyed <Show> keeps the same component mounted.
    const initial = finishPart({ status: "completed", result: reviewResult() })
    const { app, setPart } = await mountSession(initial, { height: 30 })
    await app.waitForFrame((frame: string) => frame.includes("Needs fixes"))
    expect(await frameOf(app)).toContain("Two issues need attention before merge.")

    const nextResult = reviewResult({ assessment: "approved", summary: "All checks passed." })
    setPart({
      ...initial,
      state: {
        status: "completed",
        input: { reason: "success", result: nextResult },
        output: nextResult,
        title: "Task completed",
        metadata: {},
        time: { start: at(3), end: at(4) },
      } as ToolPart["state"],
    })

    await app.waitForFrame((frame: string) => frame.includes("Approved") && frame.includes("All checks passed."))
    const frame = await frameOf(app)
    expect(frame).toContain("Approved")
    expect(frame).toContain("All checks passed.")
    expect(frame).not.toContain("Needs fixes")
    expect(frame).not.toContain("Two issues need attention before merge.")
  })

  test("keeps plain finish results on the existing inline path", async () => {
    const { app } = await mountSession(
      finishPart({ status: "completed", result: "Implemented the feature and verified tests." }),
      { height: 10 },
    )
    await app.waitForFrame((frame: string) => frame.includes("Task completed"))
    const frame = await frameOf(app)
    expect(frame).toContain("Task completed")
    expect(frame).toContain("Implemented the feature and verified tests.")
    expect(frame).not.toContain("Raw review report")
  })

  test("does not pre-announce the verdict while the finish is still running", async () => {
    const { app } = await mountSession(finishPart({ status: "running", result: reviewResult() }), { height: 10 })
    await app.waitForFrame((frame: string) => frame.includes("Completing task"))
    const frame = await frameOf(app)
    expect(frame).toContain("Completing task")
    expect(frame).not.toContain("Needs fixes")
    expect(frame).not.toContain("Approved")
    expect(frame).not.toContain("Raw review report")
  })

  test("keeps the failure presentation for a declined review finish", async () => {
    const { app } = await mountSession(
      finishPart({
        status: "error",
        result: reviewResult(),
        error: "Review finish rejected: the report does not match the version 1 review report schema.",
      }),
      { height: 10 },
    )
    await app.waitForFrame((frame: string) => frame.includes("Finish call failed"))
    const frame = await frameOf(app)
    expect(frame).toContain("Finish call failed")
    expect(frame).not.toContain("Raw review report")
    expect(frame).not.toContain("Needs fixes")
  })
})
