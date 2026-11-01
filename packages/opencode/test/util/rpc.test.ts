import { describe, expect, test } from "bun:test"
import { Rpc } from "../../src/util/rpc"

describe("Rpc client", () => {
  test("rejects pending calls when the transport closes", async () => {
    const target = {
      postMessage() {},
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onclose: null as ((error: Error) => void) | null,
    }

    const client = Rpc.client<{ work: (input: string) => Promise<string> }>(target)
    const pending = client.call("work", "input")
    target.onclose?.(new Error("worker crashed"))

    await expect(pending).rejects.toThrow("worker crashed")
  })

  test("rejects the call when postMessage throws, without leaking it", async () => {
    let down = true
    const target = {
      postMessage(message: string) {
        if (down) throw new Error("Bun worker is not running")
        queueMicrotask(() =>
          target.onmessage?.({
            data: JSON.stringify({ type: "rpc.result", id: JSON.parse(message).id, result: "recovered" }),
          } as MessageEvent<string>),
        )
      },
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onclose: null as ((error: Error) => void) | null,
    }

    const client = Rpc.client<{ work: (input: string) => Promise<string> }>(target)
    await expect(client.call("work", "input")).rejects.toThrow("Bun worker is not running")

    down = false
    await expect(client.call("work", "again")).resolves.toBe("recovered")
  })

  test("rejects pending calls on rpc.error replies", async () => {
    const target = {
      postMessage() {},
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onclose: null as ((error: Error) => void) | null,
    }

    const client = Rpc.client<{ work: (input: string) => Promise<string> }>(target)
    const pending = client.call("work", "input")
    target.onmessage?.({ data: JSON.stringify({ type: "rpc.error", id: 0, error: "nope" }) } as MessageEvent<string>)

    await expect(pending).rejects.toThrow("nope")
  })

  test("ignores malformed inbound messages", async () => {
    const target = {
      postMessage() {},
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onclose: null as ((error: Error) => void) | null,
    }

    const client = Rpc.client<{ work: (input: string) => Promise<string> }>(target)
    const pending = client.call("work", "input")
    target.onmessage?.({ data: "not-json{{{ " } as MessageEvent<string>)
    target.onmessage?.({
      data: JSON.stringify({ type: "rpc.result", id: 0, result: "done" }),
    } as MessageEvent<string>)

    await expect(pending).resolves.toBe("done")
  })
})

describe("Rpc handleRequest", () => {
  const request = (method: string, id = 7) => JSON.stringify({ type: "rpc.request", id, method, input: undefined })

  test("replies rpc.error when the handler throws", async () => {
    const reply = await Rpc.handleRequest(
      {
        work: () => {
          throw new Error("boom")
        },
      },
      request("work"),
    )

    expect(JSON.parse(reply ?? "")).toEqual({ type: "rpc.error", id: 7, error: "boom" })
  })

  test("replies rpc.error for unknown methods", async () => {
    const reply = await Rpc.handleRequest({}, request("missing"))

    expect(JSON.parse(reply ?? "").type).toBe("rpc.error")
    expect(JSON.parse(reply ?? "").error).toMatch(/missing/)
  })

  test("drops malformed input without replying", async () => {
    await expect(Rpc.handleRequest({}, "not-json{{{")).resolves.toBeUndefined()
  })
})
