import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect } from "effect"
import { generateText, streamText, tool } from "ai"
import { z } from "zod"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Env } from "@/env"
import { LLMRequestPrep } from "@/session/llm/request"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import {
  ZEN_PUBLIC_AUTHENTICATION,
  ZEN_USER_AGENT,
  createFetch,
  freeTier,
  requestID,
  sessionID,
  zeroCost,
  type ZenFetch,
} from "@/provider/opencode-zen"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

const zenURL = "https://opencode.ai/zen/v1/chat/completions"
const ZEN_UUID = "11111111-1111-4111-8111-111111111111"
// A session id as `Identifier.create` generates it: 12 hex timestamp chars
// followed by 14 base 62 chars. These are not UUIDs.
const SESSION_ID = "ses_1134d213e0014q5ohvhfGiiuCj"
// Request ids share that shape under the `msg_` prefix.
const REQUEST_ID_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/
// The web tools the free-tier gate requires in every tool catalog; the adapter
// appends upstream's definitions when the caller's catalog carries neither.
const ZEN_WEB_TOOLS = ["webfetch", "websearch"]

const encoder = new TextEncoder()

const completionStream = [
  'data: {"id":"chatcmpl-1","created":1,"model":"deepseek-v4-flash-free","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
  "",
  'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
  "",
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
  "",
  "data: [DONE]",
  "",
].join("\n")

type Captured = {
  url: string
  method: string
  headers: Headers
  /** The JSON body the adapter sent, when it sent one. */
  body: Record<string, any> | undefined
  /** The raw body fetch received, so tests can assert byte-for-byte forwarding. */
  raw: RequestInit["body"] | undefined
  init: RequestInit | undefined
}

function recorder(handler: (input: URL | RequestInfo, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Captured[] = []
  const upstream: ZenFetch = async (input, init) => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      headers: new Headers(init?.headers),
      body: jsonBody(init?.body),
      raw: init?.body,
      init,
    })
    return handler(input, init)
  }
  return { calls, upstream }
}

function jsonBody(body: RequestInit["body"] | undefined) {
  if (typeof body !== "string") return undefined
  try {
    const value = JSON.parse(body)
    return typeof value === "object" && value !== null ? (value as Record<string, any>) : undefined
  } catch {
    return undefined
  }
}

function sse() {
  return new Response(completionStream, { headers: { "content-type": "text/event-stream" } })
}

function stream(...lines: string[]) {
  return new Response(lines.join("\n"), { headers: { "content-type": "text/event-stream" } })
}

function uuids(...values: string[]) {
  let index = 0
  return () => values[index++] ?? `uuid-${index}`
}

describe("OpenCodeZen", () => {
  describe("ids", () => {
    test("keeps a workspace session id, a UUID, and a bare UUID", () => {
      expect(sessionID(SESSION_ID)).toBe(SESSION_ID)
      expect(sessionID(`ses_${ZEN_UUID}`)).toBe(`ses_${ZEN_UUID}`)
      expect(sessionID(ZEN_UUID, () => "unused")).toBe(`ses_${ZEN_UUID}`)
    })

    test("replaces an invalid session id instead of forwarding it", () => {
      expect(sessionID("ses_invalid", () => ZEN_UUID)).toBe(`ses_${ZEN_UUID}`)
      expect(sessionID("ses_conversation", () => ZEN_UUID)).toBe(`ses_${ZEN_UUID}`)
      expect(sessionID("", () => ZEN_UUID)).toBe(`ses_${ZEN_UUID}`)
      expect(sessionID(undefined, () => ZEN_UUID)).toBe(`ses_${ZEN_UUID}`)
      const sessions = uuids("first", "second")
      expect(sessionID(undefined, sessions)).not.toBe(sessionID(undefined, sessions))
    })

    test("only treats fully zero-cost models as free and keys them by wire id", () => {
      const costs = { input: 0, output: 0, cache: { read: 0, write: 0 } }
      expect(
        [
          ...freeTier([
            { api: { id: "wire/free" }, cost: costs },
            { api: { id: "wire/free-alias" }, cost: costs },
            { api: { id: "wire/paid-output" }, cost: { ...costs, output: 5 } },
            { api: { id: "wire/paid-cache" }, cost: { ...costs, cache: { read: 0.1, write: 0 } } },
            {
              api: { id: "wire/paid-tier" },
              cost: {
                ...costs,
                tiers: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }],
              },
            },
            {
              api: { id: "wire/paid-over-200k" },
              cost: {
                ...costs,
                experimentalOver200K: { input: 2, output: 4, cache: { read: 0, write: 0 } },
              },
            },
          ]),
        ].sort(),
      ).toEqual(["wire/free", "wire/free-alias"])
    })

    test("zeroCost checks base pricing, tiers, and experimentalOver200K", () => {
      const costs = { input: 0, output: 0, cache: { read: 0, write: 0 } }
      expect(zeroCost(costs)).toBe(true)
      expect(zeroCost({ ...costs, output: 1 })).toBe(false)
      expect(zeroCost({ ...costs, cache: { read: 0.1, write: 0 } })).toBe(false)
      expect(zeroCost({ ...costs, tiers: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }] })).toBe(false)
      expect(
        zeroCost({
          ...costs,
          experimentalOver200K: { input: 2, output: 4, cache: { read: 0, write: 0 } },
        }),
      ).toBe(false)
    })

    test("normalizeCostTier enforces finite numbers and rejects non-finite values", () => {
      expect(
        Provider.normalizeCostTier({
          input: 1,
          output: 2,
          cache: { read: 0.1, write: 0.2 },
          tier: { type: "context", size: 128_000 },
        }),
      ).toEqual({
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 0.2 },
        tier: { type: "context", size: 128_000 },
      })

      // Non-finite values (NaN, Infinity) must be rejected
      expect(Provider.normalizeCostTier({ input: NaN, output: 2, tier: 100_000 })).toBeUndefined()
      expect(Provider.normalizeCostTier({ input: 1, output: Infinity, tier: 100_000 })).toBeUndefined()
      expect(Provider.normalizeCostTier({ input: 1, output: 2, tier: Number.POSITIVE_INFINITY })).toBeUndefined()
      expect(Provider.normalizeCostTier({ input: 1, output: 2, tier: { size: NaN } })).toBeUndefined()
      expect(
        Provider.normalizeCostTier({ input: 1, output: 2, cache: { read: Infinity, write: 0 }, tier: 100_000 }),
      ).toBeUndefined()
      expect(Provider.normalizeCostTier({ input: 1, output: 2, cache_read: NaN, tier: 100_000 })).toBeUndefined()
      expect(Provider.normalizeCostTier({ input: 1, output: 2 })).toBeUndefined()
      expect(Provider.normalizeCostTier("invalid")).toBeUndefined()
    })

    test("mergeCostTiers merges tiers and ensures malformed tiers cannot make model free", () => {
      const existing = [
        {
          input: 3,
          output: 15,
          cache: { read: 0.3, write: 3.75 },
          tier: { type: "context" as const, size: 200_000 },
        },
      ]

      // Undefined raw tiers returns existing tiers
      expect(Provider.mergeCostTiers(undefined, existing)).toEqual(existing)

      // Empty array explicitly clears tiers
      expect(Provider.mergeCostTiers([], existing)).toEqual([])

      // Valid tiers override matching size and union new sizes
      const merged = Provider.mergeCostTiers(
        [
          { input: 2, output: 10, tier: 200_000 },
          { input: 5, output: 25, tier: 500_000 },
        ],
        existing,
      )
      expect(merged).toEqual([
        {
          input: 2,
          output: 10,
          cache: { read: 0, write: 0 },
          tier: { type: "context", size: 200_000 },
        },
        {
          input: 5,
          output: 25,
          cache: { read: 0, write: 0 },
          tier: { type: "context", size: 500_000 },
        },
      ])

      // Malformed configured tiers insert non-zero fallback tier so zeroCost returns false
      const withMalformed = Provider.mergeCostTiers([{ input: 2, output: 4 /* missing tier */ }])
      expect(withMalformed).toEqual([
        {
          input: 1,
          output: 1,
          cache: { read: 0, write: 0 },
          tier: { type: "context", size: 0 },
        },
      ])
      expect(zeroCost({ input: 0, output: 0, cache: { read: 0, write: 0 }, tiers: withMalformed })).toBe(false)

      // Malformed configured tiers with existing tiers preserves existing tiers and adds sentinel
      const withExisting = Provider.mergeCostTiers([{ input: 2, output: 4 /* missing tier */ }], existing)
      expect(withExisting).toEqual([
        existing[0],
        {
          input: 1,
          output: 1,
          cache: { read: 0, write: 0 },
          tier: { type: "context", size: 0 },
        },
      ])

      // Malformed configured tiers does not overwrite existing tier at size 0 if it is paid
      const existingWithZero = [
        {
          input: 9,
          output: 9,
          cache: { read: 0, write: 0 },
          tier: { type: "context" as const, size: 0 },
        },
      ]
      const withZeroPreserved = Provider.mergeCostTiers([{ input: 2, output: 4 /* missing tier */ }], existingWithZero)
      expect(withZeroPreserved).toEqual(existingWithZero)

      // Malformed configured tiers preserves existing tier at size 0 intact while invalid pricing is nonfree
      const existingZeroCostTier = [
        {
          input: 0,
          output: 0,
          cache: { read: 0, write: 0 },
          tier: { type: "context" as const, size: 0 },
        },
      ]
      const withZeroPreservedAndNonfree = Provider.mergeCostTiers(
        [{ input: 2, output: 4 /* missing tier */ }],
        existingZeroCostTier,
      )
      expect(withZeroPreservedAndNonfree).toEqual([
        existingZeroCostTier[0],
        {
          input: 1,
          output: 1,
          cache: { read: 0, write: 0 },
          tier: { type: "context", size: Number.MAX_SAFE_INTEGER },
        },
      ])
      // Existing valid zero-cost tier at size 0 remains intact
      expect(withZeroPreservedAndNonfree?.find((t) => t.tier.size === 0)).toEqual(existingZeroCostTier[0])
      // Model with invalid configured pricing is non-free
      expect(zeroCost({ input: 0, output: 0, cache: { read: 0, write: 0 }, tiers: withZeroPreservedAndNonfree })).toBe(
        false,
      )

      // Extra untiered paid cost entry in v2 array format is rejected and triggers invalidFallback while preserving existing size 0 tier
      const withExtraUntiered = Provider.parseConfigCost(
        [
          { input: 0, output: 0, cache: { read: 0, write: 0 } },
          { input: 10, output: 20 }, // extra untiered paid cost entry
        ],
        { input: 0, output: 0, cache: { read: 0, write: 0 }, tiers: existingZeroCostTier },
      )
      expect(zeroCost(withExtraUntiered)).toBe(false)
      expect(withExtraUntiered.tiers?.find((t) => t.tier.size === 0)).toEqual(existingZeroCostTier[0])
      expect(withExtraUntiered.tiers?.find((t) => t.tier.size === Number.MAX_SAFE_INTEGER)).toEqual({
        input: 1,
        output: 1,
        cache: { read: 0, write: 0 },
        tier: { type: "context", size: Number.MAX_SAFE_INTEGER },
      })

      // Invalid base pricing is rejected even if tiers are empty
      const withInvalidBase = Provider.parseConfigCost(
        { input: NaN, output: 0 },
        {
          input: 0,
          output: 0,
          cache: { read: 0, write: 0 },
          tiers: existingZeroCostTier,
        },
      )
      expect(zeroCost(withInvalidBase)).toBe(false)
      expect(withInvalidBase.tiers?.find((t) => t.tier.size === 0)).toEqual(existingZeroCostTier[0])

      // Collision test: when existing tiers already occupy MAX_SAFE_INTEGER and size 0 has a valid zero-cost tier,
      // invalid pricing preserves both and allocates the non-zero sentinel at MAX_SAFE_INTEGER - 1 without collision.
      const existingWithMaxSafe = [
        existingZeroCostTier[0],
        {
          input: 5,
          output: 25,
          cache: { read: 0.5, write: 5 },
          tier: { type: "context" as const, size: Number.MAX_SAFE_INTEGER },
        },
      ]
      const mergedWithCollision = Provider.mergeCostTiers(
        [{ input: Number.NaN, output: 10, tier: { size: 100_000 } }],
        existingWithMaxSafe,
        true,
      )
      expect(mergedWithCollision).toBeDefined()
      expect(mergedWithCollision?.find((t) => t.tier.size === 0)).toEqual(existingZeroCostTier[0])
      expect(mergedWithCollision?.find((t) => t.tier.size === Number.MAX_SAFE_INTEGER)).toEqual(existingWithMaxSafe[1])
      const sentinelTier = mergedWithCollision?.find((t) => t.tier.size === Number.MAX_SAFE_INTEGER - 1)
      expect(sentinelTier).toBeDefined()
      expect(sentinelTier?.input).toBe(1)
      expect(sentinelTier?.output).toBe(1)
      expect(zeroCost({ input: 0, output: 0, cache: { read: 0, write: 0 }, tiers: mergedWithCollision })).toBe(false)

      // Base-only v1 cost override (and migrated v2 array without tier entries) preserves existing paid catalog tiers
      const existingPaidWithTiers = {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
        tiers: [
          {
            input: 6,
            output: 30,
            cache: { read: 0.6, write: 7.5 },
            tier: { type: "context" as const, size: 200_000 },
          },
        ],
      }
      // Direct v1 base-only override preserves existing tiers
      const parsedV1BaseOnly = Provider.parseConfigCost({ input: 3.5, output: 16 }, existingPaidWithTiers)
      expect(parsedV1BaseOnly.input).toBe(3.5)
      expect(parsedV1BaseOnly.output).toBe(16)
      expect(parsedV1BaseOnly.tiers).toEqual(existingPaidWithTiers.tiers)

      // Migrated v2 array with only base entry preserves existing tiers
      const parsedMigratedBaseOnly = Provider.parseConfigCost(
        [{ input: 3.5, output: 16, cache: { read: 0.3, write: 3.75 } }],
        existingPaidWithTiers,
      )
      expect(parsedMigratedBaseOnly.input).toBe(3.5)
      expect(parsedMigratedBaseOnly.output).toBe(16)
      expect(parsedMigratedBaseOnly.tiers).toEqual(existingPaidWithTiers.tiers)

      // Empty cost: [] preserves existing cost and does NOT become free
      const parsedEmptyCostWithExisting = Provider.parseConfigCost([], existingPaidWithTiers)
      expect(parsedEmptyCostWithExisting).toEqual(existingPaidWithTiers)
      expect(zeroCost(parsedEmptyCostWithExisting)).toBe(false)

      // Empty cost: [] without existing cost does NOT become free (triggers non-zero fallback)
      const parsedEmptyCostWithoutExisting = Provider.parseConfigCost([])
      expect(zeroCost(parsedEmptyCostWithoutExisting)).toBe(false)
    })

    test("parseConfigCost handles both v1 and v2 formats including context_over_200k", () => {
      // v1 format
      const v1Cost = {
        input: 1,
        output: 2,
        cache_read: 0.1,
        cache_write: 0.2,
        tiers: [{ input: 3, output: 4, tier: 100_000 }],
        context_over_200k: { input: 5, output: 6, cache_read: 0.5, cache_write: 0.6 },
      }
      expect(Provider.parseConfigCost(v1Cost)).toEqual({
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 0.2 },
        tiers: [
          {
            input: 3,
            output: 4,
            cache: { read: 0, write: 0 },
            tier: { type: "context", size: 100_000 },
          },
        ],
        experimentalOver200K: {
          input: 5,
          output: 6,
          cache: { read: 0.5, write: 0.6 },
        },
      })

      // v2 array format (from migration or direct v2 config)
      const v2ArrayCost = [
        {
          input: 1,
          output: 2,
          cache: { read: 0.1, write: 0.2 },
        },
        {
          input: 3,
          output: 4,
          tier: { type: "context" as const, size: 100_000 },
        },
        {
          input: 5,
          output: 6,
          cache: { read: 0.5, write: 0.6 },
          tier: { type: "context" as const, size: 200_000 },
        },
      ]
      expect(Provider.parseConfigCost(v2ArrayCost)).toEqual({
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 0.2 },
        tiers: [
          {
            input: 3,
            output: 4,
            cache: { read: 0, write: 0 },
            tier: { type: "context", size: 100_000 },
          },
          {
            input: 5,
            output: 6,
            cache: { read: 0.5, write: 0.6 },
            tier: { type: "context", size: 200_000 },
          },
        ],
        experimentalOver200K: {
          input: 5,
          output: 6,
          cache: { read: 0.5, write: 0.6 },
        },
      })

      // v2 single Cost object format
      const v2SingleCost = {
        input: 2,
        output: 4,
        cache: { read: 0.2, write: 0.4 },
      }
      expect(Provider.parseConfigCost(v2SingleCost)).toEqual({
        input: 2,
        output: 4,
        cache: { read: 0.2, write: 0.4 },
      })
    })

    test("regenerates request ids in the workspace message-id shape", () => {
      // The gateway rejects uuid-style request ids; ids follow `Identifier`
      // (`msg_` + 12 hex timestamp chars + 14 base 62 chars) even when a uuid
      // source is supplied.
      expect(requestID()).toMatch(REQUEST_ID_PATTERN)
      expect(requestID(() => ZEN_UUID)).toMatch(REQUEST_ID_PATTERN)
      expect(requestID(() => ZEN_UUID)).not.toBe(`msg_${ZEN_UUID}`)
      expect(requestID()).not.toBe(requestID())
    })
  })

  describe("requests", () => {
    test("sends the client headers Zen verifies", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream, uuid: () => ZEN_UUID })

      await zen(zenURL, { method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [] }) })

      expect(calls).toHaveLength(1)
      expect(calls[0].headers.get("user-agent")).toBe(ZEN_USER_AGENT)
      expect(calls[0].headers.get("x-opencode-client")).toBe("cli")
      expect(calls[0].headers.get("x-opencode-project")).toBe("global")
      expect(calls[0].headers.get("x-opencode-session")).toBe(`ses_${ZEN_UUID}`)
      // The gate requires the session id under `x-opencode-session-id` too.
      expect(calls[0].headers.get("x-opencode-session-id")).toBe(`ses_${ZEN_UUID}`)
      expect(calls[0].headers.get("x-opencode-request")).toMatch(REQUEST_ID_PATTERN)
    })

    test("mirrors the resolved session into x-opencode-session-id", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream })
      const body = JSON.stringify({ model: "big-pickle", messages: [], stream: true })

      await zen(zenURL, { method: "POST", headers: { "x-opencode-session": SESSION_ID }, body })
      await zen(zenURL, { method: "POST", headers: { "x-opencode-session": "garbage" }, body })

      expect(calls[0].headers.get("x-opencode-session-id")).toBe(SESSION_ID)
      // A replaced session id is mirrored, so both headers always agree.
      const replaced = calls[1].headers.get("x-opencode-session")
      expect(replaced).toMatch(/^ses_/)
      expect(replaced).not.toBe("garbage")
      expect(calls[1].headers.get("x-opencode-session-id")).toBe(replaced)
    })

    test("keeps a caller request id and regenerates one per request otherwise", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream })
      const body = JSON.stringify({ model: "big-pickle", messages: [] })

      await zen(zenURL, { method: "POST", headers: { "x-opencode-request": "msg_turn" }, body })
      await zen(zenURL, { method: "POST", body })
      await zen(zenURL, { method: "POST", body })

      expect(calls[0].headers.get("x-opencode-request")).toBe("msg_turn")
      expect(calls[1].headers.get("x-opencode-request")).toMatch(REQUEST_ID_PATTERN)
      expect(calls[2].headers.get("x-opencode-request")).toMatch(REQUEST_ID_PATTERN)
      expect(calls[2].headers.get("x-opencode-request")).not.toBe(calls[1].headers.get("x-opencode-request"))
    })

    test("keeps a caller session and gives each caller without one its own session", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream, uuid: uuids("first", "second") })
      const body = JSON.stringify({ model: "big-pickle", messages: [], stream: true })

      await zen(zenURL, { method: "POST", headers: { "x-opencode-session": SESSION_ID }, body })
      await zen(zenURL, { method: "POST", headers: { "x-opencode-session": SESSION_ID }, body })
      await zen(zenURL, { method: "POST", body })
      await zen(zenURL, { method: "POST", body })

      const sessions = calls.map((call) => call.headers.get("x-opencode-session"))
      expect(sessions[0]).toBe(SESSION_ID)
      expect(sessions[1]).toBe(SESSION_ID)
      // Callers without a conversation id get a session per request instead of
      // sharing one client-wide id.
      expect(sessions[2]).toMatch(/^ses_/)
      expect(sessions[2]).not.toBe(SESSION_ID)
      expect(sessions[3]).not.toBe(SESSION_ID)
      expect(sessions[3]).not.toBe(sessions[2])
    })

    test("authenticates free models with the public bearer token", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream, free: new Set(["deepseek-v4-flash-free"]) })
      const headers = { authorization: "Bearer sk-secret" }

      await zen(zenURL, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [] }),
      })
      await zen(zenURL, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
      })

      expect(calls[0].headers.get("authorization")).toBe(ZEN_PUBLIC_AUTHENTICATION)
      expect(calls[1].headers.get("authorization")).toBe("Bearer sk-secret")
    })

    test("authenticates only the model id carried in the payload", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      // Free-tier ids are wire ids, so eligibility follows the request's `model`
      // field: an id outside the set must keep the caller's own key.
      const zen = createFetch({ upstream, free: new Set(["wire/id"]) })

      await zen(zenURL, {
        method: "POST",
        headers: { authorization: "Bearer sk" },
        body: JSON.stringify({ model: "wire/id", messages: [] }),
      })
      await zen(zenURL, {
        method: "POST",
        headers: { authorization: "Bearer sk" },
        body: JSON.stringify({ model: "other/id", messages: [] }),
      })

      expect(calls[0].headers.get("authorization")).toBe(ZEN_PUBLIC_AUTHENTICATION)
      expect(calls[1].headers.get("authorization")).toBe("Bearer sk")
    })

    test("enforces streaming and sends a tool-less request without a synthetic catalog", async () => {
      const { calls, upstream } = recorder(() => sse())
      const zen = createFetch({ upstream })

      // The gate now rejects the synthetic bash/glob/grep/read quartet and
      // accepts genuine tool-less requests (e.g. title or compaction turns), so
      // nothing is injected and tool_choice is left untouched.
      await zen(zenURL, { method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [] }) })

      expect(calls[0].body?.stream).toBe(true)
      expect(calls[0].body).not.toHaveProperty("tools")
      expect(calls[0].body).not.toHaveProperty("tool_choice")

      // An empty catalog is dropped as well; an explicit caller tool_choice is
      // preserved verbatim and not silently weakened.
      await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({ model: "big-pickle", messages: [], tools: [], tool_choice: "required" }),
      })

      expect(calls[1].body).not.toHaveProperty("tools")
      expect(calls[1].body?.tool_choice).toBe("required")
    })

    test("appends the upstream web tools the wiregate requires when a caller catalog lacks both", async () => {
      const { calls, upstream } = recorder(() => sse())
      const zen = createFetch({ upstream })
      const custom = { type: "function", function: { name: "my_custom_tool", description: "custom", parameters: {} } }

      // Caller tools are preserved verbatim at the front; upstream's webfetch and
      // websearch definitions are appended, and the quartet is never injected.
      await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({
          model: "big-pickle",
          messages: [],
          tools: [custom],
          tool_choice: { type: "function", function: { name: "my_custom_tool" } },
        }),
      })

      expect(calls[0].body?.tools).toHaveLength(3)
      expect(calls[0].body?.tools[0]).toEqual(custom)
      expect(calls[0].body?.tools.slice(1).map((t: any) => t.function?.name)).toEqual(ZEN_WEB_TOOLS)
      expect(calls[0].body?.tool_choice).toEqual({ type: "function", function: { name: "my_custom_tool" } })

      // The appended definitions are real upstream tool schemas, not empty stubs.
      const [webfetch, websearch] = calls[0].body?.tools.slice(1)
      expect(webfetch.function.parameters.required).toEqual(["url"])
      expect(Object.keys(webfetch.function.parameters.properties)).toEqual(["url", "format", "timeout"])
      expect(websearch.function.parameters.required).toEqual(["query"])
      expect(websearch.function.parameters.properties.query.type).toBe("string")

      // Caller tools that share a quartet name are passed through untouched and
      // the remaining quartet members are not filled in.
      await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({
          model: "big-pickle",
          messages: [],
          tools: [{ type: "function", function: { name: "bash", description: "caller bash" } }],
        }),
      })

      expect(calls[1].body?.tools.map((t: any) => t.function?.name)).toEqual(["bash", ...ZEN_WEB_TOOLS])
      expect(calls[1].body?.tools[0].function.description).toBe("caller bash")
    })

    test("leaves a caller catalog alone when it already carries webfetch or websearch", async () => {
      const { calls, upstream } = recorder(() => sse())
      const zen = createFetch({ upstream })
      const webfetch = { type: "function", function: { name: "webfetch", description: "caller webfetch" } }
      const websearch = { type: "function", function: { name: "websearch", description: "caller websearch" } }

      await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({ model: "big-pickle", messages: [], tools: [webfetch] }),
      })
      await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({ model: "big-pickle", messages: [], tools: [websearch] }),
      })

      // Either web tool satisfies the gate, so the caller's definition is the
      // only one on the wire and nothing is duplicated.
      expect(calls[0].body?.tools).toEqual([webfetch])
      expect(calls[1].body?.tools).toEqual([websearch])
    })

    test("leaves non-completion requests alone", async () => {
      const { calls, upstream } = recorder(() => Response.json({ data: [] }))
      const zen = createFetch({ upstream })

      await zen("https://opencode.ai/zen/v1/models", { method: "GET" })
      await zen("https://opencode.ai/zen/v1/models")

      expect(calls[0].method).toBe("GET")
      expect(calls[0].body).toBeUndefined()
      // A plain fetch defaults to GET; the adapter must not turn it into a POST.
      expect(calls[1].method).toBe("GET")
      expect(calls[1].body).toBeUndefined()
      expect(calls[1].headers.get("x-opencode-session")).toMatch(/^ses_/)
    })

    test("leaves native Anthropic requests untouched and passes through streams without OpenAI aggregation", async () => {
      const anthropicBody = {
        model: "claude-sonnet-4",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      }
      const ssePayload = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join("")
      const { calls, upstream } = recorder(
        () =>
          new Response(ssePayload, {
            headers: { "content-type": "text/event-stream" },
          }),
      )
      const zen = createFetch({ upstream })

      const response = await zen("https://opencode.ai/zen/v1/messages", {
        method: "POST",
        headers: { "anthropic-version": "2023-06-01", authorization: "Bearer sk-anthropic" },
        body: JSON.stringify(anthropicBody),
      })

      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe("https://opencode.ai/zen/v1/messages")
      expect(calls[0].headers.get("user-agent")).toBe(ZEN_USER_AGENT)
      expect(calls[0].headers.get("x-opencode-client")).toBe("cli")
      expect(calls[0].headers.get("authorization")).toBe("Bearer sk-anthropic")
      expect(calls[0].body).toEqual(anthropicBody)
      expect(calls[0].body?.stream).toBeUndefined()
      expect(calls[0].body?.tools).toBeUndefined()
      // Anthropic SSE stream is passed through without triggering OpenAI completion aggregation.
      expect(response.headers.get("content-type")).toBe("text/event-stream")
      expect(await response.text()).toBe(ssePayload)
    })

    test("converts a stream cut before completion into an in-band provider error frame", async () => {
      // No finish-reason chunk and no [DONE]: the upstream connection ended
      // mid-completion. Ending the guarded stream cleanly here would let the
      // SDK synthesize a reason-less "unknown" finish and hide the cut.
      const { upstream } = recorder(() =>
        stream('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}', ""),
      )
      const zen = createFetch({ upstream })
      const body = JSON.stringify({ model: "big-pickle", messages: [], stream: true })

      const response = await zen(zenURL, { method: "POST", body })
      const text = await response.text()
      expect(text).toContain('"content":"partial"')
      expect(text).not.toContain("[DONE]")
      expect(text).toContain('"error"')
      expect(text).toContain("Zen stream ended before the completion finished")
    })

    test("passes a [DONE]-terminated stream through without a truncation frame", async () => {
      const { upstream } = recorder(() => sse())
      const zen = createFetch({ upstream })
      const body = JSON.stringify({ model: "big-pickle", messages: [], stream: true })

      const response = await zen(zenURL, { method: "POST", body })
      const text = await response.text()
      expect(text).toContain("[DONE]")
      expect(text).not.toContain('"error"')
    })

    test("tolerates a finish-reason completion that omits the [DONE] frame", async () => {
      const { upstream } = recorder(() =>
        stream('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}', ""),
      )
      const zen = createFetch({ upstream })
      const body = JSON.stringify({ model: "big-pickle", messages: [], stream: true })

      const response = await zen(zenURL, { method: "POST", body })
      const text = await response.text()
      expect(text).not.toContain('"error"')
    })

    test("converts a mid-stream transport failure into an in-band provider error frame", async () => {
      const failing = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n'),
          )
          controller.error(new Error("connection reset"))
        },
      })
      const { upstream } = recorder(() => new Response(failing, { headers: { "content-type": "text/event-stream" } }))
      const zen = createFetch({ upstream })
      const body = JSON.stringify({ model: "big-pickle", messages: [], stream: true })

      const response = await zen(zenURL, { method: "POST", body })
      const text = await response.text()
            // Bytes buffered behind the failed read may or may not survive the
      // transport error; the truncation frame is the contract.
      expect(text).toContain("Zen stream ended before the completion finished")
    })

    test("applies the truncation contract when the caller catalog already carries the fingerprint tools", async () => {
      // injectedOnly is empty here (caller already lists bash/glob/grep/read,
      // the production shape): the guard must still wrap the stream, or a cut
      // like this one would sail through as a clean end.
      const { upstream } = recorder(() =>
        stream('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}', ""),
      )
      const zen = createFetch({ upstream })
      const body = JSON.stringify({
        model: "big-pickle",
        messages: [],
        stream: true,
        tools: ["bash", "glob", "grep", "read"].map((name) => ({
          type: "function",
          function: { name, parameters: { type: "object", properties: {} } },
        })),
      })

      const response = await zen(zenURL, { method: "POST", body })
      const text = await response.text()
      expect(text).toContain("Zen stream ended before the completion finished")
    })

    test("treats a frame cut off inside the finish_reason value as truncation", async () => {
      // The tail dies after the full `"finish_reason":"sto` prefix: a
      // substring search would count this as a completed response even though
      // the frame is not valid JSON and no finish was ever transmitted.
      const { upstream } = recorder(() =>
        stream(
          'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}',
          "",
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"sto',
        ),
      )
      const zen = createFetch({ upstream })
      const body = JSON.stringify({ model: "big-pickle", messages: [], stream: true })

      const response = await zen(zenURL, { method: "POST", body })
      const text = await response.text()
      expect(text).toContain("Zen stream ended before the completion finished")
    })

    test("does not mistake content quoting a finish_reason literal for completion", async () => {
      // The model's own text can contain the substring `"finish_reason":"stop"`;
      // only a parsed finish field proves completion.
      const { upstream } = recorder(() =>
        stream(
          'data: {"choices":[{"index":0,"delta":{"content":"see {\\"finish_reason\\":\\"stop\\"} here"}}]}',
          "",
        ),
      )
      const zen = createFetch({ upstream })
      const body = JSON.stringify({ model: "big-pickle", messages: [], stream: true })

      const response = await zen(zenURL, { method: "POST", body })
      const text = await response.text()
      expect(text).toContain("Zen stream ended before the completion finished")
    })

    test("forwards a non-JSON body untouched", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream })
      const bytes = new Uint8Array([0, 255, 16])

      await zen(zenURL, { method: "POST", body: bytes })
      await zen(zenURL, { method: "POST", body: "not json" })

      expect(calls[0].raw).toBe(bytes)
      expect(calls[0].body).toBeUndefined()
      expect(calls[1].raw).toBe("not json")
      expect(calls[1].body).toBeUndefined()
    })

    test("rewrites a JSON body sent as bytes", async () => {
      const { calls, upstream } = recorder(() => sse())
      const zen = createFetch({ upstream })

      await zen(zenURL, {
        method: "POST",
        body: encoder.encode(JSON.stringify({ model: "big-pickle", messages: [], tools: [], tool_choice: "auto" })),
      })

      expect(calls[0].body?.stream).toBe(true)
      expect(calls[0].body?.model).toBe("big-pickle")
      expect(calls[0].body).not.toHaveProperty("tools")
      expect(calls[0].body?.tool_choice).toBe("auto")
    })

    test("honors an init body override over a Request body", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream })
      const request = new Request(zenURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "original" }] }),
      })

      await zen(request, { body: JSON.stringify({ model: "big-pickle", messages: [], stream: false }) })

      expect(calls[0].body?.messages).toEqual([])
      expect(calls[0].body?.stream).toBe(true)
    })

    test("honors an explicit null body override", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream })
      const request = new Request(zenURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [] }),
      })

      await zen(request, { body: null })

      expect(calls[0].raw).toBeNull()
      expect(calls[0].body).toBeUndefined()
    })

    test("drops a stale content-length when it rewrites the body", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream })

      await zen(zenURL, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "2" },
        body: JSON.stringify({ model: "big-pickle", messages: [] }),
      })

      expect(calls[0].headers.get("content-length")).toBeNull()
      expect(calls[0].body?.stream).toBe(true)
    })

    test("builds headers from the effective list instead of reviving a dropped Authorization header", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream, free: new Set(["big-pickle"]) })
      const request = new Request(zenURL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sk-secret" },
        body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
      })

      await zen(request, { headers: { "content-type": "application/json" } })

      expect(calls[0].headers.get("authorization")).toBeNull()
      expect(calls[0].headers.get("x-opencode-session")).toMatch(/^ses_/)
    })

    test("keeps a Request method that has no init override", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream })

      await zen(new Request("https://opencode.ai/zen/v1/models", { method: "GET" }))

      expect(calls[0].method).toBe("GET")
    })
  })

  describe("responses", () => {
    test("reassembles a stream for a non-streaming caller", async () => {
      const { calls, upstream } = recorder(() => sse())
      const zen = createFetch({ upstream })

      const response = await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({ model: "big-pickle", messages: [], stream: false }),
      })

      expect(calls[0].body?.stream).toBe(true)
      expect(response.headers.get("content-type")).toContain("application/json")
      expect(await response.json()).toEqual({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "deepseek-v4-flash-free",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello world" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      })
    })

    test("reassembles reasoning and tool calls", async () => {
      const { upstream } = recorder(() =>
        stream(
          'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}',
          "",
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\\"cmd\\":"}}]}}]}',
          "",
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}',
          "",
          "data: [DONE]",
          "",
        ),
      )
      const zen = createFetch({ upstream })

      const response = await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({
          model: "big-pickle",
          messages: [],
          tools: [{ type: "function", function: { name: "bash" } }],
        }),
      })
      const body = (await response.json()) as {
        choices: Array<{ message: { reasoning_content?: string; tool_calls?: unknown[] }; finish_reason?: string }>
      }

      expect(body.choices[0].message.reasoning_content).toBe("think")
      expect(body.choices[0].message.tool_calls).toEqual([
        { id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
      ])
      expect(body.choices[0].finish_reason).toBe("tool_calls")
    })

    test("keys tool calls by the streamed index instead of their position in a delta", async () => {
      const { upstream } = recorder(() =>
        stream(
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"grep","arguments":""}}]}}]}',
          "",
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"bash","arguments":"{\\"cmd\\":"}}]}}]}',
          "",
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"q\\":\\"x\\"}"}}]}}]}',
          "",
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}',
          "",
          "data: [DONE]",
          "",
        ),
      )
      const zen = createFetch({ upstream })

      const response = await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({
          model: "big-pickle",
          messages: [],
          tools: [
            { type: "function", function: { name: "bash" } },
            { type: "function", function: { name: "grep" } },
          ],
        }),
      })
      const body = (await response.json()) as { choices: Array<{ message: { tool_calls?: unknown[] } }> }

      expect(body.choices[0].message.tool_calls).toEqual([
        { id: "call_a", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
        { id: "call_b", type: "function", function: { name: "grep", arguments: '{"q":"x"}' } },
      ])
    })

    test("leaves a streamed response untouched", async () => {
      const { upstream } = recorder(() => sse())
      const zen = createFetch({ upstream })

      const response = await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({ model: "big-pickle", messages: [], stream: true }),
      })

      expect(response.headers.get("content-type")).toBe("text/event-stream")
      expect(await response.text()).toBe(completionStream)
    })

    test("propagates a stream error frame", async () => {
      const { upstream } = recorder(() =>
        stream(
          'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}',
          "",
          'data: {"error":{"message":"upstream exploded","type":"server_error"}}',
          "",
        ),
      )
      const zen = createFetch({ upstream })

      await expect(
        zen(zenURL, { method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [] }) }),
      ).rejects.toThrow("Zen stream error: upstream exploded")
    })

    test("does not report a truncated stream as success", async () => {
      const { upstream } = recorder(() => stream('data: {"choices":[{"index":0,"delta":{"content":"half"}}]}', ""))
      const zen = createFetch({ upstream })

      await expect(
        zen(zenURL, { method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [] }) }),
      ).rejects.toThrow("Zen stream ended before the completion finished")
    })

    test("keeps a missing finish reason distinct from a normal stop", async () => {
      const { upstream } = recorder(() =>
        stream('data: {"choices":[{"index":0,"delta":{"content":"half"}}]}', "", "data: [DONE]", ""),
      )
      const zen = createFetch({ upstream })

      const response = await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({ model: "big-pickle", messages: [] }),
      })
      const body = (await response.json()) as {
        choices: Array<{ message: { content: string }; finish_reason: string | null }>
      }

      expect(body.choices[0].message.content).toBe("half")
      expect(body.choices[0].finish_reason).toBeNull()
    })

    test("fails a stalled stream once the chunk timeout elapses", async () => {
      const { upstream } = recorder(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n'))
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      )
      const zen = createFetch({ upstream, chunkTimeout: 25 })

      await expect(
        zen(zenURL, { method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [] }) }),
      ).rejects.toThrow("stalled")
    })

    test("cancels the upstream stream when the caller aborts", async () => {
      const controller = new AbortController()
      const reading = Promise.withResolvers<void>()
      const { calls, upstream } = recorder(
        (_input, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n'))
                init?.signal?.addEventListener(
                  "abort",
                  () => stream.error(init.signal?.reason ?? new Error("aborted")),
                  { once: true },
                )
              },
              pull() {
                // The adapter is waiting for the next chunk when pull runs.
                reading.resolve()
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      )
      const zen = createFetch({ upstream })
      const request = new Request(zenURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [], stream: false }),
        signal: controller.signal,
      })

      const pending = zen(request)
      await reading.promise
      controller.abort()

      await expect(pending).rejects.toThrow()
      // The Request's signal has to survive the rewrite to a URL request.
      expect(calls[0].init?.signal?.aborted).toBe(true)
    })

    test("rejects a pre-aborted caller signal without waiting for the upstream", async () => {
      const controller = new AbortController()
      controller.abort(new Error("caller cancelled"))
      const { upstream } = recorder(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n'))
                // The stream never closes and never reacts to the abort.
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      )
      const zen = createFetch({ upstream })
      const request = new Request(zenURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [], stream: false }),
        signal: controller.signal,
      })

      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<"still reading">((resolve) => {
        timer = setTimeout(() => resolve("still reading"), 5_000)
      })
      const call = zen(request).then(
        () => "resolved" as const,
        (error: unknown) => error,
      )
      const outcome = await Promise.race([call, timeout]).finally(() => {
        if (timer) clearTimeout(timer)
      })

      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as Error).message).toBe("caller cancelled")
    })

    test("cancels the upstream body when a pending read is aborted", async () => {
      const controller = new AbortController()
      const reading = Promise.withResolvers<void>()
      const cancelled = Promise.withResolvers<void>()
      const { upstream } = recorder(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n'))
              },
              pull() {
                reading.resolve()
              },
              // The upstream never reacts to the abort itself.
              cancel() {
                cancelled.resolve()
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      )
      const zen = createFetch({ upstream })
      const request = new Request(zenURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [], stream: false }),
        signal: controller.signal,
      })

      const pending = zen(request)
      await reading.promise
      controller.abort()

      await expect(pending).rejects.toThrow()
      await cancelled.promise
    })
  })

  describe("injected tool guard", () => {
    const callerTools = [{ type: "function", function: { name: "custom_lookup" } }]
    const bashCall = { id: "call_b", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }
    const customCall = {
      id: "call_c",
      type: "function",
      function: { name: "custom_lookup", arguments: '{"key":"v"}' },
    }

    function frame(value: unknown) {
      return `data: ${JSON.stringify(value)}`
    }

    function sseFrames(...chunks: unknown[]) {
      const lines: string[] = []
      for (const chunk of chunks) lines.push(frame(chunk), "")
      lines.push("data: [DONE]", "")
      return stream(...lines)
    }

    function completionJson(calls: unknown[], content: string | null, finish = "tool_calls") {
      return JSON.stringify({
        id: "chatcmpl-9",
        object: "chat.completion",
        created: 1,
        model: "big-pickle",
        choices: [{ index: 0, message: { role: "assistant", content, tool_calls: calls }, finish_reason: finish }],
      })
    }

    function jsonGuard(body: Record<string, any>, response: Response) {
      const { upstream } = recorder(() => response)
      const zen = createFetch({ upstream })
      return zen(zenURL, { method: "POST", body: JSON.stringify(body) })
    }

    function streamGuard(body: Record<string, any>, response: Response) {
      const { upstream } = recorder(() => response)
      const zen = createFetch({ upstream })
      return zen(zenURL, { method: "POST", body: JSON.stringify(body) })
    }

    function dataLines(text: string) {
      return text
        .split("\n")
        .filter((line) => line.startsWith("data:") && line.includes("{"))
        .map((line) => JSON.parse(line.slice("data:".length).trim()) as any)
    }

    test("strips injected-only calls from a JSON response and drops stale transfer headers", async () => {
      const response = await jsonGuard(
        { model: "big-pickle", messages: [] },
        new Response(completionJson([bashCall], null), {
          headers: {
            "content-type": "application/json",
            "content-length": "999",
            "content-encoding": "gzip",
          },
        }),
      )

      const body = JSON.parse(await response.text())
      expect(body.choices[0].finish_reason).toBe("stop")
      expect(body.choices[0].message.tool_calls).toBeUndefined()
      expect(body.choices[0].message.content).toBe("")
      // The guard re-encoded the body, so length and encoding metadata of the
      // original response are stale for it and must not survive the rewrite.
      expect(response.headers.get("content-length")).toBeNull()
      expect(response.headers.get("content-encoding")).toBeNull()
    })

    test("keeps caller tool calls mixed with injected ones in a JSON response", async () => {
      const response = await jsonGuard(
        { model: "big-pickle", messages: [], tools: callerTools },
        new Response(completionJson([customCall, bashCall], null), {
          headers: { "content-type": "application/json" },
        }),
      )

      const body = (await response.json()) as any
      expect(body.choices[0].finish_reason).toBe("tool_calls")
      expect(body.choices[0].message.tool_calls).toEqual([customCall])
    })

    test("passes a hallucinated bash call through when the caller catalog carries shell (#780)", async () => {
      // The catalog publishes the tool as `shell`; a model calling the legacy
      // fingerprint name `bash` made a caller-visible invalid call, not a
      // gateway-injected one. The guard must keep it so the runtime's
      // invalid-tool repair handles it (and nothing executes).
      const shellTools = [{ type: "function", function: { name: "shell" } }]
      const response = await jsonGuard(
        { model: "big-pickle", messages: [], tools: shellTools },
        new Response(completionJson([bashCall], null), { headers: { "content-type": "application/json" } }),
      )

      const body = (await response.json()) as any
      expect(body.choices[0].finish_reason).toBe("tool_calls")
      expect(body.choices[0].message.tool_calls).toEqual([bashCall])
    })

    test("does not fail a required tool_choice for a hallucinated bash call when the caller carries shell (#780)", async () => {
      const shellTools = [{ type: "function", function: { name: "shell" } }]
      const response = await jsonGuard(
        { model: "big-pickle", messages: [], tools: shellTools, tool_choice: "required" },
        new Response(completionJson([bashCall], null), { headers: { "content-type": "application/json" } }),
      )

      const body = (await response.json()) as any
      expect(body.choices[0].message.tool_calls).toEqual([bashCall])
    })

    test("keeps streamed hallucinated bash fragments when the caller catalog carries shell (#780)", async () => {
      const shellTools = [{ type: "function", function: { name: "shell" } }]
      const response = await streamGuard(
        { model: "big-pickle", messages: [], tools: shellTools, stream: true },
        sseFrames(
          {
            id: "chatcmpl-9",
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, id: "call_b", type: "function", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } }] },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-9",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          },
        ),
      )

      const chunks = dataLines(await response.text())
      const names = chunks.flatMap((chunk: any) =>
        (chunk.choices?.[0]?.delta?.tool_calls ?? []).map((call: any) => call.function?.name),
      )
      expect(names).toEqual(["bash"])
      expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls")
    })

    test("fails an explicit required tool_choice when only injected calls would remain", async () => {
      await expect(
        jsonGuard(
          { model: "big-pickle", messages: [], tools: callerTools, tool_choice: "required" },
          new Response(completionJson([bashCall], null), { headers: { "content-type": "application/json" } }),
        ),
      ).rejects.toThrow("required tool_choice")
    })

    test("treats a forced function tool_choice as required", async () => {
      await expect(
        jsonGuard(
          {
            model: "big-pickle",
            messages: [],
            tools: callerTools,
            tool_choice: { type: "function", function: { name: "custom_lookup" } },
          },
          new Response(completionJson([bashCall], null), { headers: { "content-type": "application/json" } }),
        ),
      ).rejects.toThrow("required tool_choice")
    })

    test("keeps mixed calls when a required tool_choice is satisfied by caller tools", async () => {
      const response = await jsonGuard(
        { model: "big-pickle", messages: [], tools: callerTools, tool_choice: "required" },
        new Response(completionJson([bashCall, customCall], null), {
          headers: { "content-type": "application/json" },
        }),
      )

      const body = (await response.json()) as any
      expect(body.choices[0].finish_reason).toBe("tool_calls")
      expect(body.choices[0].message.tool_calls).toEqual([customCall])
    })

    test("honors an explicit none tool_choice with silent stripping", async () => {
      const response = await jsonGuard(
        { model: "big-pickle", messages: [], tool_choice: "none" },
        new Response(completionJson([bashCall], "summarized"), { headers: { "content-type": "application/json" } }),
      )

      const body = (await response.json()) as any
      expect(body.choices[0].finish_reason).toBe("stop")
      expect(body.choices[0].message.content).toBe("summarized")
      expect(body.choices[0].message.tool_calls).toBeUndefined()
    })

    test("returns a readable body when a guarded JSON response is malformed", async () => {
      const text = '{"choices": [oops not json'
      const response = await jsonGuard(
        { model: "big-pickle", messages: [] },
        new Response(text, {
          status: 200,
          headers: { "content-type": "application/json", "content-length": String(text.length + 40) },
        }),
      )

      // The guard consumed the upstream body to inspect it, so it must hand
      // back the buffered text instead of the drained original response.
      expect(await response.text()).toBe(text)
    })

    test("passes through a JSON response without choices intact", async () => {
      const text = JSON.stringify({ ok: true })
      const response = await jsonGuard(
        { model: "big-pickle", messages: [] },
        new Response(text, { headers: { "content-type": "application/json" } }),
      )

      expect(await response.text()).toBe(text)
    })

    test("guards a JSON completion served to a streaming caller", async () => {
      const response = await streamGuard(
        { model: "big-pickle", messages: [], stream: true, tools: callerTools },
        new Response(completionJson([customCall, bashCall], null), {
          headers: { "content-type": "application/json" },
        }),
      )

      // A gateway that answers even a streamed request with JSON must still
      // go through the guard so injected-only calls cannot bypass it and
      // reach the runtime as an unexecutable tool call.
      const body = (await response.json()) as any
      expect(body.choices[0].finish_reason).toBe("tool_calls")
      expect(body.choices[0].message.tool_calls).toEqual([customCall])
    })

    test("fails an aggregated stream that only injected tools would satisfy under a required tool_choice", async () => {
      const response = sseFrames({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_b", function: { name: "bash", arguments: "{}" } }] },
            finish_reason: "tool_calls",
          },
        ],
      })

      await expect(
        streamGuard({ model: "big-pickle", messages: [], tools: callerTools, tool_choice: "required" }, response),
      ).rejects.toThrow("required tool_choice")
    })

    test("keeps an index-less caller call separate from an injected index 0 when aggregating", async () => {
      const response = sseFrames(
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: "call_b", function: { name: "bash", arguments: '{"command":"ls"}' } }],
              },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ id: "call_c", function: { name: "custom_lookup", arguments: '{"key":"v"}' } }] },
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      )

      const guarded = await streamGuard({ model: "big-pickle", messages: [], tools: callerTools }, response)
      const body = (await guarded.json()) as any

      expect(body.choices[0].message.tool_calls).toEqual([
        { id: "call_c", type: "function", function: { name: "custom_lookup", arguments: '{"key":"v"}' } },
      ])
    })

    test("keeps index-less caller tool call fragments next to an injected call at index 0", async () => {
      const response = sseFrames(
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: "call_b", function: { name: "bash", arguments: '{"comm' } }] },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ id: "call_c", function: { name: "custom_lookup", arguments: '{"key":"v"}' } }],
              },
            },
          ],
        },
        { choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: "tail" } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      )

      const guarded = await streamGuard(
        { model: "big-pickle", messages: [], stream: true, tools: callerTools },
        response,
      )
      const text = await guarded.text()
      const chunks = dataLines(text)
      const names = chunks.flatMap((chunk: any) => chunk.choices?.[0]?.delta?.tool_calls ?? [])

      // The injected bash head is removed; the index-less caller head and its
      // index-less argument continuation survive even though bash claimed 0.
      expect(JSON.stringify(names)).not.toContain("bash")
      expect(names).toEqual([
        { id: "call_c", function: { name: "custom_lookup", arguments: '{"key":"v"}' } },
        { function: { arguments: "tail" } },
      ])
      expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("tool_calls")
    })

    test("strips injected-only fragments including continuations in a guarded stream", async () => {
      const response = sseFrames(
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: "call_b", function: { name: "bash", arguments: '{"comm' } }] },
            },
          ],
        },
        {
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'mand":"ls"}' } }] } }],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      )

      const guarded = await streamGuard({ model: "big-pickle", messages: [], stream: true }, response)
      const text = await guarded.text()
      expect(text).not.toContain("bash")
      expect(text).not.toContain("call_b")

      const chunks = dataLines(text)
      // A caller that never demanded tool calls (the tool-less compaction
      // request defaults to tool_choice "none") keeps the silent strip.
      expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("stop")
      expect(chunks[chunks.length - 1].choices[0].delta.content).toBe("")
    })

    test("fails a guarded stream that would fake a required tool_choice with an empty stop", async () => {
      const response = sseFrames(
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: "call_b", function: { name: "bash", arguments: "{}" } }] },
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      )

      const guarded = await streamGuard(
        { model: "big-pickle", messages: [], stream: true, tools: callerTools, tool_choice: "required" },
        response,
      )
      await expect(guarded.text()).rejects.toThrow("required tool_choice")
    })

    test("cancels a guarded stream when the caller aborts", async () => {
      const controller = new AbortController()
      const cancelled = Promise.withResolvers<void>()
      const reading = Promise.withResolvers<void>()
      const { upstream } = recorder(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(out) {
                out.enqueue(encoder.encode(`${frame({ choices: [{ index: 0, delta: { content: "Hel" } }] })}\n`))
              },
              pull() {
                reading.resolve()
              },
              // The upstream never reacts to the abort itself.
              cancel() {
                cancelled.resolve()
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      )
      const zen = createFetch({ upstream })
      const request = new Request(zenURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [], stream: true }),
        signal: controller.signal,
      })

      const response = await zen(request)
      await reading.promise
      controller.abort(new Error("caller stop"))

      await expect(response.text()).rejects.toThrow("caller stop")
      await cancelled.promise
    })

    test("rejects a pre-aborted caller on a guarded stream", async () => {
      const controller = new AbortController()
      controller.abort(new Error("caller cancelled"))
      const { upstream } = recorder(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(out) {
                out.enqueue(encoder.encode(`${frame({ choices: [{ index: 0, delta: { content: "Hel" } }] })}\n`))
              },
              // The stream never ends and never reacts to the abort.
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      )
      const zen = createFetch({ upstream })
      const request = new Request(zenURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [], stream: true }),
        signal: controller.signal,
      })

      const response = await zen(request)
      await expect(response.text()).rejects.toThrow("caller cancelled")
    })
  })
})

it.live("keeps the session header and regenerates the request header per turn", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
      const prepare = () =>
        LLMRequestPrep.prepare({
          user: {
            id: "msg_turn",
            sessionID: SESSION_ID,
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
          } as any,
          sessionID: SESSION_ID,
          model,
          agent: { name: "test", mode: "primary", options: {}, permission: [] } as any,
          system: [],
          messages: [{ role: "user", content: "hello" }],
          tools: {},
          provider: { id: "opencode", options: {} } as any,
          auth: undefined,
          plugin: {
            trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
          } as any,
          flags: { outputTokenMax: 32_000, client: "cli" } as any,
          isWorkflow: false,
        })

      const first = (yield* prepare()).headers as Record<string, string | undefined>
      const second = (yield* prepare()).headers as Record<string, string | undefined>

      expect(first["x-opencode-session"]).toBe(SESSION_ID)
      expect(second["x-opencode-session"]).toBe(SESSION_ID)
      expect(first["x-opencode-request"]).toMatch(/^msg_/)
      expect(second["x-opencode-request"]).toMatch(/^msg_/)
      expect(first["x-opencode-request"]).not.toBe(second["x-opencode-request"])
    }),
  ),
)

it.live("keeps the Zen headers in front of model or plugin headers", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
      const prepared = yield* LLMRequestPrep.prepare({
        user: {
          id: "msg_turn",
          sessionID: SESSION_ID,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
        } as any,
        sessionID: SESSION_ID,
        model: {
          ...model,
          headers: {
            "X-OpenCode-Session": "ses_stale",
            "X-OPENCODE-REQUEST": "msg_stale",
            "USER-AGENT": "stale",
          },
        },
        agent: { name: "test", mode: "primary", options: {}, permission: [] } as any,
        system: [],
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        provider: { id: "opencode", options: {} } as any,
        auth: undefined,
        plugin: {
          trigger: (_name: string, _input: unknown, output: Record<string, any>) => {
            const headers = {
              ...output["headers"],
              "X-OpenCode-Session": "ses_plugin",
              "X-OpenCode-Client": "web",
            }
            return Effect.succeed({ ...output, headers })
          },
        } as any,
        flags: { outputTokenMax: 32_000, client: "cli" } as any,
        isWorkflow: false,
      })

      const headers = prepared.headers as Record<string, string | undefined>
      expect(headers["x-opencode-session"]).toBe(SESSION_ID)
      expect(headers["X-OpenCode-Session"]).toBeUndefined()
      expect(headers["x-opencode-request"]).toMatch(/^msg_/)
      expect(headers["x-opencode-request"]).not.toBe("msg_stale")
      expect(headers["X-OPENCODE-REQUEST"]).toBeUndefined()
      expect(headers["x-opencode-client"]).toBe("cli")
      expect(headers["X-OpenCode-Client"]).toBeUndefined()
      expect(headers["User-Agent"]).not.toBe("stale")
      expect(headers["USER-AGENT"]).toBeUndefined()
    }),
  ),
)

it.live("preserves the session id on the wire when model headers use mixed-case reserved headers", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => zenServer()),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
          const prepared = yield* LLMRequestPrep.prepare({
            user: {
              id: "msg_turn",
              sessionID: SESSION_ID,
              role: "user",
              time: { created: Date.now() },
              agent: "test",
              model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
            } as any,
            sessionID: SESSION_ID,
            model: {
              ...model,
              headers: {
                "X-OpenCode-Session": "ses_stale",
                "X-OPENCODE-REQUEST": "msg_stale",
                "USER-AGENT": "stale",
              },
            },
            agent: { name: "test", mode: "primary", options: {}, permission: [] } as any,
            system: [],
            messages: [{ role: "user", content: "hello" }],
            tools: {},
            provider: { id: "opencode", options: {} } as any,
            auth: undefined,
            plugin: {
              trigger: (_name: string, _input: unknown, output: Record<string, any>) =>
                Effect.succeed({ ...output, headers: { ...output["headers"], "X-OpenCode-Client": "web" } }),
            } as any,
            flags: { outputTokenMax: 32_000, client: "cli" } as any,
            isWorkflow: false,
          })

          const language = yield* provider.getLanguage(model)
          yield* Effect.promise(() =>
            generateText({
              model: language,
              messages: [{ role: "user", content: "hello" }],
              headers: prepared.headers,
            }),
          )

          expect(server.requests).toHaveLength(1)
          const wire = server.requests[0].headers
          expect(wire.get("x-opencode-session")).toBe(SESSION_ID)
          expect(wire.get("x-opencode-request")).toMatch(/^msg_/)
          expect(wire.get("x-opencode-request")).not.toContain("msg_stale")
          expect(wire.get("x-opencode-client")).toBe("cli")
          expect(wire.get("user-agent")).toBe(ZEN_USER_AGENT)
        }),
      { config: zenProviderConfig(server.url) },
    )
  }),
)

it.live("runs a non-streaming free-tier request through the opencode provider", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => zenServer()),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
          const language = yield* provider.getLanguage(model)
          const result = yield* Effect.promise(() =>
            generateText({
              model: language,
              messages: [{ role: "user", content: "hello" }],
              headers: { "x-opencode-session": SESSION_ID, "x-opencode-request": "msg_turn" },
            }),
          )

          expect(result.text).toBe("Hello world")
          expect(server.requests).toHaveLength(1)
          const request = server.requests[0]
          expect(request.headers.get("user-agent")).toBe(ZEN_USER_AGENT)
          expect(request.headers.get("x-opencode-client")).toBe("cli")
          expect(request.headers.get("x-opencode-project")).toBe("global")
          expect(request.headers.get("x-opencode-session")).toBe(SESSION_ID)
          expect(request.headers.get("x-opencode-session-id")).toBe(SESSION_ID)
          expect(request.headers.get("x-opencode-request")).toBe("msg_turn")
          expect(request.headers.get("authorization")).toBe(ZEN_PUBLIC_AUTHENTICATION)
          expect(request.body?.stream).toBe(true)
          // A plain chat turn carries no tools, and the adapter no longer
          // fabricates a catalog for it.
          expect(request.body).not.toHaveProperty("tools")
          expect(request.body).not.toHaveProperty("tool_choice")
          expect(request.body?.model).toBe("deepseek-v4-flash-free")
        }),
      { config: zenProviderConfig(server.url) },
    )
  }),
)

const zenRequest = (modelID: string) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => zenServer()),
      (server) => Effect.sync(() => server.server.close()),
    )
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make(modelID))
          const language = yield* provider.getLanguage(model)
          yield* Effect.promise(() => generateText({ model: language, messages: [{ role: "user", content: "hello" }] }))
        }),
      { config: zenProviderConfig(server.url) },
    )
    return server.requests[0]
  })

it.live("keeps the caller API key for paid models", () =>
  Effect.gen(function* () {
    const request = yield* zenRequest("paid-sonnet")

    expect(request.headers.get("authorization")).toBe("Bearer sk-secret")
    expect(request.body?.stream).toBe(true)
  }),
)

it.live("never authenticates a zero-input model with priced output as free", () =>
  Effect.gen(function* () {
    const request = yield* zenRequest("zero-input-paid")

    expect(request.body?.model).toBe("zero-input-paid")
    expect(request.headers.get("authorization")).toBe("Bearer sk-secret")
  }),
)

it.live("keeps the caller API key for models with zero base price but priced context tiers", () =>
  Effect.gen(function* () {
    const request = yield* zenRequest("tier-priced")

    expect(request.body?.model).toBe("tier-priced")
    expect(request.headers.get("authorization")).toBe("Bearer sk-secret")
  }),
)

it.live("keeps the caller API key for models with zero base price but configured cost tiers", () =>
  Effect.gen(function* () {
    const request = yield* zenRequest("configured-tier-priced")

    expect(request.body?.model).toBe("configured-tier-priced")
    expect(request.headers.get("authorization")).toBe("Bearer sk-secret")
  }),
)

it.live("merges configured model.cost.tiers with existing model tiers through Provider.Service", () =>
  Effect.gen(function* () {
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          // claude-sonnet-4 is in the opencode catalog with a tier at size 200_000.
          // Config overrides size 200_000 and adds a new tier at size 500_000.
          const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("claude-sonnet-4"))
          expect(model.cost?.tiers).toBeDefined()
          expect(model.cost?.tiers).toEqual([
            {
              input: 5,
              output: 20,
              cache: { read: 0.5, write: 5 },
              tier: { type: "context", size: 200_000 },
            },
            {
              input: 10,
              output: 35,
              cache: { read: 0, write: 0 },
              tier: { type: "context", size: 500_000 },
            },
          ])
        }),
      {
        config: {
          formatter: false,
          lsp: false,
          provider: {
            opencode: {
              options: { baseURL: "http://127.0.0.1:9999", apiKey: "sk-secret" },
              models: {
                "claude-sonnet-4": {
                  name: "Claude Sonnet 4 Custom Tiers",
                  cost: {
                    input: 3,
                    output: 15,
                    tiers: [
                      {
                        input: 5,
                        output: 20,
                        cache: { read: 0.5, write: 5 },
                        tier: { type: "context" as const, size: 200_000 },
                      },
                      {
                        input: 10,
                        output: 35,
                        tier: { type: "context", size: 500_000 },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    )
  }),
)

it.live("parses v2 array cost format and migrated v1 config through Provider.Service", () =>
  Effect.gen(function* () {
    // 1. Test actual migration of a v1 config with base cost, tiers, and context_over_200k
    const migratedV2 = ConfigMigrateV1.migrate({
      provider: {
        opencode: {
          models: {
            "v2-migrated-model": {
              name: "V2 Migrated Model",
              cost: {
                input: 1.5,
                output: 3.5,
                cache_read: 0.15,
                cache_write: 0.35,
                tiers: [
                  {
                    input: 4,
                    output: 8,
                    tier: 128_000,
                  },
                ],
                context_over_200k: {
                  input: 6,
                  output: 12,
                  cache_read: 0.6,
                  cache_write: 1.2,
                },
              },
            },
          },
        },
      },
    })

    const migratedModel = migratedV2.providers?.["opencode"]?.models?.["v2-migrated-model"]
    expect(migratedModel?.cost).toBeDefined()
    expect(Array.isArray(migratedModel?.cost)).toBe(true)

    // 2. Test loading through Provider.Service with v2 array cost structure
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("v2-tiered-model"))
          expect(model.cost.input).toBe(1.5)
          expect(model.cost.output).toBe(3.5)
          expect(model.cost.cache).toEqual({ read: 0.15, write: 0.35 })
          expect(model.cost.tiers).toEqual([
            {
              input: 4,
              output: 8,
              cache: { read: 0, write: 0 },
              tier: { type: "context", size: 128_000 },
            },
            {
              input: 6,
              output: 12,
              cache: { read: 0.6, write: 1.2 },
              tier: { type: "context", size: 200_000 },
            },
          ])
          expect(model.cost.experimentalOver200K).toEqual({
            input: 6,
            output: 12,
            cache: { read: 0.6, write: 1.2 },
          })
        }),
      {
        config: {
          formatter: false,
          lsp: false,
          provider: {
            opencode: {
              options: { baseURL: "http://127.0.0.1:9999", apiKey: "sk-secret" },
              models: {
                "v2-tiered-model": {
                  name: "V2 Tiered Model",
                  cost: migratedModel?.cost as any,
                },
              },
            },
          },
        },
      },
    )
  }),
)

it.live("rejects extra untiered paid cost entries and invalid pricing after migration through Provider.Service", () =>
  Effect.gen(function* () {
    // 1. Migrate v1 config containing:
    //    - Model A: base zero cost, but has an untiered paid cost entry in tiers (no tier size)
    //    - Model B: base zero cost, but has an invalid tier with missing size
    const migratedV2 = ConfigMigrateV1.migrate({
      provider: {
        opencode: {
          models: {
            "migrated-untiered-paid": {
              name: "Migrated Untiered Paid",
              cost: {
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
                tiers: [
                  {
                    input: 10,
                    output: 20,
                  },
                ],
              },
            },
            "migrated-invalid-tier": {
              name: "Migrated Invalid Tier",
              cost: {
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
                tiers: [
                  {
                    input: 5,
                    output: 10,
                    tier: {} as any,
                  },
                ],
              },
            },
          },
        },
      },
    })

    const modelA = migratedV2.providers?.["opencode"]?.models?.["migrated-untiered-paid"]
    const modelB = migratedV2.providers?.["opencode"]?.models?.["migrated-invalid-tier"]
    expect(modelA?.cost).toBeDefined()
    expect(modelB?.cost).toBeDefined()

    // 2. Load models into Provider.Service with an existing size 0 tier that has zero cost
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const loadedA = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("migrated-untiered-paid"))
          const loadedB = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("migrated-invalid-tier"))

          // Extra untiered paid cost entry must trigger invalid fallback even when existing size 0 tier was zero
          expect(zeroCost(loadedA.cost)).toBe(false)
          expect(loadedA.cost.tiers).toEqual([
            {
              input: 1,
              output: 1,
              cache: { read: 0, write: 0 },
              tier: { type: "context", size: 0 },
            },
          ])
          expect(freeTier([loadedA]).has("migrated-untiered-paid")).toBe(false)

          // Invalid tier pricing must also trigger invalid fallback
          expect(zeroCost(loadedB.cost)).toBe(false)
          expect(loadedB.cost.tiers).toEqual([
            {
              input: 1,
              output: 1,
              cache: { read: 0, write: 0 },
              tier: { type: "context", size: 0 },
            },
          ])
          expect(freeTier([loadedB]).has("migrated-invalid-tier")).toBe(false)
        }),
      {
        config: {
          formatter: false,
          lsp: false,
          provider: {
            opencode: {
              options: { baseURL: "http://127.0.0.1:9999", apiKey: "sk-secret" },
              models: {
                "migrated-untiered-paid": {
                  name: "Migrated Untiered Paid",
                  cost: modelA?.cost as any,
                },
                "migrated-invalid-tier": {
                  name: "Migrated Invalid Tier",
                  cost: modelB?.cost as any,
                },
              },
            },
          },
        },
      },
    )
  }),
)

it.live("preserves tiered catalog pricing and auth after migration of base-only v1 override and empty cost[]", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => zenServer()),
      (server) => Effect.sync(() => server.server.close()),
    )

    // 1. Migrate a v1 config with:
    //    - claude-sonnet-4: base-only cost override (input: 3.5, output: 16.5)
    const migratedV2 = ConfigMigrateV1.migrate({
      provider: {
        opencode: {
          options: { baseURL: server.url, apiKey: "sk-user-key" },
          models: {
            "claude-sonnet-4": {
              name: "Claude Sonnet 4 Base Override",
              cost: { input: 3.5, output: 16.5 },
            },
          },
        },
      },
    })
    const baseOverrideCost = migratedV2.providers?.["opencode"]?.models?.["claude-sonnet-4"]?.cost
    expect(baseOverrideCost).toEqual([{ input: 3.5, output: 16.5, cache: { read: undefined, write: undefined } }])

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const modelBaseOverride = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("claude-sonnet-4"))
          const modelEmptyCost = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("gpt-empty-cost"))

          // Base-only override must update input/output rates while PRESERVING catalog tiers
          expect(modelBaseOverride.cost.input).toBe(3.5)
          expect(modelBaseOverride.cost.output).toBe(16.5)
          expect(modelBaseOverride.cost.tiers).toBeDefined()
          expect(modelBaseOverride.cost.tiers?.length).toBeGreaterThan(0)
          const tier200k = modelBaseOverride.cost.tiers?.find((t) => t.tier.size === 200_000)
          expect(tier200k).toBeDefined()
          expect(tier200k?.input).toBe(6)
          expect(tier200k?.output).toBe(22.5)

          // Model is non-free
          expect(zeroCost(modelBaseOverride.cost)).toBe(false)
          expect(freeTier([modelBaseOverride]).has("claude-sonnet-4")).toBe(false)

          // Empty cost: [] must NOT become free; it preserves catalog cost
          expect(zeroCost(modelEmptyCost.cost)).toBe(false)
          expect(modelEmptyCost.cost.input).toBe(1.07)
          expect(modelEmptyCost.cost.output).toBe(8.5)
          expect(freeTier([modelEmptyCost]).has("gpt-empty-cost")).toBe(false)

          // Auth regression: paid models retain the caller's API key and must NEVER authenticate as Bearer public
          const language = yield* provider.getLanguage(modelBaseOverride)
          yield* Effect.promise(() => generateText({ model: language, messages: [{ role: "user", content: "hello" }] }))

          expect(server.requests).toHaveLength(1)
          expect(server.requests[0].headers.get("x-api-key")).toBe("sk-user-key")
          expect(server.requests[0].headers.get("authorization")).not.toBe(ZEN_PUBLIC_AUTHENTICATION)

          const languageGPT = yield* provider.getLanguage(modelEmptyCost)
          yield* Effect.promise(() =>
            generateText({ model: languageGPT, messages: [{ role: "user", content: "hello" }] }),
          )

          expect(server.requests).toHaveLength(2)
          expect(server.requests[1].headers.get("authorization")).toBe("Bearer sk-user-key")
          expect(server.requests[1].headers.get("authorization")).not.toBe(ZEN_PUBLIC_AUTHENTICATION)
        }),
      {
        config: {
          formatter: false,
          lsp: false,
          provider: {
            opencode: {
              options: { baseURL: server.url, apiKey: "sk-user-key" },
              models: {
                "claude-sonnet-4": {
                  name: "Claude Sonnet 4 Base Override",
                  cost: baseOverrideCost as any,
                },
                "gpt-empty-cost": {
                  name: "GPT Empty Cost",
                  id: "gpt-5",
                  cost: [] as any,
                },
              },
            },
          },
        },
      },
    )
  }),
)

it.live("prunes non-free models when credentials are missing and authenticates free models as public", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => zenServer()),
      (server) => Effect.sync(() => server.server.close()),
    )

    const baseConfig = zenProviderConfig(server.url)
    const noKeyConfig = {
      ...baseConfig,
      provider: {
        opencode: {
          options: { baseURL: server.url },
          models: baseConfig.provider.opencode.models,
        },
      },
    }

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const providers = yield* provider.list()
          const opencode = providers[ProviderV2.ID.opencode]
          const modelIDs = new Set(Object.keys(opencode?.models ?? {}))

          expect(modelIDs.has("deepseek-v4-flash-free")).toBe(true)
          expect(modelIDs.has("big-pickle")).toBe(true)
          expect(modelIDs.has("free-alias")).toBe(true)
          // Models with non-zero output, cache, or context tiers must be pruned when credentials are missing.
          expect(modelIDs.has("zero-input-paid")).toBe(false)
          expect(modelIDs.has("tier-priced")).toBe(false)
          expect(modelIDs.has("configured-tier-priced")).toBe(false)
          expect(modelIDs.has("paid-sonnet")).toBe(false)

          const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
          const language = yield* provider.getLanguage(model)
          yield* Effect.promise(() => generateText({ model: language, messages: [{ role: "user", content: "hello" }] }))

          expect(server.requests).toHaveLength(1)
          expect(server.requests[0].headers.get("authorization")).toBe(ZEN_PUBLIC_AUTHENTICATION)
        }),
      { config: noKeyConfig },
    )
  }),
)

it.live("authenticates a free model through its wire model id", () =>
  Effect.gen(function* () {
    // The config alias is not a Zen model id, and no model is configured under
    // the wire id, so only wire-id metadata can mark this request free.
    const request = yield* zenRequest("free-alias")

    expect(request.body?.model).toBe("team-wire-free")
    expect(request.headers.get("authorization")).toBe(ZEN_PUBLIC_AUTHENTICATION)
  }),
)

it.live("streams a free-tier response through the opencode provider", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => zenServer()),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("big-pickle"))
          const language = yield* provider.getLanguage(model)
          const result = streamText({
            model: language,
            messages: [{ role: "user", content: "hello" }],
            headers: { "x-opencode-session": SESSION_ID, "x-opencode-request": "msg_turn" },
          })

          expect(yield* Effect.promise(() => result.text)).toBe("Hello world")
          expect(server.requests[0].headers.get("x-opencode-session")).toBe(SESSION_ID)
          expect(server.requests[0].body?.stream).toBe(true)
        }),
      { config: zenProviderConfig(server.url) },
    )
  }),
)

it.live(
  "guards injected-only tool calls from AI SDK runtime when model selects injected tool with empty caller tools",
  () =>
    Effect.gen(function* () {
      const bashStream = [
        'data: {"id":"chatcmpl-1","created":1,"model":"deepseek-v4-flash-free","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
        "",
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_bash_1","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]},"finish_reason":null}]}',
        "",
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n")

      const server = yield* Effect.acquireRelease(
        Effect.promise(() => zenServer(() => bashStream)),
        (server) => Effect.sync(() => server.server.close()),
      )

      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
            const language = yield* provider.getLanguage(model)

            // 1. generateText with empty caller tools (tools: {})
            // The model returns an injected tool call (bash), which lacks an executor in tools: {}.
            // The guarded adapter strips the injected call and normalizes finishReason to "stop",
            // preventing AI SDK NoSuchToolError or unknown executor hang.
            const genResult = yield* Effect.promise(() =>
              generateText({
                model: language,
                tools: {},
                messages: [{ role: "user", content: "summarize this conversation" }],
              }),
            )
            expect(genResult.finishReason).toBe("stop")
            expect(genResult.toolCalls).toHaveLength(0)

            // 2. streamText with empty caller tools (tools: {})
            const streamResult = yield* Effect.promise(async () => {
              const stream = streamText({
                model: language,
                tools: {},
                messages: [{ role: "user", content: "summarize this conversation" }],
              })
              const text = await stream.text
              const finishReason = await stream.finishReason
              const toolCalls = await stream.toolCalls
              return { text, finishReason, toolCalls }
            })
            expect(streamResult.finishReason).toBe("stop")
            expect(streamResult.toolCalls).toHaveLength(0)
          }),
        { config: zenProviderConfig(server.url) },
      )
    }),
)

it.live(
  "guards injected-only tool calls while executing caller tools when model selects injected tool with partial caller tools",
  () =>
    Effect.gen(function* () {
      const mixedStream = [
        'data: {"id":"chatcmpl-2","created":1,"model":"deepseek-v4-flash-free","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
        "",
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_custom_1","type":"function","function":{"name":"custom_lookup","arguments":"{\\"key\\":\\"test-val\\"}"}},{"index":1,"id":"call_bash_1","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]},"finish_reason":null}]}',
        "",
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n")

      const server = yield* Effect.acquireRelease(
        Effect.promise(() => zenServer(() => mixedStream)),
        (server) => Effect.sync(() => server.server.close()),
      )

      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
            const language = yield* provider.getLanguage(model)

            let executedQuery = ""
            const customLookup = tool({
              description: "Caller defined custom tool",
              inputSchema: z.object({ key: z.string() }),
              execute: async ({ key }: { key: string }) => {
                executedQuery = key
                return `found-${key}`
              },
            })

            // 1. generateText with partial caller tools (caller provided custom_lookup, but not bash)
            // Model emitted both custom_lookup and injected bash.
            // Injected bash is filtered out; custom_lookup is preserved and executed without unknown executor / hang.
            const genResult = yield* Effect.promise(() =>
              generateText({
                model: language,
                tools: { custom_lookup: customLookup },
                messages: [{ role: "user", content: "perform lookup" }],
              }),
            )
            expect(genResult.finishReason).toBe("tool-calls")
            expect(genResult.toolCalls).toHaveLength(1)
            expect(genResult.toolCalls[0].toolName).toBe("custom_lookup")
            expect(genResult.toolResults).toHaveLength(1)
            expect(genResult.toolResults[0].output).toBe("found-test-val")
            expect(executedQuery).toBe("test-val")

            // On the wire the caller catalog is kept in front, upstream's web
            // tools are appended for the gate, and the quartet is not injected.
            expect(server.requests).toHaveLength(1)
            expect(server.requests[0].body?.tools?.map((t: any) => t.function?.name)).toEqual([
              "custom_lookup",
              ...ZEN_WEB_TOOLS,
            ])

            // 2. streamText with partial caller tools
            executedQuery = ""
            const streamResult = yield* Effect.promise(async () => {
              const stream = streamText({
                model: language,
                tools: { custom_lookup: customLookup },
                messages: [{ role: "user", content: "perform lookup" }],
              })
              const finishReason = await stream.finishReason
              const toolCalls = await stream.toolCalls
              const toolResults = await stream.toolResults
              return { finishReason, toolCalls, toolResults }
            })
            expect(streamResult.finishReason).toBe("tool-calls")
            expect(streamResult.toolCalls).toHaveLength(1)
            expect(streamResult.toolCalls[0].toolName).toBe("custom_lookup")
            expect(streamResult.toolResults).toHaveLength(1)
            expect(streamResult.toolResults[0].output).toBe("found-test-val")
            expect(executedQuery).toBe("test-val")
          }),
        { config: zenProviderConfig(server.url) },
      )
    }),
)

function collectErrorMessages(error: unknown, seen = new Set<unknown>()): string[] {
  if (!error || (typeof error !== "object" && typeof error !== "function") || seen.has(error)) return []
  seen.add(error)
  const message = typeof (error as any).message === "string" ? [(error as any).message] : []
  return [...message, ...collectErrorMessages((error as any).cause, seen)]
}

it.live("strips injected-only tool calls from a JSON completion served to the AI SDK", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() =>
        zenServer(undefined, (_captured, _request, response) => {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(
            JSON.stringify({
              id: "chatcmpl-json-1",
              object: "chat.completion",
              created: 1,
              model: "deepseek-v4-flash-free",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "Done.",
                    tool_calls: [
                      { id: "call_b", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
          )
        }),
      ),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
          const language = yield* provider.getLanguage(model)

          // The gateway answered the AI SDK request with JSON instead of SSE;
          // it must pass the same guard so the injected-only bash call never
          // reaches the runtime as an unexecutable tool call.
          const result = yield* Effect.promise(() =>
            generateText({ model: language, tools: {}, messages: [{ role: "user", content: "wrap up" }] }),
          )
          expect(result.finishReason).toBe("stop")
          expect(result.text).toBe("Done.")
          expect(result.toolCalls).toHaveLength(0)
        }),
      { config: zenProviderConfig(server.url) },
    )
  }),
)

it.live("fails a required tool_choice that only injected tools would have answered", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() =>
        zenServer(undefined, (_captured, _request, response) => {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(
            JSON.stringify({
              id: "chatcmpl-json-2",
              object: "chat.completion",
              created: 1,
              model: "deepseek-v4-flash-free",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      { id: "call_b", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
          )
        }),
      ),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
          const language = yield* provider.getLanguage(model)

          // The caller required a tool call; the only call the model produced
          // belongs to the injected quartet. Reporting a normal stop after
          // stripping it would falsely satisfy the required contract, so the
          // guard must fail the request explicitly instead.
          const messages = yield* Effect.promise(async () => {
            try {
              await generateText({
                model: language,
                tools: {
                  custom_lookup: tool({
                    inputSchema: z.object({ key: z.string() }),
                    execute: async () => "unused",
                  }),
                },
                toolChoice: "required",
                messages: [{ role: "user", content: "run the lookup" }],
              })
              return ["<no error thrown>"]
            } catch (error) {
              return collectErrorMessages(error)
            }
          })
          expect(messages.join(" | ")).toContain("required tool_choice")
        }),
      { config: zenProviderConfig(server.url) },
    )
  }),
)

it.live("executes an index-less caller tool call while stripping the injected one in a guarded stream", () =>
  Effect.gen(function* () {
    const indexlessCallerStream = [
      'data: {"id":"chatcmpl-4","created":1,"model":"deepseek-v4-flash-free","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_b","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]},"finish_reason":null}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_c","type":"function","function":{"name":"custom_lookup","arguments":"{\\"key\\":\\"indexed\\"}"}}]},"finish_reason":null}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n")

    const server = yield* Effect.acquireRelease(
      Effect.promise(() => zenServer(() => indexlessCallerStream)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
          const language = yield* provider.getLanguage(model)

          let executedKey = ""
          const customLookup = tool({
            description: "Caller defined custom tool",
            inputSchema: z.object({ key: z.string() }),
            execute: async ({ key }: { key: string }) => {
              executedKey = key
              return `found-${key}`
            },
          })

          // The caller's tool call arrives without an `index`, which a naive
          // index map folds onto 0 — exactly the slot the injected bash call
          // owns — and drops both. The caller call has to survive so it can
          // execute.
          const streamResult = yield* Effect.promise(async () => {
            const stream = streamText({
              model: language,
              tools: { custom_lookup: customLookup },
              messages: [{ role: "user", content: "perform lookup" }],
            })
            const finishReason = await stream.finishReason
            const toolCalls = await stream.toolCalls
            const toolResults = await stream.toolResults
            return { finishReason, toolCalls, toolResults }
          })
          expect(streamResult.finishReason).toBe("tool-calls")
          expect(streamResult.toolCalls).toHaveLength(1)
          expect(streamResult.toolCalls[0].toolName).toBe("custom_lookup")
          expect(streamResult.toolResults).toHaveLength(1)
          expect(streamResult.toolResults[0].output).toBe("found-indexed")
          expect(executedKey).toBe("indexed")
        }),
      { config: zenProviderConfig(server.url) },
    )
  }),
)

it.live("surfaces the required-contract guard failure through a streamed AI SDK call", () =>
  Effect.gen(function* () {
    const bashOnlyStream = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_b","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]},"finish_reason":null}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n")

    const server = yield* Effect.acquireRelease(
      Effect.promise(() => zenServer(() => bashOnlyStream)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
          const language = yield* provider.getLanguage(model)

          // A guarded stream that can only answer the required tool_choice
          // with injected tools must error the stream, not rewrite the
          // finish reason to a normal stop.
          const outcome = yield* Effect.promise(async () => {
            const stream = streamText({
              model: language,
              tools: {
                custom_lookup: tool({
                  inputSchema: z.object({ key: z.string() }),
                  execute: async () => "unused",
                }),
              },
              toolChoice: "required",
              messages: [{ role: "user", content: "run the lookup" }],
            })
            const messages: string[] = []
            try {
              for await (const part of stream.fullStream) {
                if (part.type === "error") messages.push(...collectErrorMessages((part as any).error))
              }
              messages.push(
                ...collectErrorMessages(await Promise.resolve(stream.text).catch((error: unknown) => error)),
              )
            } catch (error) {
              messages.push(...collectErrorMessages(error))
            }
            return messages
          })
          expect(outcome.join(" | ")).toContain("required tool_choice")
        }),
      { config: zenProviderConfig(server.url) },
    )
  }),
)

it.live("keeps a caller abort on a guarded stream from hanging the AI SDK consumer", () =>
  Effect.gen(function* () {
    const closed = Promise.withResolvers<void>()
    const server = yield* Effect.acquireRelease(
      Effect.promise(() =>
        zenServer(undefined, (_captured, request, response) => {
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.write('data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n')
          // The response is deliberately never ended, so only a properly
          // propagated abort can settle the consumer.
          request.on("close", () => closed.resolve())
        }),
      ),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
          const language = yield* provider.getLanguage(model)

          const controller = new AbortController()
          const settled = yield* Effect.promise(async () => {
            const stream = streamText({
              model: language,
              abortSignal: controller.signal,
              messages: [{ role: "user", content: "hello" }],
            })
            for await (const part of stream.fullStream) {
              if (part.type === "text-delta") {
                controller.abort()
                break
              }
            }
            return await Promise.race([
              stream.text.then(
                (value) => `resolved:${value}`,
                (error) => `rejected:${collectErrorMessages(error).join(" ")}`,
              ),
              new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 10_000)),
            ])
          })

          expect(settled).not.toBe("hung")
          yield* Effect.promise(() => closed.promise)
        }),
      { config: zenProviderConfig(server.url) },
    )
  }),
)

function zenProviderConfig(url: string) {
  return {
    formatter: false,
    lsp: false,
    provider: {
      opencode: {
        options: { baseURL: url, apiKey: "sk-secret" },
        models: {
          "deepseek-v4-flash-free": {
            name: "DeepSeek Flash Free",
            tool_call: true,
            limit: { context: 100_000, output: 10_000 },
          },
          "big-pickle": {
            name: "Big Pickle",
            tool_call: true,
            limit: { context: 100_000, output: 10_000 },
          },
          "free-alias": {
            id: "team-wire-free",
            name: "Aliased Free",
            tool_call: true,
            cost: { input: 0, output: 0 },
          },
          "zero-input-paid": {
            name: "Priced Output",
            tool_call: true,
            cost: { input: 0, output: 5 },
            limit: { context: 100_000, output: 10_000 },
          },
          "paid-sonnet": {
            name: "Paid",
            tool_call: true,
            cost: { input: 3, output: 15 },
            limit: { context: 100_000, output: 10_000 },
          },
          "tier-priced": {
            name: "Tier Priced",
            tool_call: true,
            cost: {
              input: 0,
              output: 0,
              context_over_200k: { input: 5, output: 10 },
            },
            limit: { context: 300_000, output: 10_000 },
          },
          "configured-tier-priced": {
            name: "Configured Tier Priced",
            tool_call: true,
            cost: {
              input: 0,
              output: 0,
              tiers: [
                {
                  input: 2,
                  output: 4,
                  tier: { type: "context" as const, size: 128_000 },
                },
              ],
            },
            limit: { context: 300_000, output: 10_000 },
          },
        },
      },
    },
  }
}

async function zenServer(
  streamFactory?: (req: Captured) => string | undefined,
  /**
   * Takes over chat completion requests entirely, so tests can answer them
   * with a JSON completion instead of the default SSE, or hold a streamed
   * response open to observe client aborts.
   */
  responder?: (req: Captured, request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; url: string; requests: Captured[] }> {
  const requests: Captured[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      const captured: Captured = {
        url: request.url ?? "",
        method: request.method ?? "GET",
        headers: new Headers(
          Object.entries(request.headers).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, String(value)] as [string, string]],
          ),
        ),
        body: chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString()),
        raw: chunks.length === 0 ? undefined : Buffer.concat(chunks),
        init: undefined,
      }
      requests.push(captured)
      if (responder && request.url?.includes("/chat/completions")) {
        responder(captured, request, response)
        return
      }
      if (request.url?.includes("/messages")) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Hello world" }],
            model: "claude-sonnet-4",
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 2 },
          }),
        )
        return
      }
      if (request.url?.includes("/responses")) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            status: "completed",
            created_at: Math.floor(Date.now() / 1000),
            output: [
              {
                id: "out_1",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Hello world", annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 2 },
          }),
        )
        return
      }
      if (streamFactory) {
        const custom = streamFactory(captured)
        if (custom !== undefined) {
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.end(custom)
          return
        }
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(completionStream)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}`, requests }
}
