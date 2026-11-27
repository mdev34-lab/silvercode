import { spawn as create } from "bun-pty"
import { windowsConsoleCodePage } from "../shell-encoding"
import { conptyTextDecoder, normalizeConptyOutput } from "./encoding"
import type { Opts, Proc } from "./pty"

export type { Disp, Exit, Opts, Proc } from "./pty"

export function spawn(file: string, args: string[], opts: Opts): Proc {
  const proc = create(file, args, opts)
  const session: Proc = {
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
  // Same ConPTY stream shape as the node backend: text arrives as UTF-8, and
  // byte-oriented output was expanded through the console codepage first (#710).
  if (process.platform !== "win32") return session
  return normalizeConptyOutput(session, conptyTextDecoder({ codepage: windowsConsoleCodePage() }))
}
