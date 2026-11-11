import { describe, expect, test } from "bun:test"
import { CommandV2 } from "@opencode-ai/core/command"
import { PluginInternal } from "@opencode-ai/core/plugin/internal"
import { Effect, Deferred, Layer, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Credential } from "@opencode-ai/core/credential"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { ServerAuth } from "../src/auth"
import { authorizationLayer } from "../src/middleware/authorization"
import { schemaErrorLayer } from "../src/middleware/schema-error"
import { PtyEnvironment } from "../src/pty-environment"
import { layer as locationLayer } from "../src/location"
import { sessionLocationLayer } from "../src/middleware/session-location"
import { handlers } from "../src/handlers"

const applicationServices = LayerNode.group([
  Database.node,
  EventV2.node,
  httpClient,
  ToolOutputStore.cleanupNode,
  SessionV2.node,
  PermissionSaved.node,
  PtyTicket.node,
  Credential.node,
  PtyEnvironment.node,
  LocationServiceMap.node,
])

describe("command readiness", () => {
  test("does not list before PluginInternal.ready completes, then lists after", async () => {
    const readyGate = await Effect.runPromise(Deferred.make<void>())
    const enteredReady = await Effect.runPromise(Deferred.make<void>())
    let readyCompleted = false
    let listCalled = false

    const commands = [
      { name: "init", template: "" },
      { name: "review", template: "" },
      { name: "my-cmd", template: "" },
    ]

    const pluginInternalService = PluginInternal.Service.of({
      ready: Effect.gen(function* () {
        yield* Deferred.succeed(enteredReady, undefined).pipe(Effect.asVoid)
        yield* Deferred.await(readyGate)
        readyCompleted = true
      }),
    })

    const commandService = CommandV2.Service.of({
      get: (name: string) => Effect.succeed(commands.find((command) => command.name === name)),
      list: () =>
        Effect.sync(() => {
          if (!readyCompleted) throw new Error("command.list entered before PluginInternal.ready completed")
          listCalled = true
          return commands
        }),
      transform: () => Effect.succeed({ dispose: Effect.void }),
      reload: () => Effect.void,
    })

    const gatedPluginNode = makeLocationNode({
      service: PluginInternal.Service,
      layer: Layer.succeed(PluginInternal.Service, pluginInternalService),
      deps: [],
    })

    const commandNode = makeLocationNode({
      service: CommandV2.Service,
      layer: Layer.succeed(CommandV2.Service, commandService),
      deps: [],
    })

    const serviceLayer = AppNodeBuilder.build(applicationServices, [
      [LocationServiceMap.node, buildLocationServiceMap([[PluginInternal.node, gatedPluginNode], [CommandV2.node, commandNode]])],
      [SessionExecution.node, SessionExecutionLocal.node],
    ])

    const routes = Layer.mergeAll(
      HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
        Layer.provide(handlers),
        Layer.provide(sessionLocationLayer),
        Layer.provide(locationLayer),
        Layer.provide(authorizationLayer),
        Layer.provide(schemaErrorLayer),
        Layer.provide(ServerAuth.Config.configLayer({ username: "opencode", password: Option.none() })),
        Layer.provide(serviceLayer),
      ),
    )

    const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })

    const readyWaiterController = new AbortController()
    const readyWaiter = Effect.runPromise(Deferred.await(enteredReady), { signal: readyWaiterController.signal })
    let responsePromise: Promise<Response> | undefined
    try {
      responsePromise = web.handler(new Request("http://localhost/api/command"))
      await Promise.race([
        readyWaiter,
        responsePromise.then(() => {
          throw new Error("request completed before PluginInternal.ready was entered")
        }),
      ])
      expect(listCalled).toBe(false)
      expect(readyCompleted).toBe(false)

      await Effect.runPromise(Deferred.succeed(readyGate, undefined))
      const response = await responsePromise
      expect(response.status).toBe(200)
      const body = (await response.json()) as { data: Array<{ name: string }> }
      expect(body.data.map((command) => command.name)).toEqual(["init", "review", "my-cmd"])
      expect(listCalled).toBe(true)
    } finally {
      readyWaiterController.abort()
      await readyWaiter.catch(() => {})
      await Effect.runPromise(Deferred.succeed(readyGate, undefined).pipe(Effect.ignore)).catch(() => {})
      if (responsePromise) await responsePromise.catch(() => {})
      await web.dispose()
    }
  }, 10_000)
})
