import { dlopen, ptr } from "bun:ffi"

const STD_INPUT_HANDLE = -10
const ENABLE_PROCESSED_INPUT = 0x0001

const kernel = () =>
  dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "ptr" },
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "ptr" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
    GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
    SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
    FlushConsoleInputBuffer: { args: ["ptr"], returns: "i32" },
  })

let k32: ReturnType<typeof kernel> | undefined

function load() {
  if (process.platform !== "win32") return false
  try {
    k32 ??= kernel()
    return true
  } catch {
    return false
  }
}

// A renderer may read CONIN$ while process.stdin is a pipe. GetStdHandle
// then names the pipe, so open the controlling console rather than using the
// stream's CRT fd as a Win32 HANDLE. Only handles opened here are owned here.
function consoleInput(stdin: NodeJS.ReadStream) {
  if (!stdin.isTTY || !load()) return
  if (stdin === process.stdin) {
    return { handle: k32!.symbols.GetStdHandle(STD_INPUT_HANDLE), close: () => {} }
  }
  const name = new Uint16Array([..."CONIN$\0"].map((char) => char.charCodeAt(0)))
  const handle = k32!.symbols.CreateFileW(ptr(name), 0xc0000000, 3, null, 3, 0, null)
  if (!handle || Number(handle) === -1 || Number(handle) === 0xffffffff || Number(handle) === 0xffffffffffffffff) return
  return {
    handle,
    close: () => {
      k32!.symbols.CloseHandle(handle)
    },
  }
}

/**
 * Clear ENABLE_PROCESSED_INPUT on the console stdin handle.
 */
export function win32DisableProcessedInput(stdin: NodeJS.ReadStream = process.stdin) {
  if (process.platform !== "win32") return
  const source = consoleInput(stdin)
  if (!source) return
  try {
    const buf = new Uint32Array(1)
    if (k32!.symbols.GetConsoleMode(source.handle, ptr(buf)) === 0) return
    const mode = buf[0]!
    if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
    k32!.symbols.SetConsoleMode(source.handle, mode & ~ENABLE_PROCESSED_INPUT)
  } finally {
    source.close()
  }
}

/**
 * Discard any queued console input (mouse events, key presses, etc.).
 */
export function win32FlushInputBuffer() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  k32!.symbols.FlushConsoleInputBuffer(handle)
}

let unhook: (() => void) | undefined

/**
 * Keep ENABLE_PROCESSED_INPUT disabled.
 *
 * On Windows, Ctrl+C becomes a CTRL_C_EVENT (instead of stdin input) when
 * ENABLE_PROCESSED_INPUT is set. Various runtimes can re-apply console modes
 * (sometimes on a later tick), and the flag is console-global, not per-process.
 *
 * We combine:
 * - A `setRawMode(...)` hook to re-clear after known raw-mode toggles.
 * - A low-frequency poll as a backstop for native/external mode changes.
 */
export function win32InstallCtrlCGuard(stdin: NodeJS.ReadStream = process.stdin) {
  if (process.platform !== "win32") return
  if (!stdin.isTTY) return
  if (unhook) return unhook
  const source = consoleInput(stdin)
  if (!source) return
  const original = stdin.setRawMode
  const handle = source.handle
  const buf = new Uint32Array(1)

  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) {
    source.close()
    return
  }
  const initial = buf[0]!
  let done = false

  const enforce = () => {
    if (done) return
    if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return
    const mode = buf[0]!
    if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
    k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
  }

  // Some runtimes can re-apply console modes on the next tick; enforce twice.
  const later = () => {
    enforce()
    setImmediate(enforce)
  }

  let wrapped: NodeJS.ReadStream["setRawMode"] | undefined

  let interval: ReturnType<typeof setInterval> | undefined
  const cleanup = () => {
    if (done) return
    done = true
    if (interval) clearInterval(interval)
    try {
      if (wrapped && stdin.setRawMode === wrapped) stdin.setRawMode = original
      k32!.symbols.SetConsoleMode(handle, initial)
    } finally {
      source.close()
      unhook = undefined
    }
  }

  try {
    if (typeof original === "function") {
      wrapped = (mode: boolean) => {
        const result = original.call(stdin, mode)
        later()
        return result
      }
      stdin.setRawMode = wrapped
    }
    later()
    interval = setInterval(enforce, 100)
    interval.unref()
    unhook = cleanup
  } catch (error) {
    cleanup()
    throw error
  }

  return unhook
}
