/** @jsxImportSource @opentui/solid */
import { describe, expect, spyOn, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount, type JSX } from "solid-js"
import { chmod, mkdir } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { waitFor } from "../../fixture/frame"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { TuiConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { DataProvider } from "../../../src/context/data"
import { DialogAgentEffort } from "../../../src/component/dialog-agent-effort"
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
import { wait } from "../cmd/tui/sync-fixture"

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
  await wait(() => captured!.sync.status === "complete")

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
    200,
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
function chipHex(app: Setup, level: string) {
  const spans = app.captureSpans()
  for (const line of spans.lines) {
    const chip = line.spans.find((span) => span.text === ` ${level} `)
    if (chip) return { fg: hexOf(chip.fg), bg: hexOf(chip.bg) }
  }
  throw new Error(`no ${level} chip in the captured frame`)
}

/** Waits for a persisted JSON file to appear, then returns it. */
async function fileJson(file: string, level?: string): Promise<unknown> {
  for (let pass = 0; pass < 300; pass++) {
    const value = await Bun.file(file)
      .json()
      .catch(() => undefined)
    if (value !== undefined && (!level || (value as { agentEffort?: string } | null)?.agentEffort === level)) return value
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${file}`)
}

describe("agent effort selector", () => {
  test("renders three levels with process meanings and the session's selection", async () => {
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
      expect(frame).toContain("no review ritual")
      expect(frame).toContain("up to 2 review passes")
      expect(frame).toContain("review until clean")
      expect(frame).toContain("Stored on this session")
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
      await wait(() => harness.updates.length >= 1, 3000)
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
      expect(chipHex(harness.app, "Fast").bg).toBe("#3fb950")
      expect(chipHex(harness.app, "Medium").bg).toBe("#f0883e")
      expect(chipHex(harness.app, "Thorough").bg).toBe("#f85149")
      for (const label of ["Fast", "Medium", "Thorough"]) expect(chipHex(harness.app, label).fg).toBe("#000000")

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

        await wait(() => harness.local.effort.current() === "thorough", 3000)
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
        await wait(() => restarted.local.effort.current() === "thorough", 3000)
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
      await wait(() => harness.local.effort.current() === "thorough")
      await harness.app.renderOnce()
      harness.app.mockInput.typeText("Check the project")
      await frameWhere(harness.app, (f) => f.includes("Check the project"), "home prompt")
      harness.app.mockInput.pressEnter()
      await wait(() => harness.creates.length === 1)
      expect(harness.creates[0].metadata).toEqual({ agentEffort: "thorough" })
      await wait(() => harness.route.data.type === "session")
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
      await wait(() => harness.local.effort.current() === "fast", 3000)
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
      expect(harness.app.captureCharFrame()).not.toContain("Failed to load the agent effort default")
    } finally {
      await harness.dispose()
    }
  })

  test.each(["before selection", "after queued selection"])(
    "orders a deferred initial read %s before writes and rolls back to the latest saved value",
    async (ordering) => {
      await using shared = await tmpdir()
      const file = `${shared.path}/effort.json`
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
          await wait(() => harness.local.effort.current() === "medium")
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
        await wait(() => written.length === 1)
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
        await wait(() => written.length === 3)
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
      await wait(() => harness.local.effort.current() === "thorough", 3000)

      // An existing session keeps the level it was created with.
      harness.route.navigate({ type: "session", sessionID: SESSION_FAST })
      await wait(() => harness.local.effort.current() === "fast", 3000)
      await frameWhere(harness.app, (f) => f.includes("Stored on this session"), "session footer")

      // An override on that session is written to the session only: the home
      // default for new sessions stays what the user picked on home.
      harness.local.effort.set("medium")
      await wait(() => harness.updates.length >= 1, 3000)
      expect(harness.updates[0]).toEqual({
        sessionID: SESSION_FAST,
        body: { metadata: { agentEffort: "medium", task: "keep-me" } },
      })
      expect(await fileJson(`${shared.path}/effort.json`)).toEqual({ agentEffort: "thorough" })

      // A plain session still falls back to the configured default rather than
      // silently inheriting another session's override.
      harness.route.navigate({ type: "session", sessionID: SESSION_PLAIN })
      await wait(() => harness.local.effort.current() === "fast", 3000)
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
      await wait(() => harness.updates.length >= 1, 3000)
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

      await wait(() => harness.updates.length >= 3, 3000)
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

      await wait(() => harness.updates.length >= 2, 3000)
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
      await wait(() => harness.updates.length >= 1, 3000)
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
      await wait(() => harness.updates.length >= 1, 3000)
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
      await wait(() => harness.updates.length >= 1, 3000)
      // The second PATCH must not be in flight while the first is pending:
      // that concurrency is what let a stale write land last.
      await Bun.sleep(100)
      expect(harness.updates.length).toBe(1)
      expect(harness.local.effort.current()).toBe("thorough")

      harness.release(0)
      await wait(() => harness.updates.length >= 2, 3000)
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
      await wait(() => harness.updates.length >= 1, 3000)
      harness.release(0, "fail")
      await wait(() => harness.updates.length >= 2, 3000)
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
})
