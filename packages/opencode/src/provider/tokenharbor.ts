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

/**
 * Reads model ids from a `/v1/models` body. Accepts the OpenAI shape
 * (`{ data: [{ id }] }`), `{ models: [...] }` and a bare array whose items are
 * objects with an `id` or plain strings.
 */
export function parseModelList(body: unknown): { id: string; name?: string; context?: number; output?: number }[] {
  const list = Array.isArray(body) ? body : isRecord(body) ? (body.data ?? body.models) : undefined
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const result: { id: string; name?: string; context?: number; output?: number }[] = []
  for (const item of list) {
    const record = isRecord(item) ? item : undefined
    const id = typeof item === "string" ? item : typeof record?.id === "string" ? record.id : undefined
    if (!id || seen.has(id)) continue
    seen.add(id)
    const positive = (...values: unknown[]) =>
      values.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    result.push({
      id,
      name: typeof record?.name === "string" ? record.name : undefined,
      context: positive(record?.context_length, record?.context_window, record?.max_context_length),
      output: positive(record?.max_output_tokens, record?.max_completion_tokens),
    })
  }
  return result
}

export function toModel(entry: ReturnType<typeof parseModelList>[number]): Model {
  return {
    id: ModelV2.ID.make(entry.id),
    providerID: ProviderV2.ID.make(TOKENHARBOR_PROVIDER_ID),
    name: entry.name ?? entry.id,
    family: "",
    api: { id: entry.id, url: TOKENHARBOR_BASE_URL, npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: entry.context ?? DEFAULT_CONTEXT, output: entry.output ?? DEFAULT_OUTPUT },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
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
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (!response?.ok) return {}
  const body = await response.json().catch(() => undefined)
  return Object.fromEntries(parseModelList(body).map((entry) => [entry.id, toModel(entry)]))
}
