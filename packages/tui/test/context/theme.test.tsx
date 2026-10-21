/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { CliRenderEvents, type CliRendererFrameEvent, type SyntaxStyle } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider, useTheme } from "../../src/context/theme"
import { tmpdir } from "../fixture/fixture"
import { waitFor } from "../fixture/frame"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

function usable(style: SyntaxStyle) {
  try {
    style.getRegisteredNames()
    return true
  } catch {
    return false
  }
}

// #371: code, markdown and diff renderables keep the previous SyntaxStyle until the frame
// after a theme switch rebinds them, so the old native style cannot be destroyed while the
// renderer is idle but has not painted that frame yet.
test("theme switch keeps the previous syntax style until the next frame", async () => {
  await using dir = await tmpdir()
  await mkdir(path.join(dir.path, "state"), { recursive: true })
  await writeFile(path.join(dir.path, "state", "kv.json"), "{}")
  const config = createTuiResolvedConfig()
  let theme!: ReturnType<typeof useTheme>

  function Probe() {
    theme = useTheme()
    return (
      <box flexDirection="column">
        <diff
          diff={`--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,2 @@\n-const first = 1\n+const first = 2\n const last = 3`}
          filetype="typescript"
          syntaxStyle={theme.syntax()}
          view="unified"
          showLineNumbers={true}
        />
        <markdown content={"# Title\n\n```ts\nconst value = 1\n```\n\nBody text"} syntaxStyle={theme.syntax()} />
        <code filetype="typescript" content={"const value = 1"} syntaxStyle={theme.syntax()} />
      </box>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: path.join(dir.path, "state") }}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <Probe />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30 },
  )

  try {
    await waitFor(app, () => (theme ? true : undefined))
    await app.renderer.idle()
    await app.renderOnce()

    // Hold the frame loop so the next frame only renders when the test pumps it.
    app.renderer.pause()
    const previous = theme.syntax()
    expect(usable(previous)).toBe(true)

    expect(theme.set("nord")).toBe(true)
    app.renderer.pause()

    // The renderer settles idle here, while the frame that rebinds the renderables above
    // has not rendered yet. The previous style must still be usable at this point.
    await app.renderer.idle()
    await Bun.sleep(0)
    expect(usable(previous)).toBe(true)

    await app.renderOnce()
    expect(usable(previous)).toBe(false)
    expect(usable(theme.syntax())).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

// #371 review: the FRAME event of a frame already in flight when the style is released
// carries the frameId the renderer had at release time, and that frame can still read the
// style - only a strictly later frame retires it.
test("a frame already in flight at release does not retire the previous style", async () => {
  await using dir = await tmpdir()
  await mkdir(path.join(dir.path, "state"), { recursive: true })
  await writeFile(path.join(dir.path, "state", "kv.json"), "{}")
  const config = createTuiResolvedConfig()
  let theme!: ReturnType<typeof useTheme>

  function Probe() {
    theme = useTheme()
    return <code filetype="typescript" content={"const value = 1"} syntaxStyle={theme.syntax()} />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: path.join(dir.path, "state") }}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <Probe />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30 },
  )

  try {
    await waitFor(app, () => (theme ? true : undefined))
    await app.renderer.idle()
    await app.renderOnce()
    app.renderer.pause()
    const previous = theme.syntax()
    expect(usable(previous)).toBe(true)

    expect(theme.set("nord")).toBe(true)
    app.renderer.pause()

    // A FRAME event for the frame that was already in flight when the style was released
    // (the frameId the renderer held at release) must not retire the style yet.
    app.renderer.emit(CliRenderEvents.FRAME, { frameId: app.renderer.frameId } satisfies CliRendererFrameEvent)
    expect(usable(previous)).toBe(true)

    // Only a strictly later frame retires it.
    app.renderer.emit(CliRenderEvents.FRAME, { frameId: app.renderer.frameId + 1 } satisfies CliRendererFrameEvent)
    expect(usable(previous)).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})
