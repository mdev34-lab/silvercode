import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"

// The daemon state directory is resolved from XDG_STATE_HOME when the module is
// first imported, so the isolated directory must be set before the import.
const stateHome = mkdtempSync(path.join(tmpdir(), "silvercode-daemon-test-"))
process.env.XDG_STATE_HOME = stateHome
const serverFile = path.join(stateHome, "opencode", "server.json")
const markerScript = path.join(stateHome, "spawn-marker.js")
const markerOut = path.join(stateHome, "spawn-marker.out")

import type { Interface as DaemonInterface } from "../../src/services/daemon"

type DaemonModule = typeof import("../../src/services/daemon")
let mod: DaemonModule
let installationVersion: string

beforeAll(async () => {
  mod = await import("../../src/services/daemon")
  installationVersion = (await import("@opencode-ai/core/installation/version")).InstallationVersion
  // Replacement path spawns `<execPath> <argv[1]> serve --register`. The marker
  // records that a spawn happened and exits, instead of starting a real server.
  writeFileSync(
    markerScript,
    'require("fs").writeFileSync(process.env.SILVERCODE_TEST_MARK, process.argv.slice(2).join(" "))\n',
  )
})

afterAll(() => {
  rmSync(stateHome, { recursive: true, force: true })
})

describe("decideStart", () => {
  const base = { registered: true, sameVersion: true, compiled: true, factoryDefault: false }

  test("spawns when nothing is registered, whatever the probe says", () => {
    expect(mod.decideStart({ ...base, registered: false, activeRuns: undefined })).toBe("spawn")
    expect(mod.decideStart({ ...base, registered: false, activeRuns: 3 })).toBe("spawn")
  })

  test("unknown reuses same-version non-destructively, refuses a version mismatch", () => {
    for (const sameVersion of [true, false]) {
      for (const compiled of [true, false]) {
        for (const factoryDefault of [true, false]) {
          expect(mod.decideStart({ ...base, sameVersion, compiled, factoryDefault, activeRuns: undefined })).toBe(
            sameVersion ? "reuse" : "refuse-unknown",
          )
        }
      }
    }
  })

  test("active runs: same-version reuses, version mismatch refuses", () => {
    expect(mod.decideStart({ ...base, activeRuns: 1 })).toBe("reuse")
    expect(mod.decideStart({ ...base, compiled: false, activeRuns: 1 })).toBe("reuse")
    expect(mod.decideStart({ ...base, sameVersion: false, activeRuns: 1 })).toBe("refuse-active")
  })

  test("verified idle zero: reuses a same-version compiled service, replaces otherwise", () => {
    expect(mod.decideStart({ ...base, activeRuns: 0 })).toBe("reuse")
    expect(mod.decideStart({ ...base, compiled: false, activeRuns: 0 })).toBe("replace")
    expect(mod.decideStart({ ...base, factoryDefault: true, activeRuns: 0 })).toBe("replace")
    expect(mod.decideStart({ ...base, sameVersion: false, activeRuns: 0 })).toBe("replace")
  })
})

describe("decideRestart", () => {
  test("proceeds when nothing is registered, whatever the answer would be", () => {
    for (const stop of [
      { status: "stopping" } as const,
      { status: "busy", activeRuns: 2 } as const,
      { status: "unknown" } as const,
    ]) {
      expect(mod.decideRestart({ registered: false, stop })).toBe("proceed")
    }
  })

  test("proceeds only when the service itself accepted the stop", () => {
    expect(mod.decideRestart({ registered: true, stop: { status: "stopping" } })).toBe("proceed")
  })

  test("refuses while runs are active, with or without a count", () => {
    expect(mod.decideRestart({ registered: true, stop: { status: "busy", activeRuns: 1 } })).toBe("refuse-active")
    expect(mod.decideRestart({ registered: true, stop: { status: "busy", activeRuns: undefined } })).toBe(
      "refuse-active",
    )
  })

  test("refuses when the active-run state is unknown", () => {
    expect(mod.decideRestart({ registered: true, stop: { status: "unknown" } })).toBe("refuse-unknown")
  })

  test("refuses when the listener is gone but the process is alive (orphaned)", () => {
    expect(mod.decideRestart({ registered: true, stop: { status: "orphaned" } })).toBe("refuse-orphaned")
  })

  test("proceeds when nothing is registered even with an orphaned answer", () => {
    expect(mod.decideRestart({ registered: false, stop: { status: "orphaned" } })).toBe("proceed")
  })
})

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type ActiveMode =
  | { kind: "ok"; runs: number }
  | { kind: "status"; status: number }
  | { kind: "body"; text: string }
  | { kind: "hang" }
  | { kind: "drop" }

// How the fake service answers `POST /api/daemon/stop-if-idle`. `grant` also
// ends the stand-in process, the way a real service terminates itself.
type StopMode =
  | { kind: "grant" }
  | { kind: "grant-drop" }
  | { kind: "busy"; runs: number }
  | { kind: "busy"; body: string }
  | { kind: "ok-body"; text: string }
  | { kind: "unavailable" }
  | { kind: "missing" }
  | { kind: "status"; status: number }
  | { kind: "hang" }
  | { kind: "drop" }

// Fake registered server. /api/health is always healthy, /api/session/active
// behaves according to `active` (only `start` uses it), and
// /api/daemon/stop-if-idle behaves according to `stop` (only `restart` uses it).
// `then` answers the first health request with ok (the registration pre-check
// must pass) and every later request with the given mode, so recheck probes see
// it. `hang` never responds; `{ status }` answers with that status.
type HealthMode = "ok" | { then: "hang" | { status: number } }

function fakeServer(input: {
  active: ActiveMode
  stop: StopMode
  health?: HealthMode
  onGrant?: () => void
  // Called synchronously with the running health-request count before each
  // answer; lets a test rewrite the registration file mid-protocol.
  onHealth?: (n: number) => void
}) {
  const requests: Array<{ path: string; authorization: string | null }> = []
  let healthRequests = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      requests.push({ path: url.pathname, authorization: req.headers.get("Authorization") })
      if (url.pathname === "/api/health") {
        healthRequests++
        input.onHealth?.(healthRequests)
        const health = input.health ?? "ok"
        if (health === "ok" || healthRequests === 1) return Response.json({ healthy: true })
        if (health.then === "hang") return new Promise<Response>(() => {})
        return new Response("nope", { status: health.then.status })
      }
      if (url.pathname === "/api/session/active") return activeResponse(input.active)
      if (url.pathname !== "/api/daemon/stop-if-idle") return new Response("not found", { status: 404 })
      return stopResponse(input.stop, input.onGrant)
    },
  })
  return Object.assign(server, { requests })
}

function activeResponse(active: ActiveMode) {
  if (active.kind === "ok") {
    const sessions = Object.fromEntries(
      Array.from({ length: active.runs }, (_, i) => [`ses_test_${i}`, { type: "running" }]),
    )
    return Response.json({ data: sessions })
  }
  if (active.kind === "status") return new Response("nope", { status: active.status })
  if (active.kind === "body") return new Response(active.text, { status: 200 })
  if (active.kind === "drop") return Response.error() // connection-level failure; listener stays up
  return new Promise<Response>(() => {}) // hang: the client's 2 s timeout must fire
}

function stopResponse(stop: StopMode, onGrant?: () => void): Response | Promise<Response> {
  if (stop.kind === "grant") {
    onGrant?.()
    return Response.json({ data: { status: "stopping" } })
  }
  if (stop.kind === "grant-drop") {
    // The service grants and terminates, but the answer never reaches the
    // client (the way a lost response plays out against the 250ms teardown).
    onGrant?.()
    return new Promise<Response>(() => {})
  }
  if (stop.kind === "ok-body") return new Response(stop.text, { status: 200 })
  if (stop.kind === "busy") {
    const body =
      "body" in stop ? stop.body : JSON.stringify({ _tag: "ActiveRunsError", message: "busy", activeRuns: stop.runs })
    return new Response(body, { status: 409 })
  }
  if (stop.kind === "unavailable")
    return Response.json({ _tag: "ActiveRunsUnknownError", message: "unknown" }, { status: 503 })
  if (stop.kind === "missing") return new Response("not found", { status: 404 })
  if (stop.kind === "status") return new Response("nope", { status: stop.status })
  if (stop.kind === "drop") return Response.error()
  return new Promise<Response>(() => {})
}

function writeRegistration(input: { version: string; url: string; pid: number }) {
  mkdirSync(path.dirname(serverFile), { recursive: true })
  writeFileSync(serverFile, JSON.stringify({ id: randomUUID(), ...input }))
}

type Outcome = { ok: true; value: unknown } | { ok: false; message: string }

function runDaemon<A, E>(program: (daemon: DaemonInterface) => Effect.Effect<A, E, never>): Promise<Outcome> {
  const layer = mod.layer.pipe(Layer.provide(NodeFileSystem.layer))
  const outcome = Effect.gen(function* () {
    const daemon = yield* mod.Service
    yield* daemon.password("test-password")
    return yield* program(daemon)
  }).pipe(
    Effect.match({
      onFailure: (error): Outcome => ({ ok: false, message: errorText(error) }),
      onSuccess: (value): Outcome => ({ ok: true, value }),
    }),
  )
  return Effect.runPromise(Effect.provide(outcome, layer))
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// Restores argv/marker env around a body, and starts from no registration.
async function withMarker(body: () => Promise<void>) {
  const originalArgv1 = process.argv[1]
  const originalMark = process.env.SILVERCODE_TEST_MARK
  process.argv[1] = markerScript
  process.env.SILVERCODE_TEST_MARK = markerOut
  rmSync(markerOut, { force: true })
  try {
    await body()
  } finally {
    process.argv[1] = originalArgv1
    if (originalMark === undefined) delete process.env.SILVERCODE_TEST_MARK
    else process.env.SILVERCODE_TEST_MARK = originalMark
    rmSync(serverFile, { force: true })
  }
}

// Registers a healthy service whose active-run probe and stop-if-idle answers
// are controlled by the caller. A real process stands in for the service so a
// stop is observable. Refusals must leave the process alive, the marker
// unwritten, and the registration untouched.
async function withRegisteredService(
  input: { active: ActiveMode; stop: StopMode; health?: HealthMode; version: string },
  body: (ctx: {
    child: ReturnType<typeof Bun.spawn>
    url: string
    requests: ReturnType<typeof fakeServer>["requests"]
  }) => Promise<void>,
) {
  const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
  const server = fakeServer({
    active: input.active,
    stop: input.stop,
    health: input.health,
    onGrant: () => child.kill("SIGTERM"),
  })
  writeRegistration({ version: input.version, url: server.url.origin, pid: child.pid })
  const originalRegistration = readFileSync(serverFile, "utf8")
  try {
    await withMarker(async () => {
      await body({ child, url: server.url.origin, requests: server.requests })
      expect(alive(child.pid)).toBe(true)
      expect(existsSync(markerOut)).toBe(false)
      expect(readFileSync(serverFile, "utf8")).toBe(originalRegistration)
    })
  } finally {
    child.kill()
    server.stop(true)
    rmSync(serverFile, { force: true })
  }
}

describe("daemon start: verified active-run boundary (integration)", () => {
  test("active run on a same-version service: start reuses, process stays alive", async () => {
    await withRegisteredService(
      { active: { kind: "ok", runs: 1 }, stop: { kind: "missing" }, version: installationVersion },
      async ({ url }) => {
        const started = await runDaemon((daemon) => daemon.start())
        expect(started.ok).toBe(true)
        if (started.ok) expect(started.value).toBe(url)
      },
    )
  }, 60_000)

  const unknownCases: Array<{ name: string; active: ActiveMode }> = [
    { name: "HTTP 401 (auth mismatch)", active: { kind: "status", status: 401 } },
    { name: "HTTP 403 (forbidden)", active: { kind: "status", status: 403 } },
    { name: "HTTP 404", active: { kind: "status", status: 404 } },
    { name: "HTTP 500", active: { kind: "status", status: 500 } },
    { name: "2xx with a body that does not decode", active: { kind: "body", text: "not-json" } },
    { name: "JSON with missing data", active: { kind: "body", text: "{}" } },
    { name: "JSON with null data", active: { kind: "body", text: '{"data":null}' } },
    { name: "JSON with array data", active: { kind: "body", text: '{"data":[]}' } },
    { name: "timeout (no response)", active: { kind: "hang" } },
    { name: "network error (connection dropped)", active: { kind: "drop" } },
  ]

  for (const item of unknownCases) {
    test(`unknown probe (${item.name}): same-version start/transport reuse`, async () => {
      await withRegisteredService(
        { active: item.active, stop: { kind: "missing" }, version: installationVersion },
        async ({ url, requests }) => {
          const started = await runDaemon((daemon) => daemon.start())
          expect(started).toEqual({ ok: true, value: url })
          expect(requests.filter((req) => req.path === "/api/session/active")).toHaveLength(1)

          const transported = await runDaemon((daemon) => daemon.transport())
          const headers = { Authorization: `Basic ${Buffer.from("opencode:test-password").toString("base64")}` }
          expect(transported).toEqual({ ok: true, value: { url, headers } })
          expect(requests.filter((req) => req.path === "/api/session/active")).toHaveLength(2)
          expect(requests.every((req) => req.authorization === headers.Authorization)).toBe(true)
        },
      )
    }, 60_000)

    test(`unknown probe (${item.name}): version mismatch start/transport refuse`, async () => {
      await withRegisteredService(
        { active: item.active, stop: { kind: "missing" }, version: "0.0.0-old" },
        async ({ requests }) => {
          for (const operation of ["start", "transport"] as const) {
            const result = await runDaemon<unknown, unknown>((daemon) => daemon[operation]())
            expect(result.ok).toBe(false)
            if (!result.ok) expect(result.message).toContain("could not be confirmed")
          }
          expect(requests.filter((req) => req.path === "/api/session/active")).toHaveLength(2)
        },
      )
    }, 60_000)
  }

  test("verified active run on a mismatched service: start refuses without replacement", async () => {
    await withRegisteredService(
      { active: { kind: "ok", runs: 1 }, stop: { kind: "missing" }, version: "0.0.0-old" },
      async () => {
        const started = await runDaemon((daemon) => daemon.start())
        expect(started.ok).toBe(false)
        if (!started.ok) expect(started.message).toContain("1 active run(s)")
      },
    )
  })

  test("verified idle zero, version mismatch: start replaces (old process killed, new spawn attempted)", async () => {
    await withMarker(async () => {
      const server = fakeServer({ active: { kind: "ok", runs: 0 }, stop: { kind: "missing" } })
      const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
      writeRegistration({ version: "0.0.0-old", url: server.url.origin, pid: child.pid })
      try {
        const started = await runDaemon((daemon) => daemon.start())
        expect(started.ok).toBe(false)
        if (!started.ok) expect(started.message).toContain("Failed to start server")
        expect(await child.exited).not.toBe(null)
        expect(alive(child.pid)).toBe(false)
        expect(readFileSync(markerOut, "utf8")).toBe("serve --register")
      } finally {
        child.kill()
        server.stop(true)
      }
    })
  }, 60_000)

  test("explicit service stop is unchanged: ends the process even with an active run", async () => {
    const server = fakeServer({ active: { kind: "ok", runs: 1 }, stop: { kind: "missing" } })
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
    writeRegistration({ version: installationVersion, url: server.url.origin, pid: child.pid })
    try {
      await runDaemon((daemon) => daemon.stop())
      expect(await child.exited).not.toBe(null)
      expect(alive(child.pid)).toBe(false)
      expect(existsSync(serverFile)).toBe(false)
    } finally {
      child.kill()
      server.stop(true)
      rmSync(serverFile, { force: true })
    }
  }, 60_000)
})

describe("daemon restart: server-side stop-if-idle (integration)", () => {
  test("idle: the service accepts the stop, so restart ends it and starts a new one", async () => {
    await withMarker(async () => {
      const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
      const server = fakeServer({
        active: { kind: "ok", runs: 0 },
        stop: { kind: "grant" },
        onGrant: () => child.kill("SIGTERM"),
      })
      writeRegistration({ version: installationVersion, url: server.url.origin, pid: child.pid })
      try {
        const restarted = await runDaemon((daemon) => daemon.restart())
        // The marker writes no registration, so the new service never reports
        // healthy; the spawn itself is what this test asserts.
        expect(restarted.ok).toBe(false)
        if (!restarted.ok) expect(restarted.message).toContain("Failed to start server")
        expect(await child.exited).not.toBe(null)
        expect(alive(child.pid)).toBe(false)
        expect(existsSync(serverFile)).toBe(false)
        expect(readFileSync(markerOut, "utf8")).toBe("serve --register")
      } finally {
        child.kill()
        server.stop(true)
      }
    })
  }, 60_000)

  test("busy: the service refuses, so restart reports the count and leaves it running", async () => {
    await withRegisteredService(
      { active: { kind: "ok", runs: 1 }, stop: { kind: "busy", runs: 1 }, version: installationVersion },
      async ({ requests }) => {
        const restarted = await runDaemon((daemon) => daemon.restart())
        expect(restarted.ok).toBe(false)
        if (!restarted.ok) expect(restarted.message).toContain("1 active run(s)")
        // Refusal is decided by the service, not by a client-side probe.
        expect(requests.filter((req) => req.path === "/api/session/active")).toHaveLength(0)
        expect(requests.filter((req) => req.path === "/api/daemon/stop-if-idle")).toHaveLength(1)
      },
    )
  }, 60_000)

  test("busy: an unreadable refusal body still refuses", async () => {
    await withRegisteredService(
      { active: { kind: "ok", runs: 1 }, stop: { kind: "busy", body: "not-json" }, version: installationVersion },
      async () => {
        const restarted = await runDaemon((daemon) => daemon.restart())
        expect(restarted.ok).toBe(false)
        if (!restarted.ok) expect(restarted.message).toContain("active runs")
      },
    )
  }, 60_000)

  const unknownCases: Array<{ name: string; stop: StopMode }> = [
    { name: "HTTP 503 (active-run state unavailable)", stop: { kind: "unavailable" } },
    { name: "HTTP 404 (older service without the endpoint)", stop: { kind: "missing" } },
    { name: "HTTP 401 (auth mismatch)", stop: { kind: "status", status: 401 } },
    { name: "HTTP 500", stop: { kind: "status", status: 500 } },
    { name: "timeout (no response)", stop: { kind: "hang" } },
    { name: "network error (connection dropped)", stop: { kind: "drop" } },
  ]

  for (const item of unknownCases) {
    test(`unknown (${item.name}): restart refuses and leaves the service running`, async () => {
      await withRegisteredService(
        { active: { kind: "ok", runs: 0 }, stop: item.stop, version: installationVersion },
        async ({ requests }) => {
          const restarted = await runDaemon((daemon) => daemon.restart())
          expect(restarted.ok).toBe(false)
          if (!restarted.ok) expect(restarted.message).toContain("could not be confirmed")
          expect(requests.filter((req) => req.path === "/api/daemon/stop-if-idle")).toHaveLength(1)
        },
      )
    }, 60_000)
  }

  const unconfirmedBodies: Array<{ name: string; text: string }> = [
    { name: "200 with a non-contract status", text: '{"data":{"status":"ok"}}' },
    { name: "200 with an unrelated body", text: "<html>ok</html>" },
    { name: "200 with no body", text: "" },
  ]

  for (const item of unconfirmedBodies) {
    test(`unconfirmed grant (${item.name}): restart refuses and leaves the service running`, async () => {
      await withRegisteredService(
        { active: { kind: "ok", runs: 0 }, stop: { kind: "ok-body", text: item.text }, version: installationVersion },
        async ({ requests }) => {
          const restarted = await runDaemon((daemon) => daemon.restart())
          expect(restarted.ok).toBe(false)
          if (!restarted.ok) expect(restarted.message).toContain("could not be confirmed")
          expect(requests.filter((req) => req.path === "/api/daemon/stop-if-idle")).toHaveLength(1)
        },
      )
    }, 60_000)
  }

  test("granted stop whose response is lost: restart re-verifies and proceeds instead of claiming the service runs", async () => {
    await withMarker(async () => {
      const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
      const server = fakeServer({
        active: { kind: "ok", runs: 0 },
        stop: { kind: "grant-drop" },
        onGrant: () => {
          child.kill("SIGTERM")
          setTimeout(() => server.stop(true), 25)
        },
      })
      writeRegistration({ version: installationVersion, url: server.url.origin, pid: child.pid })
      try {
        const restarted = await runDaemon((daemon) => daemon.restart())
        // The marker writes no registration, so the new service never reports
        // healthy; the spawn itself is what this test asserts.
        expect(restarted.ok).toBe(false)
        if (!restarted.ok) {
          expect(restarted.message).toContain("Failed to start server")
          expect(restarted.message).not.toContain("left running")
        }
        expect(await child.exited).not.toBe(null)
        expect(alive(child.pid)).toBe(false)
        expect(readFileSync(markerOut, "utf8")).toBe("serve --register")
      } finally {
        child.kill()
        server.stop(true)
      }
    })
  }, 60_000)

  test("granted stop whose response is lost but the service survived: restart still refuses", async () => {
    // The answer is lost for a transport reason while the service stays up
    // (it never granted): the liveness recheck finds it alive and refuses.
    await withRegisteredService(
      { active: { kind: "ok", runs: 0 }, stop: { kind: "hang" }, version: installationVersion },
      async ({ requests }) => {
        const restarted = await runDaemon((daemon) => daemon.restart())
        expect(restarted.ok).toBe(false)
        if (!restarted.ok) expect(restarted.message).toContain("could not be confirmed")
        expect(requests.filter((req) => req.path === "/api/daemon/stop-if-idle")).toHaveLength(1)
        expect(requests.filter((req) => req.path === "/api/health").length).toBeGreaterThan(0)
      },
    )
  }, 60_000)

  test("listener gone but the process alive: restart refuses as orphaned and leaves the process (regression: a closed port is not a dead process)", async () => {
    await withMarker(async () => {
      const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
      const server = fakeServer({ active: { kind: "ok", runs: 0 }, stop: { kind: "hang" } })
      writeRegistration({ version: installationVersion, url: server.url.origin, pid: child.pid })
      const originalRegistration = readFileSync(serverFile, "utf8")
      try {
        // The listener dies while the stop answer hangs: the recheck probes get
        // ECONNREFUSED twice, but the registered process never exited. Without
        // the PID check this played out as remove-registration + spawn, leaving
        // the wedged process alive and unmanaged.
        setTimeout(() => server.stop(true), 100)
        const restarted = await runDaemon((daemon) => daemon.restart())
        expect(restarted.ok).toBe(false)
        if (!restarted.ok) expect(restarted.message).toContain("still holds that PID")
        expect(alive(child.pid)).toBe(true)
        expect(existsSync(markerOut)).toBe(false)
        expect(readFileSync(serverFile, "utf8")).toBe(originalRegistration)
      } finally {
        child.kill()
        server.stop(true)
      }
    })
  }, 60_000)

  test("listener gone and the process exited: restart proceeds (the granted-stop teardown path)", async () => {
    await withMarker(async () => {
      const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
      const server = fakeServer({ active: { kind: "ok", runs: 0 }, stop: { kind: "hang" } })
      writeRegistration({ version: installationVersion, url: server.url.origin, pid: child.pid })
      try {
        setTimeout(() => {
          child.kill("SIGTERM")
          server.stop(true)
        }, 100)
        const restarted = await runDaemon((daemon) => daemon.restart())
        expect(restarted.ok).toBe(false)
        if (!restarted.ok) expect(restarted.message).toContain("Failed to start server")
        expect(alive(child.pid)).toBe(false)
        expect(readFileSync(markerOut, "utf8")).toBe("serve --register")
      } finally {
        child.kill()
        server.stop(true)
      }
    })
  }, 60_000)

  test("lost stop answer with the service answering 401 on health: restart refuses (a live listener is not a dead one)", async () => {
    await withRegisteredService(
      {
        active: { kind: "ok", runs: 0 },
        stop: { kind: "hang" },
        health: { then: { status: 401 } },
        version: installationVersion,
      },
      async () => {
        const restarted = await runDaemon((daemon) => daemon.restart())
        expect(restarted.ok).toBe(false)
        if (!restarted.ok) expect(restarted.message).toContain("could not be confirmed")
      },
    )
  }, 60_000)

  test("lost stop answer with the service hung on health: restart refuses (a timeout proves nothing)", async () => {
    await withRegisteredService(
      {
        active: { kind: "ok", runs: 0 },
        stop: { kind: "hang" },
        health: { then: "hang" },
        version: installationVersion,
      },
      async () => {
        const restarted = await runDaemon((daemon) => daemon.restart())
        expect(restarted.ok).toBe(false)
        if (!restarted.ok) expect(restarted.message).toContain("could not be confirmed")
      },
    )
  }, 60_000)

  test("nothing registered: restart starts a service without asking one to stop", async () => {
    await withMarker(async () => {
      const restarted = await runDaemon((daemon) => daemon.restart())
      expect(restarted.ok).toBe(false)
      if (!restarted.ok) expect(restarted.message).toContain("Failed to start server")
      expect(readFileSync(markerOut, "utf8")).toBe("serve --register")
    })
  }, 60_000)
})

describe("kill(0) classification (unit)", () => {
  test("ESRCH means exited; EPERM and any other failure mean alive (refuse-safe)", () => {
    expect(mod.kill0MeansExited({ code: "ESRCH" })).toBe(true)
    expect(mod.kill0MeansExited({ code: "EPERM" })).toBe(false)
    expect(mod.kill0MeansExited({ code: "EINVAL" })).toBe(false)
    expect(mod.kill0MeansExited(new Error("boom"))).toBe(false)
    expect(mod.kill0MeansExited(undefined)).toBe(false)
  })
})

// A URL whose port nothing listens on: bound once, then closed.
async function closedPortUrl() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") })
  const url = server.url.origin
  server.stop(true)
  return url
}

describe("daemon restart: unhealthy registration at ENTRY (integration)", () => {
  test("listener gone since entry and the PID held by another process: refuses as orphaned - no spawn, no signal, registration kept (regression: healthy() failure is not absence)", async () => {
    await withMarker(async () => {
      const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
      const url = await closedPortUrl()
      writeRegistration({ version: installationVersion, url, pid: child.pid })
      const originalRegistration = readFileSync(serverFile, "utf8")
      try {
        const restarted = await runDaemon((daemon) => daemon.restart())
        expect(restarted.ok).toBe(false)
        if (!restarted.ok) {
          expect(restarted.message).toContain("Restart refused")
          expect(restarted.message).toContain("not proof of identity")
        }
        expect(alive(child.pid)).toBe(true)
        expect(existsSync(markerOut)).toBe(false)
        expect(readFileSync(serverFile, "utf8")).toBe(originalRegistration)
      } finally {
        child.kill()
      }
    })
  }, 60_000)

  test("listener gone since entry and the PID exited: stale registration is cleared and restart proceeds", async () => {
    await withMarker(async () => {
      const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
      const url = await closedPortUrl()
      writeRegistration({ version: installationVersion, url, pid: child.pid })
      child.kill("SIGTERM")
      await new Promise((resolve) => setTimeout(resolve, 200))
      try {
        const restarted = await runDaemon((daemon) => daemon.restart())
        expect(restarted.ok).toBe(false)
        if (!restarted.ok) expect(restarted.message).toContain("Failed to start server")
        expect(readFileSync(markerOut, "utf8")).toBe("serve --register")
      } finally {
        child.kill()
      }
    })
  }, 60_000)

  test("a transient refusal that answers again refuses as unknown: nothing signaled, spawned, or removed", async () => {
    await withMarker(async () => {
      const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
      const gone = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") })
      const port = gone.port
      const url = gone.url.origin
      gone.stop(true)
      writeRegistration({ version: installationVersion, url, pid: child.pid })
      const originalRegistration = readFileSync(serverFile, "utf8")
      let revived: ReturnType<typeof Bun.serve> | undefined
      try {
        // The listener comes back between the two entry probes: the second
        // probe answers HTTP, which is alive-but-unconfirmed, never orphaned.
        setTimeout(() => {
          revived = Bun.serve({
            hostname: "127.0.0.1",
            port,
            fetch: () => Response.json({ healthy: true }),
          })
        }, 150)
        const restarted = await runDaemon((daemon) => daemon.restart())
        expect(restarted.ok).toBe(false)
        if (!restarted.ok) expect(restarted.message).toContain("could not be confirmed")
        expect(alive(child.pid)).toBe(true)
        expect(existsSync(markerOut)).toBe(false)
        expect(readFileSync(serverFile, "utf8")).toBe(originalRegistration)
      } finally {
        child.kill()
        revived?.stop(true)
      }
    })
  }, 60_000)

  test("service stop never signals an unauthenticated PID and keeps the registration while the PID is alive (PID-reuse safety)", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
    const url = await closedPortUrl()
    writeRegistration({ version: installationVersion, url, pid: child.pid })
    const originalRegistration = readFileSync(serverFile, "utf8")
    try {
      const stopped = await runDaemon((daemon) => daemon.stop())
      expect(stopped.ok).toBe(true)
      expect(alive(child.pid)).toBe(true)
      expect(readFileSync(serverFile, "utf8")).toBe(originalRegistration)
    } finally {
      child.kill()
      rmSync(serverFile, { force: true })
    }
  }, 60_000)

  test("service stop removes a stale registration once the PID is gone", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
    const url = await closedPortUrl()
    writeRegistration({ version: installationVersion, url, pid: child.pid })
    child.kill("SIGTERM")
    await new Promise((resolve) => setTimeout(resolve, 200))
    try {
      const stopped = await runDaemon((daemon) => daemon.stop())
      expect(stopped.ok).toBe(true)
      expect(existsSync(serverFile)).toBe(false)
    } finally {
      child.kill()
      rmSync(serverFile, { force: true })
    }
  }, 60_000)
})

describe("daemon teardown: verified-exit protocol (integration)", () => {
  test("service stop refuses when the health re-check during teardown hangs: registration kept, process untouched (regression: a failed re-check is not a verified exit)", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
    const server = fakeServer({ active: { kind: "ok", runs: 0 }, stop: { kind: "grant" }, health: { then: "hang" } })
    writeRegistration({ version: installationVersion, url: server.url.origin, pid: child.pid })
    const originalRegistration = readFileSync(serverFile, "utf8")
    try {
      const stopped = await runDaemon((daemon) => daemon.stop())
      expect(stopped.ok).toBe(false)
      if (!stopped.ok) {
        expect(stopped.message).toContain("could not be verified")
        expect(stopped.message).toContain("registration stays")
      }
      expect(alive(child.pid)).toBe(true)
      expect(readFileSync(serverFile, "utf8")).toBe(originalRegistration)
      expect(existsSync(markerOut)).toBe(false)
    } finally {
      child.kill()
      server.stop(true)
      rmSync(serverFile, { force: true })
    }
  }, 60_000)

  test("restart refuses when the granted stop cannot be verified (health hangs during teardown): no spawn, no removal, process untouched", async () => {
    await withMarker(async () => {
      const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
      const server = fakeServer({
        active: { kind: "ok", runs: 0 },
        stop: { kind: "grant" }, // grants but the process stays alive
        health: { then: "hang" },
      })
      writeRegistration({ version: installationVersion, url: server.url.origin, pid: child.pid })
      const originalRegistration = readFileSync(serverFile, "utf8")
      try {
        const restarted = await runDaemon((daemon) => daemon.restart())
        expect(restarted.ok).toBe(false)
        if (!restarted.ok) {
          expect(restarted.message).toContain("could not be verified")
          expect(restarted.message).not.toContain("Failed to start server")
        }
        expect(alive(child.pid)).toBe(true)
        expect(existsSync(markerOut)).toBe(false)
        expect(readFileSync(serverFile, "utf8")).toBe(originalRegistration)
      } finally {
        child.kill()
        server.stop(true)
        rmSync(serverFile, { force: true })
      }
    })
  }, 60_000)

  test("start replacement refuses when teardown cannot be verified: nothing spawned, registration kept, process untouched", async () => {
    await withRegisteredService(
      { active: { kind: "ok", runs: 0 }, stop: { kind: "grant" }, health: { then: "hang" }, version: "0.0.0-outdated" },
      async () => {
        const started = await runDaemon((daemon) => daemon.start())
        expect(started.ok).toBe(false)
        if (!started.ok) expect(started.message).toContain("could not be verified")
      },
    )
  }, 60_000)

  test("EPERM on kill(0) and on signals is never treated as exited: stop refuses and the process is left alone", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
    const server = fakeServer({ active: { kind: "ok", runs: 0 }, stop: { kind: "grant" } })
    writeRegistration({ version: installationVersion, url: server.url.origin, pid: child.pid })
    const originalRegistration = readFileSync(serverFile, "utf8")
    const originalKill = process.kill
    process.kill = (() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
    }) as typeof process.kill
    let stopped: Outcome
    try {
      stopped = await runDaemon((daemon) => daemon.stop())
    } finally {
      process.kill = originalKill
    }
    try {
      expect(stopped!.ok).toBe(false)
      if (!stopped!.ok) expect(stopped!.message).toContain("could not be verified")
      expect(alive(child.pid)).toBe(true)
      expect(readFileSync(serverFile, "utf8")).toBe(originalRegistration)
    } finally {
      child.kill()
      server.stop(true)
      rmSync(serverFile, { force: true })
    }
  }, 60_000)

  test("status no longer removes the registration on a failed health check while the PID is alive", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
    const url = await closedPortUrl()
    writeRegistration({ version: installationVersion, url, pid: child.pid })
    const originalRegistration = readFileSync(serverFile, "utf8")
    try {
      const status = await runDaemon((daemon) => daemon.status())
      expect(status.ok).toBe(true)
      expect(readFileSync(serverFile, "utf8")).toBe(originalRegistration)
    } finally {
      child.kill()
      rmSync(serverFile, { force: true })
    }
  }, 60_000)

  test("status removes the registration only once the PID is verified gone", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
    const url = await closedPortUrl()
    writeRegistration({ version: installationVersion, url, pid: child.pid })
    child.kill("SIGTERM")
    await new Promise((resolve) => setTimeout(resolve, 200))
    try {
      const status = await runDaemon((daemon) => daemon.status())
      expect(status.ok).toBe(true)
      expect(existsSync(serverFile)).toBe(false)
    } finally {
      child.kill()
      rmSync(serverFile, { force: true })
    }
  }, 60_000)
})

describe("daemon teardown: ownership and wait-path regressions (integration)", () => {
  test("EPERM injected on the WAIT path (probe and signals allowed): stop refuses, registration kept, nothing spawned", async () => {
    // A child that ignores SIGTERM, so the wait path is what decides.
    const child = Bun.spawn(["sh", "-c", "trap '' TERM; exec sleep 30"], { stdio: ["ignore", "ignore", "ignore"] })
    const server = fakeServer({ active: { kind: "ok", runs: 0 }, stop: { kind: "grant" } })
    writeRegistration({ version: installationVersion, url: server.url.origin, pid: child.pid })
    const originalRegistration = readFileSync(serverFile, "utf8")
    const originalKill = process.kill
    let signaled = false
    process.kill = ((pid: number, sig?: NodeJS.Signals | 0) => {
      if (sig === 0 || sig === undefined) {
        if (signaled) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
        return originalKill(pid, 0)
      }
      signaled = true
      return originalKill(pid, sig)
    }) as typeof process.kill
    let stopped: Outcome
    try {
      stopped = await runDaemon((daemon) => daemon.stop())
    } finally {
      process.kill = originalKill
    }
    try {
      // The wait never saw a verified exit (EPERM after SIGTERM and after
      // SIGKILL), so teardown must refuse even though the signals landed.
      expect(stopped!.ok).toBe(false)
      if (!stopped!.ok) {
        expect(stopped!.message).toContain("could not be verified")
        expect(stopped!.message).toContain("after SIGKILL")
      }
      expect(readFileSync(serverFile, "utf8")).toBe(originalRegistration)
      expect(existsSync(markerOut)).toBe(false)
    } finally {
      child.kill("SIGKILL")
      server.stop(true)
      rmSync(serverFile, { force: true })
    }
  }, 60_000)

  test("registration changed before the teardown re-check: stop refuses without signaling, the new registration is preserved (regression: ownership race)", async () => {
    const childA = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
    const childB = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
    const server = fakeServer({
      active: { kind: "ok", runs: 0 },
      stop: { kind: "grant" },
      onHealth: () => {
        // B registers while A's stop is between its first probe and the
        // teardown re-check.
        writeRegistration({ version: installationVersion, url: server.url.origin, pid: childB.pid })
      },
    })
    writeRegistration({ version: installationVersion, url: server.url.origin, pid: childA.pid })
    try {
      const stopped = await runDaemon((daemon) => daemon.stop())
      expect(stopped.ok).toBe(false)
      if (!stopped.ok) expect(stopped.message).toContain("could not be verified")
      const kept = JSON.parse(readFileSync(serverFile, "utf8"))
      expect(kept.pid).toBe(childB.pid)
      expect(alive(childA.pid)).toBe(true)
      expect(alive(childB.pid)).toBe(true)
      expect(existsSync(markerOut)).toBe(false)
    } finally {
      childA.kill()
      childB.kill()
      server.stop(true)
      rmSync(serverFile, { force: true })
    }
  }, 60_000)

  test("a different service registers while replacement tears down: stop preserves it (regression: A exit + B register + A teardown must not delete B)", async () => {
    const childA = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
    const childB = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
    let bFile = ""
    const server = fakeServer({
      active: { kind: "ok", runs: 0 },
      stop: { kind: "grant" },
      onHealth: (n) => {
        // B registers during A's teardown health re-check (second probe).
        if (n === 2) {
          writeRegistration({ version: installationVersion, url: server.url.origin, pid: childB.pid })
          bFile = readFileSync(serverFile, "utf8")
        }
      },
    })
    writeRegistration({ version: installationVersion, url: server.url.origin, pid: childA.pid })
    try {
      const stopped = await runDaemon((daemon) => daemon.stop())
      // A's teardown is verified (SIGTERM after authentication); B's file must
      // survive untouched.
      expect(stopped.ok).toBe(true)
      expect(alive(childA.pid)).toBe(false)
      expect(alive(childB.pid)).toBe(true)
      expect(bFile).not.toBe("")
      expect(readFileSync(serverFile, "utf8")).toBe(bFile)
      expect(existsSync(markerOut)).toBe(false)
    } finally {
      childA.kill()
      childB.kill()
      server.stop(true)
      rmSync(serverFile, { force: true })
    }
  }, 60_000)

  test("start replacement that loses the registration race rediscovers the new service instead of deleting it without ownership", async () => {
    const childA = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
    const childB = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
    let bFile = ""
    const server = fakeServer({
      active: { kind: "ok", runs: 0 },
      stop: { kind: "grant" },
      onHealth: (n) => {
        if (n === 2) {
          writeRegistration({ version: installationVersion, url: server.url.origin, pid: childB.pid })
          bFile = readFileSync(serverFile, "utf8")
        }
      },
    })
    // A is outdated and verified idle: start would replace it. B (current
    // version) registers during A's teardown.
    writeRegistration({ version: "0.0.0-outdated", url: server.url.origin, pid: childA.pid })
    await withMarker(async () => {
      try {
        const started = await runDaemon((daemon) => daemon.start())
        // A is torn down, B is rediscovered and the decision re-runs against
        // B: a dev build replaces a verified-idle same-version service, so B
        // is torn down too - but ONLY after stopProcess authenticates B and
        // removeIfSame confirms the file still belongs to B. The marker
        // records the resulting spawn; it cannot serve, so start reports the
        // spawn failure.
        expect(started.ok).toBe(false)
        if (!started.ok) expect(started.message).toContain("Failed to start server")
        expect(alive(childA.pid)).toBe(false)
        expect(alive(childB.pid)).toBe(false)
        expect(readFileSync(markerOut, "utf8")).toBe("serve --register")
        expect(bFile).not.toBe("")
      } finally {
        childA.kill()
        childB.kill()
        server.stop(true)
        rmSync(serverFile, { force: true })
      }
    })
  }, 60_000)
})
