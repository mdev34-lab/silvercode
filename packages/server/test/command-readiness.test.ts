import { describe, expect, test } from "bun:test"
import { CommandV2 } from "@opencode-ai/core/command"
import { Location } from "@opencode-ai/core/location"
import { PluginInternal } from "@opencode-ai/core/plugin/internal"
import { Project } from "@opencode-ai/core/project"
import { Effect, Deferred, Layer, Option } from "effect"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { CommandGroup } from "@opencode-ai/protocol/groups/command"
import { HttpApi } from "effect/unstable/httpapi"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CommandHandler } from "../src/handlers/command"
import { LocationMiddleware } from "../src/location"
import { ServerAuth } from "../src/auth"
import { authorizationLayer } from "../src/middleware/authorization"
import { schemaErrorLayer } from "../src/middleware/schema-error"

const NarrowApi = HttpApi.make("server").add(CommandGroup.middleware(LocationMiddleware))

describe("command readiness", () => {
  test("does not list before PluginInternal.ready completes, then lists after", async () => {
    const readyGate = await Effect.runPromise(Deferred.make<void>())
    const enteredReady = await Effect.runPromise(Deferred.make<void>())
    let readyCompleted = false
    let listCalled = false

    const locationService = Location.Service.of({
      directory: AbsolutePath.make(process.cwd()),
      workspaceID: undefined,
      project: { id: Project.ID.global, directory: AbsolutePath.make(process.cwd()) },
      vcs: undefined,
    })

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

    const locationServicesLayer = Layer.mergeAll(
      Layer.succeed(Location.Service, locationService),
      Layer.succeed(PluginInternal.Service, pluginInternalService),
      Layer.succeed(CommandV2.Service, commandService),
    )

    const locationMiddlewareLayer = Layer.succeed(
      LocationMiddleware,
      LocationMiddleware.of((effect) => effect.pipe(Effect.provide(locationServicesLayer))),
    )

    const routes = HttpApiBuilder.layer(NarrowApi).pipe(
      Layer.provide(CommandHandler),
      Layer.provide(locationMiddlewareLayer),
      Layer.provide(authorizationLayer),
      Layer.provide(schemaErrorLayer),
      Layer.provide(ServerAuth.Config.configLayer({ username: "opencode", password: Option.none() })),
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
