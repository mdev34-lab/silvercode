/**
 * The owner, for the real Windows owner-death proof (#442).
 *
 * Runs the same production worker factory the TUI command uses
 * (`src/cli/cmd/tui.ts` -> `createTuiWorker` -> `createWorkerProcess` ->
 * `adoptWorkerProcess`), so the worker is put into this process's kill-on-close
 * Job Object by the real `bun:ffi`/kernel32 binding. No adopter is injected and
 * nothing about the binding is stubbed.
 *
 * The owner then does nothing but hold the job handle open. It installs no
 * shutdown path of its own: the test ends it with TerminateProcess, and the OS
 * closing that handle is what must take the whole worker tree down.
 */
import path from "node:path"
import { createTuiWorker } from "../../src/cli/tui/worker-process"

const target = process.env["SILVERCODE_TEST_WORKER_TARGET"]
if (!target) throw new Error("SILVERCODE_TEST_WORKER_TARGET is required")

// Guard the premise: the subprocess path (and therefore a worker PID the test
// can inspect) is only taken for an uncompiled Bun run. A compiled binary would
// silently host the worker as a thread and make the whole test vacuous.
if (path.basename(process.execPath).replace(/\.exe$/, "") !== "bun") {
  throw new Error(`expected an uncompiled bun run, got ${process.execPath}`)
}

// The TUI hands the worker its whole environment (src/cli/cmd/tui.ts); this
// only adds the grandchild path the worker fixture needs.
const env: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value

const worker = createTuiWorker(target, {
  env,
  // Every job creation/assignment failure the production adopter reports is
  // tagged "(#442)". Forwarding it over IPC (not just stderr) lets the test
  // assert the binding was really in place before it force-kills this process,
  // so a worker that died for some other reason cannot read as job coverage.
  log: (message) => {
    console.error(message)
    process.send?.(`log:${message}`)
  },
})
worker.onmessage = (event) => {
  if (typeof event.data === "string") process.send?.(event.data)
}

// Hold the job handle open until the test force-kills this process.
setInterval(() => {}, 1000)
