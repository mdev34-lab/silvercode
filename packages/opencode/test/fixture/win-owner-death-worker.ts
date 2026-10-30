/**
 * The worker, for the real Windows owner-death proof (#442).
 *
 * The owner spawns this through the production `createTuiWorker` path, which
 * is what assigns the process to the owner's kill-on-close Job Object. The
 * script deliberately installs no owner watchdog, no `disconnect` handler and
 * no exit path of its own: the IPC channel closing when the owner dies must
 * NOT be what ends this process, or the test would prove nothing about the
 * job. If it stops running after its owner is force-killed, the Job Object is
 * the only thing that could have ended it.
 *
 * It holds a listening port and spawns a grandchild so the test can assert on
 * both the process tree and the resources that tree held.
 */
import net from "node:net"

const grandchildTarget = process.env["SILVERCODE_TEST_GRANDCHILD"]
if (!grandchildTarget) throw new Error("SILVERCODE_TEST_GRANDCHILD is required")

const server = net.createServer()
await new Promise<void>((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => resolve())
})
const address = server.address()
if (address === null || typeof address === "string") throw new Error("worker listener has no address")

const grandchild = Bun.spawn([process.execPath, grandchildTarget], { stdout: "pipe", stderr: "inherit" })
const reported = await readFirstLine(grandchild.stdout)
const grandchildPid = Number(/pid=(\d+)/.exec(reported)?.[1])
const grandchildPort = Number(/port=(\d+)/.exec(reported)?.[1])
if (!Number.isInteger(grandchildPid) || grandchildPid <= 0) {
  throw new Error(`grandchild reported no usable pid: ${JSON.stringify(reported)}`)
}
if (!Number.isInteger(grandchildPort) || grandchildPort <= 0) {
  throw new Error(`grandchild reported no usable port: ${JSON.stringify(reported)}`)
}

// Up to the owner over the real Bun IPC channel; the owner forwards it to the
// test process, which is what force-kills the owner.
process.send?.(`report:${process.pid}:${address.port}:${grandchildPid}:${grandchildPort}`)

// Hold the listener open forever: this process must not end by itself.
setInterval(() => {}, 1000)

async function readFirstLine(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (!buffer.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`grandchild exited before reporting (read ${JSON.stringify(buffer)})`)
    buffer += decoder.decode(chunk.value, { stream: true })
  }
  reader.releaseLock()
  return buffer.slice(0, buffer.indexOf("\n"))
}
