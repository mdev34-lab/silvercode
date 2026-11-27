import { describe, expect, test } from "bun:test"
import { discoverModels, parseModelList, toModel } from "../../src/provider/pollinations"

// Entries mirror the shape of `GET https://gen.pollinations.ai/v1/models`.
// The first three are copied from the live catalog; the others are minimal
// constructions of the categories the filter must drop or label.
const gpt = {
  id: "openai/gpt-5.4-nano",
  object: "model",
  owned_by: "OpenAI",
  aliases: ["gpt-5.4-nano", "openai"],
  category: "text",
  community: false,
  title: "GPT-5.4 Nano",
  input_modalities: ["text", "image"],
  output_modalities: ["text"],
  supported_endpoints: ["/v1/chat/completions", "/text", "/text/{prompt}", "/v1/responses", "/v1/messages"],
  paid_only: false,
  pricing: {
    currency: "pollen",
    promptTextTokens: "0.00000015",
    promptCachedTokens: "0.000000015",
    completionTextTokens: "0.0000009375",
  },
  top_provider: { max_completion_tokens: null },
  capabilities: ["tool_calling", "reasoning"],
  supported_parameters: ["max_tokens", "temperature", "tools", "reasoning_effort"],
  tools: true,
  reasoning: true,
  context_length: 400000,
}

const paidOnly = {
  id: "google/gemini-4-neon",
  category: "text",
  community: false,
  title: "Gemini 4 Neon",
  input_modalities: ["text", "image", "audio", "video"],
  output_modalities: ["text"],
  supported_endpoints: ["/v1/chat/completions"],
  paid_only: true,
  pricing: { currency: "pollen", promptTextTokens: "0.000003", completionTextTokens: "0.000015" },
  capabilities: ["tool_calling", "reasoning", "web_search"],
  context_length: 1048576,
}

const communityPriced = {
  id: "community/nemotron-lite",
  category: "text",
  community: true,
  title: "Nemotron Lite",
  input_modalities: ["text"],
  output_modalities: ["text"],
  supported_endpoints: ["/v1/chat/completions"],
  paid_only: false,
  pricing: { currency: "pollen", promptTextTokens: "0.00000001", completionTextTokens: "0.00000004" },
}

const communityFree = {
  id: "community/open-chat",
  category: "text",
  community: true,
  title: "Open Chat",
  input_modalities: ["text"],
  output_modalities: ["text"],
  supported_endpoints: ["/v1/chat/completions"],
  paid_only: false,
  pricing: { currency: "pollen", promptTextTokens: "0", completionTextTokens: "0" },
  context_length: 32000,
}

const communityUnpriced = {
  id: "community/unpriced-chat",
  category: "text",
  community: true,
  title: "Unpriced Chat",
  input_modalities: ["text"],
  output_modalities: ["text"],
  supported_endpoints: ["/v1/chat/completions"],
  paid_only: false,
}

const decision = {
  id: "liquid/d1",
  category: "text",
  community: false,
  title: "Liquid d1",
  input_modalities: ["text"],
  output_modalities: ["text"],
  supported_endpoints: ["/alpha/decisions", "/v1/chat/completions"],
  paid_only: true,
  pricing: { currency: "pollen", promptTextTokens: "0.000001" },
}

const imageModel = {
  id: "black-forest-labs/flux.2-pro",
  category: "image",
  community: false,
  title: "FLUX.2 Pro",
  input_modalities: ["text"],
  output_modalities: ["image"],
  supported_endpoints: ["/image/{prompt}", "/v1/images/generations"],
  paid_only: true,
}

const embeddingModel = {
  id: "openai/text-embedding-3-small",
  category: "embedding",
  community: false,
  title: "Embedding",
  input_modalities: ["text"],
  output_modalities: ["embedding"],
  supported_endpoints: ["/v1/embeddings"],
  paid_only: false,
}

const audioModel = {
  id: "openai/tts-1-hd",
  category: "audio",
  community: false,
  title: "TTS-1 HD",
  input_modalities: ["text"],
  output_modalities: ["audio"],
  supported_endpoints: ["/audio/{text}", "/v1/audio/speech", "/v1/chat/completions"],
  paid_only: false,
}

const textNoChat = {
  id: "text/no-chat",
  category: "text",
  community: false,
  title: "No Chat",
  input_modalities: ["text"],
  output_modalities: ["text"],
  supported_endpoints: ["/text/{prompt}"],
  paid_only: false,
}

describe("pollinations model list", () => {
  test("keeps only chat LLMs and drops image, video, audio, embedding and decision entries", () => {
    const body = {
      object: "list",
      data: [gpt, paidOnly, decision, imageModel, embeddingModel, audioModel, textNoChat],
    }
    expect(parseModelList(body).map((entry) => entry.id)).toEqual(["openai/gpt-5.4-nano", "google/gemini-4-neon"])
  })

  test("keeps community LLMs, and labels them community and free only on explicit zero pricing", () => {
    const names = Object.fromEntries(
      parseModelList({ data: [communityPriced, communityFree, communityUnpriced, paidOnly] }).map((entry) => [
        entry.id,
        entry.name,
      ]),
    )
    expect(names).toEqual({
      "community/nemotron-lite": "Nemotron Lite (community)",
      "community/open-chat": "Open Chat (community, free)",
      "community/unpriced-chat": "Unpriced Chat (community)",
      "google/gemini-4-neon": "Gemini 4 Neon",
    })
  })

  test("never labels a paid-only model free, even with zero prices", () => {
    const [entry] = parseModelList({ data: [{ ...communityFree, id: "x/paid", paid_only: true }] })
    expect(entry?.name).toBe("Open Chat (community)")
  })

  test("converts per-token Pollen prices into per-million cost figures", () => {
    const [entry] = parseModelList({ data: [gpt] })
    if (!entry) throw new Error("entry missing")
    const model = toModel(entry)
    expect(model.cost.input).toBeCloseTo(0.15, 10)
    expect(model.cost.output).toBeCloseTo(0.9375, 10)
    expect(model.cost.cache.read).toBeCloseTo(0.015, 10)
    expect(model.cost.cache.write).toBe(0)
  })

  test("maps an entry onto an openai-compatible model with declared capabilities", () => {
    const [entry] = parseModelList({ data: [gpt] })
    if (!entry) throw new Error("entry missing")
    const model = toModel(entry)
    expect(String(model.providerID)).toBe("pollinations")
    expect(model.api).toEqual({
      id: "openai/gpt-5.4-nano",
      url: "https://gen.pollinations.ai/v1",
      npm: "@ai-sdk/openai-compatible",
    })
    expect(model.limit).toEqual({ context: 400000, output: 16384 })
    expect(model.capabilities.toolcall).toBe(true)
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.capabilities.temperature).toBe(true)
    expect(model.capabilities.attachment).toBe(true)
    expect(model.capabilities.input.image).toBe(true)
    expect(model.capabilities.output.image).toBe(false)
  })

  test("does not claim tool calling when the catalog does not declare it", () => {
    const [entry] = parseModelList({ data: [communityUnpriced] })
    if (!entry) throw new Error("entry missing")
    expect(toModel(entry).capabilities.toolcall).toBe(false)
  })

  test("returns nothing for a body without a data array", () => {
    expect(parseModelList({ error: "nope" })).toEqual([])
    expect(parseModelList(null)).toEqual([])
    expect(parseModelList([gpt])).toEqual([])
  })

  test("discovery sends the key to /v1/models and skips without one or on failure", async () => {
    const calls: { url: string; auth: string | null }[] = []
    const ok = async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") })
      return Response.json({ object: "list", data: [gpt] })
    }
    expect(Object.keys(await discoverModels("sk_x", "https://gen.pollinations.ai/v1/", ok))).toEqual([
      "openai/gpt-5.4-nano",
    ])
    expect(calls).toEqual([{ url: "https://gen.pollinations.ai/v1/models", auth: "Bearer sk_x" }])
    expect(await discoverModels(undefined, undefined, ok)).toEqual({})
    const denied = async () => new Response("{}", { status: 401 })
    expect(await discoverModels("bad", undefined, denied)).toEqual({})
  })
})
