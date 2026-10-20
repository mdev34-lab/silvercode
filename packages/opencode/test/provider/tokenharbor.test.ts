import { describe, expect, test } from "bun:test"
import { discoverModels, parseModelList, toModel } from "../../src/provider/tokenharbor"

describe("tokenharbor model list", () => {
  test("parses the OpenAI list shape", () => {
    const list = parseModelList({ object: "list", data: [{ id: "a", object: "model" }, { id: "b", context_length: 64000 }, { id: "a" }] })
    expect(list.map((item) => item.id)).toEqual(["a", "b"])
    expect(list[1].context).toBe(64000)
  })

  test("reads label, pricing and tool support from the real catalog shape", () => {
    const [entry] = parseModelList({
      object: "list",
      data: [
        {
          id: "claude-sonnet-4.6",
          object: "model",
          label: "Claude Sonnet 4.6",
          pricing: { input_usd_per_1m: 3, output_usd_per_1m: 15, cache_read_usd_per_1m: 0.3, cache_write_usd_per_1m: 3.75 },
          context_length: null,
          tool_call: true,
        },
      ],
    })
    const model = toModel(entry)
    expect(model.name).toBe("Claude Sonnet 4.6")
    expect(model.cost).toEqual({ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } })
    expect(model.capabilities.toolcall).toBe(true)
    expect(model.limit.context).toBe(128_000)
  })

  test("accepts bare arrays, models key and plain strings", () => {
    expect(parseModelList([{ id: "x" }, "y"]).map((item) => item.id)).toEqual(["x", "y"])
    expect(parseModelList({ models: [{ id: "z" }] }).map((item) => item.id)).toEqual(["z"])
    expect(parseModelList({ error: "nope" })).toEqual([])
    expect(parseModelList(null)).toEqual([])
  })

  test("maps an entry onto an openai-compatible model", () => {
    const model = toModel({ id: "deepseek-v4.1-flash" })
    expect(model.providerID).toBe("tokenharbor")
    expect(model.api).toMatchObject({ id: "deepseek-v4.1-flash", url: "https://tokenharbor.ai/v1", npm: "@ai-sdk/openai-compatible" })
    expect(model.name).toBe("deepseek-v4.1-flash")
  })

  test("discovery sends the key and skips without one or on failure", async () => {
    const calls: { url: string; auth: string | null }[] = []
    const ok = (async (url: any, init: any) => {
      calls.push({ url: String(url), auth: new Headers(init.headers).get("authorization") })
      return Response.json({ data: [{ id: "m1" }] })
    }) as unknown as typeof fetch
    expect(Object.keys(await discoverModels("thk_x", "https://tokenharbor.ai/v1/", ok))).toEqual(["m1"])
    expect(calls).toEqual([{ url: "https://tokenharbor.ai/v1/models", auth: "Bearer thk_x" }])
    expect(await discoverModels(undefined, undefined, ok)).toEqual({})
    const denied = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch
    expect(await discoverModels("bad", undefined, denied)).toEqual({})
  })
})
