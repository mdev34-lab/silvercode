
// No elapsed-time assertions or cleanup sleeps: the finalizer cannot finish until
// the parent sees Bun report the hook cutoff and opens the gate over stdin.
import { afterAll, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../effect"
import { inflightOwnedRunCount } from "../owned-deadline"
import { hangWithLiveHandle } from "./abandoned-keepalive"

// In-memory bounded trace. Written to stderr only when an unexpected assertion fails.
const TRACE_MAX_RECORDS = 16
const trace: string[] = []

function capture(phase: string, elapsedMs: number, fields = "") {
  try {
    if (trace.length >= TRACE_MAX_RECORDS) return
    trace.push(`phase=${phase} elapsedMs=${elapsedMs}${fields ? ` ${fields}` : ""}`)
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

function ownedCount(): string {
  try {
    return String(inflightOwnedRunCount())
  } catch {
    return "unavailable"
  }
}

const c0 = performance.now()
capture("C0", 0)

const envKey = "SILVERCODE_TEST_ABANDONED_ENTRY_ENV"
const previousEnv = process.env[envKey]
const events: string[] = []
const gate = new Response(Bun.stdin.stream()).text()

const restoreEnv = () => {
  if (previousEnv === undefined) delete process.env[envKey]
  else process.env[envKey] = previousEnv
}
afterAll(restoreEnv)

const it = testEffect(Layer.empty)
it.live("host timeout interrupts a scope whose finalizer outlives the cleanup hook", () =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env[envKey] = "active"
        events.push("acquired")
      }),
      () =>
        Effect.promise(async () => {
          events.push("finalizer-start")
          capture("C1", performance.now() - c0)
          const gateText = await gate
          capture("C2", performance.now() - c0, `bytes=${new TextEncoder().encode(gateText).byteLength}`)
          try {
            expect(gateText).toBe("release\n")
          } catch (error) {
            flushTrace()
            throw error
          }
          restoreEnv()
          events.push("finalizer-end")
          capture("C3", performance.now() - c0)
        }),
    )
    yield* Effect.never.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          events.push("child-interrupted")
        }),
      ),
      Effect.forkChild,
    )
    yield* hangWithLiveHandle
    yield* Effect.sync(() => {
      events.push("orphan-body-write")
    })
  }),
)

test("next plain test enters only after abandoned scope and child are joined", () => {
  capture("C4", performance.now() - c0, `inflightOwnedRunCount=${ownedCount()}`)
  try {
    expect(process.env[envKey]).toBe(previousEnv)
    expect(events).toEqual(["acquired", "finalizer-start", "finalizer-end", "child-interrupted"])
    expect(inflightOwnedRunCount()).toBe(0)
  } catch (error) {
    flushTrace()
    throw error
  }
  process.env[envKey] = "newer-test"
  events.push("next-test")
})

test("no abandoned work or late finalizer overwrites the newer test state", async () => {
  capture("C5", performance.now() - c0)
  await new Promise<void>((resolve) => setImmediate(resolve))
  try {
    expect(process.env[envKey]).toBe("newer-test")
    expect(events).toEqual(["acquired", "finalizer-start", "finalizer-end", "child-interrupted", "next-test"])
    expect(inflightOwnedRunCount()).toBe(0)
  } catch (error) {
    flushTrace()
    throw error
  }
})
