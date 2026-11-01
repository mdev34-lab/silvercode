/**
 * Token Harbor (`https://tokenharbor.ai/v1`) is a plain OpenAI-compatible
 * gateway, so chat goes through `@ai-sdk/openai-compatible` unchanged. The only
 * custom piece is the model list, which is read live from `GET /v1/models`
 * (it needs the API key) so new models show up without a release.
 */
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { isRecord } from "@/util/record"
import type { Info, Model } from "./provider"

export const TOKENHARBOR_PROVIDER_ID = "tokenharbor"
export const TOKENHARBOR_BASE_URL = "https://tokenharbor.ai/v1"
export const TOKENHARBOR_ENV = "TOKENHARBOR_API_KEY"

const DEFAULT_CONTEXT = 128_000
const DEFAULT_OUTPUT = 16_384

export function providerInfo(): Info {
  return {
    id: ProviderV2.ID.make(TOKENHARBOR_PROVIDER_ID),
    name: "Token Harbor",
    source: "custom",
    env: [TOKENHARBOR_ENV],
    options: {},
    models: {},
  }
}

export type ModelEntry = {
  id: string
  name?: string
  context?: number
  output?: number
  toolcall?: boolean
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

/**
 * Reads model ids from a `/v1/models` body. Accepts the OpenAI shape
 * (`{ data: [{ id }] }`), `{ models: [...] }` and a bare array whose items are
 * objects with an `id` or plain strings.
 */
export function parseModelList(body: unknown): ModelEntry[] {
  const list = Array.isArray(body) ? body : isRecord(body) ? (body.data ?? body.models) : undefined
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const result: ModelEntry[] = []
  for (const item of list) {
    const record = isRecord(item) ? item : undefined
    const id = typeof item === "string" ? item : typeof record?.id === "string" ? record.id : undefined
    if (!id || seen.has(id)) continue
    seen.add(id)
    const positive = (...values: unknown[]) =>
      values.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    const pricing = isRecord(record?.pricing) ? record.pricing : undefined
    const price = (value: unknown) => {
      const number = typeof value === "string" && value.trim() ? Number(value) : value
      return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : undefined
    }
    const input = price(pricing?.input_usd_per_1m)
    const outputPrice = price(pricing?.output_usd_per_1m)
    result.push({
      id,
      name: typeof record?.label === "string" && record.label.trim() ? record.label : typeof record?.name === "string" ? record.name : undefined,
      toolcall: typeof record?.tool_call === "boolean" ? record.tool_call : undefined,
      cost: pricing
        ? {
            input: input ?? 0,
            output: outputPrice ?? 0,
            cacheRead: price(pricing.cache_read_usd_per_1m) ?? 0,
            cacheWrite: price(pricing.cache_write_usd_per_1m) ?? 0,
          }
        : undefined,
      context: positive(record?.context_length, record?.context_window, record?.max_context_length),
      output: positive(record?.max_output_tokens, record?.max_completion_tokens),
    })
  }
  return result
}

export function toModel(entry: ModelEntry): Model {
  return {
    id: ModelV2.ID.make(entry.id),
    providerID: ProviderV2.ID.make(TOKENHARBOR_PROVIDER_ID),
    name: entry.name ?? entry.id,
    family: "",
    api: { id: entry.id, url: TOKENHARBOR_BASE_URL, npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    cost: {
      input: entry.cost?.input ?? 0,
      output: entry.cost?.output ?? 0,
      cache: { read: entry.cost?.cacheRead ?? 0, write: entry.cost?.cacheWrite ?? 0 },
    },
    limit: { context: entry.context ?? DEFAULT_CONTEXT, output: entry.output ?? DEFAULT_OUTPUT },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: entry.toolcall ?? true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

export async function discoverModels(
  apiKey: string | undefined,
  baseURL = TOKENHARBOR_BASE_URL,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, Model>> {
  if (!apiKey) return {}
  const response = await fetcher(`${baseURL.replace(/\/+$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined)
  if (!response?.ok) return {}
  const body = await response.json().catch(() => undefined)
  return Object.fromEntries(parseModelList(body).map((entry) => [entry.id, toModel(entry)]))
}
