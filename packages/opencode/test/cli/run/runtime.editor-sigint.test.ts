// Mini editor handoff (Windows Ctrl+C, #441).
//
// The mini runtime owns the console through the split-footer lifecycle. While
// an external editor owns the console, Ctrl+C must reach the editor: the
// runtime detaches its own SIGINT handler for the handoff and restores it
// afterwards, so an editor session can never take the runtime's cleanup path
// away from it. That handoff runs inside `createRuntimeLifecycle`, so it is
// driven here through the real lifecycle source with a fake renderer, footer
// and console, and no terminal.
import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import path from "node:path"
import vm from "node:vm"

const sourceFile = new URL("../../../src/cli/cmd/run/runtime.lifecycle.ts", import.meta.url)
const source = new Bun.Transpiler({ loader: "ts" })
  .transformSync(await Bun.file(sourceFile).text())
  .replace(/^import[\s\S]*?from ["'][^"']+["'];?\n/gm, "")
  .replaceAll('import("./footer")', "Promise.resolve(__footer)")
  .replaceAll("export ", "")

type EditorHandoff = (input: { value: string }) => Promise<string | undefined>

// The handoff awaits the renderer before it starts the editor; settle those
// microtasks instead of sleeping.
async function flush() {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}

function fixture() {
  const exited: number[] = []
  const opens: unknown[] = []
  const proc = Object.assign(new EventEmitter(), {
    platform: "win32",
    env: {},
    pid: 4711,
    stdout: { write() {} },
  })
  const stdin = { isTTY: true, setRawMode() {} }
  const renderer = {
    isDestroyed: false,
    externalOutputMode: "capture-stdout",
    screenMode: "split-footer",
    terminalWidth: 80,
    terminalHeight: 24,
    setBackgroundColor() {},
    async idle() {},
    writeToScrollback() {},
    requestRender() {},
    on() {},
    off() {},
    resetSplitFooterForReplay() {},
    destroy() {},
  }
  let handoff: EditorHandoff | undefined
  let settleEditor: { resolve: (value: string) => void; reject: (error: Error) => void } | undefined
  const footer = {
    isClosed: false,
    requestExit() {
      exited.push(1)
    },
    async idle() {},
    close() {},
    destroy() {},
    refreshTheme() {},
    currentTheme: () => ({ splash: {} }),
    resetForReplay() {},
  }
  const api = vm.runInNewContext(`(() => { ${source}; return { createRuntimeLifecycle } })()`, {
    path,
    console,
    process: proc,
    CliRenderEvents: { RESIZE: "resize" },
    createCliRenderer: async () => renderer,
    Global: { Path: { home: "/home/tester" } },
    openEditor: (input: unknown) => {
      opens.push(input)
      return new Promise<string>((resolve, reject) => {
        settleEditor = { resolve, reject }
      })
    },
    win32InstallCtrlCGuard: () => () => {},
    registerOpencodeKeymap: () => () => {},
    SessionApi: { isDefaultTitle: () => false },
    Locale: { titlecase: (value: string) => value },
    resolveInteractiveStdin: () => ({ stdin }),
    entrySplash: (input: unknown) => input,
    exitSplash: (input: unknown) => input,
    splashMeta: (input: unknown) => input,
    resolveRunTheme: async () => ({ background: "#000000", splash: {} }),
    createDefaultOpenTuiKeymap: () => ({}),
    formatModelLabel: () => "test/model",
    __footer: {
      RunFooter: class {
        constructor(_renderer: unknown, input: { onEditorOpen: EditorHandoff }) {
          handoff = input.onEditorOpen
          return Object.assign(Object.create(this), footer) as never
        }
      },
    },
  })
  return {
    api: api as { createRuntimeLifecycle: (input: unknown) => Promise<{ close: () => Promise<void> }> },
    proc,
    stdin,
    opens,
    exited,
    handoff: () => {
      if (!handoff) throw new Error("editor handoff was not wired")
      return handoff
    },
    finishEditor(value: string) {
      settleEditor?.resolve(value)
    },
    failEditor(error: Error) {
      settleEditor?.reject(error)
    },
  }
}

function lifecycleInput() {
  return {
    directory: "/work",
    findFiles: async () => [],
    agents: [],
    resources: [],
    sessionID: "session-1",
    sessionTitle: "session",
    first: true,
    history: [],
    agent: "work",
    model: undefined,
    variant: undefined,
    tuiConfig: { diff_style: "auto" },
    onPermissionReply: () => {},
    onQuestionReply: () => {},
    onQuestionReject: () => {},
  }
}

test("the editor handoff hands Ctrl+C to the editor and restores the runtime handler (#441)", async () => {
  const f = fixture()
  await f.api.createRuntimeLifecycle(lifecycleInput())

  // The runtime owns SIGINT while it owns the console.
  expect(f.proc.listenerCount("SIGINT")).toBe(1)
  const runtime = f.proc.listeners("SIGINT")[0]
  f.proc.emit("SIGINT")
  expect(f.exited).toHaveLength(1)

  const handoff = f.handoff()({ value: "draft" })
  await flush()

  // While the editor owns the console the runtime handler is detached, so a
  // console Ctrl+C cannot request a runtime exit behind the editor's back.
  expect(f.opens).toHaveLength(1)
  expect(f.proc.listenerCount("SIGINT")).toBe(1)
  expect(f.proc.listeners("SIGINT")[0]).not.toBe(runtime)
  f.proc.emit("SIGINT")
  expect(f.exited).toHaveLength(1)

  f.finishEditor("edited")
  await expect(handoff).resolves.toBe("edited")

  // Resume restores the same handler, so Ctrl+C drives the runtime cleanup
  // path again instead of leaving the console ownerless.
  expect(f.proc.listenerCount("SIGINT")).toBe(1)
  expect(f.proc.listeners("SIGINT")[0]).toBe(runtime)
  f.proc.emit("SIGINT")
  expect(f.exited).toHaveLength(2)
})

test("the editor handoff restores the runtime handler when the editor fails", async () => {
  const f = fixture()
  await f.api.createRuntimeLifecycle(lifecycleInput())
  const runtime = f.proc.listeners("SIGINT")[0]
  const failure = new Error("Editor exited with code 1")

  const handoff = f.handoff()({ value: "draft" })
  await flush()
  f.failEditor(failure)
  await expect(handoff).rejects.toBe(failure)

  // The detached runtime handler comes back on the failure path too, so a
  // broken editor cannot leave the mini runtime without a console owner.
  expect(f.proc.listenerCount("SIGINT")).toBe(1)
  expect(f.proc.listeners("SIGINT")[0]).toBe(runtime)
  f.proc.emit("SIGINT")
  expect(f.exited).toHaveLength(1)
})
