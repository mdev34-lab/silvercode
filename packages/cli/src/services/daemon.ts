import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { filesystem } from "@opencode-ai/core/effect/app-node-platform"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { ServerAuth } from "@opencode-ai/server/auth"
import { Cause, Context, Effect, Exit, FileSystem, Layer, Option, Schedule, Schema, Scope } from "effect"
import { HttpServer } from "effect/unstable/http"
import { randomBytes, randomUUID } from "crypto"
import { spawn } from "node:child_process"
import path from "path"

export interface Interface {
  readonly client: () => Effect.Effect<ReturnType<typeof createOpencodeClient>, unknown>
  readonly transport: () => Effect.Effect<{ url: string; headers: RequestInit["headers"] }, unknown>
  readonly start: () => Effect.Effect<string, Error>
  readonly restart: () => Effect.Effect<string, unknown>
  readonly status: () => Effect.Effect<string | undefined>
  readonly stop: () => Effect.Effect<void, unknown>
  readonly password: (value?: string) => Effect.Effect<string, unknown>
  readonly register: (address: HttpServer.Address) => Effect.Effect<void, unknown, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/cli/Daemon") {}

export type StartDecision = "reuse" | "spawn" | "replace" | "refuse-active" | "refuse-unknown"

// `activeRuns` is undefined when the active-run probe did not return a verified
// answer (non-2xx, network error, timeout, or an unparseable body). Unknown is
// never treated as idle: replacement is refused. A healthy same-version service
// can still be reused without stopping it, regardless of its active-run count.
export function decideStart(input: {
  registered: boolean
  sameVersion: boolean
  compiled: boolean
  factoryDefault: boolean
  activeRuns: number | undefined
}): StartDecision {
  if (!input.registered) return "spawn"
  if (input.activeRuns === undefined) return input.sameVersion ? "reuse" : "refuse-unknown"
  if (input.activeRuns > 0) return input.sameVersion ? "reuse" : "refuse-active"
  if (input.sameVersion && input.compiled && !input.factoryDefault) return "reuse"
  return "replace"
}

// Result of the server-side stop-if-idle contract. `busy` is a refusal, not a
// failure to stop: the service answered and stays up. `stopping` is only
// returned for a 200 whose body confirms `{ data: { status: "stopping" } }`;
// any other 200 is unconfirmed. Any transport-level surprise (non-2xx other
// than 409, timeout, network error, unconfirmed 200) is `unknown`. An
// unconfirmed stop is not proof the service stayed up: a granted stop ends the
// service even if the answer is lost, so `restart` re-verifies liveness before
// refusing (see recheckAfterUnknown) and never treats unknown as idle.
export type StopIdleResult =
  | { readonly status: "stopping" }
  | { readonly status: "busy"; readonly activeRuns: number | undefined }
  | { readonly status: "unknown" }

// Restart is stop-then-start, so it is refused unless the registered service
// itself accepted a stop-if-idle request. The server performs the idle check and
// closes its run gate in one atomic step, so unlike a client-side probe there is
// no window where a run can begin after the service was verified idle. If
// spawning fails after the stop, the service stays stopped. Explicit
// `service stop` remains the way to end a service on purpose.
export function decideRestart(input: {
  registered: boolean
  stop: StopIdleResult
}): "proceed" | "refuse-active" | "refuse-unknown" {
  if (!input.registered) return "proceed"
  if (input.stop.status === "busy") return "refuse-active"
  if (input.stop.status === "unknown") return "refuse-unknown"
  return "proceed"
}

const ACTIVE_PROBE_TIMEOUT = "2 seconds"
const ACTIVE_PROBE_TIMEOUT_MS = 2_000
const STOP_IDLE_PATH = "/api/daemon/stop-if-idle"
const STOP_IDLE_TIMEOUT = 2_000
const ActiveBody = Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })
const ActiveRunsBody = Schema.Struct({ activeRuns: Schema.Number })
const StoppingBody = Schema.Struct({ data: Schema.Struct({ status: Schema.Literal("stopping") }) })

const Registration = Schema.Struct({
  id: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  url: Schema.String,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
})
type Registration = typeof Registration.Type

function sameRegistration(left: Registration, right: Registration) {
  return left.id === right.id && left.version === right.version && left.url === right.url && left.pid === right.pid
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = Global.Path.state
    const file = path.join(directory, "server.json")
    const passwordFile = path.join(directory, "password")
    const decodeRegistration = Schema.decodeUnknownEffect(Schema.fromJsonString(Registration))

    const password = Effect.fn("cli.daemon.password")(function* (value?: string) {
      const existing = yield* fs.readFileString(passwordFile).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (value === undefined && existing) return existing

      // Keep one private credential across server restarts so discovered clients
      // can reconnect without exposing a password flag or environment variable.
      const generated = value ?? randomBytes(32).toString("base64url")
      const temp = passwordFile + ".tmp"
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* fs.writeFileString(temp, generated, { mode: 0o600 })
      yield* fs.rename(temp, passwordFile)
      return generated
    })

    const registration = Effect.fnUntraced(function* () {
      return yield* fs.readFileString(file).pipe(Effect.flatMap(decodeRegistration))
    })

    const createClient = Effect.fnUntraced(function* (url: string) {
      return createOpencodeClient({ baseUrl: url, headers: ServerAuth.headers({ password: yield* password() }) })
    })

    const healthy = Effect.fnUntraced(function* () {
      const info = yield* registration()
      const client = yield* createClient(info.url)
      const response = yield* Effect.tryPromise(() => client.v2.health.get({ signal: AbortSignal.timeout(2_000) }))
      if (response.data?.healthy === true) return info
      return yield* Effect.fail(new Error("Registered server is not healthy"))
    })

    const compatible = Effect.fnUntraced(function* () {
      const info = yield* healthy()
      if (info.version === InstallationVersion) return info
      return yield* Effect.fail(new Error("Registered server version does not match the client"))
    })

    const signal = (pid: number, signal: NodeJS.Signals) =>
      Effect.try({ try: () => process.kill(pid, signal), catch: (cause) => cause }).pipe(Effect.ignore)

    const awaitStopped = Effect.fnUntraced(function* (pid: number) {
      const running = yield* Effect.try({ try: () => process.kill(pid, 0), catch: () => false }).pipe(
        Effect.orElseSucceed(() => false),
      )
      if (!running) return true
      return yield* Effect.fail(new Error(`Server process ${pid} is still running`))
    })

    const stopProcess = Effect.fnUntraced(function* (info: Registration) {
      const current = yield* healthy().pipe(Effect.option)
      if (Option.isNone(current) || !sameRegistration(current.value, info)) return

      yield* signal(info.pid, "SIGTERM")
      const stopped = yield* awaitStopped(info.pid).pipe(
        Effect.retry(Schedule.spaced("50 millis").pipe(Schedule.both(Schedule.recurs(100)))),
        Effect.option,
      )
      if (Option.isSome(stopped)) return

      const latest = yield* healthy().pipe(Effect.option)
      if (Option.isNone(latest) || !sameRegistration(latest.value, info)) return
      yield* signal(info.pid, "SIGKILL")
      yield* awaitStopped(info.pid).pipe(
        Effect.retry(Schedule.spaced("50 millis").pipe(Schedule.both(Schedule.recurs(100)))),
      )
    })

    // Verified active-run count for the registered server. Only a 2xx response
    // whose body decodes to `{ data: {...} }` yields a number. Non-2xx, network
    // errors (the SDK returns them instead of throwing), timeouts, and bad bodies
    // all yield undefined, which callers must treat as unknown, never as idle.
    const probeActiveRuns = (info: Registration | undefined): Effect.Effect<number | undefined> =>
      info === undefined
        ? Effect.succeed(undefined)
        : Effect.gen(function* () {
            const client = yield* createClient(info.url)
            const result = yield* Effect.tryPromise({
              try: () => client.v2.session.active({ signal: AbortSignal.timeout(2_000) }),
              catch: (cause) => cause,
            }).pipe(Effect.timeout(ACTIVE_PROBE_TIMEOUT))
            if (result.error !== undefined || result.response === undefined || !result.response.ok) return undefined
            const body = yield* Schema.decodeUnknownEffect(ActiveBody)(result.data)
            return Object.keys(body.data).length
          }).pipe(Effect.catch(() => Effect.succeed(undefined)))

    // Asks the registered service to stop itself, atomically, only while idle.
    // The status code is the contract: 200 granted (the service is terminating),
    // 409 refused with runs active, 503 refused because its active-run state is
    // unknown. Anything else — network error, timeout, other status — is unknown.
    const stopIfIdle = Effect.fn("cli.daemon.stopIfIdle")(function* (info: Registration) {
      const headers = ServerAuth.headers({ password: yield* password() })
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(new URL(STOP_IDLE_PATH, info.url), {
            method: "POST",
            headers,
            signal: AbortSignal.timeout(STOP_IDLE_TIMEOUT),
          }),
        catch: (cause) => cause,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (response === undefined) return { status: "unknown" as const }
      if (response.status === 200) {
        // The status code alone is not the grant: an unrelated 200 (a server
        // that does not mount the daemon route behind a fallback, a proxy, an
        // older build) must not be read as acceptance. Only the contract body
        // confirms the service is terminating.
        return yield* Effect.tryPromise(() => response.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(StoppingBody)),
          Effect.map(() => ({ status: "stopping" }) as const),
          Effect.catch(() => Effect.succeed({ status: "unknown" } as const)),
        )
      }
      if (response.status === 503) return { status: "unknown" as const }
      if (response.status !== 409) return { status: "unknown" as const }
      // A busy refusal is already safe to act on; the count only improves the
      // message, so an unreadable body still refuses.
      const activeRuns = yield* Effect.tryPromise(() => response.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ActiveRunsBody)),
        Effect.map((body) => body.activeRuns),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      return { status: "busy" as const, activeRuns }
    })

    // Re-verifies liveness after an unconfirmed stop request. A granted stop
    // terminates the service ~250ms after the response is written, whether or
    // not the answer arrived, so a lost answer must not be reported as "left
    // running". The recheck waits out the self-terminate delay with margin,
    // then classifies the probe precisely, because only one outcome proves
    // termination:
    //
    // - any HTTP response at all (200, 401, 404, 500, ...) proves a process is
    //   listening and answering: the service is ALIVE. A 401/404 is an auth or
    //   version mismatch, not a dead process.
    // - a refused connection proves the local port is closed: the listener is
    //   gone. Both endpoints are local, so a refused connection is a dead
    //   (or dying) process, not a network partition.
    // - anything else (timeout, reset, DNS, TLS) proves nothing and stays
    //   unknown, which refuses.
    //
    // Death is accepted only after two consecutive refused connections, so a
    // transient refusal while the socket tears down cannot reopen the stop.
    type Liveness = "alive" | "dead" | "unknown"

    const isConnectionRefused = (error: unknown): boolean => {
      let current: unknown = error
      while (current !== null && typeof current === "object") {
        const code = (current as { code?: unknown }).code
        if (code === "ECONNREFUSED" || code === "ConnectionRefused") return true
        const message = (current as { message?: unknown }).message
        if (typeof message === "string" && message.includes("Connection refused")) return true
        current = (current as { cause?: unknown }).cause
      }
      return false
    }

    const probeLiveness = Effect.fn("cli.daemon.probeLiveness")(function* (info: Registration) {
      const headers = ServerAuth.headers({ password: yield* password() })
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(new URL("/api/health", info.url), {
            headers,
            signal: AbortSignal.timeout(ACTIVE_PROBE_TIMEOUT_MS),
          }),
        catch: (cause) => cause,
      }).pipe(Effect.exit)
      if (Exit.isSuccess(response)) return "alive" as const
      // Unwrap the Effect Cause to the original fetch error before inspecting
      // codes; the Cause wrapper itself carries no connection information.
      return isConnectionRefused(Cause.squash(response.cause)) ? ("dead" as const) : ("unknown" as const)
    })

    const recheckAfterUnknown = Effect.fn("cli.daemon.recheckAfterUnknown")(function* (info: Registration) {
      yield* Effect.sleep("500 millis")
      const first = yield* probeLiveness(info)
      if (first !== "dead") return { status: "unknown" } as const
      yield* Effect.sleep("250 millis")
      const second = yield* probeLiveness(info)
      return second === "dead" ? ({ status: "stopping" } as const) : ({ status: "unknown" } as const)
    })

    const start = Effect.fn("cli.daemon.start")(function* () {
      const existing = yield* healthy().pipe(Effect.option)
      const found = Option.getOrUndefined(existing)
      const compiled = path.basename(process.execPath).replace(/\.exe$/, "") !== "bun"
      const factoryDefault =
        process.env.OPENCODE_FACTORY_DEFAULT === "1" || process.env.OPENCODE_FACTORY_DEFAULT === "true"
      // Keep probing even for compatible servers: verified idle retains the
      // development/factory replacement behavior. Unknown permits only reuse,
      // not replacement, and is never converted to a zero active-run count.
      const activeCount = yield* probeActiveRuns(found)

      const decision = decideStart({
        registered: found !== undefined,
        sameVersion: found?.version === InstallationVersion,
        compiled,
        factoryDefault,
        activeRuns: activeCount,
      })
      if (decision === "reuse" && found) return found.url
      if (decision === "refuse-active" && found) {
        return yield* Effect.fail(
          new Error(
            `Background service ${found.version ?? "unknown"} does not match this client and has ${activeCount} active run(s). Wait for them to finish, or run "service stop" to end them explicitly, then start again.`,
          ),
        )
      }
      if (decision === "refuse-unknown" && found) {
        return yield* Effect.fail(
          new Error(
            'Could not confirm whether the background service has active runs (active-run probe failed). The service was left running. Retry, or run "service stop" to end it explicitly.',
          ),
        )
      }
      if (found) yield* stopProcess(found).pipe(Effect.ignore)

      const entrypoint = compiled ? undefined : process.argv[1]
      if (!compiled && entrypoint === undefined)
        return yield* Effect.fail(new Error("Failed to resolve CLI entrypoint"))
      yield* Effect.try({
        try: () => {
          spawn(process.execPath, [...(entrypoint ? [entrypoint] : []), "serve", "--register"], {
            detached: true,
            stdio: "ignore",
          }).unref()
        },
        catch: (cause) => new Error("Failed to start server", { cause }),
      })

      return yield* compatible().pipe(
        Effect.retry(Schedule.spaced("50 millis").pipe(Schedule.both(Schedule.recurs(100)))),
        Effect.map((info) => info.url),
        Effect.mapError(() => new Error("Failed to start server")),
      )
    })

    const restart = Effect.fn("cli.daemon.restart")(function* () {
      const existing = yield* healthy().pipe(Effect.option)
      const found = Option.getOrUndefined(existing)
      let stopIdle: StopIdleResult = found === undefined ? { status: "stopping" } : yield* stopIfIdle(found)
      if (found !== undefined && stopIdle.status === "unknown") stopIdle = yield* recheckAfterUnknown(found)
      const restartDecision = decideRestart({ registered: found !== undefined, stop: stopIdle })
      if (restartDecision === "refuse-active") {
        const runs = stopIdle.status === "busy" ? stopIdle.activeRuns : undefined
        const active = runs === undefined ? "has active runs" : `has ${runs} active run(s)`
        return yield* Effect.fail(
          new Error(
            `Background service ${active}; restart refused so they are not interrupted. Wait for them to finish, or run "service stop" to end them explicitly.`,
          ),
        )
      }
      if (restartDecision === "refuse-unknown") {
        return yield* Effect.fail(
          new Error(
            'Could not confirm the background service is idle (stop-if-idle refused or unconfirmed); the service was verified still running and left up. Retry, or run "service stop" to end it explicitly.',
          ),
        )
      }
      // The service closed its run gate when it granted the stop, so the usual
      // teardown (SIGTERM, escalating to SIGKILL) cannot interrupt a run.
      // Waiting for it to go away also keeps the replacement from racing the
      // registration of the service that is still shutting down.
      if (found) {
        yield* stopProcess(found)
        yield* fs.remove(file).pipe(Effect.ignore)
      }
      return yield* start()
    })

    const transport = Effect.fn("cli.daemon.transport")(function* () {
      return { url: yield* start(), headers: ServerAuth.headers({ password: yield* password() }) }
    })

    const client = Effect.fn("cli.daemon.client")(function* () {
      const connection = yield* transport()
      return createOpencodeClient({ baseUrl: connection.url, headers: connection.headers })
    })

    const status = Effect.fn("cli.daemon.status")(function* () {
      const existing = yield* healthy().pipe(Effect.option)
      const found = Option.getOrUndefined(existing)
      if (found?.version === InstallationVersion) return found.url
      if (found) return undefined
      yield* fs.remove(file).pipe(Effect.ignore)
      return undefined
    })

    const stop = Effect.fn("cli.daemon.stop")(function* () {
      const existing = yield* healthy().pipe(Effect.option)
      // A stale registration may point at a PID that has since been reused by
      // another process. Only signal the PID after authenticating the server.
      if (Option.isNone(existing)) return yield* fs.remove(file).pipe(Effect.ignore)
      yield* stopProcess(existing.value)
      yield* fs.remove(file).pipe(Effect.ignore)
    })

    const register = Effect.fn("cli.daemon.register")(function* (address: HttpServer.Address) {
      const id = randomUUID()
      const temp = file + "." + id + ".tmp"
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* fs.writeFileString(
        temp,
        JSON.stringify({ id, version: InstallationVersion, url: HttpServer.formatAddress(address), pid: process.pid }),
        { mode: 0o600 },
      )
      yield* fs.rename(temp, file)
      yield* registration().pipe(
        Effect.flatMap((info) => (info.id === id ? Effect.void : signal(process.pid, "SIGTERM"))),
        Effect.catch(() => signal(process.pid, "SIGTERM")),
        Effect.repeat(Schedule.spaced("10 seconds")),
        Effect.forkScoped,
      )
      yield* Effect.addFinalizer(() =>
        registration().pipe(
          Effect.flatMap((info) => (info.id === id ? fs.remove(file) : Effect.void)),
          Effect.ignore,
        ),
      )
    })

    return Service.of({ client, transport, start, restart, status, stop, password, register })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [filesystem, Global.node],
})

export * as Daemon from "./daemon"
