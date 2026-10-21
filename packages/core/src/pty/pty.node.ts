import * as pty from "@lydell/node-pty"
import type { Opts, Proc } from "./pty"

export type { Disp, Exit, Opts, Proc } from "./pty"

/**
 * True when a spawn failure looks like the bundled ConPTY DLL could not be
 * loaded (blocked by policy, quarantined, or corrupt) rather than the spawn
 * request itself being invalid (bad file, bad args). Only DLL-load failures
 * justify retrying with the system ConPTY (#443).
 */
export function isConptyDllLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /conpty|\.dll|specified module could not be found|winerror 126|\b0x7e\b/i.test(message)
}

/**
 * Spawn with the bundled ConPTY DLL, falling back to the operating system's
 * own ConPTY when the DLL fails to load. Non-DLL failures are rethrown
 * without a pointless retry; when both backends fail the thrown error
 * carries both underlying errors as `cause`. Exported for tests; the
 * win32-only caller passes the platform spawn through.
 */
export function spawnWithConptyFallback<T>(spawnBackend: (backend: { useConptyDll: boolean }) => T): T {
  try {
    return spawnBackend({ useConptyDll: true })
  } catch (firstError) {
    if (!isConptyDllLoadError(firstError)) throw firstError
    try {
      return spawnBackend({ useConptyDll: false })
    } catch (secondError) {
      throw new Error("ConPTY spawn failed with both the bundled DLL and the system ConPTY", {
        cause: { first: firstError, second: secondError },
      })
    }
  }
}

export function spawn(file: string, args: string[], opts: Opts): Proc {
  // On Windows the bundled ConPTY DLL is preferred, but a blocked or corrupt
  // DLL must not make terminal creation impossible: fall back to the
  // operating system's own ConPTY (#443). @lydell/node-pty ships no winpty
  // backend, so system ConPTY is the only degradation path available.
  const proc =
    process.platform === "win32"
      ? spawnWithConptyFallback((backend) => pty.spawn(file, args, { ...opts, ...backend }))
      : pty.spawn(file, args, opts)
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
