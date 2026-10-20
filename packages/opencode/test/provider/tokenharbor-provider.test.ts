import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect } from "effect"
import { Provider } from "../../src/provider/provider"
import { testEffect } from "../lib/effect"

const TOKENHARBOR = ProviderV2.ID.make("tokenharbor")
const it = testEffect(LayerNode.compile(Provider.node))

const server = Bun.serve({
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname !== "/v1/models") return new Response("missing", { status: 404 })
    if (request.headers.get("authorization") !== "Bearer thk_test") return new Response("{}", { status: 401 })
    return Response.json({ object: "list", data: [{ id: "alpha" }, { id: "beta" }] })
  },
})

const withKey = <A, E, R>(key: string | undefined, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.TOKENHARBOR_API_KEY
      if (key) process.env.TOKENHARBOR_API_KEY = key
      else delete process.env.TOKENHARBOR_API_KEY
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.TOKENHARBOR_API_KEY
        else process.env.TOKENHARBOR_API_KEY = previous
      }),
  )

const config = { provider: { tokenharbor: { options: { baseURL: `http://localhost:${server.port}/v1` } } } }

it.instance(
  "tokenharbor lists models from /v1/models when a key is set",
  () =>
    withKey(
      "thk_test",
      Effect.gen(function* () {
        const providers = yield* (yield* Provider.Service).list()
        expect(Object.keys(providers[TOKENHARBOR].models).sort()).toEqual(["alpha", "beta"])
        expect(providers[TOKENHARBOR].models.alpha.api.npm).toBe("@ai-sdk/openai-compatible")
      }),
    ),
  { config },
)

it.instance(
  "tokenharbor stays hidden without a key",
  () =>
    withKey(
      undefined,
      Effect.gen(function* () {
        const providers = yield* (yield* Provider.Service).list()
        expect(providers[TOKENHARBOR]).toBeUndefined()
      }),
    ),
  { config },
)
