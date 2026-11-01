/** @jsxImportSource @opentui/solid */
import { describe, expect, spyOn, test } from "bun:test"
import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount, type JSX } from "solid-js"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { captureFrame, captureSpans, waitFor, waitUntil } from "../../fixture/frame"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { TuiConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { DataProvider } from "../../../src/context/data"
import { DialogAgentEffort } from "../../../src/component/dialog-agent-effort"
import { DialogSelect } from "../../../src/ui/dialog-select"
import { Prompt } from "../../../src/component/prompt"
import { EditorContextProvider } from "../../../src/context/editor"
import { EpilogueProvider } from "../../../src/context/epilogue"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { LocalProvider, parseModel, useLocal } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { PromptRefProvider } from "../../../src/context/prompt"
import { RouteProvider, useRoute, type Route } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { Toast, ToastProvider } from "../../../src/ui/toast"
import { effortBadge, effortColor, METADATA_KEY } from "../../../src/util/agent-effort"

type Setup = Awaited<ReturnType<typeof testRender>>

const SESSION_THOROUGH = "ses_effort_thorough"
const SESSION_FAST = "ses_effort_fast"
const SESSION_PLAIN = "ses_effort_plain"

function sessionRow(id: string, metadata?: Record<string, unknown>) {
  return {
    id,
    slug: id,
    title: `Session ${id}`,
    projectID: "proj_test",
    version: "0.0.0-test",
    directory,
    time: { created: 0, updated: 0 },
    metadata,
  }
}

function agentsPayload(agentVariant?: string, model?: { providerID: string; modelID: string }) {
  return [
    {
      name: "build",
      mode: "primary",
      description: "Build agent",
      permission: {},
      options: {},
      // A configured agent variant only applies when the agent's configured
      // model is the active model, so the fixture pairs the variant with the
      // model the harness actually selects.
      ...(agentVariant && model ? { variant: agentVariant, model } : {}),
    },
  ]
}

function fullModel(id: string, name: string, variants?: Record<string, unknown>) {
  return {
    id,
    providerID: "test-provider",
    name,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
    limit: { context: 100_000, output: 8_192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    ...(variants ? { variants } : {}),
  }
}

function providersPayload() {
  return {
    providers: [
      {
        id: "test-provider",
        name: "TestProvider",
        source: "config",
        env: [],
        options: {},
        models: {
          "variant-model": fullModel("variant-model", "VariantModel", {
            low: { reasoning_effort: "low" },
            medium: { reasoning_effort: "medium" },
            high: { reasoning_effort: "high" },
          }),
          "plain-model": fullModel("plain-model", "PlainModel"),
        },
      },
    ],
    default: { "test-provider": "variant-model" },
  }
}

type Harness = {
  app: Setup
  local: ReturnType<typeof useLocal>
  route: ReturnType<typeof useRoute>
  sync: ReturnType<typeof useSync>
  dialog: ReturnType<typeof useDialog>
  updates: { sessionID: string; body: Record<string, unknown> }[]
  // Bodies of the session.create calls a home submit issued.
  creates: Record<string, unknown>[]
  sessions: ReturnType<typeof sessionRow>[]
  // Gated mode only: answer PATCH number `index` (and emit its session.updated event), or fail it.
  release: (index: number, outcome?: "ok" | "fail") => void
  dispose: () => Promise<void>
}

async function mountEffort(input: {
  route: Route
  model: string
  children: () => JSX.Element
  agentVariant?: string
  configEffort?: "fast" | null
  // Hold every session.update PATCH until the test releases it.
  gated?: boolean
  // Reuse a state directory (restart coverage); a fresh tmpdir is created otherwise.
  state?: string
  width?: number
  height?: number
}): Promise<Harness> {

  const tmp = await tmpdir()
  const state = input.state ?? tmp.path
  await Bun.write(`${state}/kv.json`, "{}")

  const events = createEventSource()
  const agentModel = parseModel(input.model)
  const sessions = [
    sessionRow(SESSION_THOROUGH, { agentEffort: "thorough", task: "keep-me" }),
    sessionRow(SESSION_FAST, { agentEffort: "fast", task: "keep-me" }),
    sessionRow(SESSION_PLAIN),
  ]
  const updates: { sessionID: string; body: Record<string, unknown> }[] = []
  const creates: Record<string, unknown>[] = []
  const gates: Array<(outcome: "ok" | "fail") => void> = []

  const calls = createFetch((url) => {
    if (url.pathname === "/config") return json(input.configEffort === null ? {} : { agent: { effort: "fast" } })
    if (url.pathname === "/config/providers") return json(providersPayload())
    if (url.pathname === "/agent") return json(agentsPayload(input.agentVariant, agentModel))
    if (url.pathname === "/api/agent") {
      return json({
        location: { directory, project: { id: "proj_test", directory } },
        data: agentsPayload(input.agentVariant, agentModel),
      })
    }
    if (url.pathname === "/session") return json(sessions)
    if (url.pathname.startsWith("/session/")) {
      const parts = url.pathname.split("/")
      const sessionID = parts[2]
      const suffix = parts[3]
      const row = sessions.find((item) => item.id === sessionID)
      if (suffix === "message" || suffix === "todo" || suffix === "diff") return json([])
      if (row) return json(row)
      return json({ id: sessionID })
    }
    return undefined
  }, events)

  // session.update is a PATCH whose body the URL-only fetch fixture cannot
  // see, so wrap it to capture and answer the metadata writes under test.
  const fetch = (async (raw: RequestInfo | URL, init?: RequestInit) => {
    const request = raw instanceof Request ? raw : new Request(raw, init)
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/session") {
      const body = (await request.clone().json()) as Record<string, unknown>
      creates.push(body)
      const row = sessionRow(`ses_created_${creates.length}`, body.metadata as Record<string, unknown> | undefined)
      sessions.push(row)
      return json(row)
    }
    if (request.method === "PATCH" && url.pathname.startsWith("/session/")) {
      const sessionID = url.pathname.slice("/session/".length)
      const body = (await request.clone().json()) as Record<string, unknown>
      updates.push({ sessionID, body })
      const row = sessions.find((item) => item.id === sessionID)
      if (input.gated) {
        const outcome = await new Promise<"ok" | "fail">((resolve) => gates.push(resolve))
        if (outcome === "fail") return new Response("boom", { status: 500 })
        events.emit({
          directory,
          payload: { type: "session.updated", properties: { info: { ...row, metadata: body.metadata } } },
        } as any)
      }
      return json(row ? { ...row, metadata: body.metadata ?? row.metadata } : { id: sessionID })
    }
    return calls.fetch(request)
  }) as typeof globalThis.fetch

  const config = createTuiResolvedConfig({})
  let captured: Pick<Harness, "local" | "route" | "sync" | "dialog"> | undefined
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Capture() {
    const local = useLocal()
    const route = useRoute()
    const sync = useSync()
    const dialog = useDialog()
    onMount(() => {
      captured = { local, route, sync, dialog }
      done()
    })
    return null
  }

  function Harness(props: { children: () => JSX.Element }) {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <ClipboardProvider>
        <OpencodeKeymapProvider keymap={keymap}>
          <ToastProvider>
            <RouteProvider initialRoute={input.route}>
              <TuiConfigProvider config={config}>
                <PluginRuntimeProvider value={createPluginRuntime()}>
                  <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
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
                                            <Capture />
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <PromptRefProvider>{props.children()}</PromptRefProvider>
                                              </PromptHistoryProvider>
                                            </FrecencyProvider>
                                          </DialogProvider>
                                        </PromptStashProvider>
                                      </LocalProvider>
                                      {/* Production mounts the toast surface on
                                          the home and session routes; the
                                          harness renders it directly so no-op
                                          toasts stay visible. */}
                                      <Toast />
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
      <TestTuiContexts directory={directory} paths={{ home: "/tmp", state, worktree: directory }}>
        <ArgsProvider model={input.model}>
          <KVProvider>
            <Harness>{input.children}</Harness>
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ),
    { width: input.width ?? 120, height: input.height ?? 40, kittyKeyboard: true },
  )

  await ready
  await waitUntil(() => captured!.sync.status === "complete")

  return {
    app,
    local: captured!.local,
    route: captured!.route,
    sync: captured!.sync,
    dialog: captured!.dialog,
    updates,
    creates,
    sessions,
    release(index, outcome = "ok") {
      gates[index](outcome)
    },
    async dispose() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

async function frameWhere(app: Setup, predicate: (frame: string) => boolean, label: string) {
  return waitFor(
    app,
    () => {
      const frame = app.captureCharFrame()
      return predicate(frame) ? frame : undefined
    },
    // 200 passes ran dry in ~3.5s on the loaded windows runner before the
    // failure toast painted; 600 keeps the same pump shape with headroom
    // (#485).
    600,
    `timed out waiting for frame: ${label}`,
  )
}

function lineOf(frame: string, needle: string) {
  return frame.split("\n").find((line) => line.includes(needle)) ?? ""
}

function markerLine(frame: string) {
  return frame.split("\n").find((line) => line.includes("●")) ?? ""
}

function hexOf(color: { r: number; g: number; b: number }) {
  const part = (value: number) => Math.round(value * 255).toString(16).padStart(2, "0")
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`
}

/** The filled ` Level ` chip a selector row paints, with its ink. */
async function chipHex(app: Setup, level: string) {
  const spans = await captureSpans(app)
  for (const line of spans.lines) {
    const chip = line.spans.find((span) => span.text === ` ${level} `)
    if (chip) return { fg: hexOf(chip.fg), bg: hexOf(chip.bg) }
  }
  throw new Error(`no ${level} chip in the captured frame`)
}

/** Waits for a persisted JSON file to appear, then returns it. */
async function fileJson(file: string, level?: string): Promise<unknown> {
  for (let pass = 0; pass < 1500; pass++) {
    const value = await Bun.file(file)
      .json()
      .catch(() => undefined)
    if (value !== undefined && (!level || (value as { agentEffort?: string } | null)?.agentEffort === level)) return value
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${file}`)
}


/** The lines one option paints: its title row plus any wrapped description rows. */
function optionBlock(frame: string, level: string) {
  const lines = frame.split("\n")
  const start = lines.findIndex((line) => line.includes(level))
  if (start < 0) throw new Error(`no ${level} row in the captured frame`)
  const block = [lines[start]]
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) break
    block.push(line)
  }
  return block
}

/** A frame read as one whitespace-normalized string, so a wrapped sentence matches. */
function flatText(frame: string) {
  return frame
    .split("\n")
    .map((line) => line.trim())
    .join(" ")
    .replace(/\s+/g, " ")
}

/** The painted panel's rows: its background fill bounds what the dialog occupies. */
async function panelGeometry(app: Setup, title: string) {
  const spans = await captureSpans(app)
  const titleRow = spans.lines.findIndex((line) => line.spans.some((span) => span.text.includes(title)))
  if (titleRow < 0) throw new Error(`no ${title} title row in the captured frame`)
  const widest = (line: (typeof spans.lines)[number]) =>
    line.spans.reduce((acc, span) => (span.width > acc.width ? span : acc), line.spans[0])
  const panel = hexOf(widest(spans.lines[titleRow]).bg)
  const rows = spans.lines.flatMap((line, index) =>
    line.spans.some((span) => hexOf(span.bg) === panel && span.width > 10) ? [index] : [],
  )
  if (rows.length === 0) throw new Error("no painted panel rows in the captured frame")
  return { top: rows[0], bottom: rows[rows.length - 1], height: rows[rows.length - 1] - rows[0] + 1 }
}

/**
 * The panel geometry once it stops moving. A wrapping row can only be measured
 * after it has laid out, so the first frame or two resize the panel; assertions
 * read it only after three reads agree.
 */
async function settledPanel(app: Setup, title: string) {
  let signature = ""
  let same = 0
  for (let attempt = 0; attempt < 120; attempt++) {
    const geometry = await panelGeometry(app, title)
    const next = `${geometry.top}:${geometry.bottom}`
    same = next === signature ? same + 1 : 0
    signature = next
    // Three agreeing reads: one late resize alone must not be read as settled.
    if (same >= 3) return geometry
    await Bun.sleep(25)
  }
  throw new Error("panel geometry never settled")
}

/** The last row above the footer that still paints text. */
function lastPaintedAbove(frame: string, footerRow: number) {
  const lines = frame.split("\n")
  return lines.slice(0, footerRow).reduce((last, line, index) => (line.trim() ? index : last), -1)
}

/** The background of the widest span on a row, i.e. the fill the row paints. */
async function rowFills(app: Setup) {
  const spans = await captureSpans(app)
  return spans.lines.map((line) => {
    const widest = line.spans.reduce((acc, span) => (span.width > acc.width ? span : acc), line.spans[0])
    return widest ? hexOf(widest.bg) : undefined
  })
}

describe("agent effort selector", () => {
  test("renders three levels with purpose-led copy and the session's selection", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_THOROUGH },
      model: "test-provider/variant-model",
      children: () => <DialogAgentEffort />,
    })
    try {
      expect(harness.local.effort.current()).toBe("thorough")
      const frame = await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      expect(frame).toContain("Fast")
      expect(frame).toContain("Medium")
      expect(frame).toContain("Thorough")
      expect(frame).toContain("Reliable workhorse for everyday tasks")
      expect(frame).toContain("Smarter agent for more demanding work")
      expect(frame).toContain("Deep, meticulous work on complex tasks from start to finish")
      expect(frame).toContain("Stored on this session")
      const lines = frame.split("\n")
      const searchRow = lines.findIndex((line) => line.includes("Search"))
      const footerRow = lines.findIndex((line) => line.includes("Stored on this session"))
      expect(searchRow).toBeGreaterThanOrEqual(0)
      expect(footerRow).toBeGreaterThan(searchRow)
      const selectorRows = lines.slice(searchRow + 1, footerRow).filter((line) => line.trim().length > 0)
      expect(selectorRows).toHaveLength(3)
      expect(markerLine(frame)).toContain("Thorough")
    } finally {
      await harness.dispose()
    }
  })

  test("persists a selection on the active session and preserves unrelated metadata", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_FAST },
      model: "test-provider/variant-model",
      children: () => <DialogAgentEffort />,
    })
    try {
      await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      expect(harness.local.effort.current()).toBe("fast")
      harness.app.mockInput.pressArrow("down")
      harness.app.mockInput.pressEnter()
      await waitUntil(() => harness.updates.length >= 1)
      const [update] = harness.updates
      expect(update.sessionID).toBe(SESSION_FAST)
      expect(update.body.metadata).toEqual({ agentEffort: "medium", task: "keep-me" })
      // the pending write is visible immediately, before any sync event lands
      expect(harness.local.effort.current()).toBe("medium")
    } finally {
      await harness.dispose()
    }
  })

  test("keeps selections isolated across session switches and off the home default", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_THOROUGH },
      model: "test-provider/variant-model",
      children: () => <DialogAgentEffort />,
    })
    try {
      const first = await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      expect(markerLine(first)).toContain("Thorough")

      harness.route.navigate({ type: "session", sessionID: SESSION_PLAIN })
      const switched = await frameWhere(harness.app, (f) => markerLine(f).includes("Fast"), "marker on plain session")
      expect(harness.local.effort.current()).toBe("fast")
      expect(switched).toContain("Stored on this session")

      harness.route.navigate({ type: "home" })
      const home = await frameWhere(harness.app, (f) => f.includes("Default for new sessions"), "home footer")
      // Home offers the new-session default instead of a session override, and
      // switching back never rewrote the sessions that have their own level.
      expect(harness.local.effort.current()).toBe("fast")
      expect(harness.local.effort.scoped()).toBe(false)
      expect(home).not.toContain("applies per session")
      expect(harness.updates.length).toBe(0)
    } finally {
      await harness.dispose()
    }
  })

  test("paints each level's hue as a filled chip with its name in the dialog", async () => {
    const harness = await mountEffort({
      route: { type: "home" },
      model: "test-provider/variant-model",
      children: () => <DialogAgentEffort />,
    })
    try {
      await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      // Fast green, medium orange, thorough red; the names stay visible so the
      // levels never depend on color alone.
      expect((await chipHex(harness.app, "Fast")).bg).toBe("#3fb950")
      expect((await chipHex(harness.app, "Medium")).bg).toBe("#f0883e")
      expect((await chipHex(harness.app, "Thorough")).bg).toBe("#f85149")
      for (const label of ["Fast", "Medium", "Thorough"]) expect((await chipHex(harness.app, label)).fg).toBe("#000000")

      const frame = await frameWhere(harness.app, () => true, "settled dialog")
      expect(frame).toContain("Fast")
      expect(frame).toContain("Medium")
      expect(frame).toContain("Thorough")
      expect(markerLine(frame)).toContain("Fast")
    } finally {
      await harness.dispose()
    }
  })

  test("home selection persists as the default for new sessions and survives a restart", async () => {
    const shared = await tmpdir()
    try {
      const harness = await mountEffort({
        route: { type: "home" },
        model: "test-provider/variant-model",
        children: () => <Prompt />,
        state: shared.path,
      })
      try {
        // Configured default until the user picks one.
        expect(harness.local.effort.current()).toBe("fast")
        expect(harness.local.effort.scoped()).toBe(false)
        expect(harness.local.effort.newSessionMetadata()).toBeUndefined()

        harness.dialog.replace(() => <DialogAgentEffort />)
        await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
        harness.app.mockInput.pressArrow("down")
        harness.app.mockInput.pressArrow("down")
        harness.app.mockInput.pressEnter()

        await waitUntil(() => harness.local.effort.current() === "thorough")
        // Visible immediately: the composer label follows the new default
        // before the write settles, and the selector marks it when reopened.
        await frameWhere(harness.app, (f) => f.includes("thorough"), "composer label")
        harness.dialog.replace(() => <DialogAgentEffort />)
        await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog reopened")
        await frameWhere(harness.app, (f) => markerLine(f).includes("Thorough"), "home marker")
        harness.dialog.clear()
        expect(await fileJson(`${shared.path}/effort.json`)).toEqual({ agentEffort: "thorough" })
        expect(harness.local.effort.newSessionMetadata()).toEqual({ agentEffort: "thorough" })
        // A home default never writes to a session.
        expect(harness.updates.length).toBe(0)
      } finally {
        await harness.dispose()
      }

      // Restart: a fresh app reading the same state directory starts from the
      // persisted default, with no user action.
      const restarted = await mountEffort({
        route: { type: "home" },
        model: "test-provider/variant-model",
        children: () => <Prompt />,
        state: shared.path,
      })
      try {
        await waitUntil(() => restarted.local.effort.current() === "thorough")
        await frameWhere(restarted.app, (f) => f.includes("thorough"), "restart composer label")
        expect(restarted.local.effort.scoped()).toBe(false)
        expect(restarted.local.effort.newSessionMetadata()).toEqual({ agentEffort: "thorough" })
      } finally {
        await restarted.dispose()
      }
    } finally {
      await shared[Symbol.asyncDispose]()
    }
  })

  test("home submit inherits the chosen effort and seeds it before the new session syncs", async () => {
    const harness = await mountEffort({
      route: { type: "home" },
      model: "test-provider/variant-model",
      children: () => <Prompt />,
    })
    try {
      harness.dialog.replace(() => <DialogAgentEffort />)
      await frameWhere(harness.app, (f) => f.includes("Agent effort"), "effort selector")
      harness.app.mockInput.pressArrow("down")
      harness.app.mockInput.pressArrow("down")
      harness.app.mockInput.pressEnter()
      await waitUntil(() => harness.local.effort.current() === "thorough")
      await harness.app.renderOnce()
      harness.app.mockInput.typeText("Check the project")
      await frameWhere(harness.app, (f) => f.includes("Check the project"), "home prompt")
      harness.app.mockInput.pressEnter()
      await waitUntil(() => harness.creates.length === 1)
      expect(harness.creates[0].metadata).toEqual({ agentEffort: "thorough" })
      await waitUntil(() => harness.route.data.type === "session")
      const sessionID = harness.route.data.type === "session" ? harness.route.data.sessionID : ""
      expect(sessionID).toBe("ses_created_1")
      // The create response has not been emitted as a session.updated event.
      // Only the seeded overlay can show the inherited level on this route.
      expect(harness.sync.session.get(sessionID)).toBeUndefined()
      expect(harness.local.effort.scoped()).toBe(true)
      expect(harness.local.effort.current()).toBe("thorough")
      expect(harness.updates).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("a failed home default write is visible and keeps the selection consistent", async () => {
    const shared = await tmpdir()
    // A directory where the default file belongs makes every write fail.
    await mkdir(`${shared.path}/effort.json`, { recursive: true })
    const harness = await mountEffort({
      route: { type: "home" },
      model: "test-provider/variant-model",
      children: () => <Prompt />,
      state: shared.path,
    })
    try {
      expect(harness.local.effort.current()).toBe("fast")
      harness.local.effort.set("thorough")
      await frameWhere(harness.app, (f) => f.includes("Failed to save the agent effort default"), "failure toast")
      // The selection rolls back to what is really stored instead of claiming
      // a level that never landed.
      await waitUntil(() => harness.local.effort.current() === "fast")
      expect(harness.local.effort.newSessionMetadata()).toBeUndefined()
      expect(harness.local.effort.scoped()).toBe(false)
    } finally {
      await harness.dispose()
      await shared[Symbol.asyncDispose]()
    }
  })

  test.each(["{", '{"agentEffort":"invalid"}', "{}", "null", "[]"])(
    "warns about corrupt or invalid stored defaults (%s) and keeps the config fallback",
    async (content) => {
      await using shared = await tmpdir()
      await Bun.write(`${shared.path}/effort.json`, content)
      const harness = await mountEffort({
        route: { type: "home" },
        model: "test-provider/variant-model",
        children: () => <Prompt />,
        state: shared.path,
      })
      try {
        await frameWhere(harness.app, (f) => f.includes("Failed to load the agent effort default"), "load warning")
        expect(harness.local.effort.current()).toBe("fast")
        expect(harness.local.effort.newSessionMetadata()).toBeUndefined()
        harness.local.effort.set("thorough")
        expect(await fileJson(`${shared.path}/effort.json`, "thorough")).toEqual({ agentEffort: "thorough" })
      } finally {
        await harness.dispose()
      }
    },
  )

  test.skipIf(process.platform === "win32")("warns about an unreadable stored default and keeps the medium fallback", async () => {
    await using shared = await tmpdir()
    const file = `${shared.path}/effort.json`
    await Bun.write(file, '{"agentEffort":"thorough"}')
    await chmod(file, 0)
    const harness = await mountEffort({
      route: { type: "home" },
      model: "test-provider/variant-model",
      children: () => <Prompt />,
      state: shared.path,
      configEffort: null,
    })
    try {
      await frameWhere(harness.app, (f) => f.includes("Failed to load the agent effort default"), "permission warning")
      expect(harness.local.effort.current()).toBe("medium")
      expect(harness.local.effort.newSessionMetadata()).toBeUndefined()
    } finally {
      await chmod(file, 0o600)
      await harness.dispose()
    }
  })

  test("a missing stored default is silent and does not block the first write", async () => {
    await using shared = await tmpdir()
    const harness = await mountEffort({
      route: { type: "home" },
      model: "test-provider/variant-model",
      children: () => <Prompt />,
      state: shared.path,
    })
    try {
      harness.local.effort.set("thorough")
      expect(await fileJson(`${shared.path}/effort.json`)).toEqual({ agentEffort: "thorough" })
      await harness.app.renderOnce()
      expect(await captureFrame(harness.app)).not.toContain("Failed to load the agent effort default")
    } finally {
      await harness.dispose()
    }
  })

  test.each(["before selection", "after queued selection"])(
    "orders a deferred initial read %s before writes and rolls back to the latest saved value",
    async (ordering) => {
      await using shared = await tmpdir()
      // Join like the implementation does: a forward-slash template path never
      // equals path.join's all-backslashes result on Windows, so the readJson /
      // writeJsonAtomic spies below would silently pass every call through.
      const file = path.join(shared.path, "effort.json")
      await Bun.write(file, '{"agentEffort":"medium"}')
      const persistence = await import("../../../src/util/persistence")
      const readJson = persistence.readJson
      const writeJsonAtomic = persistence.writeJsonAtomic
      let release!: (value: unknown) => void
      const initialRead = new Promise<unknown>((resolve) => {
        release = resolve
      })
      const reads = spyOn(persistence, "readJson").mockImplementation(<T,>(path: string): Promise<T> =>
        path === file ? (initialRead as Promise<T>) : readJson<T>(path),
      )
      const written: unknown[] = []
      const writes = spyOn(persistence, "writeJsonAtomic").mockImplementation(async (path, value) => {
        if (path !== file) return writeJsonAtomic(path, value)
        written.push(value)
        if (written.length === 2) throw new Error("write failed")
        await writeJsonAtomic(path, value)
      })
      const harness = await mountEffort({
        route: { type: "home" },
        model: "test-provider/variant-model",
        children: () => <Prompt />,
        state: shared.path,
      })
      try {
        if (ordering === "before selection") {
          release({ agentEffort: "medium" })
          await waitUntil(() => harness.local.effort.current() === "medium")
        }
        harness.local.effort.set("thorough")
        expect(harness.local.effort.current()).toBe("thorough")
        if (ordering === "after queued selection") {
          // Give a wrongly unordered write time to complete before releasing
          // the stale snapshot. The correct implementation must still wait.
          await Bun.sleep(30)
          expect(written).toEqual([])
          expect(await Bun.file(file).json()).toEqual({ agentEffort: "medium" })
          release({ agentEffort: "medium" })
        }
        await waitUntil(() => written.length === 1)
        expect(await fileJson(file, "thorough")).toEqual({ agentEffort: "thorough" })
        expect(harness.local.effort.current()).toBe("thorough")
        harness.local.effort.set("fast")
        await frameWhere(harness.app, (f) => f.includes("Failed to save the agent effort default"), "write warning")
        expect(written).toEqual([{ agentEffort: "thorough" }, { agentEffort: "fast" }])
        expect(harness.local.effort.current()).toBe("thorough")
        expect(harness.local.effort.newSessionMetadata()).toEqual({ agentEffort: "thorough" })
        expect(await Bun.file(file).json()).toEqual({ agentEffort: "thorough" })
        // A failed write must not poison the queue for the next selection.
        harness.local.effort.set("medium")
        await waitUntil(() => written.length === 3)
        expect(await fileJson(file, "medium")).toEqual({ agentEffort: "medium" })
        expect(harness.local.effort.current()).toBe("medium")
      } finally {
        reads.mockRestore()
        writes.mockRestore()
        release({ agentEffort: "medium" })
        await harness.dispose()
      }
    },
  )

  test("a home default leaves the sessions that carry their own selection alone", async () => {
    const shared = await tmpdir()
    const harness = await mountEffort({
      route: { type: "home" },
      model: "test-provider/variant-model",
      children: () => <DialogAgentEffort />,
      state: shared.path,
    })
    try {
      await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      expect(harness.local.effort.current()).toBe("fast")

      harness.app.mockInput.pressArrow("down")
      harness.app.mockInput.pressArrow("down")
      harness.app.mockInput.pressEnter()
      await waitUntil(() => harness.local.effort.current() === "thorough")

      // An existing session keeps the level it was created with.
      harness.route.navigate({ type: "session", sessionID: SESSION_FAST })
      await waitUntil(() => harness.local.effort.current() === "fast")
      await frameWhere(harness.app, (f) => f.includes("Stored on this session"), "session footer")

      // An override on that session is written to the session only: the home
      // default for new sessions stays what the user picked on home.
      harness.local.effort.set("medium")
      await waitUntil(() => harness.updates.length >= 1)
      expect(harness.updates[0]).toEqual({
        sessionID: SESSION_FAST,
        body: { metadata: { agentEffort: "medium", task: "keep-me" } },
      })
      expect(await fileJson(`${shared.path}/effort.json`)).toEqual({ agentEffort: "thorough" })

      // A plain session still falls back to the configured default rather than
      // silently inheriting another session's override.
      harness.route.navigate({ type: "session", sessionID: SESSION_PLAIN })
      await waitUntil(() => harness.local.effort.current() === "fast")
    } finally {
      await harness.dispose()
      await shared[Symbol.asyncDispose]()
    }
  })

  test("labels effort in the prompt for models without thinking variants", async () => {
    const harness = await mountEffort({
      route: { type: "home" },
      model: "test-provider/plain-model",
      children: () => <Prompt />,
    })
    try {
      const frame = await frameWhere(harness.app, (f) => f.includes("PlainModel"), "prompt meta row")
      expect(lineOf(frame, "PlainModel")).toContain("fast")
      expect(harness.local.model.variant.list()).toEqual([])
      expect(harness.local.model.variant.current()).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })

  test("shows effort beside an explicit thinking choice and never clobbers it", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_THOROUGH },
      model: "test-provider/variant-model",
      children: () => <Prompt />,
    })
    try {
      await frameWhere(harness.app, (f) => f.includes("VariantModel"), "prompt meta row")
      harness.local.model.variant.set("high")
      await frameWhere(harness.app, (f) => lineOf(f, "VariantModel").includes("high"), "variant label")

      harness.local.effort.set("fast")
      await waitUntil(() => harness.updates.length >= 1)
      expect(harness.updates[0].body.metadata).toEqual({ agentEffort: "fast", task: "keep-me" })
      expect(harness.local.effort.current()).toBe("fast")
      expect(harness.local.model.variant.current()).toBe("high")

      const after = await frameWhere(
        harness.app,
        (f) => {
          const line = lineOf(f, "VariantModel")
          return line.includes("fast") && line.includes("high")
        },
        "effort label beside thinking",
      )
      expect(after).toContain("fast · high")
    } finally {
      await harness.dispose()
    }
  })

  test("applies the coupled thinking default only when nothing chose thinking", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_THOROUGH },
      model: "test-provider/variant-model",
      children: () => <DialogAgentEffort />,
    })
    try {
      await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      expect(harness.local.model.variant.current()).toBeUndefined()

      harness.local.effort.set("fast")
      expect(harness.local.model.variant.current()).toBe("low")
      harness.local.effort.set("thorough")
      expect(harness.local.model.variant.current()).toBe("high")

      // an explicit default/off selection is still a selection: no clobber
      harness.local.model.variant.set(undefined)
      harness.local.effort.set("fast")
      expect(harness.local.model.variant.current()).toBeUndefined()

      await waitUntil(() => harness.updates.length >= 3)
      expect(harness.updates.map((update) => update.body.metadata)).toEqual([
        { agentEffort: "fast", task: "keep-me" },
        { agentEffort: "thorough", task: "keep-me" },
        { agentEffort: "fast", task: "keep-me" },
      ])
    } finally {
      await harness.dispose()
    }
  })

  test("keeps a real selector choice from being re-coupled by effort changes", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_THOROUGH },
      model: "test-provider/variant-model",
      children: () => <DialogAgentEffort />,
    })
    try {
      await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      // A direct selector write becomes explicit provenance for this model.
      harness.local.model.variant.set("medium")
      expect(harness.local.model.variant.current()).toBe("medium")

      harness.local.effort.set("fast")
      // The dial must not re-couple `low` over the user's explicit choice.
      expect(harness.local.model.variant.current()).toBe("medium")
      expect(harness.local.model.variant.selected()).toBe("medium")

      harness.local.effort.set("thorough")
      expect(harness.local.model.variant.current()).toBe("medium")

      await waitUntil(() => harness.updates.length >= 2)
      expect(harness.updates.map((update) => update.body.metadata)).toEqual([
        { agentEffort: "fast", task: "keep-me" },
        { agentEffort: "thorough", task: "keep-me" },
      ])
    } finally {
      await harness.dispose()
    }
  })

  test("keeps a configured thinking variant when effort changes", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_THOROUGH },
      model: "test-provider/variant-model",
      agentVariant: "high",
      children: () => <DialogAgentEffort />,
    })
    try {
      await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      expect(harness.local.model.variant.current()).toBe("high")
      harness.local.effort.set("fast")
      expect(harness.local.model.variant.current()).toBe("high")
      expect(harness.local.model.variant.selected()).toBeUndefined()
      await waitUntil(() => harness.updates.length >= 1)
      expect(harness.local.effort.current()).toBe("fast")
    } finally {
      await harness.dispose()
    }
  })

  test("keeps behavior unchanged for models without thinking variants", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_THOROUGH },
      model: "test-provider/plain-model",
      children: () => <DialogAgentEffort />,
    })
    try {
      await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      expect(harness.local.model.variant.list()).toEqual([])
      harness.local.effort.set("fast")
      expect(harness.local.model.variant.current()).toBeUndefined()
      await waitUntil(() => harness.updates.length >= 1)
      expect(harness.updates[0].body.metadata).toEqual({ agentEffort: "fast", task: "keep-me" })
      expect(harness.local.effort.current()).toBe("fast")
    } finally {
      await harness.dispose()
    }
  })

  test("serializes effort writes so the last selection wins when completions would be reversed", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_THOROUGH },
      model: "test-provider/variant-model",
      children: () => <DialogAgentEffort />,
      gated: true,
    })
    try {
      harness.local.effort.set("fast")
      harness.local.effort.set("thorough")
      await waitUntil(() => harness.updates.length >= 1)
      // The second PATCH must not be in flight while the first is pending:
      // that concurrency is what let a stale write land last.
      await Bun.sleep(100)
      expect(harness.updates.length).toBe(1)
      expect(harness.local.effort.current()).toBe("thorough")

      harness.release(0)
      await waitUntil(() => harness.updates.length >= 2)
      expect(harness.local.effort.current()).toBe("thorough")
      harness.release(1)
      await Bun.sleep(100)

      expect(harness.updates.map((update) => update.body.metadata)).toEqual([
        { agentEffort: "fast", task: "keep-me" },
        { agentEffort: "thorough", task: "keep-me" },
      ])
      expect(harness.local.effort.current()).toBe("thorough")
      expect(
        (harness.sync.session.get(SESSION_THOROUGH)?.metadata as { agentEffort?: string } | undefined)?.agentEffort,
      ).toBe("thorough")
    } finally {
      await harness.dispose()
    }
  })

  test("a failed effort write does not block the queued newer selection", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_THOROUGH },
      model: "test-provider/variant-model",
      children: () => <DialogAgentEffort />,
      gated: true,
    })
    try {
      harness.local.effort.set("fast")
      harness.local.effort.set("thorough")
      await waitUntil(() => harness.updates.length >= 1)
      harness.release(0, "fail")
      await waitUntil(() => harness.updates.length >= 2)
      harness.release(1)
      await Bun.sleep(100)
      expect(harness.local.effort.current()).toBe("thorough")
      expect(
        (harness.sync.session.get(SESSION_THOROUGH)?.metadata as { agentEffort?: string } | undefined)?.agentEffort,
      ).toBe("thorough")
    } finally {
      await harness.dispose()
    }
  })

  test("separates the levels with one blank row and aligns their descriptions", async () => {
    const harness = await mountEffort({
      route: { type: "home" },
      model: "test-provider/variant-model",
      children: () => null,
    })
    try {
      // Opened the way app.tsx opens it, so the assertions read the real panel.
      harness.dialog.replace(() => <DialogAgentEffort />)
      const frame = await frameWhere(
        harness.app,
        (f) =>
          f.includes("Agent effort") &&
          flatText(f).includes("Deep, meticulous work on complex tasks from start to finish"),
        "dialog rows",
      )
      await settledPanel(harness.app, "Agent effort")
      const lines = frame.split("\n")
      const rowOf = (needle: string) => lines.findIndex((line) => line.includes(needle))
      // One blank row between options, and no more: the levels stop reading as
      // a packed block without spending the panel on empty rows.
      expect(rowOf("Medium") - rowOf("Fast")).toBe(2)
      expect(rowOf("Thorough") - rowOf("Medium")).toBe(2)
      expect(lines[rowOf("Fast") + 1].trim()).toBe("")
      expect(lines[rowOf("Medium") + 1].trim()).toBe("")
      // Each description sits in its own column, in the same column for every
      // level, and only the copy that no longer fits wraps: the two short ones
      // stay on their title's line.
      const columns = ["Reliable workhorse", "Smarter agent", "Deep, meticulous"].map((copy) =>
        lines[rowOf(copy)].indexOf(copy),
      )
      expect(new Set(columns).size).toBe(1)
      expect(rowOf("Reliable workhorse")).toBe(rowOf("Fast"))
      expect(rowOf("Smarter agent")).toBe(rowOf("Medium"))
      const thorough = optionBlock(frame, "Thorough")
      // The panel is 60 columns wide, so the 59-column copy takes two lines
      // rather than being clipped, and the second line holds the column.
      expect(thorough).toHaveLength(2)
      expect(thorough[1].search(/\S/)).toBe(columns[2])
      // The accepted copy, footer and indicator are untouched by the layout.
      expect(flatText(frame)).toContain("Deep, meticulous work on complex tasks from start to finish")
      expect(frame).toContain("Default for new sessions")
      expect(markerLine(frame)).toContain("Fast")
    } finally {
      await harness.dispose()
    }
  })


  // The panel's own chrome: paddingTop 1, title 1, gap 1, search 1, gap 1,
  // the option rows, gap 1, footer 1, paddingBottom 1.
  const CHROME = 8

  test("sizes the dialog to the rows it paints, not to the terminal cap", async () => {
    // The three levels paint 6 rows at a normal width (one blank row between
    // them, Thorough wrapping to two lines) and 10 rows at a narrow one. The
    // panel must follow those rows, so the same content is the same height in
    // a 40-row terminal and an 80-row one, and the footer stays right under
    // the last row instead of at the bottom of an oversized box.
    for (const view of [
      { name: "normal", width: 120, height: 40, rows: 6 },
      { name: "tall", width: 120, height: 80, rows: 6 },
      { name: "narrow", width: 44, height: 40, rows: 10 },
    ]) {
      const harness = await mountEffort({
        route: { type: "home" },
        model: "test-provider/variant-model",
        children: () => null,
        width: view.width,
        height: view.height,
      })
      try {
        harness.dialog.replace(() => <DialogAgentEffort />)
        const frame = await frameWhere(
          harness.app,
          (f) =>
            flatText(f).includes("Deep, meticulous work on complex tasks from start to finish") &&
            f.includes("Default for new sessions"),
          view.name,
        )
        const panel = await settledPanel(harness.app, "Agent effort")
        const settled = await captureFrame(harness.app)
        const lines = settled.split("\n")
        const footerRow = lines.findIndex((line) => line.includes("Default for new sessions"))

        expect(panel.height).toBe(view.rows + CHROME)
        // The footer is the panel's last content row, with the panel's usual
        // bottom padding under it.
        expect(footerRow).toBe(panel.bottom - 1)
        // Exactly one blank row separates the last painted option row from the
        // footer: the dialog's normal gap, not dead space.
        expect(lastPaintedAbove(frame, footerRow)).toBe(footerRow - 2)
        expect(lines[footerRow - 1].trim()).toBe("")
      } finally {
        await harness.dispose()
      }
    }
  })

  test("keeps the panel compact around a single filtered level", async () => {
    const harness = await mountEffort({
      route: { type: "home" },
      model: "test-provider/variant-model",
      children: () => null,
      width: 120,
      height: 40,
    })
    try {
      harness.dialog.replace(() => <DialogAgentEffort />)
      await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      await harness.app.mockInput.typeText("tho")
      await frameWhere(harness.app, (f) => f.includes("Thorough") && !f.includes("Medium"), "filtered")
      const panel = await settledPanel(harness.app, "Agent effort")
      const frame = await captureFrame(harness.app)
      const lines = frame.split("\n")
      const footerRow = lines.findIndex((line) => line.includes("Default for new sessions"))
      // Only Thorough is left, and its copy wraps to two rows.
      expect(panel.height).toBe(2 + CHROME)
      expect(footerRow).toBe(panel.bottom - 1)
      expect(lastPaintedAbove(frame, footerRow)).toBe(footerRow - 2)
      expect(lines[footerRow - 1].trim()).toBe("")
    } finally {
      await harness.dispose()
    }
  })

  test("keeps the footer directly under the list in a short viewport", async () => {
    for (const view of [
      // 26 rows leaves a 7-row cap, one row more than the 6 rows the levels
      // need: the panel must still stop at the content.
      { name: "short with room", width: 120, height: 26, rows: 6 },
      // 20 rows leaves a 4-row cap, so the list scrolls and the footer sits
      // under the capped viewport instead of a taller one.
      { name: "short capped", width: 44, height: 20, rows: 4 },
    ]) {
      const harness = await mountEffort({
        route: { type: "home" },
        model: "test-provider/variant-model",
        children: () => null,
        width: view.width,
        height: view.height,
      })
      try {
        harness.dialog.replace(() => <DialogAgentEffort />)
        await frameWhere(harness.app, (f) => f.includes("Default for new sessions"), view.name)
        const panel = await settledPanel(harness.app, "Agent effort")
        const frame = await captureFrame(harness.app)
        const lines = frame.split("\n")
        const footerRow = lines.findIndex((line) => line.includes("Default for new sessions"))
        expect(panel.height).toBe(view.rows + CHROME)
        expect(footerRow).toBe(panel.bottom - 1)
        expect(lastPaintedAbove(frame, footerRow)).toBe(footerRow - 2)
        expect(lines[footerRow - 1].trim()).toBe("")
        // Nothing paints below the footer inside the panel.
        expect(lines.slice(footerRow + 1, panel.bottom + 1).every((line) => line.trim() === "")).toBe(true)
        // The selected level and its wrap stay on screen.
        expect(markerLine(frame)).toContain("Fast")
        expect(frame).toContain("for everyday tasks")
      } finally {
        await harness.dispose()
      }
    }
  })

  test("wraps descriptions inside their column in a narrow viewport", async () => {
    const harness = await mountEffort({
      route: { type: "home" },
      model: "test-provider/variant-model",
      children: () => null,
      width: 44,
    })
    try {
      harness.dialog.replace(() => <DialogAgentEffort />)
      const frame = await frameWhere(
        harness.app,
        (f) => flatText(f).includes("start to finish") && f.includes("Reliable workhorse"),
        "narrow rows",
      )
      const copy = [
        ["Fast", "Reliable workhorse for everyday tasks"],
        ["Medium", "Smarter agent for more demanding work"],
        ["Thorough", "Deep, meticulous work on complex tasks from start to finish"],
      ]
      const blocks = copy.map(([level, description]) => {
        const block = optionBlock(frame, level)
        // Nothing is clipped: the full accepted copy is painted, split over the
        // wrapped rows and read back by joining them.
        expect(flatText(block.join("\n"))).toContain(description)
        expect(block.length).toBeGreaterThan(1)
        return { level, description, block }
      })
      // Wrapped rows continue under the description column rather than under
      // the level name, and every level shares that column.
      const columns = blocks.map(({ description, block }) => {
        const column = block[0].indexOf(description.split(" ").slice(0, 2).join(" "))
        expect(column).toBeGreaterThan(0)
        for (const line of block.slice(1)) expect(line.search(/\S/)).toBe(column)
        return column
      })
      expect(new Set(columns).size).toBe(1)
      // The blank row between options survives the wrap.
      expect(frame.split("\n")[frame.split("\n").findIndex((line) => line.includes("Medium")) - 1].trim()).toBe("")
      expect(frame).toContain("Default for new sessions")
    } finally {
      await harness.dispose()
    }
  })

  test("paints the selected row's background across every wrapped line", async () => {
    const harness = await mountEffort({
      route: { type: "home" },
      model: "test-provider/variant-model",
      children: () => null,
      width: 44,
      height: 34,
    })
    try {
      harness.dialog.replace(() => <DialogAgentEffort />)
      await frameWhere(harness.app, (f) => flatText(f).includes("start to finish"), "narrow rows")
      // Walk the cursor to the wrapping level: its highlight must cover the
      // whole description, not just the title line.
      harness.app.mockInput.pressArrow("down")
      harness.app.mockInput.pressArrow("down")
      const frame = await frameWhere(harness.app, (f) => markerLine(f).includes("Fast"), "marker stays on the level")
      const fills = await rowFills(harness.app)
      const lines = frame.split("\n")
      const start = lines.findIndex((line) => line.includes("Thorough"))
      const block = optionBlock(frame, "Thorough")
      expect(block.length).toBeGreaterThan(1)
      // The search field paints its own focused fill, so the option area starts
      // below it; there the only filled rows are the selected level's.
      const searchRow = lines.findIndex((line) => line.includes("Search"))
      const highlight = fills[start]
      expect(highlight).not.toBe(fills[0])
      const painted = fills.flatMap((fill, index) => (index > searchRow && fill === highlight ? [index] : []))
      expect(painted).toEqual(block.map((_, offset) => start + offset))
      // The rows the highlight covers are the wrapped description rows, which
      // stay aligned under the description column.
      const column = block[0].indexOf("Deep, meticulous")
      for (const line of block.slice(1)) expect(line.search(/\S/)).toBe(column)
      expect(flatText(block.join("\n"))).toContain("Deep, meticulous work on complex tasks from start to finish")
      // The current-level indicator still points at the stored level, which is
      // not the row the cursor is on now.
      expect(frame).toContain("●")
    } finally {
      await harness.dispose()
    }
  })

  test("keeps keyboard selection on a wrapped row visible in a short viewport", async () => {
    const harness = await mountEffort({
      route: { type: "home" },
      model: "test-provider/variant-model",
      children: () => null,
      width: 44,
      height: 26,
    })
    try {
      harness.dialog.replace(() => <DialogAgentEffort />)
      await frameWhere(harness.app, (f) => f.includes("Reliable workhorse"), "first row")
      harness.app.mockInput.pressArrow("down")
      harness.app.mockInput.pressArrow("down")
      // The scroll reveals the row by its own height: all three wrapped lines
      // of the selected level are on screen together.
      const selected = await frameWhere(harness.app, (f) => flatText(f).includes("start to finish"), "wrapped row revealed")
      const lines = selected.split("\n")
      const start = lines.findIndex((line) => line.includes("Thorough"))
      expect(start).toBeGreaterThanOrEqual(0)
      const block = optionBlock(selected, "Thorough")
      expect(block.length).toBeGreaterThan(1)
      // Every wrapped line of the selected level is on screen, and the footer
      // still follows the list.
      expect(flatText(lines.slice(start, start + block.length).join("\n"))).toContain("start to finish")
      expect(lines.findIndex((line) => line.includes("Default for new sessions"))).toBeGreaterThan(start + block.length)

      harness.app.mockInput.pressArrow("up")
      harness.app.mockInput.pressArrow("up")
      const back = await frameWhere(harness.app, (f) => f.includes("Reliable workhorse"), "first row again")
      expect(markerLine(back)).toContain("Fast")
    } finally {
      await harness.dispose()
    }
  })

  test("filters the levels by search and keeps the spacing and footer", async () => {
    const harness = await mountEffort({
      route: { type: "home" },
      model: "test-provider/variant-model",
      children: () => <DialogAgentEffort />,
    })
    try {
      await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      await harness.app.mockInput.typeText("tho")
      const filtered = await frameWhere(
        harness.app,
        (f) => f.includes("Thorough") && !f.includes("Medium") && !f.includes("Reliable workhorse"),
        "filtered rows",
      )
      expect(filtered).toContain("Deep, meticulous work on complex tasks from start to finish")
      expect(filtered).toContain("Default for new sessions")

      harness.app.mockInput.pressBackspace()
      harness.app.mockInput.pressBackspace()
      harness.app.mockInput.pressBackspace()
      const restored = await frameWhere(
        harness.app,
        (f) => f.includes("Fast") && f.includes("Medium") && f.includes("Thorough"),
        "restored rows",
      )
      const lines = restored.split("\n")
      const rowOf = (needle: string) => lines.findIndex((line) => line.includes(needle))
      expect(rowOf("Medium") - rowOf("Fast")).toBe(2)
      expect(lines[rowOf("Fast") + 1].trim()).toBe("")
      expect(restored).toContain("Default for new sessions")
    } finally {
      await harness.dispose()
    }
  })

  test("leaves other pickers on their packed single-line rows", async () => {
    const harness = await mountEffort({
      route: { type: "home" },
      model: "test-provider/variant-model",
      children: () => (
        <DialogSelect
          options={[
            { value: "alpha", title: "Alpha", description: "First option" },
            { value: "bravo", title: "Bravo", description: "Second option" },
          ]}
          title="Control picker"
          current="alpha"
        />
      ),
    })
    try {
      const frame = await frameWhere(
        harness.app,
        (f) => f.includes("Control picker") && f.includes("Second option"),
        "control picker",
      )
      const lines = frame.split("\n")
      const rowOf = (needle: string) => lines.findIndex((line) => line.includes(needle))
      // No opt-in props means the shared picker keeps painting one packed line
      // per option with the description trailing the title.
      expect(rowOf("Bravo") - rowOf("Alpha")).toBe(1)
      expect(lines[rowOf("Alpha")]).toContain("Alpha First option")
      expect(lines[rowOf("Bravo")]).toContain("Bravo Second option")
    } finally {
      await harness.dispose()
    }
  })

  // Asset capture is opt-in: `TUI_CAPTURE_DIR=<dir> bun test ... -t captures`
  // writes the sanitized span dumps that the committed PNGs are rendered from.
  // It renders through the production dialog stack, like app.tsx does, so the
  // frames carry the real panel width.
  test.skipIf(!process.env.TUI_CAPTURE_DIR)("captures the normal, narrow and short layout frames", async () => {
    const dir = process.env.TUI_CAPTURE_DIR
    if (!dir) return
    for (const view of [
      { name: "normal", width: 120, height: 40, downs: 0 },
      { name: "narrow", width: 44, height: 40, downs: 0 },
      // A short viewport caps the list; the cursor walks to the wrapping level
      // so the frame also shows the wrapped selection held on screen.
      { name: "short", width: 44, height: 26, downs: 2 },
    ]) {
      const harness = await mountEffort({
        route: { type: "home" },
        model: "test-provider/variant-model",
        children: () => null,
        width: view.width,
        height: view.height,
      })
      try {
        harness.dialog.replace(() => <DialogAgentEffort />)
        await frameWhere(harness.app, (f) => f.includes("Agent effort"), view.name)
        for (let press = 0; press < view.downs; press++) harness.app.mockInput.pressArrow("down")
        await frameWhere(
          harness.app,
          (f) => flatText(f).includes("start to finish") && f.includes("Default for new sessions"),
          view.name,
        )
        await settledPanel(harness.app, "Agent effort")
        const spans = await captureSpans(harness.app)
        const lines = spans.lines.map((line) =>
          line.spans.map((span) => ({
            text: span.text,
            fg: hexOf(span.fg),
            bg: span.bg.a > 0.01 ? hexOf(span.bg) : null,
            bold: (span.attributes & TextAttributes.BOLD) === TextAttributes.BOLD,
          })),
        )
        await mkdir(dir, { recursive: true })
        await Bun.write(
          path.join(dir, `agent-effort-${view.name}.json`),
          JSON.stringify({ cols: spans.cols, rows: spans.rows, lines }),
        )
        console.log(`\n=== ${view.name} (${spans.cols}x${spans.rows}) ===\n${await captureFrame(harness.app)}`)
      } finally {
        await harness.dispose()
      }
    }
  })


})
