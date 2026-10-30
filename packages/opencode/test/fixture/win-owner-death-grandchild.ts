/**
 * Grandchild of the TUI worker, for the real Windows owner-death proof (#442).
 *
 * Job Object membership is inherited by every descendant, so this process is
 * what separates "the worker was killed" from "the worker *tree* was killed":
 * only the job reaches this PID. It binds a listening port as well, so the
 * test can prove a resource held two levels below the owner is released too.
 *
 * Nothing here ever exits on its own and nothing watches the owner, so the
 * only thing that can end this process is the owner's kill-on-close job.
 */
import net from "node:net"

const server = net.createServer()
await new Promise<void>((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => resolve())
})
const address = server.address()
if (address === null || typeof address === "string") throw new Error("grandchild listener has no address")

process.stdout.write(`ready pid=${process.pid} port=${address.port}\n`)

// Hold the listener open forever: this process must not end by itself.
setInterval(() => {}, 1000)
