import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Sink, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ChildProcess } from "effect/unstable/process"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId,
  type ChildProcessHandle,
} from "effect/unstable/process/ChildProcessSpawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { it } from "../lib/effect"

// Timeout partial-output retention is verified against a fake spawner under
// TestClock, never against real child startup timing. `consumed` completes its
// signal only when the collector pulls *past* the final chunk: pull-based
// backpressure means the runForEach step that records a chunk has already
// returned before the next pull is issued, so a completed signal proves the
// bytes were collected before the test fires the timeout via TestClock.

const enc = (text: string) => new TextEncoder().encode(text)

const consumed = (chunks: ReadonlyArray<Uint8Array>, signal: Deferred.Deferred<boolean>) =>
  Stream.fromIterable(chunks).pipe(
    Stream.concat(Stream.unwrap(Deferred.succeed(signal, true).pipe(Effect.as(Stream.never)))),
  )

const cmd = ChildProcess.make("fake", ["run"])

const fakeHandle = (parts: {
  stdout: Stream.Stream<Uint8Array, never>
  stderr: Stream.Stream<Uint8Array, never>
  all?: Stream.Stream<Uint8Array, never>
  exitCode: Effect.Effect<ExitCode, never>
}): ChildProcessHandle =>
  makeHandle({
    pid: ProcessId(4242),
    exitCode: parts.exitCode,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: parts.stdout,
    stderr: parts.stderr,
    all: parts.all ?? Stream.never,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  })

const fakeLayer = (handle: ChildProcessHandle, spawned: Deferred.Deferred<boolean>) => {
  const replacement = [
    CrossSpawnSpawner.node,
    Layer.succeed(
      ChildProcessSpawner,
      makeSpawner(() => Deferred.succeed(spawned, true).pipe(Effect.as(handle))),
    ),
  ] as const
  return LayerNode.compile(AppProcess.node, [replacement])
}

const failure = (exit: Exit.Exit<AppProcess.RunResult, AppProcess.AppProcessError>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error("expected failure exit")
  const reason = exit.cause.reasons[0]
  if (!reason || reason._tag !== "Fail") throw new Error("expected fail reason")
  expect(reason.error).toBeInstanceOf(AppProcess.AppProcessError)
  return reason.error as AppProcess.AppProcessError
}

// The pre-retention timeout contract, pinned identically before and after:
// same cause, same derived message, no exit code, no stderr field.
const expectPreservedTimeout = (error: AppProcess.AppProcessError) => {
  expect(error.exitCode).toBeUndefined()
  expect(error.stderr).toBeUndefined()
  expect(error.cause).toBeInstanceOf(Error)
  expect((error.cause as Error).message).toBe("Timed out")
  expect(error.message).toBe("Command failed: fake run: Timed out")
}

describe("AppProcess run timeout partial output", () => {
  it.effect("retains partial stdout and stderr collected before the timeout fires", () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<boolean>()
      const outDone = yield* Deferred.make<boolean>()
      const errDone = yield* Deferred.make<boolean>()
      const handle = fakeHandle({
        stdout: consumed([enc("out-marker\n")], outDone),
        stderr: consumed([enc("err-marker\n")], errDone),
        exitCode: Effect.never,
      })
      const exit = yield* Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const fiber = yield* Effect.exit(svc.run(cmd, { timeout: "30 seconds" })).pipe(Effect.forkChild)
        yield* Deferred.await(spawned)
        yield* Deferred.await(outDone)
        yield* Deferred.await(errDone)
        yield* TestClock.adjust("30 seconds")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(fakeLayer(handle, spawned)))

      const error = failure(exit)
      expectPreservedTimeout(error)
      expect(error.partialStdout).toBe("out-marker\n")
      expect(error.partialStderr).toBe("err-marker\n")
      expect(error.partialStdoutTruncated).toBe(false)
      expect(error.partialStderrTruncated).toBe(false)
    }),
  )

  it.effect("keeps the timeout error identical when nothing was collected", () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<boolean>()
      const outDone = yield* Deferred.make<boolean>()
      const errDone = yield* Deferred.make<boolean>()
      // Zero chunks: the signals still prove each collector pulled, so the
      // timeout fires against known-empty accumulators, not an assumed race.
      const handle = fakeHandle({
        stdout: consumed([], outDone),
        stderr: consumed([], errDone),
        exitCode: Effect.never,
      })
      const exit = yield* Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const fiber = yield* Effect.exit(svc.run(cmd, { timeout: "30 seconds" })).pipe(Effect.forkChild)
        yield* Deferred.await(spawned)
        yield* Deferred.await(outDone)
        yield* Deferred.await(errDone)
        yield* TestClock.adjust("30 seconds")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(fakeLayer(handle, spawned)))

      const error = failure(exit)
      expectPreservedTimeout(error)
      expect(error.partialStdout).toBeUndefined()
      expect(error.partialStderr).toBeUndefined()
      expect(error.partialStdoutTruncated).toBeUndefined()
      expect(error.partialStderrTruncated).toBeUndefined()
    }),
  )

  it.effect("still returns collected output when the command exits before the timeout", () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<boolean>()
      const handle = fakeHandle({
        stdout: Stream.fromIterable([enc("out-marker\n")]),
        stderr: Stream.fromIterable([enc("err-marker\n")]),
        exitCode: Effect.succeed(ExitCode(0)),
      })
      const result = yield* Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        return yield* svc.run(cmd, { timeout: "30 seconds" })
      }).pipe(Effect.provide(fakeLayer(handle, spawned)))

      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString("utf8")).toBe("out-marker\n")
      expect(result.stderr.toString("utf8")).toBe("err-marker\n")
      expect(result.stdoutTruncated).toBe(false)
      expect(result.stderrTruncated).toBe(false)
    }),
  )

  it.effect("returns a result instead of a timeout error for a non-zero exit", () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<boolean>()
      const handle = fakeHandle({
        stdout: Stream.fromIterable([enc("out-marker\n")]),
        stderr: Stream.fromIterable([enc("err-marker\n")]),
        exitCode: Effect.succeed(ExitCode(3)),
      })
      const result = yield* Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        return yield* svc.run(cmd, { timeout: "30 seconds" })
      }).pipe(Effect.provide(fakeLayer(handle, spawned)))

      expect(result.exitCode).toBe(3)
      expect(result.stdout.toString("utf8")).toBe("out-marker\n")
      expect(result.stderr.toString("utf8")).toBe("err-marker\n")
    }),
  )

  it.effect("bounds retained partial stderr by the existing maxErrorBytes cap", () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<boolean>()
      const outDone = yield* Deferred.make<boolean>()
      const errDone = yield* Deferred.make<boolean>()
      const handle = fakeHandle({
        stdout: consumed([enc("out")], outDone),
        stderr: consumed([enc("0123456789ABCDEF")], errDone),
        exitCode: Effect.never,
      })
      const exit = yield* Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const fiber = yield* Effect.exit(svc.run(cmd, { timeout: "30 seconds", maxErrorBytes: 8 })).pipe(
          Effect.forkChild,
        )
        yield* Deferred.await(spawned)
        yield* Deferred.await(outDone)
        yield* Deferred.await(errDone)
        yield* TestClock.adjust("30 seconds")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(fakeLayer(handle, spawned)))

      const error = failure(exit)
      expectPreservedTimeout(error)
      expect(error.partialStdout).toBe("out")
      expect(error.partialStdoutTruncated).toBe(false)
      expect(error.partialStderr).toBe("01234567")
      expect(error.partialStderrTruncated).toBe(true)
    }),
  )

  it.effect("decodes multibyte UTF-8 and replaces a character split by the byte cap", () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<boolean>()
      const outDone = yield* Deferred.make<boolean>()
      const errDone = yield* Deferred.make<boolean>()
      const handle = fakeHandle({
        stdout: consumed([enc("caf"), new Uint8Array([0xc3]), new Uint8Array([0xa9]), enc(" ☃")], outDone),
        stderr: consumed([enc("A€B")], errDone),
        exitCode: Effect.never,
      })
      const exit = yield* Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const fiber = yield* Effect.exit(svc.run(cmd, { timeout: "30 seconds", maxErrorBytes: 2 })).pipe(
          Effect.forkChild,
        )
        yield* Deferred.await(spawned)
        yield* Deferred.await(outDone)
        yield* Deferred.await(errDone)
        yield* TestClock.adjust("30 seconds")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(fakeLayer(handle, spawned)))

      const error = failure(exit)
      expectPreservedTimeout(error)
      expect(error.partialStdout).toBe("café ☃")
      expect(error.partialStdoutTruncated).toBe(false)
      expect(error.partialStderr).toBe("A�")
      expect(error.partialStderrTruncated).toBe(true)
      expect(Buffer.from(error.partialStderr!, "utf8").equals(Buffer.from([0x41, 0xe2]))).toBe(false)
    }),
  )

  it.effect("does not retain partial fields for combineOutput timeouts (explicit scope)", () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<boolean>()
      const allDone = yield* Deferred.make<boolean>()
      const handle = fakeHandle({
        stdout: Stream.never,
        stderr: Stream.never,
        all: consumed([enc("combined\n")], allDone),
        exitCode: Effect.never,
      })
      const exit = yield* Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const fiber = yield* Effect.exit(svc.run(cmd, { timeout: "30 seconds", combineOutput: true })).pipe(
          Effect.forkChild,
        )
        yield* Deferred.await(spawned)
        yield* Deferred.await(allDone)
        yield* TestClock.adjust("30 seconds")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(fakeLayer(handle, spawned)))

      const error = failure(exit)
      expectPreservedTimeout(error)
      expect(error.partialStdout).toBeUndefined()
      expect(error.partialStderr).toBeUndefined()
      expect(error.partialStdoutTruncated).toBeUndefined()
      expect(error.partialStderrTruncated).toBeUndefined()
    }),
  )

  it.effect("omits partial text and truncation flags when zero-byte caps consumed nonempty output", () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<boolean>()
      const outDone = yield* Deferred.make<boolean>()
      const errDone = yield* Deferred.make<boolean>()
      // Both streams produce bytes that are consumed but none may be retained.
      const handle = fakeHandle({
        stdout: consumed([enc("out-marker\n")], outDone),
        stderr: consumed([enc("err-marker\n")], errDone),
        exitCode: Effect.never,
      })
      const exit = yield* Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const fiber = yield* Effect.exit(
          svc.run(cmd, { timeout: "30 seconds", maxOutputBytes: 0, maxErrorBytes: 0 }),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(spawned)
        yield* Deferred.await(outDone)
        yield* Deferred.await(errDone)
        yield* TestClock.adjust("30 seconds")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(fakeLayer(handle, spawned)))

      const error = failure(exit)
      expectPreservedTimeout(error)
      expect(error.partialStdout).toBeUndefined()
      expect(error.partialStderr).toBeUndefined()
      expect(error.partialStdoutTruncated).toBeUndefined()
      expect(error.partialStderrTruncated).toBeUndefined()
    }),
  )

  it.effect("keeps an uncapped opposite stream while a zero-byte stdout cap omits its text", () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<boolean>()
      const outDone = yield* Deferred.make<boolean>()
      const errDone = yield* Deferred.make<boolean>()
      const handle = fakeHandle({
        stdout: consumed([enc("out-marker\n")], outDone),
        stderr: consumed([enc("err-marker\n")], errDone),
        exitCode: Effect.never,
      })
      const exit = yield* Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const fiber = yield* Effect.exit(svc.run(cmd, { timeout: "30 seconds", maxOutputBytes: 0 })).pipe(
          Effect.forkChild,
        )
        yield* Deferred.await(spawned)
        yield* Deferred.await(outDone)
        yield* Deferred.await(errDone)
        yield* TestClock.adjust("30 seconds")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(fakeLayer(handle, spawned)))

      const error = failure(exit)
      expectPreservedTimeout(error)
      expect(error.partialStdout).toBeUndefined()
      expect(error.partialStdoutTruncated).toBeUndefined()
      expect(error.partialStderr).toBe("err-marker\n")
      expect(error.partialStderrTruncated).toBe(false)
    }),
  )

  it.effect("keeps a finite-truncated opposite stream while a zero-byte stderr cap omits its text", () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<boolean>()
      const outDone = yield* Deferred.make<boolean>()
      const errDone = yield* Deferred.make<boolean>()
      const handle = fakeHandle({
        stdout: consumed([enc("0123456789ABCDEF")], outDone),
        stderr: consumed([enc("err-marker\n")], errDone),
        exitCode: Effect.never,
      })
      const exit = yield* Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const fiber = yield* Effect.exit(
          svc.run(cmd, { timeout: "30 seconds", maxOutputBytes: 8, maxErrorBytes: 0 }),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(spawned)
        yield* Deferred.await(outDone)
        yield* Deferred.await(errDone)
        yield* TestClock.adjust("30 seconds")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(fakeLayer(handle, spawned)))

      const error = failure(exit)
      expectPreservedTimeout(error)
      expect(error.partialStdout).toBe("01234567")
      expect(error.partialStdoutTruncated).toBe(true)
      expect(error.partialStderr).toBeUndefined()
      expect(error.partialStderrTruncated).toBeUndefined()
    }),
  )
})
