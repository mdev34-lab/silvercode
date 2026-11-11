/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { DiffRenderable, type Renderable, ScrollBoxRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import type { TuiPluginApi, TuiPluginMeta, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import type { Session } from "@opencode-ai/sdk/v2"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { TuiKeybind } from "../../../src/config/keybind"
import { OpencodeKeymapProvider } from "../../../src/keymap"
import diffViewerPlugin from "../../../src/feature-plugins/system/diff-viewer"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { Flock } from "@opencode-ai/core/util/flock"
import path from "path"
import { onMount, type ParentProps } from "solid-js"
test("closing the diff viewer returns to the route it opened from", async () => {
  const viewer = await renderDiffViewer([])
  try {
    expect(viewer.current()).toEqual({
      name: "diff",
      params: { mode: "git", sessionID: "session-1", returnRoute: startRoute },
    })
    expect(viewer.vcsDiffInput()).toEqual({ directory: "/repo/session", mode: "git", context: 12 })

    expect(viewer.commands.has("diff.close")).toBe(true)
    viewer.commands.get("diff.close")!.run?.({} as never)
    expect(viewer.current()).toEqual(startRoute)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("brackets navigate diff hunks", async () => {
  const viewer = await renderDiffViewer(
    [
      {
        file: "src/file.ts",
        additions: 3,
        deletions: 3,
        status: "modified",
        patch: `--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,3 @@
 const first = true
-const oldFirst = true
+const newFirst = true
 const afterFirst = true
@@ -20,3 +20,3 @@
 const second = true
-const oldSecond = true
+const newSecond = true
 const afterSecond = true
@@ -40,3 +40,3 @@
 const third = true
-const oldThird = true
+const newThird = true
 const afterThird = true`,
      },
    ],
    12,
  )
  try {
    await viewer.app.waitForFrame((frame) => frame.includes("const first"))
    await viewer.app.waitFor(() => Boolean(findScrollBox(viewer.app.renderer.root)))
    await viewer.app.flush()
    const scroll = findScrollBox(viewer.app.renderer.root)!
    const initial = scroll.scrollTop

    expect(TuiKeybind.defaultValue("diff_next_hunk")).toBe("]")
    expect(TuiKeybind.defaultValue("diff_previous_hunk")).toBe("[")

    viewer.commands.get("diff.next_hunk")!.run?.({} as never)
    await viewer.app.renderOnce()
    const first = scroll.scrollTop
    expect(first).toBeGreaterThan(initial)

    viewer.commands.get("diff.next_hunk")!.run?.({} as never)
    await viewer.app.renderOnce()
    const second = scroll.scrollTop
    expect(second).toBeGreaterThan(first)

    viewer.commands.get("diff.previous_hunk")!.run?.({} as never)
    await viewer.app.renderOnce()
    expect(scroll.scrollTop).toBe(first)

    viewer.commands.get("diff.next_hunk")!.run?.({} as never)
    await viewer.app.renderOnce()
    expect(scroll.scrollTop).toBe(second)

    scroll.scrollTo(initial)
    viewer.commands.get("diff.next_hunk")!.run?.({} as never)
    await viewer.app.renderOnce()
    expect(scroll.scrollTop).toBe(first)
  } finally {
    viewer.app.renderer.destroy()
  }
})

async function renderDiffViewer(
  vcsDiff: unknown[],
  height = 20,
  initialRoute?: TuiRouteCurrent,
  holdSelectedRequestUntilCommandObserved = false,
) {
  let releaseSelectedRequest: (() => void) | undefined
  const selectedRequestGate = holdSelectedRequestUntilCommandObserved
    ? new Promise<void>((resolve) => {
        releaseSelectedRequest = resolve
      })
    : undefined
  const commands = new Map<
    string,
    NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]
  >()
  let current = initialRoute ?? startRoute
  let mounted = false
  let renderDiff: TuiRouteDefinition["render"] | undefined
  let vcsDiffInput: unknown
  let sessionDiffInput: unknown
  const config = createTuiResolvedConfig()
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const registerLayer = keymap.registerLayer.bind(keymap)
    keymap.registerLayer = (layer) => {
      layer.commands?.forEach((command) => commands.set(command.name, command))
      return registerLayer(layer)
    }
    const base = createTuiPluginApi({
      keymap,
      client: {
        vcs: {
          diff: async (input: unknown) => {
            await selectedRequestGate
            vcsDiffInput = input
            return { data: vcsDiff }
          },
        },
        session: {
          diff: async (input: unknown) => {
            await selectedRequestGate
            sessionDiffInput = input
            return { data: [] }
          },
        },
      } as unknown as TuiPluginApi["client"],
      state: {
        session: {
          get: () => session,
        },
      },
    })
    const api = {
      ...base,
      route: {
        register(routes) {
          renderDiff = routes.find((route) => route.name === "diff")?.render
          return () => {}
        },
        navigate(name, params) {
          current = params ? { name, params } : { name }
        },
        get current() {
          return current
        },
      },
    } satisfies TuiPluginApi

    void diffViewerPlugin.tui(api, undefined, pluginMeta)
    if (!initialRoute) commands.get("diff.open")?.run?.({} as never)

    return (
      <TestTuiContexts>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <Mounted>
                  {renderDiff?.({ params: "params" in current ? current.params : undefined })}
                </Mounted>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  function Mounted(props: ParentProps) {
    onMount(() => {
      mounted = true
    })
    return props.children
  }

  const app = await testRender(() => <Harness />, { width: 80, height })
  const selectedRequestReady = () => {
    if (current.name !== "diff" || !current.params) return false
    if (current.params.mode === "last-turn") return sessionDiffInput !== undefined
    return vcsDiffInput !== undefined
  }
  await waitForViewerReadyAndCleanup(app, () =>
    waitForViewerReady(
      app,
      commands,
      "diff.close",
      selectedRequestReady,
      holdSelectedRequestUntilCommandObserved ? () => setTimeout(() => releaseSelectedRequest?.(), 0) : undefined,
      () => mounted,
    ),
  )
  return {
    app,
    commands,
    current: () => current,
    vcsDiffInput: () => vcsDiffInput,
    sessionDiffInput: () => sessionDiffInput,
  }
}

const startRoute: TuiRouteCurrent = { name: "session", params: { sessionID: "session-1" } }

function findScrollBox(root: Renderable): ScrollBoxRenderable | undefined {
  if (root instanceof ScrollBoxRenderable && containsDiff(root)) return root
  return root.getChildren().map(findScrollBox).find(Boolean)
}

function containsDiff(root: Renderable): boolean {
  if (root instanceof DiffRenderable) return true
  return root.getChildren().some(containsDiff)
}

const session = {
  id: "session-1",
  slug: "session-1",
  projectID: "project-1",
  directory: "/repo/session",
  title: "Session",
  version: "1",
  time: {
    created: 0,
    updated: 0,
  },
} satisfies Session

test("diff viewer waits for its selected VCS request after command registration", async () => {
  const viewer = await renderDiffViewer(
    [],
    20,
    {
      name: "diff",
      params: { mode: "branch", sessionID: "session-1", returnRoute: startRoute },
    },
    true,
  )
  try {
    expect(viewer.commands.has("diff.close")).toBe(true)
    expect(viewer.vcsDiffInput()).toEqual({ directory: "/repo/session", mode: "branch", context: 12 })
    expect(viewer.sessionDiffInput()).toBeUndefined()
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("last-turn viewer waits for its selected session request after command registration", async () => {
  const viewer = await renderDiffViewer(
    [],
    20,
    {
      name: "diff",
      params: { mode: "last-turn", sessionID: "session-1", messageID: "message-1", returnRoute: startRoute },
    },
    true,
  )
  try {
    expect(viewer.commands.has("diff.close")).toBe(true)
    expect(viewer.sessionDiffInput()).toEqual({ sessionID: "session-1", messageID: "message-1" })
    expect(viewer.vcsDiffInput()).toBeUndefined()
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("branch diff source requests branch VCS diff", async () => {
  const viewer = await renderDiffViewer([], 20, {
    name: "diff",
    params: { mode: "branch", sessionID: "session-1", returnRoute: startRoute },
  })
  try {
    expect(viewer.current()).toEqual({
      name: "diff",
      params: { mode: "branch", sessionID: "session-1", returnRoute: startRoute },
    })
    expect(viewer.vcsDiffInput()).toEqual({ directory: "/repo/session", mode: "branch", context: 12 })
    expect(viewer.sessionDiffInput()).toBeUndefined()
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("viewer waits for a slow KV state lock before requesting the branch diff", async () => {
  const { lockPromise } = await holdKvLock(400)
  try {
    const viewer = await renderDiffViewer([], 20, {
      name: "diff",
      params: { mode: "branch", sessionID: "session-1", returnRoute: startRoute },
    })
    try {
      expect(viewer.current()).toEqual({
        name: "diff",
        params: { mode: "branch", sessionID: "session-1", returnRoute: startRoute },
      })
      expect(viewer.vcsDiffInput()).toEqual({ directory: "/repo/session", mode: "branch", context: 12 })
      expect(viewer.sessionDiffInput()).toBeUndefined()
    } finally {
      viewer.app.renderer.destroy()
    }
  } finally {
    await lockPromise
  }
})

test("diff viewer mount timeout destroys its renderer exactly once", async () => {
  let renderCount = 0
  let destroyCount = 0
  const app = {
    renderOnce: async () => {
      renderCount++
    },
    renderer: {
      destroy: () => {
        destroyCount++
      },
    },
  } as unknown as Awaited<ReturnType<typeof testRender>>
  const error = await waitForViewerReadyAndCleanup(app, () =>
    waitForViewerReady(app, new Map(), "diff.close", () => false, undefined, () => false),
  ).then(
    () => undefined,
    (reason: unknown) => reason,
  )

  expect(error).toEqual(new Error("Timed out waiting for the diff viewer to mount"))
  expect(renderCount).toBe(50)
  expect(destroyCount).toBe(1)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(renderCount).toBe(50)
  expect(destroyCount).toBe(1)
})

test("KV lock helper propagates an acquisition rejection", async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(holdKvLock(400, controller.signal)).rejects.toBeDefined()
})

test("last-turn diff source requests session diff", async () => {
  const viewer = await renderDiffViewer([], 20, {
    name: "diff",
    params: { mode: "last-turn", sessionID: "session-1", messageID: "message-1", returnRoute: startRoute },
  })
  try {
    expect(viewer.current()).toEqual({
      name: "diff",
      params: { mode: "last-turn", sessionID: "session-1", messageID: "message-1", returnRoute: startRoute },
    })
    expect(viewer.sessionDiffInput()).toEqual({ sessionID: "session-1", messageID: "message-1" })
    expect(viewer.vcsDiffInput()).toBeUndefined()
  } finally {
    viewer.app.renderer.destroy()
  }
})

const MOUNT_ATTEMPTS = 50 // Each attempt renders once and waits 25ms, about 1.25s minimum. The KV provider mounts children only after its real file lock and read settle; a 400ms held lock mounts in roughly 0.55s. 50 attempts leaves more than twice that margin and still rejects well before Bun's default 5000ms test timeout, so the cleanup wrapper destroys the renderer while the test is active.

async function holdKvLock(durationMs: number, signal?: AbortSignal) {
  let acquired!: () => void
  const lockAcquired = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const lockPromise = Flock.withLock(`tui-kv:${path.join(`/tmp/opencode/state-${process.pid}`, "kv.json")}`, () => {
    acquired()
    return new Promise<void>((resolve) => setTimeout(resolve, durationMs))
  }, { signal })
  await Promise.race([lockAcquired, lockPromise])
  return { lockPromise }
}

async function waitForViewerReady(
  app: Awaited<ReturnType<typeof testRender>>,
  commands: Map<string, unknown>,
  command: string,
  selectedRequestReady: () => boolean,
  onCommandObserved?: () => void,
  mounted: () => boolean = () => true,
) {
  let commandObserved = false
  for (let attempt = 0; !mounted(); attempt++) {
    if (attempt >= MOUNT_ATTEMPTS) throw new Error("Timed out waiting for the diff viewer to mount")
    await app.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    await app.renderOnce()
    if (commands.has(command) && !commandObserved) {
      commandObserved = true
      onCommandObserved?.()
    }
    if (commands.has(command) && selectedRequestReady()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${command} and its selected diff request`)
}

async function waitForViewerReadyAndCleanup(app: Awaited<ReturnType<typeof testRender>>, wait: () => Promise<void>) {
  try {
    await wait()
  } catch (error) {
    app.renderer.destroy()
    throw error
  }
}

test("diff viewer readiness timeout destroys its renderer", async () => {
  let renderCount = 0
  let destroyCount = 0
  const app = {
    renderOnce: async () => {
      renderCount++
    },
    renderer: {
      destroy: () => {
        destroyCount++
      },
    },
  } as unknown as Awaited<ReturnType<typeof testRender>>
  const error = await waitForViewerReadyAndCleanup(app, () =>
    waitForViewerReady(app, new Map(), "diff.close", () => false),
  ).then(
    () => undefined,
    (reason: unknown) => reason,
  )

  expect(error).toEqual(new Error("Timed out waiting for diff.close and its selected diff request"))
  expect(renderCount).toBe(10)
  expect(destroyCount).toBe(1)
})

test("diff viewer render failure destroys its renderer and preserves the error", async () => {
  let destroyCount = 0
  const renderError = new Error("renderOnce failed")
  const app = {
    renderOnce: async () => {
      throw renderError
    },
    renderer: {
      destroy: () => {
        destroyCount++
      },
    },
  } as unknown as Awaited<ReturnType<typeof testRender>>
  const error = await waitForViewerReadyAndCleanup(app, () =>
    waitForViewerReady(app, new Map(), "diff.close", () => false),
  ).then(
    () => undefined,
    (reason: unknown) => reason,
  )

  expect(error).toBe(renderError)
  expect(destroyCount).toBe(1)
})

const pluginMeta = {
  id: "diff-viewer",
  source: "internal",
  spec: "diff-viewer",
  target: "diff-viewer",
  first_time: 0,
  last_time: 0,
  time_changed: 0,
  load_count: 1,
  fingerprint: "test",
  state: "same",
} satisfies TuiPluginMeta
