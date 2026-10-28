import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, beforeEach, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Npm } from "@opencode-ai/core/npm"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

// #579: every fixture below builds a fresh tmpdir instance, and its first config load
// forkDetach'es an in-process `npm install @opencode-ai/plugin` (Arborist reify) per
// config directory — always including the process-wide global config dir. A detached
// fiber outlives the test scope it started in, so one test's Arborist import/tree-build/
// extraction CPU bursts run on the same single thread while the NEXT test's
// waitForPending window is open. Under load that starved the readiness poll: the reported
// failure spent 2074ms inside a 1s live bound because neither the poll loop nor its
// timeout could get the loop. The flag keeps these fixtures out of the preseed (none of
// them configure plugins); the stub additionally records calls so the readiness guard
// test below can prove no fixture in this file ever kicks an install off.
const depInstalls: string[] = []
const stubNpm = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.die(new Error("permission timeout fixtures must not install packages")),
    install: (dir) => Effect.sync(() => void depInstalls.push(dir)),
    which: () => Effect.die(new Error("permission timeout fixtures must not install packages")),
  }),
)

const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [Npm.node, stubNpm],
  ],
)
const it = testEffect(env)

let priorDepInstallFlag: string | undefined
beforeEach(() => {
  priorDepInstallFlag = process.env.OPENCODE_DISABLE_CONFIG_DEP_INSTALL
  // Same convention as test/project/instance-bootstrap.test.ts: keep the countdown
  // contract independent from npm dependency preseed timing. Evaluated at access time
  // during instance config load, so setting it per test is enough.
  process.env.OPENCODE_DISABLE_CONFIG_DEP_INSTALL = "1"
})
afterEach(() => {
  if (priorDepInstallFlag === undefined) delete process.env.OPENCODE_DISABLE_CONFIG_DEP_INSTALL
  else process.env.OPENCODE_DISABLE_CONFIG_DEP_INSTALL = priorDepInstallFlag
})

// One second is the shortest countdown the config accepts, so every test here outlives
// it: a request that is still pending afterwards proves the timer was cancelled rather
// than simply not fired yet.
const countdown = { permission_timeout: { enabled: true, seconds: 1 } }

const ask = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

const reply = (input: Parameters<Permission.Interface["reply"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.reply(input)
  })

const list = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.list()
  })

const bash = (id: string, session = "session_timeout") => ({
  id: PermissionV1.ID.make(id),
  sessionID: SessionID.make(session),
  permission: "bash",
  patterns: ["ls"],
  metadata: {},
  always: ["ls"],
  ruleset: [],
})

// On a timeout the error carries what was observed: how long the wait actually ran, how
// many polls got to run (a starved event loop runs few), the worst gap between polls, and
// the pending requests. A slow runner and a request that never arrived look different here.
// The 1 second bound is unchanged.
const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const started = Date.now()
    let polls = 0
    let last = started
    let worstGap = 0
    let seen = -1
    return yield* Effect.gen(function* () {
      while (true) {
        const now = Date.now()
        worstGap = Math.max(worstGap, now - last)
        last = now
        polls++
        const pending = yield* list()
        seen = pending.length
        if (pending.length === count) return pending
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () =>
          Effect.fail(
            new Error(
              `timed out waiting for ${count} pending permission request(s): elapsed=${Date.now() - started}ms polls=${polls} worstPollGap=${worstGap}ms lastSeenPending=${seen}`,
            ),
          ),
      }),
    )
  })

const rejectAll = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (const request of yield* permission.list()) {
      yield* permission.reply({ requestID: request.id, reply: "reject" })
    }
  })

// Collects every `permission.replied` outcome so a test can assert the countdown never
// settled a request that a human already answered.
const collectReplies = () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const replies: PermissionV1.ReplyOutcome[] = []
    const unsub = yield* events.listen((event) => {
      if (event.type === Permission.Event.Replied.type)
        replies.push((event.data as { reply: PermissionV1.ReplyOutcome }).reply)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsub)
    return replies
  })

const waitForReplies = (replies: ReadonlyArray<unknown>, count: number) =>
  Effect.gen(function* () {
    while (replies.length < count) yield* Effect.sleep("10 millis")
  }).pipe(
    Effect.timeoutOrElse({
      duration: "1 second",
      orElse: () => Effect.fail(new Error(`timed out waiting for ${count} permission replied event(s)`)),
    }),
  )

// Records the instant the request was announced. The deadline is computed immediately
// before that — measured 2ms apart, with only a log line and the publish in between — so
// the two instants bracket `expiresAt` to within the countdown itself.
const collectAnnounced = () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const announced = { at: 0 }
    const unsub = yield* events.listen((event) => {
      if (event.type === Permission.Event.Asked.type) announced.at = Date.now()
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsub)
    return announced
  })

// Once a request leaves `pending` with its deferred still open, nothing can settle it any
// more: not a later reply, not the countdown, not the instance dispose finalizer. Fail
// loudly instead of hanging the suite for the full test timeout.
const notStranded = <A, E>(self: Effect.Effect<A, E>) =>
  self.pipe(
    Effect.timeoutOrElse({
      duration: "3 seconds",
      orElse: () => Effect.fail(new Error("permission ask was never settled")),
    }),
  )

it.instance(
  "ask - auto-denies an unanswered prompt when the countdown expires",
  () =>
    Effect.gen(function* () {
      const replies = yield* collectReplies()
      const announced = yield* collectAnnounced()
      const before = Date.now()
      const fiber = yield* ask(bash("per_timeout_expire")).pipe(Effect.forkScoped)

      const [request] = yield* waitForPending(1)
      // Published on the request so every client renders the same countdown. Both bounds are
      // measured from a captured instant rather than from `Date.now()` at the assertion,
      // which would move with the test's own scheduling and let a deadline anchored anywhere
      // through. From the ask the countdown can only be late, never short; from the
      // announcement it is pinned to one second either side of a 100ms tolerance.
      const expiresAt = request.expiresAt ?? 0
      expect(expiresAt - before).toBeGreaterThanOrEqual(1000)
      expect(expiresAt - announced.at).toBeGreaterThanOrEqual(900)
      expect(expiresAt - announced.at).toBeLessThanOrEqual(1000)

      const exit = yield* Fiber.await(fiber)
      if (Exit.isSuccess(exit)) throw new Error("expected the unanswered prompt to be denied")
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(PermissionV1.TimedOutError)
      // A timeout must read differently from a rejection: the model should change
      // approach instead of treating it as the user saying no.
      if (error instanceof PermissionV1.TimedOutError) expect(error.message).toContain("automatically denied")

      expect(yield* list()).toHaveLength(0)
      yield* waitForReplies(replies, 1)
      // Clients dismiss the prompt off this event rather than polling for it.
      expect(replies).toEqual(["timeout"])
    }),
  { git: true, config: countdown },
)

it.instance(
  "ask - defaults to a 45 second countdown",
  () =>
    Effect.gen(function* () {
      const announced = yield* collectAnnounced()
      const before = Date.now()
      const fiber = yield* ask(bash("per_timeout_default")).pipe(Effect.forkScoped)

      const [request] = yield* waitForPending(1)
      // The default is 45s, not "somewhere north of 43s": measured from the announcement,
      // where a wrong default cannot hide behind the fork's scheduling delay.
      const expiresAt = request.expiresAt ?? 0
      expect(expiresAt - before).toBeGreaterThanOrEqual(45_000)
      expect(expiresAt - announced.at).toBeGreaterThanOrEqual(44_900)
      expect(expiresAt - announced.at).toBeLessThanOrEqual(45_000)

      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  { git: true },
)

// Guards the #579 quarantine: every fixture in this file routes through a fresh instance
// config load, and none of them may fork the background dependency install — its
// in-process Arborist work is what overlapped and starved the default-countdown test's
// readiness window. Without the beforeEach flag (or if loadInstanceState stops honoring
// it), the stubbed Npm.install records the attempt and this fails, instead of the flake
// sneaking back as an intermittent 1s timeout.
it.instance(
  "readiness - config startup never forks a background dependency install",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask(bash("per_timeout_no_dep_install")).pipe(Effect.forkScoped)

      const [request] = yield* waitForPending(1)
      // The deadline is stamped from the loaded config (this instance sets the 1s
      // countdown), so observing it proves the ask really went through config load and
      // the assertion below is not vacuously passing on a config path that never ran.
      const expiresAt = request.expiresAt ?? 0
      expect(expiresAt - Date.now()).toBeLessThanOrEqual(1000)
      expect(expiresAt - Date.now()).toBeGreaterThan(0)

      // A detached install fiber records synchronously when it starts; it is forked
      // inside the config load that just completed, so a short beat is enough for a
      // regressed fork to surface here.
      yield* Effect.sleep("100 millis")
      expect(depInstalls).toEqual([])

      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  { git: true, config: countdown },
)

for (const answer of ["once", "always", "reject"] as const) {
  it.instance(
    `reply - ${answer} cancels the countdown`,
    () =>
      Effect.gen(function* () {
        const replies = yield* collectReplies()
        const fiber = yield* ask(bash("per_timeout_cancel")).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        yield* reply({ requestID: PermissionV1.ID.make("per_timeout_cancel"), reply: answer })
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(answer === "reject")

        yield* Effect.sleep("1500 millis")
        expect(replies).toEqual([answer])
        expect(yield* list()).toHaveLength(0)
      }),
    { git: true, config: countdown },
  )
}

it.instance(
  "ask - expiry settles only the request that ran out of time",
  () =>
    Effect.gen(function* () {
      const first = yield* ask(bash("per_timeout_first")).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      // Start the second prompt late so its countdown is still running when the first one
      // expires. The stagger doubles as the slack the reply below has to land in, so this
      // test runs a longer countdown than the rest of the file.
      yield* Effect.sleep("2 seconds")
      const second = yield* ask(bash("per_timeout_second")).pipe(Effect.forkScoped)
      yield* waitForPending(2)

      const exit = yield* Fiber.await(first)
      if (Exit.isSuccess(exit)) throw new Error("expected the first prompt to be denied")
      expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.TimedOutError)

      // A manual reject cascades to every pending request in the session; a timeout
      // must not, or one unanswered prompt would take down tool calls a human is
      // still about to answer.
      expect((yield* waitForPending(1)).map((item) => item.id)).toEqual([PermissionV1.ID.make("per_timeout_second")])

      yield* reply({ requestID: PermissionV1.ID.make("per_timeout_second"), reply: "once" })
      yield* Fiber.join(second)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true, config: { permission_timeout: { enabled: true, seconds: 3 } } },
)

it.instance(
  "ask - arms the countdown in every session, including subagents",
  () =>
    Effect.gen(function* () {
      const parent = yield* ask(bash("per_timeout_parent", "session_parent")).pipe(Effect.forkScoped)
      const child = yield* ask(bash("per_timeout_child", "session_child")).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(2)
      expect(pending.every((item) => item.expiresAt !== undefined)).toBe(true)

      yield* rejectAll()
      yield* Effect.all([Fiber.await(parent), Fiber.await(child)])
    }),
  { git: true, config: countdown },
)

it.instance(
  "ask - enabled false waits for a human instead of counting down",
  () =>
    Effect.gen(function* () {
      const replies = yield* collectReplies()
      const fiber = yield* ask(bash("per_timeout_disabled")).pipe(Effect.forkScoped)

      const [request] = yield* waitForPending(1)
      expect(request.expiresAt).toBeUndefined()

      // Well past the one second countdown this instance is configured with, which
      // stays inert because the timeout is switched off.
      yield* Effect.sleep("1500 millis")
      expect(yield* list()).toHaveLength(1)
      expect(replies).toEqual([])

      yield* reply({ requestID: PermissionV1.ID.make("per_timeout_disabled"), reply: "once" })
      yield* Fiber.join(fiber)
    }),
  { git: true, config: { permission_timeout: { enabled: false, seconds: 1 } } },
)

// `permission.replied` is not a durable event, so publishing runs its listeners inline: a
// listener that dies fails the publish, and interrupting the publisher lands inside it.
// Both are the fault the claim has to survive, because at that point the entry is already
// out of `pending` — the state the countdown reads as "a reply settled this" and the
// dispose finalizer can no longer see.
it.instance(
  "reply - settles the ask when publishing the replied event fails",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const unsub = yield* events.listen((event) =>
        event.type === Permission.Event.Replied.type ? Effect.die(new Error("listener boom")) : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsub)

      const fiber = yield* ask(bash("per_timeout_publish")).pipe(Effect.forkScoped)
      yield* waitForPending(1)

      const answered = yield* reply({
        requestID: PermissionV1.ID.make("per_timeout_publish"),
        reply: "once",
      }).pipe(Effect.exit)
      expect(Exit.isFailure(answered)).toBe(true)

      // The answer was applied before the publish was attempted, so the ask is already
      // done and the countdown has nothing left to expire.
      yield* notStranded(Fiber.join(fiber))
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true, config: countdown },
)

it.instance(
  "reply - settles the ask when the reply is interrupted mid-publish",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      // Hold the publish open so the reply can be interrupted after it claimed the
      // request but before it finished announcing it.
      const unsub = yield* events.listen((event) =>
        event.type === Permission.Event.Replied.type ? Effect.sleep("10 seconds") : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsub)

      const fiber = yield* ask(bash("per_timeout_interrupt")).pipe(Effect.forkScoped)
      yield* waitForPending(1)

      const answering = yield* reply({
        requestID: PermissionV1.ID.make("per_timeout_interrupt"),
        reply: "once",
      }).pipe(Effect.forkScoped)
      yield* Effect.sleep("100 millis")
      yield* Fiber.interrupt(answering)

      yield* notStranded(Fiber.join(fiber))
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true, config: countdown },
)

// The countdown is armed against the absolute deadline and forked before `asked` is
// published, so no listener can stretch it: the request expires when `expiresAt` says it
// does even while the publish that announces it is still held open.
it.instance(
  "ask - expires on the deadline while a listener holds the asked event open",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const release = yield* Deferred.make<void, never>()
      const announced = yield* Deferred.make<number>()
      const unsub = yield* events.listen((event) =>
        Effect.gen(function* () {
          if (event.type !== Permission.Event.Asked.type) return
          const request = event.data as PermissionV1.Request
          if (request.id !== PermissionV1.ID.make("per_timeout_slow_asked")) return
          yield* Deferred.succeed(announced, request.expiresAt ?? 0)
          yield* Deferred.await(release)
        }),
      )
      yield* Effect.addFinalizer(() => unsub)

      return yield* Effect.gen(function* () {
        const fiber = yield* ask(bash("per_timeout_slow_asked")).pipe(Effect.forkScoped)
        // Unlike pending membership, this signal survives the deadline. A delayed
        // observer must not miss the request it is trying to test.
        const expiresAt = yield* Deferred.await(announced).pipe(Effect.timeout("1 second"))
        expect(expiresAt).toBeGreaterThan(0)
        yield* Effect.sleep(Math.max(0, expiresAt - Date.now()) + 500)
        expect(yield* list()).toHaveLength(0)
        expect(fiber.pollUnsafe()).toBeUndefined()

        yield* Deferred.succeed(release, undefined)
        const exit = yield* Fiber.await(fiber)
        if (Exit.isSuccess(exit)) throw new Error("expected the unanswered prompt to be denied")
        expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.TimedOutError)
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
    }),
  { git: true, config: countdown },
)

it.instance(
  "ask - still fails with the timeout when announcing it fails",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      // The request is already expired by the time this is announced, so a listener that
      // dies must not replace `TimedOutError` with its own error.
      const unsub = yield* events.listen((event) =>
        event.type === Permission.Event.Replied.type ? Effect.die(new Error("listener boom")) : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsub)

      const exit = yield* ask(bash("per_timeout_bad_listener")).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) throw new Error("expected the unanswered prompt to be denied")
      expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.TimedOutError)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true, config: countdown },
)

// A reject has to reach every request in the session, so each of them fails with the
// rejection rather than being left for its own countdown to pick up later.
const expectAllRejected = (exits: ReadonlyArray<Exit.Exit<void, unknown>>) => {
  for (const exit of exits) {
    if (Exit.isSuccess(exit)) throw new Error("expected the reject to cascade across the session")
    expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
  }
}

const cascadedExits = (first: Fiber.Fiber<void, unknown>, second: Fiber.Fiber<void, unknown>) =>
  Effect.all([Fiber.join(first).pipe(Effect.exit), Fiber.join(second).pipe(Effect.exit)])

it.instance(
  "reply - reject settles the whole session when announcing fails",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const unsub = yield* events.listen((event) =>
        event.type === Permission.Event.Replied.type ? Effect.die(new Error("listener boom")) : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsub)

      const first = yield* ask(bash("per_timeout_cascade_a")).pipe(Effect.forkScoped)
      const second = yield* ask(bash("per_timeout_cascade_b")).pipe(Effect.forkScoped)
      yield* waitForPending(2)

      const answered = yield* reply({
        requestID: PermissionV1.ID.make("per_timeout_cascade_a"),
        reply: "reject",
      }).pipe(Effect.exit)
      expect(Exit.isFailure(answered)).toBe(true)

      // Every request the reject decided about is settled before any of them is announced.
      expectAllRejected(yield* notStranded(cascadedExits(first, second)))
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true, config: countdown },
)

it.instance(
  "reply - reject settles the whole session when the reply is interrupted mid-publish",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const unsub = yield* events.listen((event) =>
        event.type === Permission.Event.Replied.type ? Effect.sleep("10 seconds") : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsub)

      const first = yield* ask(bash("per_timeout_interrupt_a")).pipe(Effect.forkScoped)
      const second = yield* ask(bash("per_timeout_interrupt_b")).pipe(Effect.forkScoped)
      yield* waitForPending(2)

      const rejecting = yield* reply({
        requestID: PermissionV1.ID.make("per_timeout_interrupt_a"),
        reply: "reject",
      }).pipe(Effect.forkScoped)
      yield* Effect.sleep("100 millis")
      yield* Fiber.interrupt(rejecting)

      expectAllRejected(yield* notStranded(cascadedExits(first, second)))
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true, config: countdown },
)

// An ask abandoned by an abort never got an answer, but clients only drop a prompt on
// `permission.replied`; without the event the modal outlives the request and every later
// reply for it is a not-found error.
it.instance(
  "ask - an aborted request is announced as settled so clients drop the prompt",
  () =>
    Effect.gen(function* () {
      const replies = yield* collectReplies()
      const fiber = yield* ask(bash("per_abort_announced")).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* Fiber.interrupt(fiber)
      yield* waitForReplies(replies, 1)
      expect(replies).toEqual(["reject"])
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "ask - an answered request is announced once, not again when the ask ends",
  () =>
    Effect.gen(function* () {
      const replies = yield* collectReplies()
      const fiber = yield* ask(bash("per_answered_once")).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_answered_once"), reply: "once" })
      yield* Fiber.join(fiber)
      yield* Effect.sleep("200 millis")
      expect(replies).toEqual(["once"])
    }),
  { git: true },
)
