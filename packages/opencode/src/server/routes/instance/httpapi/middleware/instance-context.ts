import {
  HEADLESS_RETRY_MAX_DELAY_HEADER,
  HEADLESS_RUN_HEADER,
  HeadlessRunRef,
  InstanceRef,
  WorkspaceRef,
} from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Effect, Layer, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiInstanceContext") {}

function decode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
    const headless = Option.isSome(request) && request.value.headers[HEADLESS_RUN_HEADER] === "1"
    const rawMaxDelay =
      headless && Option.isSome(request) ? request.value.headers[HEADLESS_RETRY_MAX_DELAY_HEADER] : undefined
    const parsedMaxDelay = rawMaxDelay !== undefined ? Number(rawMaxDelay) : Number.NaN
    const maxDelayMs = Number.isInteger(parsedMaxDelay) && parsedMaxDelay > 0 ? parsedMaxDelay : undefined
    const ctx = yield* store.load({ directory: decode(route.directory) })
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
      Effect.provideService(HeadlessRunRef, headless ? { maxDelayMs } : undefined),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store))
  }),
)
