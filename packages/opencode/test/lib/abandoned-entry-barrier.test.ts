import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PHASE_ENV } from "./fixtures/abandoned-entry-barrier-phase"

const CHILD_GUARD_MS = 15000

// Bun loads the package bunfig [test] preload before CLI --preload, so running the
// child from the package cwd registers the original barrier ahead of the early hook.
// An isolated empty cwd removes that bunfig from the child's lookup path.
async function withIsolatedCwd<T>(run: (cwd: string) => Promise<T>) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-abandoned-entry-"))
  try {
    return await run(cwd)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

const fixture = path.join(import.meta.dir, "fixtures", "abandoned-entry-barrier.ts")
const barrierPreload = path.join(import.meta.dir, "fixtures", "abandoned-entry-barrier-preload.ts")
const noBarrierPreload = path.join(import.meta.dir, "fixtures", "abandoned-entry-barrier-no-barrier-preload.ts")

// In-memory bounded trace. Nothing is written to stderr unless the test fails.
const TRACE_MAX_RECORDS = 32
const TRACE_MAX_RECEIPTS = 16
const trace: string[] = []
let chunkCount = 0
let chunkBytes = 0

function capture(phase: string, elapsedMs: number, fields = "") {
  try {
    if (trace.length >= TRACE_MAX_RECORDS) return
    trace.push(`phase=${phase} elapsedMs=${elapsedMs}${fields ? ` ${fields}` : ""}`)
  } catch {}
}

function captureReceipt(elapsedMs: number, bytes: number) {
  try {
    chunkCount += 1
    chunkBytes += bytes
    if (chunkCount <= TRACE_MAX_RECEIPTS) capture("P1", elapsedMs, `bytes=${bytes}`)
  } catch {}
}

function flushTrace() {
  try {
    for (const record of trace) {
      try {
        process.stderr.write(`[845-trace] ${record}\n`)
      } catch {}
    }
  } catch {}
}

async function flushPhases(phasePath: string) {
  try {
    const text = await fs.readFile(phasePath, "utf8")
    for (const line of text.trim().split("\n").slice(0, 24)) {
      if (line) process.stderr.write(`[845-phase] ${line}\n`)
    }
  } catch {}
}

test(
  "host timeout and hook cutoff cannot let the next test enter an unfinalized Effect scope",
  async () => {
    await withIsolatedCwd(async (cwd) => {
      const phasePath = path.join(cwd, "phase.log")
      const child = Bun.spawn([process.execPath, "test", "--timeout", "800", "--preload", barrierPreload, fixture], {
        cwd,
        env: { ...process.env, [PHASE_ENV]: phasePath },
        stdout: "pipe",
        stderr: "pipe",
      })
      const p0 = performance.now()
      capture("P0", 0)
      let timedOut = false
      let observedCutoff = false
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
              captureReceipt(performance.now() - p0, value.byteLength)
              output += decoder.decode(value, { stream: true })
              if (!observedCutoff && output.includes("a beforeEach/afterEach hook timed out for this test")) {
                capture("P2", performance.now() - p0)
                observedCutoff = true
              }
            }
          } finally {
            reader.releaseLock()
          }
          return output + decoder.decode()
        })()
        const [stdout, errors, code] = await Promise.all([
          new Response(child.stdout).text(),
          stderr,
          child.exited.then((code) => {
            capture("P4", performance.now() - p0, `code=${code} chunks=${chunkCount} bytes=${chunkBytes}`)
            return code
          }),
        ])
        const output = stdout + errors
        try {
          expect({ timedOut, observedCutoff, output }).toMatchObject({ timedOut: false, observedCutoff: true })
          expect(output).toContain("a beforeEach/afterEach hook timed out for this test")
          expect(code).toBe(1)
          expect(output).toContain("(fail) host timeout interrupts a scope whose finalizer outlives the cleanup hook")
          expect(output).toContain("(pass) next plain test enters only after abandoned scope and child are joined")
          expect(output).toContain("(pass) no abandoned work or late finalizer overwrites the newer test state")
          expect(output).toContain("2 pass")
          expect(output).toContain("1 fail")
          expect(output).not.toContain("Unhandled error")
          expect(output).not.toMatch(/^\s*\d+\s+errors?\b/m)
        } catch (error) {
          flushTrace()
          await flushPhases(phasePath)
          throw error
        }
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill()
        await child.exited
      }
    })
  },
  CHILD_GUARD_MS + 10000,
)

test(
  "negative control: without the real barrier the plain test enters unfinalized",
  async () => {
    await withIsolatedCwd(async (cwd) => {
      const phasePath = path.join(cwd, "phase.log")
      const child = Bun.spawn([process.execPath, "test", "--timeout", "800", "--preload", noBarrierPreload, fixture], {
        cwd,
        env: { ...process.env, [PHASE_ENV]: phasePath },
        stdout: "pipe",
        stderr: "pipe",
      })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, CHILD_GUARD_MS)
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        const output = stdout + stderr
        try {
          expect(timedOut).toBe(false)
          expect(code).toBe(1)
          expect(output).toContain("(fail) next plain test enters only after abandoned scope and child are joined")
          expect(output).toMatch(/\[845-trace\] phase=C4[^\n]*env=active[^\n]*inflightOwnedRunCount=1/)
          expect(output.indexOf("phase=C4")).toBeLessThan(output.indexOf("phase=C2"))
          expect(output).toMatch(/\[845-trace\] phase=C3/)
        } catch (error) {
          flushTrace()
          await flushPhases(phasePath)
          throw error
        }
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill()
        await child.exited
      }
    })
  },
  CHILD_GUARD_MS + 10000,
)
