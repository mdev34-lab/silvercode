// Runs the real worker.ts thread entrypoint in a clean bun process. Probes
// bootstrap by driving the real "snapshot" RPC method: on receipt the worker
// thread synchronously writes server.heapsnapshot into its cwd. The snapshot
// file's presence is polled on the filesystem, so the probe is immune to
// bun's flaky in-process message-event delivery on some hosts. Prints
// RESULT:snapshot when the worker booted and handled a request, otherwise
// RESULT:none (or RESULT:error:<message>).
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"

const marker = process.argv[2] === "1"
const windowMs = Number(process.argv[3] ?? 20000)

const heapFile = join(process.cwd(), "server.heapsnapshot")
rmSync(heapFile, { force: true })

const worker = new Worker(new URL("../../src/cli/tui/worker.ts", import.meta.url), {
  env: {
    ...process.env,
    ...(marker ? { SILVERCODE_TUI_WORKER: "1" } : {}),
  },
})

let error: string | undefined
let sawSnapshot = false
worker.addEventListener("error", (event) => {
  error = String((event as unknown as { message: string }).message)
})

let requestId = 0
const deadline = Date.now() + windowMs
while (Date.now() < deadline && !sawSnapshot && !error) {
  try {
    worker.postMessage(JSON.stringify({ type: "rpc.request", id: ++requestId, method: "snapshot", input: undefined }))
  } catch {
    // A worker that exited on its own (no launch marker) rejects postMessage:
    // that is the "never booted" outcome this probe reports as RESULT:none.
    break
  }
  // Wait for the thread to handle the request and write the snapshot file.
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (existsSync(heapFile)) {
      sawSnapshot = true
      break
    }
  }
}

worker.terminate()
rmSync(heapFile, { force: true })
console.log(`RESULT:${error ? `error:${error.slice(0, 120)}` : sawSnapshot ? "snapshot" : "none"}`)
process.exit(0)