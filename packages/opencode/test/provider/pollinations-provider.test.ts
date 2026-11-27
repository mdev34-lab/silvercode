import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect } from "effect"
import { Provider } from "../../src/provider/provider"
import { testEffect } from "../lib/effect"

const POLLINATIONS = ProviderV2.ID.make("pollinations")
const it = testEffect(LayerNode.compile(Provider.node))

const catalog = {
  object: "list",
  data: [
    {
      id: "openai/gpt-5.4-nano",
      category: "text",
      community: false,
      title: "GPT-5.4 Nano",
      input_modalities: ["text"],
      output_modalities: ["text"],
      supported_endpoints: ["/v1/chat/completions"],
      paid_only: false,
      pricing: { promptTextTokens: "0.00000015", completionTextTokens: "0.0000009375" },
      tools: true,
    },
    {
      id: "community/open-chat",
      category: "text",
      community: true,
      title: "Open Chat",
      input_modalities: ["text"],
      output_modalities: ["text"],
      supported_endpoints: ["/v1/chat/completions"],
      paid_only: false,
      pricing: { promptTextTokens: "0", completionTextTokens: "0" },
    },
    {
      id: "experimental/alpha-chat",
      category: "text",
      community: false,
      title: "Experimental Alpha Chat",
      input_modalities: ["text"],
      output_modalities: ["text"],
      supported_endpoints: ["/v1/chat/completions"],
      paid_only: false,
      alpha: true,
    },
    {
      id: "liquid/d1",
      category: "text",
      community: false,
      title: "Liquid d1",
      input_modalities: ["text"],
      output_modalities: ["text"],
      supported_endpoints: ["/alpha/decisions", "/v1/chat/completions"],
      paid_only: true,
    },
    {
      id: "black-forest-labs/flux.2-pro",
      category: "image",
      community: false,
      title: "FLUX.2 Pro",
      input_modalities: ["text"],
      output_modalities: ["image"],
      supported_endpoints: ["/v1/images/generations"],
      paid_only: true,
    },
  ],
}

const server = Bun.serve({
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname !== "/v1/models") return new Response("missing", { status: 404 })
    if (request.headers.get("authorization") !== "Bearer sk_test") return new Response("{}", { status: 401 })
    return Response.json(catalog)
  },
})

const withKey = <A, E, R>(key: string | undefined, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.POLLINATIONS_API_KEY
      if (key) process.env.POLLINATIONS_API_KEY = key
      else delete process.env.POLLINATIONS_API_KEY
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.POLLINATIONS_API_KEY
        else process.env.POLLINATIONS_API_KEY = previous
      }),
  )

const config = { provider: { pollinations: { options: { baseURL: `http://localhost:${server.port}/v1` } } } }

it.instance(
  "pollinations lists only chat LLMs from /v1/models when a key is set",
  () =>
    withKey(
      "sk_test",
      Effect.gen(function* () {
        const providers = yield* (yield* Provider.Service).list()
        const models = providers[POLLINATIONS].models
        expect(Object.keys(models).sort()).toEqual(["community/open-chat", "openai/gpt-5.4-nano"])
        expect(models["community/open-chat"].name).toBe("Open Chat (community, free)")
        expect(models["openai/gpt-5.4-nano"].api.npm).toBe("@ai-sdk/openai-compatible")
        expect(models["experimental/alpha-chat"]).toBeUndefined()
      }),
    ),
  { config },
)

it.instance(
  "pollinations stays hidden without a key",
  () =>
    withKey(
      undefined,
      Effect.gen(function* () {
        const providers = yield* (yield* Provider.Service).list()
        expect(providers[POLLINATIONS]).toBeUndefined()
      }),
    ),
  { config },
)
