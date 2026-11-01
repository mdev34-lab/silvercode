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

function parsePositiveIntegerHeader(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

// Trust model (#555): instance HTTP routes run behind `ServerAuth` when configured (or on a
// trusted local loopback server). Any caller authorized to submit a turn may opt *its own*
// HTTP request fiber into headless fast-fail retry semantics via `x-opencode-headless: 1`
// and an optional `x-opencode-retry-max-delay` positive integer ceiling. `HeadlessRunRef` is
// bound strictly per HTTP request fiber (`Option.isSome(request)`), so these headers cannot
// alter retry behavior for concurrent interactive/TUI sessions or bypass authentication; when
// invoked outside an HTTP request (`Option.isNone(request)`), any ambient `HeadlessRunRef` in
// Effect context is preserved unchanged.
function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
    const ctx = yield* store.load({ directory: decode(route.directory) })
    const withInstance = effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
    if (Option.isNone(request)) {
      return yield* withInstance
    }
    const headless = request.value.headers[HEADLESS_RUN_HEADER] === "1"
    const maxDelayMs = headless
      ? parsePositiveIntegerHeader(request.value.headers[HEADLESS_RETRY_MAX_DELAY_HEADER])
      : undefined
    return yield* Effect.provideService(withInstance, HeadlessRunRef, headless ? { maxDelayMs } : undefined)
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store))
  }),
)
