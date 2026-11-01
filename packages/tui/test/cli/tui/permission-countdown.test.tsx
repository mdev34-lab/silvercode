/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal, onMount } from "solid-js"
import { testRender } from "@opentui/solid"
import { tmpdir } from "../../fixture/fixture"
import { captureFrame } from "../../fixture/frame"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { Countdown } from "../../../src/routes/session/permission"

async function wait(condition: () => boolean | Promise<boolean>, message: string, timeout = 2000) {
  const start = Date.now()
  while (!(await condition())) {
    if (Date.now() - start > timeout) throw new Error(message)
    await Bun.sleep(10)
  }
}

async function mountCountdown(root: string) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const config = createTuiResolvedConfig({})
  // Starts long expired; each test moves the deadline once the harness is mounted, so a
  // slow setup cannot eat into the seconds the label reports.
  const [expiresAt, setExpiresAt] = createSignal(Date.now() - 5_000)
  let mounted = false

  function Harness() {
    onMount(() => {
      mounted = true
    })
    return <Countdown expiresAt={expiresAt()} />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <Harness />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 3 },
  )

  // KVProvider renders its children only once KV state has loaded, so the countdown is not
  // in the tree until the harness reports it mounted.
  await wait(() => mounted, "the countdown never mounted")
  await app.renderOnce()
  // captureFrame retries while the output buffer is leased mid-flush (OutputBusy),
  // which a raw captureCharFrame turns into a spurious failure on a busy runner.
  return { app, frame: () => captureFrame(app), setExpiresAt }
}

test("permission countdown renders the time left before the prompt is auto-denied", async () => {
  await using tmp = await tmpdir()
  const { app, frame, setExpiresAt } = await mountCountdown(tmp.path)
  try {
    setExpiresAt(Date.now() + 42_000)
    // The label updates through the reactive graph, which the renderer commits on a later
    // frame, so this polls instead of rendering once. Rendering that first frame can take
    // long enough for the countdown to tick, so either of the first two seconds counts.
    await wait(async () => /auto-deny in 4[12]s/.test(await frame()), "the countdown never rendered the time left")
    expect(await frame()).toMatch(/auto-deny in 4[12]s/)
  } finally {
    app.renderer.destroy()
  }
})

test("permission countdown stops at zero once the deadline has passed", async () => {
  await using tmp = await tmpdir()
  // The server settles the request at the deadline, but until the replied event reaches the
  // client the prompt is still on screen, so the label clamps instead of counting negative.
  const { app, frame } = await mountCountdown(tmp.path)
  try {
    await wait(async () => (await frame()).includes("auto-deny in 0s"), "the countdown never rendered the clamped label")
    expect(await frame()).toContain("auto-deny in 0s")
  } finally {
    app.renderer.destroy()
  }
})
