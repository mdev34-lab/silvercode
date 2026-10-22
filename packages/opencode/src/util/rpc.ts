type Definition = {
  [method: string]: (input: any) => any
}

type Message = {
  type: string
  id?: number
  method?: string
  input?: unknown
  event?: string
  data?: unknown
  result?: unknown
  error?: unknown
}

function errorReply(id: number, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return JSON.stringify({ type: "rpc.error", id, error: message })
}

export async function handleRequest(rpc: Definition, raw: string) {
  let parsed: Message
  try {
    parsed = JSON.parse(raw) as Message
  } catch {
    // Malformed IPC input carries no id to reply to; drop it.
    return undefined
  }
  if (parsed.type !== "rpc.request" || parsed.method === undefined || parsed.id === undefined) return undefined
  const method = rpc[parsed.method]
  if (typeof method !== "function") return errorReply(parsed.id, new Error(`Unknown RPC method: ${parsed.method}`))
  try {
    const result = await method(parsed.input)
    return JSON.stringify({ type: "rpc.result", result, id: parsed.id })
  } catch (error) {
    return errorReply(parsed.id, error)
  }
}

export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    const result = await handleRequest(rpc, evt.data)
    if (result) postMessage(result)
  }
  return () => {
    onmessage = null
  }
}

export function listenProcess(rpc: Definition) {
  const handler = async (message: string) => {
    const result = await handleRequest(rpc, message)
    if (result) process.send?.(result)
  }
  process.on("message", handler)
  return () => {
    process.off("message", handler)
  }
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function emitProcess(event: string, data: unknown, cb?: (error: Error | null) => void) {
  if (typeof process.send !== "function") return
  // The send callback fires when the message has been flushed to the parent,
  // so callers that exit right after a final emit can wait for the ack
  // instead of guessing a flush delay. The error is forwarded: a failed send
  // is NOT an ack and callers must not treat it as delivered.
  process.send(JSON.stringify({ type: "rpc.event", event, data }), (err) => cb?.(err ?? null))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
  onclose?: ((error: Error) => void) | null
}) {
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  target.onmessage = async (evt) => {
    let parsed: Message
    try {
      parsed = JSON.parse(evt.data) as Message
    } catch {
      return
    }
    if ((parsed.type === "rpc.result" || parsed.type === "rpc.error") && parsed.id !== undefined) {
      const request = pending.get(parsed.id)
      if (request) {
        pending.delete(parsed.id)
        if (parsed.type === "rpc.error") {
          request.reject(new Error(typeof parsed.error === "string" ? parsed.error : "RPC call failed"))
        } else {
          request.resolve(parsed.result)
        }
      }
    }
    if (parsed.type === "rpc.event" && parsed.event !== undefined) {
      const handlers = listeners.get(parsed.event)
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data)
        }
      }
    }
  }
  target.onclose = (error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      const requestId = id++
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        try {
          target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
        } catch (error) {
          // postMessage throws synchronously when the worker is terminated or
          // in its crash-restart window; settle the call instead of leaking
          // the pending entry and hanging the caller forever (#397).
          pending.delete(requestId)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
  }
}

export * as Rpc from "./rpc"
