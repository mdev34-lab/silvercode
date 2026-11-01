// Editor handoff on Windows (#441).
//
// `renderer.suspend()` restores the console mode it found, which re-enables
// ENABLE_PROCESSED_INPUT: Ctrl+C then becomes a CTRL_C_EVENT for every process
// attached to the console instead of input the editor can read. The runtime's
// Ctrl+C guard only re-asserts after raw-mode toggles on the stream it was
// installed for, so `openEditor` has to re-assert at the handoff, on the
// runtime's own stdin, before the editor is spawned.
//
// The handoff is driven through the real editor source with a fake console
// mode and a stub spawn, so no console or editor process is involved.
import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import path from "node:path"
import vm from "node:vm"

const sourceFile = new URL("../src/editor.ts", import.meta.url)
const source = new Bun.Transpiler({ loader: "ts" })
  .transformSync(await Bun.file(sourceFile).text())
  .replace(/^import[\s\S]*?from ["'][^"']+["'];?\n/gm, "")
  .replaceAll("export async function ", "async function ")
  .replaceAll("export function ", "function ")
  .replaceAll("export const ", "const ")

const ENABLE_PROCESSED_INPUT = 0x0001

function fixture(input: { mode: number; stdin?: unknown } = { mode: 7 }) {
  // Console mode is console-global: suspend() puts processed input back, the
  // handoff has to clear it again before the editor reads the console.
  let mode = input.mode
  const calls: string[] = []
  const asserted: unknown[] = []
  const spawned: { stdio: unknown }[] = []
  const renderer = {
    isDestroyed: false,
    async suspend() {
      calls.push("suspend")
      mode |= ENABLE_PROCESSED_INPUT
    },
    async resume() {
      calls.push("resume")
    },
    requestRender() {
      calls.push("render")
    },
    currentRenderBuffer: { clear() {} },
  }
  const api = vm.runInNewContext(`(() => { ${source}; return { openEditor } })()`, {
    existsSync: () => true,
    readdirSync: () => [],
    readFileSync: () => "",
    statSync: () => ({ mtimeMs: 0 }),
    readFile: async () => "edited\n",
    rm: async () => {},
    writeFile: async () => {},
    os: { tmpdir: () => path.join("/tmp", "silvercode-test") },
    path,
    spawn: (_command: string, _args: string[], options: { stdio: unknown }) => {
      calls.push("spawn")
      spawned.push({ stdio: options.stdio })
      const child = new EventEmitter()
      queueMicrotask(() => child.emit("exit", 0, null))
      return child
    },
    resolveZedDbPath: () => undefined,
    resolveZedSelection: () => undefined,
    win32DisableProcessedInput: (stdin: unknown) => {
      calls.push("assert")
      asserted.push(stdin)
      mode &= ~ENABLE_PROCESSED_INPUT
    },
    // The real editor is never started; a stub command name is enough.
    process: {
      env: { EDITOR: "test-editor", VISUAL: undefined },
      platform: "win32",
      cwd: () => "/work",
      stdin: { isTTY: true },
    },
    queueMicrotask,
  })
  return { api, renderer, calls, asserted, spawned, mode: () => mode }
}

test("editor handoff re-clears processed input after suspend and before spawn (#441)", async () => {
  const f = fixture()
  const stdin = { isTTY: true, setRawMode() {} }

  await f.api.openEditor({ value: "draft", renderer: f.renderer, cwd: "/work", stdin })

  // suspend() restored processed input, the handoff cleared it again, and the
  // editor was only started once Ctrl+C could no longer become a console event.
  expect(f.calls.slice(0, 3)).toEqual(["suspend", "assert", "spawn"])
  expect(f.mode() & ENABLE_PROCESSED_INPUT).toBe(0)
  // The runtime's stdin owns the console; re-asserting on process.stdin would
  // miss the CONIN$ stream a mini runtime reads when stdin is redirected.
  expect(f.asserted).toEqual([stdin])
  expect(f.spawned[0]?.stdio).toEqual([stdin, "inherit", "inherit"])
})

test("editor handoff re-asserts on process stdin when the runtime hands over none", async () => {
  const f = fixture()
  const stdin = { isTTY: true }

  await f.api.openEditor({ value: "draft", renderer: f.renderer, stdin: "inherit" })

  expect(f.calls.slice(0, 3)).toEqual(["suspend", "assert", "spawn"])
  expect(f.asserted).toEqual([stdin])
  expect(f.spawned[0]?.stdio).toEqual(["inherit", "inherit", "inherit"])
})

test("editor handoff leaves the runtime to own SIGINT", async () => {
  const f = fixture()
  const listeners = process.listeners("SIGINT")

  await f.api.openEditor({ value: "draft", renderer: f.renderer })

  // The mini runtime detaches/restores its own handler around the handoff; the
  // editor path must not install one that could swallow a real SIGINT.
  expect(process.listeners("SIGINT")).toEqual(listeners)
})
