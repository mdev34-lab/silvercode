import { describe, expect, test } from "bun:test"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Exit, Ref, Scope } from "effect"
import { it } from "./lib/effect"

const jobsLayer = LayerNode.compile(BackgroundJob.node)

describe("BackgroundJob", () => {
  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("promotion retains producer metadata while observation results stay shallow copies", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const metadata: Record<string, unknown> = { background: false, before: "initial" }
      const started = yield* jobs.start({ type: "task", metadata, run: Deferred.await(latch).pipe(Effect.as("done")) })
      metadata.before = "updated"
      const promoted = yield* jobs.promote(started.id)
      expect(metadata.background).toBe(true)
      expect(promoted?.metadata).toMatchObject({ before: "updated", background: true })
      metadata.reviewLoop = { writesFiles: true }
      expect(promoted?.metadata).not.toHaveProperty("reviewLoop")
      if (promoted?.metadata) promoted.metadata.before = "not the registry"
      expect((yield* jobs.get(started.id))?.metadata).toMatchObject({
        before: "updated",
        reviewLoop: { writesFiles: true },
      })
      expect((yield* jobs.list()).find((job) => job.id === started.id)?.metadata).toMatchObject({
        reviewLoop: { writesFiles: true },
      })
      expect(started.metadata).toEqual({ background: false, before: "initial" })
      yield* Deferred.succeed(latch, undefined)
      expect((yield* jobs.wait({ id: started.id })).info?.metadata).toMatchObject({
        background: true,
        reviewLoop: { writesFiles: true },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.effect("keeps same-session run keys distinct when the clock has not advanced", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const starts: number[] = []
      for (let index = 0; index < 3; index++) {
        const job = yield* jobs.start({ id: "ses_same_millisecond", type: "task", run: Effect.succeed("done") })
        starts.push(job.started_at)
        yield* jobs.wait({ id: job.id })
      }
      expect(new Set(starts).size).toBe(3)
      expect(starts).toEqual([0, 1, 2])
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.effect("starting the same explicit id twice returns the running job and does not rerun it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const reruns = yield* Ref.make(0)
      const first = yield* jobs.start({
        id: "ses_duplicate_start",
        type: "task",
        run: Deferred.succeed(latch, undefined).pipe(Effect.andThen(Effect.never)),
      })
      yield* Deferred.await(latch)
      const second = yield* jobs.start({ id: "ses_duplicate_start", type: "task", run: Ref.update(reruns, (n) => n + 1).pipe(Effect.as("rerun")) })
      expect(second).toMatchObject({ id: first.id, status: "running", started_at: first.started_at })
      yield* Effect.yieldNow
      expect(yield* Ref.get(reruns)).toBe(0)
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("increments pending work before starting immediately settling extensions", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          expect(yield* jobs.extend({ id: job.id, run: Effect.succeed(`second-${index}`) })).toBe(true)
          expect((yield* jobs.get(job.id))?.status).toBe("running")

          yield* Deferred.succeed(first, undefined)
          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `second-${index}` },
          })
        }),
      )
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("records a cancellation that cascaded from an ancestor's teardown", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const own = yield* jobs.start({ id: "job_own", type: "test", run: Effect.never })
      const descendant = yield* jobs.start({ id: "job_descendant", type: "test", run: Effect.never })

      expect(yield* jobs.cancel(own.id)).toMatchObject({ status: "cancelled" })
      expect(yield* jobs.get(own.id)).not.toHaveProperty("cancelledByTeardown")
      expect(yield* jobs.cancel(descendant.id, { teardown: true })).toMatchObject({
        status: "cancelled",
        cancelledByTeardown: true,
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  // Ownership is one relation with three readings, and callers pick the one
  // their intent needs: cancellation sweeps everything a session owns, while a
  // wait may only follow the parent link. Keeping them here means a change to
  // one reading cannot quietly move another.
  describe("ownership relations", () => {
    const job = (input: { id: string; metadata?: Record<string, unknown> }) => ({
      id: input.id,
      type: "task",
      status: "running" as const,
      started_at: 0,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })

    test("a session's own run matches runsSession and belongsToSession", () => {
      const own = job({ id: "ses_parent", metadata: { sessionId: "ses_parent" } })

      expect(BackgroundJob.runsSession(own, "ses_parent")).toBe(true)
      expect(BackgroundJob.belongsToSession(own, "ses_parent")).toBe(true)
      // Its own run is not work it can wait for.
      expect(BackgroundJob.isSubagentOf(own, "ses_parent")).toBe(false)
    })

    test("a launched subagent matches isSubagentOf and belongsToSession", () => {
      const child = job({ id: "ses_child", metadata: { parentSessionId: "ses_parent", sessionId: "ses_child" } })

      expect(BackgroundJob.isSubagentOf(child, "ses_parent")).toBe(true)
      expect(BackgroundJob.belongsToSession(child, "ses_parent")).toBe(true)
      expect(BackgroundJob.runsSession(child, "ses_parent")).toBe(false)
    })

    test("an unrelated job matches none of the relations", () => {
      const other = job({ id: "ses_other", metadata: { parentSessionId: "ses_sibling", sessionId: "ses_other" } })

      expect(BackgroundJob.isSubagentOf(other, "ses_parent")).toBe(false)
      expect(BackgroundJob.belongsToSession(other, "ses_parent")).toBe(false)
      expect(BackgroundJob.runsSession(other, "ses_parent")).toBe(false)
    })
  })

  it.live("interrupts live work without promising settlement after the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // The abandoned in-memory registry is not a durable observation channel.
      expect((yield* jobs.get(job.id))?.status).toBe("running")
    }),
  )
})
