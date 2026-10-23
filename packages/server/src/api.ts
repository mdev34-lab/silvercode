import { HttpApi } from "effect/unstable/httpapi"
import { makeDefaultApi } from "@opencode-ai/protocol/api"
import { Authorization } from "@opencode-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@opencode-ai/protocol/middleware/schema-error"
import { LocationMiddleware } from "./location"
import { SessionLocationMiddleware } from "./middleware/session-location"
import { DaemonGroup } from "./groups/daemon"

export const Api = makeDefaultApi({
  locationMiddleware: LocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
})

// Separate from `Api` on purpose: the daemon endpoints are process controls for
// the background service, not part of the shared Protocol surface.
export const DaemonApi = HttpApi.make("server-daemon")
  .add(DaemonGroup)
  .middleware(Authorization)
  .middleware(SchemaErrorMiddleware)
