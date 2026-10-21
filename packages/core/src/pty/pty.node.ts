import * as pty from "@lydell/node-pty"
import type { Opts, Proc } from "./pty"

export type { Disp, Exit, Opts, Proc } from "./pty"

export function spawn(file: string, args: string[], opts: Opts): Proc {
  // On Windows the bundled ConPTY DLL is preferred, but a blocked or corrupt
  // DLL must not make terminal creation impossible: fall back to the
  // operating system's own ConPTY (#443). @lydell/node-pty ships no winpty
  // backend, so system ConPTY is the only degradation path available.
  const backends: Record<string, unknown>[] = process.platform === "win32" ? [{ useConptyDll: true }, { useConptyDll: false }] : [{}]
  let lastError: unknown
  let proc: ReturnType<typeof pty.spawn> | undefined
  for (const backend of backends) {
    try {
      proc = pty.spawn(file, args, { ...opts, ...backend })
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!proc) throw lastError
  return {
    pid: proc.pid,
    onData(listener) {
      return proc.onData(listener)
    },
    onExit(listener) {
      return proc.onExit(listener)
    },
    write(data) {
      proc.write(data)
    },
    resize(cols, rows) {
      proc.resize(cols, rows)
    },
    kill(signal) {
      proc.kill(signal)
    },
  }
}
