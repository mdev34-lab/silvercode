import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"

function eventData(data: unknown): Sse.Event {
  // The SSE id field is the resume token: the SDK's SSE client tracks it and
  // sends it back as Last-Event-ID on reconnect. Without it every reconnect
  // silently loses the disconnect window (#399).
  const payload = (data as { payload?: { id?: unknown } } | undefined)?.payload
  return {
    _tag: "Event",
    event: "message",
    id: typeof payload?.id === "string" ? payload.id : undefined,
    data: JSON.stringify(data),
  }
}

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

function eventResponse() {
  return Effect.gen(function* () {
    yield* Effect.logInfo("global event connected")
    const request = yield* HttpServerRequest.HttpServerRequest
    const lastEventID = request.headers["last-event-id"]

    // Listener registration is eager, so events published after this point
    // cannot be lost while the replay log is read and the HTTP body fiber is
    // starting. The replay/log overlap is deduped by id below.
    const queue = yield* Queue.unbounded<GlobalBusEvent>()
    const listener = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", listener)),
      () => Effect.sync(() => GlobalBus.off("event", listener)),
    )

    // Replay what a reconnecting client missed. An expired cursor cannot
    // prove completeness, so the client is told to resync instead of trusting
    // a partial replay.
    const replay = typeof lastEventID === "string" ? GlobalBus.sinceEvents(lastEventID) : undefined
    const replayed = new Set<string>()
    for (const event of replay?.events ?? []) {
      if (typeof event.payload?.id === "string") replayed.add(event.payload.id)
    }

    const live = Stream.fromQueue(queue).pipe(
      Stream.filter((event) => {
        const id = event.payload?.id
        if (typeof id !== "string") return true
        if (replayed.has(id)) return false
        return lastEventID === undefined || id > lastEventID
      }),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    const opening: GlobalBusEvent[] = [
      { payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } },
      ...(replay && !replay.complete
        ? [
            {
              payload: {
                id: EventV2.ID.create(),
                type: "server.resync",
                properties: { reason: "resume-cursor-expired" },
              },
            } satisfies GlobalBusEvent,
          ]
        : []),
    ]

    return HttpServerResponse.stream(
      Stream.fromIterable([...opening, ...(replay?.events ?? [])]).pipe(
        Stream.concat(live.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("global event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest())
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ status: 200, body: { success: true as const, version: target } }),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      )
      if (!result.body.success) return result
      GlobalBus.emitEvent( {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const result = yield* upgrade({ payload: payload.payload })
      return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
  }),
)

