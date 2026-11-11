/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { onMount, type JSX } from "solid-js"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider, type ThemeSource } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { DiffViewerFileTree } from "../../../src/feature-plugins/system/diff-viewer-file-tree"
import { TestTuiContexts } from "../../fixture/tui-environment"
import {
  allExpandedFileTreeDirectories,
  buildFileTree,
} from "../../../src/feature-plugins/system/diff-viewer-file-tree-utils"

const RENDER_BUDGET_MS = 25 + 40 * 25

const theme = {
  background: RGBA.fromHex("#000000"),
  backgroundPanel: RGBA.fromHex("#111111"),
  backgroundElement: RGBA.fromHex("#333333"),
  primary: RGBA.fromHex("#00ffff"),
  secondary: RGBA.fromHex("#0088ff"),
  selectedListItemText: RGBA.fromHex("#ffffff"),
  text: RGBA.fromHex("#ffffff"),
  textMuted: RGBA.fromHex("#888888"),
  error: RGBA.fromHex("#ff0000"),
}

describe("DiffViewerFileTree", () => {
  test.skip("renders sorted hierarchical file rows", async () => {
    const app = await testRender(
      () =>
        withTheme(() => (
          <DiffViewerFileTree
            width={32}
            files={[
              { file: "z-file.ts" },
              { file: "b/file.ts" },
              { file: "a/zeta.ts" },
              { file: "b/alpha.ts" },
              { file: "a/alpha.ts" },
            ]}
            loading={false}
            error={undefined}
            theme={theme}
            focused={true}
          />
        )),
      { width: 40, height: 20 },
    )

    try {
      await renderOnceSettled(app)
      const lines = visibleLines(await captureFrameWithin(app, performance.now() + 40 * 25))

      expect(lines).toEqual([
        "▾ a",
        "│  ├─ alpha.ts               ?",
        "│  └─ zeta.ts                ?",
        "├─ ▾ b",
        "│  ├─ alpha.ts               ?",
        "│  └─ file.ts                ?",
      ])
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps loading and error quiet while rendering an empty settled state", async () => {
    const loading = await renderFrame(() => (
      <DiffViewerFileTree width={32} files={[]} loading={true} error={undefined} theme={theme} />
    ))
    const failed = await renderFrame(() => (
      <DiffViewerFileTree width={32} files={[]} loading={false} error={new Error("nope")} theme={theme} />
    ))
    const empty = await renderFrame(() => (
      <DiffViewerFileTree width={32} files={[]} loading={false} error={undefined} theme={theme} />
    ))

    expect(loading).not.toContain("Loading diff...")
    expect(loading).not.toContain("No files")
    expect(failed).not.toContain("Failed to load diff")
    expect(failed).not.toContain("No files")
    expect(empty).toContain("No files")
  })

  test("does not render text markers for highlighted rows", async () => {
    const files = [{ file: "src/config/tui.ts" }, { file: "README.md" }]
    const src = buildFileTree(files).nodes.find((node) => node.kind === "directory" && node.name === "src")!

    const focused = visibleLines(
      await renderFrame(() => (
        <DiffViewerFileTree
          width={32}
          files={files}
          loading={false}
          error={undefined}
          theme={theme}
          focused
          highlightedNode={src.id}
        />
      )),
    )
    const unfocused = visibleLines(
      await renderFrame(() => (
        <DiffViewerFileTree width={32} files={files} loading={false} error={undefined} theme={theme} />
      )),
    )

    expect(focused).toContain("▾ src/config")
    expect(unfocused).toContain("▾ src/config")
    expect(focused.some((line) => line.includes("*"))).toBe(false)
    expect(unfocused.some((line) => line.includes("*"))).toBe(false)
  })

  test("renders collapsed and expanded directory rows", async () => {
    const files = [{ file: "src/config/tui.ts" }, { file: "README.md" }]
    const tree = buildFileTree(files)
    const src = tree.nodes.find((node) => node.kind === "directory" && node.name === "src")!
    const collapsed = allExpandedFileTreeDirectories(tree)
    collapsed.delete(src.id)

    expect(
      visibleLines(
        await renderFrame(() => (
          <DiffViewerFileTree
            width={32}
            files={files}
            loading={false}
            error={undefined}
            theme={theme}
            expandedNodes={collapsed}
          />
        )),
      ),
    ).toEqual(["▸ src/config"])

    expect(
      visibleLines(
        await renderFrame(() => (
          <DiffViewerFileTree
            files={files}
            width={32}
            loading={false}
            error={undefined}
            theme={theme}
            expandedNodes={allExpandedFileTreeDirectories(tree)}
          />
        )),
      ),
    ).toEqual(["▾ src/config", "│  └─ tui.ts                 ?"])
  })

  test("holds the file tree unmounted until deferred theme discovery resolves", async () => {
    let startedResolve!: () => void
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve
    })
    let resolveDiscover!: (value: Record<string, unknown>) => void
    const discoverGate = new Promise<Record<string, unknown>>((resolve) => {
      resolveDiscover = resolve
    })
    const source: ThemeSource = {
      discover: async () => {
        startedResolve()
        return discoverGate
      },
    }

    let mounted = false
    let captureCount = 0
    const capture = (app: Awaited<ReturnType<typeof testRender>>, deadline: number) => {
      captureCount += 1
      return captureFrameWithin(app, deadline)
    }
    const component = () => <DiffViewerFileTree width={32} files={[]} loading={false} error={undefined} theme={theme} />

    const framePromise = renderFrame(component, {
      source,
      onMount: () => {
        mounted = true
      },
      capture,
    })

    await started
    expect(mounted).toBe(false)
    expect(captureCount).toBe(0)

    resolveDiscover({})
    const frame = await framePromise
    expect(mounted).toBe(true)
    expect(captureCount).toBeGreaterThan(0)
    expect(frame).toContain("No files")
  })

  test("fails closed when theme discovery never resolves", async () => {
    const source: ThemeSource = { discover: () => new Promise<Record<string, unknown>>(() => {}) }
    let mounted = false
    const component = () => <DiffViewerFileTree width={32} files={[]} loading={false} error={undefined} theme={theme} />

    const app = await testRender(
      () =>
        withTheme(component, {
          source,
          onMount: () => {
            mounted = true
          },
        }),
      {
        width: 40,
        height: 10,
      },
    )
    const deadline = performance.now() + RENDER_BUDGET_MS
    const start = performance.now()
    let thrown: unknown

    try {
      await waitForFileTreeMount(app, () => mounted, deadline)
      await captureSettledFrame(app, deadline)
    } catch (error) {
      thrown = error
    } finally {
      app.renderer.destroy()
    }

    expect(thrown).toEqual(new Error("Timed out waiting for DiffViewerFileTree to mount"))
    expect(app.renderer.isDestroyed).toBe(true)
    expect(performance.now() - start).toBeLessThan(RENDER_BUDGET_MS + 250)
  })
})

async function waitForFileTreeMount(
  app: Awaited<ReturnType<typeof testRender>>,
  mounted: () => boolean,
  deadline: number,
) {
  while (!mounted()) {
    await renderWithin(app, deadline)
    if (mounted()) break
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error("Timed out waiting for DiffViewerFileTree to mount")
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)))
  }
  if (!mounted()) throw new Error("Timed out waiting for DiffViewerFileTree to mount")
}

async function renderWithin(app: Awaited<ReturnType<typeof testRender>>, deadline: number) {
  if (performance.now() > deadline) throw new Error("Timed out waiting for DiffViewerFileTree to mount")
  await app.renderOnce()
  if (performance.now() > deadline) throw new Error("Timed out waiting for DiffViewerFileTree to mount")
}

async function renderFrame(
  component: () => JSX.Element,
  options?: {
    source?: ThemeSource
    onMount?: () => void
    capture?: (app: Awaited<ReturnType<typeof testRender>>, deadline: number) => Promise<string>
  },
) {
  let mounted = false
  const app = await testRender(
    () =>
      withTheme(component, {
        ...options,
        onMount: () => {
          mounted = true
          options?.onMount?.()
        },
      }),
    {
      width: 40,
      height: 10,
    },
  )
  const deadline = performance.now() + RENDER_BUDGET_MS

  try {
    await waitForFileTreeMount(app, () => mounted, deadline)
    return await captureSettledFrame(app, deadline, options?.capture ?? captureFrameWithin)
  } finally {
    app.renderer.destroy()
  }
}

async function renderOnceSettled(app: Awaited<ReturnType<typeof testRender>>) {
  await app.renderOnce()
  await new Promise((resolve) => setTimeout(resolve, 25))
  await app.renderOnce()
}

async function captureFrameWithin(app: Awaited<ReturnType<typeof testRender>>, deadline: number) {
  for (;;) {
    try {
      return app.captureCharFrame()
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("OutputBusy")) throw error
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new Error("Timed out waiting for DiffViewerFileTree frame to settle")
      await new Promise((resolve) => setTimeout(resolve, Math.min(5, remaining)))
    }
  }
}

async function captureSettledFrame(
  app: Awaited<ReturnType<typeof testRender>>,
  deadline: number,
  capture: (app: Awaited<ReturnType<typeof testRender>>, deadline: number) => Promise<string> = captureFrameWithin,
) {
  for (;;) {
    const beforeCapture = deadline - performance.now()
    if (beforeCapture <= 0) throw new Error("Timed out waiting for DiffViewerFileTree frame to settle")
    const frame = await capture(app, deadline)
    if (performance.now() > deadline) throw new Error("Timed out waiting for DiffViewerFileTree frame to settle")
    if (frame.trim().length > 0) return frame
    await renderWithin(app, deadline)
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error("Timed out waiting for DiffViewerFileTree frame to settle")
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)))
  }
}

function Mounted(props: { onMount?: () => void; children: JSX.Element }) {
  onMount(() => props.onMount?.())
  return props.children
}

function withTheme(component: () => JSX.Element, options?: { source?: ThemeSource; onMount?: () => void }) {
  return (
    <TestTuiContexts>
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <ThemeProvider mode="dark" source={options?.source ?? { discover: async () => ({}) }}>
            <Mounted onMount={options?.onMount}>{component()}</Mounted>
          </ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    </TestTuiContexts>
  )
}

function visibleLines(frame: string) {
  return frame
    .split("\n")
    .map((line) => line.trimEnd())
    .map((line) => line.replace(/^ ?│ ?/, "").replace(/[ │]*$/, ""))
    .map((line) => (line.startsWith(" ") ? line.slice(1) : line))
    .filter((line) => line.length > 0 && !/^┌|^└|^─+$/.test(line))
}
