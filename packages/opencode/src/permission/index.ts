import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Duration, Effect, Layer, Context } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"

export const Event = PermissionV1.Event

// Deliberately generous: long enough for a human watching the TUI to answer,
// short enough that an unattended run does not hang on a prompt nobody sees.
const DEFAULT_TIMEOUT_SECONDS = 45
export interface DeniesInput {
  readonly permission: string
  readonly patterns: readonly string[]
  readonly ruleset: PermissionV1.Ruleset
}

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
  readonly denies: (input: DeniesInput) => Effect.Effect<boolean>
}

// Outcomes a registered request can settle with. `DeniedError` is absent because a
// deny rule short-circuits `ask` before the request is ever published.
type ReplyError = PermissionV1.RejectedError | PermissionV1.CorrectedError | PermissionV1.TimedOutError

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, ReplyError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

/**
 * ask()'s per-pattern decision over the SAME ruleset ordering: the caller's
 * ruleset first, the instance-approved always-allow grants last, so a granted
 * always can mask a ruleset deny exactly as ask() decides it. Pure and
 * readonly: it never prompts and never mutates approvals. ask() and
 * denies() both consume this so their verdicts cannot drift apart.
 */
function assess(
  permission: string,
  patterns: readonly string[],
  ruleset: PermissionV1.Ruleset,
  approved: PermissionV1.Ruleset,
): PermissionV1.Rule[] {
  return patterns.map((pattern) => evaluate(permission, pattern, ruleset, approved))
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      let needsAsk = false

      for (const [index, rule] of assess(request.permission, request.patterns, ruleset, approved).entries()) {
        yield* Effect.logInfo("evaluated", {
          permission: request.permission,
          pattern: request.patterns[index],
          action: rule,
        })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const timeout = (yield* config.get()).permission_timeout
      // On unless explicitly disabled: an unanswered prompt would otherwise pin the
      // session forever, which is what headless runs and subagents hit.
      const seconds = timeout?.enabled === false ? undefined : (timeout?.seconds ?? DEFAULT_TIMEOUT_SECONDS)
      // One instant drives both the published `expiresAt` and the countdown below, so what
      // a client renders is exactly when the request expires.
      const deadline = seconds === undefined ? undefined : { at: Date.now() + seconds * 1000, seconds }

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
        expiresAt: deadline?.at,
      }
      yield* Effect.logInfo("asking", {
        id,
        permission: info.permission,
        patterns: info.patterns,
        expiresAt: info.expiresAt,
      })

      const deferred = yield* Deferred.make<void, ReplyError>()
      pending.set(id, { info, deferred })

      // Expires this request alone. A manual reject cascades to every pending request in
      // the session; a timeout must not, or one unanswered prompt would take down
      // unrelated tool calls that a human may still be about to answer.
      const countdown = (due: { at: number; seconds: number }) =>
        Effect.gen(function* () {
          // Against the absolute deadline, not for a duration started here: the countdown
          // is forked before `asked` is published, and a listener on either event can be
          // slow, so measuring from the publish would stretch the timeout past `expiresAt`.
          // One sleep is enough because the config schema caps `seconds` at what a single
          // timer can express; past 2^31 - 1 ms it would never resume.
          yield* Effect.sleep(Duration.millis(Math.max(0, due.at - Date.now())))
          // Claiming is what expires the request. A reply that claimed it first completed
          // the deferred in the same step that removed it from `pending`, so losing the
          // claim here can never block.
          if (!pending.delete(id)) return
          // Detached, and started before the request is expired: completing the deferred
          // lets the ask resume, and the ask terminating takes this child fiber with it,
          // which would swallow the event clients dismiss the prompt on. Nothing waits for
          // it either, so a listener that is slow cannot stretch the timeout and one that
          // fails cannot replace `TimedOutError` with its own error.
          yield* events
            .publish(Event.Replied, { sessionID: info.sessionID, requestID: id, reply: "timeout" })
            .pipe(
              Effect.ignoreCause({ log: true, message: "failed to announce the permission timeout" }),
              Effect.forkDetach,
            )
          Deferred.doneUnsafe(deferred, Effect.fail(new PermissionV1.TimedOutError({ seconds: due.seconds })))
        })

      // Forked into this fiber's scope, so it is cancelled whenever the ask ends — every
      // reply path, an abort, and the instance dispose finalizer — without a timer handle.
      if (deadline !== undefined) yield* countdown(deadline).pipe(Effect.forkChild)

      // Announced inside the same guard as the wait, so a listener that fails on `asked`
      // cannot leave a request registered that nobody is waiting on any more.
      return yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* events.publish(Event.Asked, info)
          return yield* Deferred.await(deferred)
        }),
        // Still pending here means nobody answered: the ask was aborted or the instance is
        // going away. Clients only drop a prompt on `permission.replied`, so announce it
        // the way a countdown does, detached because this runs while the ask is ending.
        Effect.suspend(() => {
          if (!pending.delete(id)) return Effect.void
          return events
            .publish(Event.Replied, { sessionID: info.sessionID, requestID: id, reply: "reject" })
            .pipe(
              Effect.ignoreCause({ log: true, message: "failed to announce the abandoned permission request" }),
              Effect.forkDetach,
            )
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      // A rejection carries the user's feedback when they typed any.
      const rejection =
        input.reply !== "reject"
          ? undefined
          : input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError()

      // Losing the claim means the countdown expired between the lookup above and here,
      // so the honest answer to the client is the same as for an unknown request.
      if (!(yield* settle(pending, existing, rejection)))
        return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      const announced = [{ sessionID: existing.info.sessionID, requestID: existing.info.id, reply: input.reply }]

      if (input.reply === "reject") {
        for (const item of pending.values()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          if (!(yield* settle(pending, item, new PermissionV1.RejectedError()))) continue
          announced.push({ sessionID: item.info.sessionID, requestID: item.info.id, reply: "reject" })
        }
      }

      if (input.reply === "always") {
        for (const pattern of existing.info.always) {
          approved.push({
            permission: existing.info.permission,
            pattern,
            action: "allow",
          })
        }

        for (const item of pending.values()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          const ok = item.info.patterns.every(
            (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
          )
          if (!ok) continue
          if (!(yield* settle(pending, item, undefined))) continue
          announced.push({ sessionID: item.info.sessionID, requestID: item.info.id, reply: "always" })
        }
      }

      // Every request this reply decided about is settled before any of them is
      // announced. Publishing is interruptible and runs listeners inline, so a listener
      // that fails — or a reply fiber interrupted mid-publish — would otherwise leave the
      // siblings a reject already cascaded over sitting in `pending` with an open deferred
      // that nothing can complete any more.
      for (const event of announced) yield* events.publish(Event.Replied, event)
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    // The readonly half of ask(): the same (ruleset, approved) evaluation
    // through the same shared decision helper, returning ask()'s deny verdict
    // without ever prompting or mutating approvals. Callers that must know
    // whether a dispatch would be denied right now — finish's reviewer
    // availability check — consult this instead of the static evaluate, which
    // cannot see the instance-approved grants that ask() applies last.
    const denies = Effect.fn("Permission.denies")(function* (input: DeniesInput) {
      const { approved } = yield* InstanceState.get(state)
      return assess(input.permission, input.patterns, input.ruleset, approved).some((rule) => rule.action === "deny")
    })

    return Service.of({ ask, reply, list, denies })
  }),
)

// Dropping an entry from `pending` and completing its deferred has to be one synchronous
// step. The countdown reads a missing entry as "a reply already settled this" and then
// awaits that deferred, and the instance dispose finalizer can only complete entries that
// are still in `pending`, so splitting the two around the interruptible `events.publish`
// would strand the ask forever when that publish fails or its fiber is interrupted.
// Returns whether this call won the claim.
function settle(pending: Map<PermissionV1.ID, PendingEntry>, entry: PendingEntry, error?: ReplyError) {
  return Effect.sync(() => {
    if (!pending.delete(entry.info.id)) return false
    Deferred.doneUnsafe(entry.deferred, error === undefined ? Effect.void : Effect.fail(error))
    return true
  })
}

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, Config.node] })

export * as Permission from "."
