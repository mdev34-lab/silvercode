import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Deferred, Latch, Layer, Scope, Context } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancelForeground: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancelBackground: (sessionID: SessionID) => Effect.Effect<void>
  /** Counts every foreground cancel request, including idle-session cancels; lets a queued caller tell it was cancelled. */
  readonly cancelEpoch: (sessionID: SessionID) => Effect.Effect<number>
  /** Waits for any in-flight foreground cancellation of `sessionID` to finish settling. */
  readonly awaitCancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts>>()
        const epochs = new Map<SessionID, number>()
        const cancelling = new Map<SessionID, Deferred.Deferred<void>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
            cancelling.clear()
          }),
        )
        return { runners, epochs, cancelling, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<SessionV1.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
    })

    const bumpEpoch = (data: { epochs: Map<SessionID, number> }, sessionID: SessionID) => {
      data.epochs.set(sessionID, (data.epochs.get(sessionID) ?? 0) + 1)
    }

    const cancelForegroundImpl = Effect.fnUntraced(function* (
      sessionID: SessionID,
      before: Effect.Effect<void> = Effect.void,
    ) {
      const data = yield* InstanceState.get(state)
      bumpEpoch(data, sessionID)
      const existing = data.runners.get(sessionID)
      // Register before background work so awaitCancel covers the whole cancellation.
      const done = yield* Deferred.make<void>()
      const prev = data.cancelling.get(sessionID)
      data.cancelling.set(sessionID, done)
      yield* before.pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (existing) {
              yield* existing.cancel
              return
            }
            if (prev) return
            yield* status.set(sessionID, { type: "idle" })
          }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            if (prev) yield* Deferred.await(prev)
            if (data.cancelling.get(sessionID) === done) data.cancelling.delete(sessionID)
            yield* Deferred.succeed(done, void 0)
          }),
        ),
      )
    })

    const cancelForeground = Effect.fn("SessionRunState.cancelForeground")(function* (sessionID: SessionID) {
      yield* cancelForegroundImpl(sessionID)
    })

    const cancelEpoch = Effect.fn("SessionRunState.cancelEpoch")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.epochs.get(sessionID) ?? 0
    })

    const awaitCancel = Effect.fn("SessionRunState.awaitCancel")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const inflight = data.cancelling.get(sessionID)
      if (inflight) yield* Deferred.await(inflight)
    })

    const cancelBackground = Effect.fn("SessionRunState.cancelBackground")(function* (sessionID: SessionID) {
      yield* cancelBackgroundJobs(background, sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      yield* cancelForegroundImpl(sessionID, cancelBackground(sessionID))
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(work)
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt))
        .startShell(work, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    return Service.of({
      assertNotBusy,
      cancel,
      cancelForeground,
      cancelBackground,
      cancelEpoch,
      awaitCancel,
      ensureRunning,
      startShell,
    })
  }),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  // A job is the session's own run only while it is the run that was asked to
  // stop. Everything else the walk reaches - the jobs of descendants - is being
  // swept up because the session that owns it is going away, and a delivery from
  // those would prompt a session that is stopping.
  const ownedBySession = (job: BackgroundJob.Info) => BackgroundJob.runsSession(job, sessionID)
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id, { teardown: !ownedBySession(job) }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [BackgroundJob.node, SessionStatus.node] })

export * as SessionRunState from "./run-state"
