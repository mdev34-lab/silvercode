import { describe, expect, test } from "bun:test"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { DaemonApi } from "../src/api"
import { ServerAuth } from "../src/auth"
import { DaemonRuns } from "../src/daemon-runs"
import { DaemonStop } from "../src/daemon-stop"
import { DaemonHandler } from "../src/handlers/daemon"
import { authorizationLayer } from "../src/middleware/authorization"
import { schemaErrorLayer } from "../src/middleware/schema-error"

type ExecutionState =
  | { readonly kind: "idle" }
  | { readonly kind: "busy"; readonly activeRuns: number }
  | { readonly kind: "failed" }
  | { readonly kind: "hung" }

const PATH = "http://localhost/api/daemon/stop-if-idle"
const PASSWORD = "secret"

function basic(password: string) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

// The process teardown is stubbed: these tests cover the contract (which
// requests stop, which are refused), not the signal that ends the process.
function app(state: ExecutionState) {
  let terminated = 0
  let notify: () => void = () => {}
  const termination = new Promise<void>((resolve) => {
    notify = resolve
  })
  const stopIfIdle: Effect.Effect<SessionExecution.IdleStop> =
    state.kind === "idle"
      ? Effect.succeed({ status: "stopping" })
      : state.kind === "busy"
        ? Effect.succeed({ status: "busy", activeRuns: state.activeRuns })
        : state.kind === "failed"
          ? Effect.die(new Error("execution state unavailable"))
          : Effect.never
  const routes = HttpApiBuilder.layer(DaemonApi).pipe(
    Layer.provide(DaemonHandler),
    Layer.provide(Layer.succeed(DaemonRuns.Service, DaemonRuns.Service.of({ stopIfIdle }))),
    Layer.provide(
      Layer.succeed(
        DaemonStop.Service,
        DaemonStop.Service.of({
          terminate: Effect.sync(() => {
            terminated++
            notify()
          }),
        }),
      ),
    ),
    Layer.provide(authorizationLayer),
    Layer.provide(schemaErrorLayer),
    Layer.provide(ServerAuth.Config.configLayer({ username: "opencode", password: Option.some(PASSWORD) })),
  )
  const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })
  return {
    terminated: () => terminated,
    // The teardown is forked, so wait for it instead of racing it.
    termination,
    request: (headers?: Record<string, string>) => web.handler(new Request(PATH, { method: "POST", headers })),
    dispose: web.dispose,
  }
}

describe("daemon stop-if-idle", () => {
  test("idle: accepts the stop and terminates the process", async () => {
    const server = app({ kind: "idle" })
    try {
      const response = await server.request({ authorization: basic(PASSWORD) })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ data: { status: "stopping" } })
      await server.termination
      expect(server.terminated()).toBe(1)
    } finally {
      await server.dispose()
    }
  })

  test("busy: refuses with the active run count and leaves the process running", async () => {
    const server = app({ kind: "busy", activeRuns: 3 })
    try {
      const response = await server.request({ authorization: basic(PASSWORD) })
      expect(response.status).toBe(409)
      // The CLI reads `activeRuns` out of the refusal, so its shape is contract.
      expect(await response.json()).toEqual({
        _tag: "ActiveRunsError",
        message: "Refused stop-if-idle: 3 active run(s)",
        activeRuns: 3,
      })
      expect(server.terminated()).toBe(0)
    } finally {
      await server.dispose()
    }
  })

  test("unknown: refuses when the active-run state cannot be read", async () => {
    const server = app({ kind: "failed" })
    try {
      const response = await server.request({ authorization: basic(PASSWORD) })
      expect(response.status).toBe(503)
      expect(server.terminated()).toBe(0)
    } finally {
      await server.dispose()
    }
  })

  test("unknown: refuses when the active-run state never answers", async () => {
    const server = app({ kind: "hung" })
    try {
      const response = await server.request({ authorization: basic(PASSWORD) })
      expect(response.status).toBe(503)
      expect(server.terminated()).toBe(0)
    } finally {
      await server.dispose()
    }
  }, 10_000)

  test("requires credentials", async () => {
    const server = app({ kind: "idle" })
    try {
      const missing = await server.request()
      expect(missing.status).toBe(401)
      const wrong = await server.request({ authorization: basic("wrong") })
      expect(wrong.status).toBe(401)
      expect(server.terminated()).toBe(0)
    } finally {
      await server.dispose()
    }
  })
})
