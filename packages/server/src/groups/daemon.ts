import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

/**
 * Daemon control surface. This group is intentionally not part of the shared
 * Protocol API: it stops a server process, so only the background service
 * started by `service start` (which owns its own process) mounts it.
 */
export class ActiveRunsError extends Schema.TaggedErrorClass<ActiveRunsError>()(
  "ActiveRunsError",
  {
    message: Schema.String,
    activeRuns: Schema.Number,
  },
  { httpApiStatus: 409 },
) {}

/** The server could not verify its active-run state, so it refuses to stop. */
export class ActiveRunsUnknownError extends Schema.TaggedErrorClass<ActiveRunsUnknownError>()(
  "ActiveRunsUnknownError",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export const DaemonGroup = HttpApiGroup.make("server.daemon").add(
  HttpApiEndpoint.post("daemon.stopIfIdle", "/api/daemon/stop-if-idle", {
    success: Schema.Struct({ data: Schema.Struct({ status: Schema.Literal("stopping") }) }),
    error: [ActiveRunsError, ActiveRunsUnknownError],
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "daemon.stopIfIdle",
      summary: "Stop the server when idle",
      description:
        "Stops this server process only when no run is active at request time. The idle check and the refusal of every later run are one atomic step, so the server cannot begin a run after it has accepted a stop. Responds 409 with the active run count while runs are active and 503 when the active-run state cannot be verified. Granted stops terminate the process after the response is written.",
    }),
  ),
)
