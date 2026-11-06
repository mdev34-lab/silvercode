import { Context, Duration, Effect, Fiber, Layer, Schema, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { ExitCode } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "./cross-spawn-spawner"
import { makeGlobalNode } from "./effect/app-node"

export class AppProcessError extends Schema.TaggedErrorClass<AppProcessError>()("AppProcessError", {
  command: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  stderr: Schema.optional(Schema.String),
  // UTF-8 text diagnostics decoded from output accumulated when a `run`
  // timeout fires (separate-stream mode only). They are not byte-faithful:
  // invalid UTF-8 or a byte cap splitting a character can produce replacement
  // characters. Absent when nothing was collected or on non-timeout failures.
  // Separate from `stderr`, which feeds `message`; timeout messages, causes,
  // and exit semantics are unchanged.
  partialStdout: Schema.optional(Schema.String),
  partialStderr: Schema.optional(Schema.String),
  partialStdoutTruncated: Schema.optional(Schema.Boolean),
  partialStderrTruncated: Schema.optional(Schema.Boolean),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    const detail =
      this.stderr?.trim() || (this.cause instanceof Error ? this.cause.message : this.cause && String(this.cause))
    const status = this.exitCode === undefined ? "" : ` (exit ${this.exitCode})`
    return `Command failed${status}: ${this.command}${detail ? `: ${detail}` : ""}`
  }
}

export interface RunOptions {
  readonly combineOutput?: boolean
  readonly maxOutputBytes?: number
  readonly maxErrorBytes?: number
  readonly signal?: AbortSignal
  readonly timeout?: Duration.Input
  readonly stdin?: string | Uint8Array | Stream.Stream<Uint8Array, PlatformError>
}

export interface RunStreamOptions {
  readonly signal?: AbortSignal
  readonly includeStderr?: boolean
  readonly okExitCodes?: ReadonlyArray<number>
  readonly maxErrorBytes?: number
}

export interface RunResult {
  readonly command: string
  readonly exitCode: number
  readonly output?: Buffer
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly outputTruncated?: boolean
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

export type Interface = ChildProcessSpawner["Service"] & {
  readonly run: (command: ChildProcess.Command, options?: RunOptions) => Effect.Effect<RunResult, AppProcessError>
  readonly runStream: (
    command: ChildProcess.Command,
    options?: RunStreamOptions,
  ) => Stream.Stream<string, AppProcessError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AppProcess") {}

export const requireSuccess = (result: RunResult): Effect.Effect<RunResult, AppProcessError> =>
  result.exitCode === 0
    ? Effect.succeed(result)
    : Effect.fail(
        new AppProcessError({
          command: result.command,
          exitCode: result.exitCode,
          stderr: result.stderr.toString("utf8"),
        }),
      )

export const requireExitIn =
  (codes: ReadonlyArray<number>) =>
  (result: RunResult): Effect.Effect<RunResult, AppProcessError> =>
    codes.includes(result.exitCode)
      ? Effect.succeed(result)
      : Effect.fail(
          new AppProcessError({
            command: result.command,
            exitCode: result.exitCode,
            stderr: result.stderr.toString("utf8"),
          }),
        )

const describeCommand = (command: ChildProcess.Command): string => {
  if (command._tag === "StandardCommand") {
    return command.args.length ? `${command.command} ${command.args.join(" ")}` : command.command
  }
  return `${describeCommand(command.left)} | ${describeCommand(command.right)}`
}

const wrapError = (description: string, cause: unknown): AppProcessError =>
  cause instanceof AppProcessError ? cause : new AppProcessError({ command: description, cause })

export const abortError = (signal: AbortSignal): Error => {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  const err = new Error("Aborted")
  err.name = "AbortError"
  return err
}

export const waitForAbort = (signal: AbortSignal) =>
  Effect.callback<never, Error>((resume) => {
    if (signal.aborted) {
      resume(Effect.fail(abortError(signal)))
      return
    }
    const onabort = () => resume(Effect.fail(abortError(signal)))
    signal.addEventListener("abort", onabort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onabort))
  })

const normalizeStdin = (
  input: string | Uint8Array | Stream.Stream<Uint8Array, PlatformError>,
): Stream.Stream<Uint8Array, PlatformError> =>
  typeof input === "string"
    ? Stream.make(new TextEncoder().encode(input))
    : input instanceof Uint8Array
      ? Stream.make(input)
      : input

export const collectStream = (stream: Stream.Stream<Uint8Array, PlatformError>, maxOutputBytes: number | undefined) =>
  Stream.runFold(
    stream,
    () => ({ chunks: [] as Uint8Array[], bytes: 0, truncated: false }),
    (acc, chunk) => {
      if (maxOutputBytes === undefined) {
        acc.chunks.push(chunk)
        acc.bytes += chunk.length
        return acc
      }
      const remaining = maxOutputBytes - acc.bytes
      if (remaining > 0) acc.chunks.push(remaining >= chunk.length ? chunk : chunk.slice(0, remaining))
      acc.bytes += chunk.length
      acc.truncated = acc.truncated || acc.bytes > maxOutputBytes
      return acc
    },
  ).pipe(Effect.map((x) => ({ buffer: Buffer.concat(x.chunks), truncated: x.truncated })))

const POST_EXIT_QUIET = Duration.millis(500)

/**
 * Collects a child process output stream without waiting for it to close.
 *
 * A detached descendant can inherit the child's stdio and keep the pipe open
 * after the child exits, so waiting for EOF/`close` hangs forever. Instead,
 * once the process exits, keep draining until the stream has been quiet for
 * `POST_EXIT_QUIET`, then stop even if the stream never closes.
 */
type CollectedOutput = { chunks: Array<Uint8Array>; bytes: number; truncated: boolean }

const makeCollectedOutput = (): CollectedOutput => ({ chunks: [], bytes: 0, truncated: false })

// Snapshots separate stdout/stderr when the timeout branch runs, before the
// losing collection is interrupted; cleanup is awaited before error delivery.
// Concatenation and UTF-8 decoding allocate fresh copies. Combine mode retains
// nothing: its single interleaved buffer is not relabeled as a partial stream.
const timeoutError = (
  description: string,
  stdout: CollectedOutput,
  stderr: CollectedOutput,
  combineOutput: boolean | undefined,
) => {
  const text = (acc: CollectedOutput) =>
    acc.bytes > 0 ? { text: Buffer.concat(acc.chunks).toString("utf8"), truncated: acc.truncated } : undefined
  const out = combineOutput ? undefined : text(stdout)
  const err = combineOutput ? undefined : text(stderr)
  return new AppProcessError({
    command: description,
    cause: new Error("Timed out"),
    ...(out ? { partialStdout: out.text, partialStdoutTruncated: out.truncated } : {}),
    ...(err ? { partialStderr: err.text, partialStderrTruncated: err.truncated } : {}),
  })
}

const collectUntilQuiet = (
  stream: Stream.Stream<Uint8Array, PlatformError>,
  maxOutputBytes: number | undefined,
  exit: Effect.Effect<ExitCode, PlatformError>,
  acc: CollectedOutput,
): Effect.Effect<{ buffer: Buffer; truncated: boolean }, PlatformError, Scope.Scope> =>
  Effect.gen(function* () {
    let activity = -1
    const output = yield* Effect.forkScoped(
      Stream.runForEach(stream, (chunk) =>
        Effect.sync(() => {
          activity++
          if (maxOutputBytes === undefined) {
            acc.chunks.push(chunk)
            acc.bytes += chunk.length
            return
          }
          const remaining = maxOutputBytes - acc.bytes
          if (remaining > 0) acc.chunks.push(remaining >= chunk.length ? chunk : chunk.slice(0, remaining))
          acc.bytes += chunk.length
          acc.truncated = acc.truncated || acc.bytes > maxOutputBytes
        }),
      ),
    )
    yield* exit
    // Prefer the stream closing: a normal command closes its pipe right after
    // exiting, so `Fiber.join(output)` wins the race and we return immediately
    // (no idle delay on the happy path). The quiet window only kicks in when the
    // stream stays open after exit — a detached descendant holding the pipe.
    const quiet = Effect.gen(function* () {
      let last = activity
      while (true) {
        yield* Effect.sleep(POST_EXIT_QUIET)
        const current = activity
        if (current === last) return
        last = current
      }
    })
    yield* Effect.raceFirst(Fiber.join(output), quiet)
    return { buffer: Buffer.concat(acc.chunks), truncated: acc.truncated }
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    const runCommand = (command: ChildProcess.Command, options?: RunOptions) => {
      const description = describeCommand(command)
      // Accumulators live outside `collect` so the timeout branch can snapshot
      // them before interrupting collection and awaiting scoped cleanup.
      const outputAcc = makeCollectedOutput()
      const stdoutAcc = makeCollectedOutput()
      const stderrAcc = makeCollectedOutput()
      const collect = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(command)
          if (options?.combineOutput) {
            const [output, exitCode] = yield* Effect.all(
              [collectUntilQuiet(handle.all, options.maxOutputBytes, handle.exitCode, outputAcc), handle.exitCode],
              { concurrency: "unbounded" },
            )
            return {
              command: description,
              exitCode,
              output: output.buffer,
              stdout: Buffer.alloc(0),
              stderr: Buffer.alloc(0),
              outputTruncated: output.truncated,
              stdoutTruncated: false,
              stderrTruncated: false,
            } satisfies RunResult
          }
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              collectUntilQuiet(handle.stdout, options?.maxOutputBytes, handle.exitCode, stdoutAcc),
              collectUntilQuiet(handle.stderr, options?.maxErrorBytes, handle.exitCode, stderrAcc),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          )
          return {
            command: description,
            exitCode,
            stdout: stdout.buffer,
            stderr: stderr.buffer,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
          } satisfies RunResult
        }),
      )
      const timed = options?.timeout
        ? Effect.timeoutOrElse(collect, {
            duration: options.timeout,
            orElse: () => Effect.fail(timeoutError(description, stdoutAcc, stderrAcc, options?.combineOutput)),
          })
        : collect
      const aborted = options?.signal
        ? timed.pipe(
            Effect.raceFirst(
              waitForAbort(options.signal).pipe(Effect.mapError((cause) => wrapError(description, cause))),
            ),
          )
        : timed
      return aborted.pipe(Effect.catch((cause) => Effect.fail(wrapError(description, cause))))
    }

    const run = Effect.fn("AppProcess.run")(function* (command: ChildProcess.Command, options?: RunOptions) {
      if (options?.stdin === undefined) return yield* runCommand(command, options)
      if (command._tag !== "StandardCommand") {
        return yield* new AppProcessError({
          command: describeCommand(command),
          cause: new Error("stdin option only supports StandardCommand; received PipedCommand"),
        })
      }
      const next = ChildProcess.make(command.command, command.args, {
        ...command.options,
        stdin: normalizeStdin(options.stdin),
      })
      return yield* runCommand(next, options)
    })

    const runStream = (
      command: ChildProcess.Command,
      options?: RunStreamOptions,
    ): Stream.Stream<string, AppProcessError> => {
      const description = describeCommand(command)
      const okExitCodes = options?.okExitCodes
      const built: Stream.Stream<string, AppProcessError | PlatformError> = Stream.unwrap(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(command)
          const stderrFiber = yield* Effect.forkScoped(
            collectStream(handle.stderr, options?.maxErrorBytes).pipe(Effect.map((x) => x.buffer.toString("utf8"))),
          )
          const source = options?.includeStderr === true ? handle.all : handle.stdout
          const lines = source.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
          )
          const tail = Stream.unwrap(
            Effect.gen(function* () {
              const code = yield* handle.exitCode
              if (okExitCodes && okExitCodes.length > 0 && !okExitCodes.includes(code)) {
                const stderr = yield* Fiber.join(stderrFiber)
                return Stream.fail(new AppProcessError({ command: description, exitCode: code, stderr }))
              }
              return Stream.empty
            }),
          )
          return Stream.concat(lines, tail) as Stream.Stream<string, AppProcessError | PlatformError>
        }),
      )
      const mapped = built.pipe(
        Stream.catch((cause): Stream.Stream<string, AppProcessError> => Stream.fail(wrapError(description, cause))),
      )
      if (!options?.signal) return mapped
      const signal = options.signal
      return mapped.pipe(
        Stream.interruptWhen(waitForAbort(signal).pipe(Effect.mapError((cause) => wrapError(description, cause)))),
      )
    }

    return Service.of({ ...spawner, run, runStream })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [CrossSpawnSpawner.node] })

export * as AppProcess from "./process"
