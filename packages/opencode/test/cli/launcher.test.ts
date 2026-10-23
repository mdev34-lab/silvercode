// The npm launcher is a plain CJS bin that runs before any package code, so it
// is driven here as a real subprocess against a stub child. OPENCODE_BIN_PATH
// replaces the platform binary, and the launcher forwards its own arguments to
// it, so the stub script is passed as an argument to the launcher entry.
//
// Windows has no POSIX signals: Ctrl+C is a console event the console delivers
// to every attached process, and child.kill("SIGINT") maps to TerminateProcess.
// Forwarding it therefore kills SilverCode before its handlers can run (#441),
// so the win32 branch must keep listening (the launcher has to survive the
// event) without forwarding to the child. A real Ctrl+C console event cannot be
// raised from a test process, so the Windows case runs through a fixture that
// pins process.platform and asserts the launcher's policy: the child must not
// observe a forwarded SIGINT.
import { expect, test } from "bun:test"
import path from "node:path"

const launcher = path.join(import.meta.dir, "../../bin/silvercode")
const win32Launcher = path.join(import.meta.dir, "../fixture/win32-launcher.cjs")
const child = path.join(import.meta.dir, "../fixture/launcher-child.js")

type Result = {
  stdout: string
  stderr: string
  exitCode: number | null
  signalCode: string | null
}

async function launch(entry: string): Promise<Result> {
  const proc = Bun.spawn({
    cmd: [process.execPath, entry, child],
    env: { ...process.env, OPENCODE_BIN_PATH: process.execPath },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  const decoder = new TextDecoder()
  let stdout = ""
  let signalled = false
  const pump = (async () => {
    for await (const chunk of proc.stdout) {
      stdout += decoder.decode(chunk)
      // Signal once the child exists so a slow launcher start cannot turn this
      // into "no child to signal yet".
      if (!signalled && stdout.includes("child:ready")) {
        signalled = true
        proc.kill("SIGINT")
      }
    }
  })()

  const exitCode = await proc.exited
  await pump
  const stderr = await new Response(proc.stderr).text()
  return { stdout, stderr, exitCode, signalCode: proc.signalCode }
}

// process.kill(pid, "SIGINT") terminates the target on Windows instead of
// delivering a signal, so the launcher's signal handling cannot be driven from
// a test process there. Both cases run on POSIX hosts; the Windows policy is
// covered by the platform-pinned fixture instead.
const noSignalDelivery = process.platform === "win32"

test.skipIf(noSignalDelivery)("forwards SIGINT to the child on POSIX hosts", async () => {
  const result = await launch(launcher)

  expect(result.stderr).toBe("")
  expect(result.stdout).toContain("child:sigint")
  expect(result.stdout).toContain("child:done")
  expect(result.exitCode).toBe(7)
})

test.skipIf(noSignalDelivery)("does not force-kill the child on win32 (#441)", async () => {
  const result = await launch(win32Launcher)

  expect(result.stderr).toBe("")
  // The console, not the launcher, delivers Ctrl+C to the child on Windows.
  expect(result.stdout).not.toContain("child:sigint")
  expect(result.stdout).toContain("child:done")
  // The launcher itself still has to survive the console event so the child
  // can finish its cleanup.
  expect(result.signalCode).toBeNull()
  expect(result.exitCode).toBe(7)
})
