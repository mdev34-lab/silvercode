import { expect, test } from "bun:test"
import path from "node:path"

const CHILD_GUARD_MS = 15000

test(
  "host timeout and hook cutoff cannot let the next test enter an unfinalized Effect scope",
  async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--timeout",
        "800",
        path.join(import.meta.dir, "fixtures", "abandoned-entry-barrier.ts"),
      ],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    let timedOut = false
    let released = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, CHILD_GUARD_MS)
    try {
      const stderr = (async () => {
        const decoder = new TextDecoder()
        let output = ""
        const reader = child.stderr.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            output += decoder.decode(value, { stream: true })
            if (!released && output.includes("a beforeEach/afterEach hook timed out for this test")) {
              released = true
              // Handshake, not a timing guess: cleanup is blocked until Bun has
              // abandoned the hook. Restoration still needs another event-loop turn.
              await child.stdin.write("release\n")
              await child.stdin.end()
            }
          }
        } finally {
          reader.releaseLock()
        }
        return output + decoder.decode()
      })()
      const [stdout, errors, code] = await Promise.all([new Response(child.stdout).text(), stderr, child.exited])
      const output = stdout + errors
      expect({ timedOut, released, output }).toMatchObject({ timedOut: false, released: true })
      expect(code).toBe(1)
      expect(output).toContain("(fail) host timeout interrupts a scope whose finalizer outlives the cleanup hook")
      expect(output).toContain("(pass) next plain test enters only after abandoned scope and child are joined")
      expect(output).toContain("(pass) no abandoned work or late finalizer overwrites the newer test state")
      expect(output).toContain("2 pass")
      expect(output).toContain("1 fail")
      expect(output).not.toContain("Unhandled error")
      expect(output).not.toMatch(/^\s*\d+\s+errors?\b/m)
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  },
  CHILD_GUARD_MS + 10000,
)
