import { Cause, Effect, Exit } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { DaemonApi } from "../api"
import { DaemonRuns } from "../daemon-runs"
import { DaemonStop } from "../daemon-stop"
import { ActiveRunsError, ActiveRunsUnknownError } from "../groups/daemon"

// A claim that does not answer in time is not an idle claim: the active-run
// state is unverified, so the stop is refused instead of assumed safe.
const CLAIM_TIMEOUT = "2 seconds"

export const DaemonHandler = HttpApiBuilder.group(DaemonApi, "server.daemon", (handlers) =>
  Effect.gen(function* () {
    const runs = yield* DaemonRuns.Service
    const stop = yield* DaemonStop.Service

    return handlers.handle(
      "daemon.stopIfIdle",
      Effect.fnUntraced(function* () {
        const claim = yield* runs.stopIfIdle.pipe(Effect.timeout(CLAIM_TIMEOUT), Effect.exit)
        // A failure, defect, timeout, or interruption all leave the active-run
        // state unverified, and unverified is never idle.
        if (!Exit.isSuccess(claim)) {
          yield* Effect.logWarning("Refused stop-if-idle: active-run state is unknown").pipe(
            Effect.annotateLogs({ reason: String(Cause.squash(claim.cause)) }),
          )
          return yield* new ActiveRunsUnknownError({ message: "Active run state is unknown" })
        }
        if (claim.value.status === "busy") {
          const activeRuns = claim.value.activeRuns
          return yield* new ActiveRunsError({
            message: `Refused stop-if-idle: ${activeRuns} active run(s)`,
            activeRuns,
          })
        }

        // Granted. The run gate closed with the claim, so terminating the
        // process after the response is written cannot interrupt a run.
        yield* stop.terminate.pipe(Effect.forkDetach)
        return { data: { status: "stopping" as const } }
      }),
    )
  }),
)
