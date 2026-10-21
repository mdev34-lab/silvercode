import { ProviderAuth } from "@/provider/auth"
import { Config } from "@/config/config"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"
import { providerInfo as qwenWebProviderInfo, QWEN_WEB_PROVIDER_ID } from "@/provider/qwen-web"
import { providerInfo as tokenHarborProviderInfo, TOKENHARBOR_PROVIDER_ID } from "@/provider/tokenharbor"
import { Auth } from "@/auth"

import { APICallError, generateText } from "ai"
import { mapValues } from "remeda"
import { Cause, Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError } from "../groups/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

function mapProviderAuthError<A, R>(self: Effect.Effect<A, ProviderAuth.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => {
      if (error instanceof ProviderAuth.OauthMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCodeMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCallbackFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: {} })
      }
      if (error instanceof ProviderAuth.ValidationFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: { field: error.field, message: error.message } })
      }
      return new ProviderAuthApiError({ name: "BadRequest", data: {} })
    }),
  )
}

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const provider = yield* Provider.Service
    const svc = yield* ProviderAuth.Service
    const authStore = yield* Auth.Service

    const list = Effect.fn("ProviderHttpApi.list")(function* () {
      const config = yield* cfg.get()
      const all = yield* ModelsDev.Service.use((s) => s.get())
      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
      const filtered: Record<string, (typeof all)[string]> = {}
      for (const [key, value] of Object.entries(all)) {
        if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) filtered[key] = value
      }
      const connected = yield* provider.list()
      const credentials = yield* authStore.all().pipe(Effect.orDie)
      // Built-in providers are registered in the internal catalog, not in the
      // remote models.dev catalog: list them for discovery/login while the
      // enabled/disabled filters allow them. A connected entry (live models)
      // always wins.
      const builtins: Record<string, () => Parameters<typeof Provider.toPublicInfo>[0]> = {
        [QWEN_WEB_PROVIDER_ID]: qwenWebProviderInfo,
        [TOKENHARBOR_PROVIDER_ID]: tokenHarborProviderInfo,
      }
      const allowedBuiltins = Object.fromEntries(
        Object.entries(builtins)
          .filter(([id]) => (enabled ? enabled.has(id) : true) && !disabled.has(id))
          .map(([id, info]) => [id, info()]),
      )
      const providers = Object.assign(
        allowedBuiltins,
        mapValues(filtered, (item) => Provider.fromModelsDevProvider(item)),
        connected,
      )
      return {
        all: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
        connected: Object.keys(providers).filter((id) => id in connected || credentials[id]),
      }
    })

    const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
      return yield* svc.methods()
    })

    const authorize = Effect.fn("ProviderHttpApi.authorize")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.AuthorizeInput
    }) {
      return yield* mapProviderAuthError(
        svc.authorize({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          inputs: ctx.payload.inputs,
        }),
      )
    })

    const authorizeRaw = Effect.fn("ProviderHttpApi.authorizeRaw")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderAuth.AuthorizeInput))(body).pipe(
        Effect.mapError(() => new ProviderAuthApiError({ name: "BadRequest", data: {} })),
      )
      // Match legacy route behavior: when authorize() resolves without a
      // result (e.g. no further redirect), serialize as JSON `null` instead
      // of an empty body so clients can `.json()` parse the response.
      const result = yield* authorize({ params: ctx.params, payload })
      return HttpServerResponse.jsonUnsafe(result ?? null)
    })

    const probe = Effect.fn("ProviderHttpApi.probe")(function* (ctx: {
      payload: { providerID: ProviderV2.ID; modelID: string }
    }) {
      const started = Date.now()
      const outcome = yield* Effect.gen(function* () {
        const model = yield* provider.getModel(ctx.payload.providerID, ModelV2.ID.make(ctx.payload.modelID))
        const language = yield* provider.getLanguage(model)
        yield* Effect.tryPromise({
          try: (signal) =>
            generateText({ model: language, prompt: "ok", maxOutputTokens: 16, maxRetries: 0, abortSignal: signal }),
          catch: (error) => error,
        }).pipe(Effect.timeout("20 seconds"))
        return "ok" as const
      }).pipe(
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause)
          const status = APICallError.isInstance(error) ? error.statusCode : undefined
          const transient =
            status === 429 ||
            (status !== undefined && status >= 500) ||
            (APICallError.isInstance(error) && error.isRetryable) ||
            Cause.isTimeoutError(error) ||
            (!APICallError.isInstance(error) && error instanceof Error && /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network/i.test(error.message))
          return Effect.succeed((transient ? "transient" : "error") as "transient" | "error")
        }),
      )
      return { outcome, latencyMs: Date.now() - started }
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.CallbackInput
    }) {
      yield* mapProviderAuthError(
        svc.callback({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          code: ctx.payload.code,
        }),
      )
      return true
    })

    return handlers
      .handle("list", list)
      .handle("auth", auth)
      .handle("probe", probe)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
  }),
)
