/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { waitFor } from "../../fixture/frame"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ArgsProvider } from "../../../src/context/args"
import { KVProvider } from "../../../src/context/kv"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { PermissionProvider } from "../../../src/context/permission"
import { LocalProvider } from "../../../src/context/local"
import { ExitProvider } from "../../../src/context/exit"
import { ThemeProvider } from "../../../src/context/theme"
import { RouteProvider } from "../../../src/context/route"
import { LocationProvider } from "../../../src/context/location"
import { EditorContextProvider } from "../../../src/context/editor"
import { DataProvider } from "../../../src/context/data"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { TuiConfigProvider } from "../../../src/config"
import { PromptRefProvider } from "../../../src/context/prompt"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { ToastProvider } from "../../../src/ui/toast"
import { DialogProvider } from "../../../src/ui/dialog"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { Prompt } from "../../../src/component/prompt"

/**
 * Regression test for "Paste to File" through the production paste path.
 *
 * Scenario (from the bug report): the user opens the normal composer, types a
 * little text ("Hello"), and pastes a large Wikipedia-like article. Before
 * the fix the entire article was inserted into the message input as ordinary
 * text and submitted to the agent as one enormous message part. Now the large
 * payload is captured as a `text/plain` file part (a compact `[Pasted file N]`
 * placeholder is shown in the composer) and the submitted prompt carries the
 * file part instead of the article text, so the server can save the full
 * content to a managed file and give the agent a bounded preview.
 *
 * The harness renders the real production composer (`<Prompt />`, exactly as
 * routes/home.tsx does, with its placeholders) inside the same provider tree
 * the app uses, and drives its real OpenTUI textarea through the stdin
 * pipeline (typed keys, bracketed paste, Enter). So these tests exercise the
 * same logical path the real UI uses — the actual `onPaste` handler, the
 * actual store, and the actual `session.prompt` request — not a mock of the
 * handler. The only thing mocked is the HTTP boundary.
 */

const SESSION_ID = "ses_pastefile"

type Setup = Awaited<ReturnType<typeof testRender>>

async function until(fn: () => boolean, timeoutMs = 15_000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms`)
    await Bun.sleep(10)
  }
}

/** Waits for the rendered frame to satisfy `predicate`, pumping frames. */
async function untilFrame(app: Setup, predicate: (frame: string) => boolean, maxPasses = 600) {
  return waitFor(
    app,
    () => {
      const frame = app.captureCharFrame()
      return predicate(frame) ? frame : undefined
    },
    maxPasses,
    `frame predicate not satisfied after ${maxPasses} passes`,
  )
}

function agentPayload() {
  return [
    {
      name: "work",
      mode: "primary",
      description: "Test agent",
      permission: {},
      options: {},
    },
  ]
}

function modelPayload() {
  return {
    id: "test-model",
    providerID: "test",
    api: { id: "test-model", url: "http://test", npm: "@ai-sdk/test" },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
    limit: { context: 100_000, output: 8_192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
}

function providersPayload() {
  return {
    providers: [
      {
        id: "test",
        name: "Test",
        source: "config",
        env: [],
        options: {},
        models: { "test-model": modelPayload() },
      },
    ],
    default: { test: "test-model" },
  }
}

function sessionPayload() {
  return {
    id: SESSION_ID,
    slug: "pastefile",
    title: "Paste to file",
    projectID: "proj_test",
    version: "0.0.0-test",
    directory,
    time: { created: 0, updated: 0 },
  }
}

/** A Wikipedia-like article: well past the 8000-char / 120-break thresholds. */
function article() {
  const paragraphs = Array.from({ length: 400 }, (_, i) => {
    return `Section ${i + 1}. SilverCode paste to file marker ${i}. ${"This is a Wikipedia-like paragraph of prose that describes the topic in detail. ".repeat(4)}`
  })
  return "SilverCode Paste To File Article\n\n" + paragraphs.join("\n\n")
}

type CapturedPrompt = { sessionID: string; body: Record<string, any> }

function createCapturingFetch() {
  const events = createEventSource()
  const captured: CapturedPrompt[] = []
  const calls = createFetch(
    (url) => {
      if (url.pathname === "/api/agent")
        return json({ location: { directory, project: { id: "proj_test", directory } }, data: agentPayload() })
      if (url.pathname === "/agent") return json(agentPayload())
      if (url.pathname === "/config/providers") return json(providersPayload())
      if (url.pathname === "/provider")
        return json({ all: providersPayload().providers, default: providersPayload().default, connected: ["test"] })
      if (url.pathname === "/config") return json({})
      if (url.pathname === `/session/${SESSION_ID}/message`) return json([])
      if (url.pathname === `/session/${SESSION_ID}`) return json(sessionPayload())
      return undefined
    },
    events,
  )

  // Wrap fetch to intercept session creation and prompt submission.
  // Note: the SDK client wraps the raw response body as `{data: BODY}`, so
  // the mocks below return the raw body (same convention as tui-sdk.ts).
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    if (url.pathname === "/session" && method === "POST") {
      return json(sessionPayload())
    }
    if (url.pathname === `/session/${SESSION_ID}/message` && method === "POST") {
      const raw = init?.body ?? (input instanceof Request ? await input.text() : "")
      const body = JSON.parse(String(raw))
      captured.push({ sessionID: SESSION_ID, body })
      return json({ info: { id: "msg_1", role: "user" }, parts: [] })
    }
    return calls.fetch(input, init)
  }) as typeof globalThis.fetch

  return { events, captured, fetch }
}

async function startApp(state: string) {
  const { events, captured, fetch } = createCapturingFetch()
  const config = createTuiResolvedConfig({})
  const pluginRuntime = createPluginRuntime()

  let sync!: ReturnType<typeof useSync>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <ClipboardProvider>
        <OpencodeKeymapProvider keymap={keymap}>
          <ToastProvider>
            <RouteProvider>
              <TuiConfigProvider config={config}>
                <PluginRuntimeProvider value={pluginRuntime}>
                  <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <LocationProvider>
                          <EditorContextProvider>
                            <ExitProvider exit={() => {}}>
                              <SyncProvider>
                                <DataProvider>
                                  <ThemeProvider mode="dark">
                                    <LocalProvider>
                                      <PromptStashProvider>
                                        <DialogProvider>
                                          <FrecencyProvider>
                                            <PromptHistoryProvider>
                                              <PromptRefProvider>
                                                <Probe />
                                              </PromptRefProvider>
                                            </PromptHistoryProvider>
                                          </FrecencyProvider>
                                        </DialogProvider>
                                      </PromptStashProvider>
                                    </LocalProvider>
                                  </ThemeProvider>
                                </DataProvider>
                              </SyncProvider>
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

  function Probe() {
    const s = useSync()
    onMount(() => {
      sync = s
      done()
    })
    // Mirrors the production home composer (routes/home.tsx).
    return (
      <Prompt
        placeholders={{
          normal: ["Fix a TODO in the codebase"],
          shell: ["ls -la"],
        }}
      />
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state }}>
        <ArgsProvider>
          <KVProvider>
            <Harness />
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 40 },
  )

  await ready
  await until(() => sync.status === "complete")
  // The composer textarea is focused once mounted (Prompt focuses itself).
  await until(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)

  return { app, captured }
}

describe("Paste to File (production TUI paste path)", () => {
  test("large paste with text before it becomes a file part, not an enormous message", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, captured } = await startApp(tmp.path)
    try {
      // The real composer is on screen and focused.
      await untilFrame(app, (frame) => frame.includes("Ask anything"))

      app.mockInput.typeText("Hello ")
      await untilFrame(app, (frame) => frame.includes("Hello"))

      const articleText = article()
      expect(articleText.length).toBeGreaterThan(8000)
      await app.mockInput.pasteBracketedText(articleText)

      // The composer shows the compact placeholder, not the article.
      const frame = await untilFrame(app, (f) => f.includes("[Pasted file 1]"))
      expect(frame).toContain("Hello")
      expect(frame).not.toContain("SilverCode paste to file marker 10")
      expect(frame).not.toContain("SilverCode Paste To File Article")

      app.mockInput.pressEnter()
      await until(() => captured.length === 1)

      const parts = captured[0].body.parts
      const textParts = parts.filter((part: any) => part.type === "text")
      const fileParts = parts.filter((part: any) => part.type === "file")

      // The message text keeps only the placeholder (plus the trailing space
      // the composer inserts after a captured paste); the article is not inlined.
      expect(textParts).toHaveLength(1)
      expect(textParts[0].text).toBe("Hello [Pasted file 1] ")

      // The article is carried as a text/plain file attachment.
      expect(fileParts).toHaveLength(1)
      const file = fileParts[0]
      expect(file.mime).toBe("text/plain")
      expect(file.filename).toBe("paste-1.txt")
      expect(file.url.startsWith("data:text/plain;base64,")).toBe(true)
      const decoded = Buffer.from(file.url.split(",")[1], "base64").toString("utf8")
      // pasteInputText trims leading/trailing whitespace before capture
      // (same behavior as the paste-summary path); body content is intact.
      expect(decoded).toBe(articleText.trim())
    } finally {
      app.renderer.destroy()
    }
  }, 120_000)

  test("multiple large pastes produce numbered files with distinct payloads", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, captured } = await startApp(tmp.path)
    try {
      await untilFrame(app, (frame) => frame.includes("Ask anything"))

      const first = "First document marker.\n" + "line of the first document\n".repeat(400)
      const second = "Second document marker.\n" + "line of the second document\n".repeat(400)
      expect(first.length).toBeGreaterThan(8000)
      expect(second.length).toBeGreaterThan(8000)

      await app.mockInput.pasteBracketedText(first)
      await untilFrame(app, (f) => f.includes("[Pasted file 1]"))
      await app.mockInput.pasteBracketedText(second)
      const frame = await untilFrame(app, (f) => f.includes("[Pasted file 2]"))
      expect(frame).not.toContain("line of the first document")
      expect(frame).not.toContain("line of the second document")

      app.mockInput.pressEnter()
      await until(() => captured.length === 1)

      const fileParts = captured[0].body.parts.filter((part: any) => part.type === "file")
      expect(fileParts).toHaveLength(2)
      expect(fileParts.map((part: any) => part.filename).sort()).toEqual(["paste-1.txt", "paste-2.txt"])
      const decode = (part: any) => Buffer.from(part.url.split(",")[1], "base64").toString("utf8")
      // Trailing newline trimmed by pasteInputText (see first test).
      expect(decode(fileParts[0])).toBe(first.trim())
      expect(decode(fileParts[1])).toBe(second.trim())
    } finally {
      app.renderer.destroy()
    }
  }, 120_000)

  test("typing after a large paste and re-pasting the same document keeps all content", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, captured } = await startApp(tmp.path)
    try {
      await untilFrame(app, (frame) => frame.includes("Ask anything"))

      const document = "Reused document.\n" + "shared line of the reused document\n".repeat(400)
      expect(document.length).toBeGreaterThan(8000)

      await app.mockInput.pasteBracketedText(document)
      await untilFrame(app, (f) => f.includes("[Pasted file 1]"))

      // The user keeps typing after the paste-to-file; the placeholder must
      // stay where it was and the typed text lands around it.
      app.mockInput.typeText("and now some notes")
      const frame = await untilFrame(app, (f) => f.includes("and now some notes"))
      expect(frame).toContain("[Pasted file 1]")
      expect(frame).not.toContain("shared line of the reused document")

      // Pasting the same large document again into the same composer numbers
      // the new file and must not corrupt the first capture.
      await app.mockInput.pasteBracketedText(document)
      await untilFrame(app, (f) => f.includes("[Pasted file 2]"))

      app.mockInput.pressEnter()
      await until(() => captured.length === 1)

      const parts = captured[0].body.parts
      const textParts = parts.filter((part: any) => part.type === "text")
      const fileParts = parts.filter((part: any) => part.type === "file")
      expect(textParts[0].text).toBe("[Pasted file 1] and now some notes[Pasted file 2] ")
      expect(fileParts).toHaveLength(2)
      expect(fileParts.map((part: any) => part.filename).sort()).toEqual(["paste-1.txt", "paste-2.txt"])
      const decode = (part: any) => Buffer.from(part.url.split(",")[1], "base64").toString("utf8")
      // Trailing newline trimmed by pasteInputText (see first test).
      expect(decode(fileParts[0])).toBe(document.trim())
      expect(decode(fileParts[1])).toBe(document.trim())
    } finally {
      app.renderer.destroy()
    }
  }, 120_000)

  test("small paste stays ordinary text (no file part, no placeholder)", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, captured } = await startApp(tmp.path)
    try {
      await untilFrame(app, (frame) => frame.includes("Ask anything"))

      // Small single-line paste: inserted verbatim, no placeholder, no file part.
      app.mockInput.typeText("summarize this: ")
      await app.mockInput.pasteBracketedText("the quick brown fox")
      const frame = await untilFrame(app, (f) => f.includes("the quick brown fox"))
      expect(frame).not.toContain("[Pasted")

      app.mockInput.pressEnter()
      await until(() => captured.length === 1)
      const parts = captured[0].body.parts
      expect(parts.filter((part: any) => part.type === "text")[0].text).toBe("summarize this: the quick brown fox")
      expect(parts.filter((part: any) => part.type === "file")).toHaveLength(0)
    } finally {
      app.renderer.destroy()
    }
  }, 120_000)
})
