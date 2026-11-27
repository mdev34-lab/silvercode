/**
 * Pollinations (`https://gen.pollinations.ai/v1`) is an OpenAI-compatible
 * gateway, so chat goes through `@ai-sdk/openai-compatible` unchanged. The
 * model list is read live from `GET /v1/models` and narrowed to chat LLMs:
 * the text category, text output, the chat-completions endpoint, and never a
 * decision model. Decision models also answer chat requests, but they list
 * `/alpha/decisions` in `supported_endpoints`.
 *
 * Prices are published per token in Pollen, the platform's credit unit. They
 * are scaled to the per-million figures the rest of the provider layer uses.
 */
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { isRecord } from "@/util/record"
import type { Info, Model } from "./provider"

export const POLLINATIONS_PROVIDER_ID = "pollinations"
export const POLLINATIONS_BASE_URL = "https://gen.pollinations.ai/v1"
export const POLLINATIONS_ENV = "POLLINATIONS_API_KEY"

const CHAT_ENDPOINT = "/v1/chat/completions"
const DECISION_ENDPOINT = "/alpha/decisions"
const DEFAULT_CONTEXT = 128_000
const DEFAULT_OUTPUT = 16_384
const PER_MILLION = 1_000_000
const DISCOVERY_TIMEOUT_MS = 5_000

export function providerInfo(): Info {
  return {
    id: ProviderV2.ID.make(POLLINATIONS_PROVIDER_ID),
    name: "Pollinations",
    source: "custom",
    env: [POLLINATIONS_ENV],
    options: {},
    models: {},
  }
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

export type ModelEntry = {
  id: string
  name: string
  inputModalities: string[]
  outputModalities: string[]
  tools: boolean
  reasoning: boolean
  temperature: boolean
  contextLength?: number
  outputLimit?: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

/**
 * Keeps only chat LLMs from a `/v1/models` body (`{ data: [...] }`). Image,
 * video, audio, embedding, and decision entries are dropped. Community models
 * stay in the list, labelled with `community`, and `free` under the rule in
 * `isFree`.
 */
export function parseModelList(body: unknown): ModelEntry[] {
  const list = isRecord(body) ? body.data : undefined
  if (!Array.isArray(list)) return []
  const entries = list.flatMap((item) =>
    isRecord(item) && typeof item.id === "string" && isChatLLM(item) ? [toEntry(item, item.id)] : [],
  )
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()]
}

export function toModel(entry: ModelEntry): Model {
  return {
    id: ModelV2.ID.make(entry.id),
    providerID: ProviderV2.ID.make(POLLINATIONS_PROVIDER_ID),
    name: entry.name,
    family: "",
    api: { id: entry.id, url: POLLINATIONS_BASE_URL, npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    cost: {
      input: entry.cost.input,
      output: entry.cost.output,
      cache: { read: entry.cost.cacheRead, write: entry.cost.cacheWrite },
    },
    limit: { context: entry.contextLength ?? DEFAULT_CONTEXT, output: entry.outputLimit ?? DEFAULT_OUTPUT },
    capabilities: {
      temperature: entry.temperature,
      reasoning: entry.reasoning,
      attachment: entry.inputModalities.includes("image"),
      toolcall: entry.tools,
      input: modalities(entry.inputModalities),
      output: modalities(entry.outputModalities),
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

export async function discoverModels(
  apiKey: string | undefined,
  baseURL = POLLINATIONS_BASE_URL,
  fetcher: Fetcher = fetch,
): Promise<Record<string, Model>> {
  if (!apiKey) return {}
  const response = await fetcher(`${baseURL.replace(/\/+$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  }).catch(() => undefined)
  if (!response?.ok) return {}
  const body = await response.json().catch(() => undefined)
  return Object.fromEntries(parseModelList(body).map((entry) => [entry.id, toModel(entry)]))
}

function isChatLLM(record: Record<string, unknown>) {
  const endpoints = strings(record.supported_endpoints)
  return (
    record.category === "text" &&
    strings(record.output_modalities).includes("text") &&
    endpoints.includes(CHAT_ENDPOINT) &&
    !endpoints.includes(DECISION_ENDPOINT)
  )
}

function toEntry(record: Record<string, unknown>, id: string): ModelEntry {
  const pricing = isRecord(record.pricing) ? record.pricing : {}
  const capabilities = strings(record.capabilities)
  const community = record.community === true
  const free = record.paid_only !== true && isFree(record)
  const title = typeof record.title === "string" && record.title.trim() ? record.title : id
  const labels = [...(community ? ["community"] : []), ...(free ? ["free"] : [])]
  const topProvider = isRecord(record.top_provider) ? record.top_provider : {}
  return {
    id,
    name: labels.length ? `${title} (${labels.join(", ")})` : title,
    inputModalities: strings(record.input_modalities),
    outputModalities: strings(record.output_modalities),
    tools: record.tools === true || capabilities.includes("tool_calling"),
    reasoning: record.reasoning === true || capabilities.includes("reasoning"),
    temperature: strings(record.supported_parameters).includes("temperature"),
    contextLength: positive(record.context_length),
    outputLimit: positive(topProvider.max_completion_tokens),
    cost: {
      input: perMillion(pricing.promptTextTokens),
      output: perMillion(pricing.completionTextTokens),
      cacheRead: perMillion(pricing.promptCachedTokens),
      cacheWrite: perMillion(pricing.promptCacheWriteTokens),
    },
  }
}

/**
 * Mirrors the dashboard rule: a model is free when it declares pricing, no
 * numeric price is positive (base, variant, or adjustment), and it is not an
 * agent. Catalog entries for free models carry only `currency`, so a missing
 * price is a zero price here, not an unknown one.
 */
function isFree(record: Record<string, unknown>) {
  const pricing = record.pricing
  if (record.agent === true || !isRecord(pricing)) return false
  const variants = Array.isArray(record.pricing_variants) ? record.pricing_variants : []
  const adjustments = Array.isArray(record.pricing_adjustments) ? record.pricing_adjustments : []
  return (
    !Object.values(pricing).some(isPositive) &&
    !variants.some(
      (variant) => isRecord(variant) && isRecord(variant.pricing) && Object.values(variant.pricing).some(isPositive),
    ) &&
    !adjustments.some((adjustment) => isRecord(adjustment) && isPositive(adjustment.price))
  )
}

function isPositive(value: unknown) {
  const number = price(value)
  return number !== undefined && number > 0
}

function modalities(list: string[]) {
  return {
    text: list.includes("text"),
    audio: list.includes("audio"),
    image: list.includes("image"),
    video: list.includes("video"),
    pdf: list.includes("pdf"),
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function price(value: unknown) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : undefined
}

function perMillion(value: unknown) {
  return (price(value) ?? 0) * PER_MILLION
}

function positive(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}
