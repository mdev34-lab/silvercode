import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { Credential } from "@opencode-ai/core/credential"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Layer, Option } from "effect"
import { Api, DaemonApi } from "./api"
import { ServerAuth } from "./auth"
import { DaemonRuns } from "./daemon-runs"
import { DaemonStop } from "./daemon-stop"
import { DaemonHandler } from "./handlers/daemon"
import { handlers } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { PtyEnvironment } from "./pty-environment"
import { layer as locationLayer } from "./location"
import { sessionLocationLayer } from "./middleware/session-location"

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

export function createRoutes(password?: string, options?: { daemon?: boolean }) {
  return makeRoutes(
    password
      ? ServerAuth.Config.configLayer({ username: "opencode", password: Option.some(password) })
      : ServerAuth.Config.layer,
    options?.daemon === true,
  )
}

function makeRoutes<AuthError, AuthServices>(
  auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>,
  daemon: boolean,
) {
  const serviceLayer = AppNodeBuilder.build(applicationServices, [[SessionExecution.node, SessionExecutionLocal.node]])

  // Process controls exist only on the background service, which owns its own
  // process (started via `service start`, i.e. `serve --register`). A regular
  // `serve` process must not expose a route that ends the process.
  const daemonRoutes = daemon
    ? HttpApiBuilder.layer(DaemonApi).pipe(
        Layer.provide(DaemonHandler),
        Layer.provide(DaemonRuns.layer),
        Layer.provide(DaemonStop.layer),
        Layer.provide(authorizationLayer),
        Layer.provide(schemaErrorLayer),
        Layer.provide(auth),
        Layer.provide(serviceLayer),
      )
    : Layer.empty

  return Layer.mergeAll(
    HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(handlers),
      Layer.provide(sessionLocationLayer),
      Layer.provide(locationLayer),
      Layer.provide(authorizationLayer),
      Layer.provide(schemaErrorLayer),
      Layer.provide(auth),
      Layer.provide(serviceLayer),
    ),
    daemonRoutes,
  )
}

export const routes = createRoutes()

export const webHandler = () =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })
