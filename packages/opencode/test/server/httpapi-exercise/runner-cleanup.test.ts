// Deterministic fault tests for the exerciser's scope-close wiring.
//
// These drive the real withContext/runScenario code with fake modules (via the
// RunnerEnv seam) and a short injected cleanup bound. No live providers, no
// global timeouts, no skips: every scenario below either completes or is
// explicitly bounded by the injected bound.

import { describe, expect, test } from "bun:test"
import { Cause, Duration, Effect, Exit, Layer } from "effect"
import { abandonedCleanups } from "./cleanup"
import { runScenario, withContext, type RunnerEnv } from "./runner"
import type { Runtime } from "./runtime"
import { TestLLMServer } from "../../lib/llm-server"
import type { ActiveScenario, Options } from "./types"

const options = (overrides: Partial<Options> = {}): Options => ({
  mode: "effect",
  include: undefined,
  startAt: undefined,
  stopAt: undefined,
  failOnMissing: false,
  failOnSkip: false,
  scenarioTimeout: Duration.seconds(5),
  progress: false,
  trace: false,
  ...overrides,
})

const scenario = (overrides: Partial<ActiveScenario> = {}): ActiveScenario => ({
  kind: "active",
  method: "GET",
  path: "/fault",
  name: "fault",
  project: undefined,
  seed: () => Effect.void,
  request: () => ({ path: "/fault" }),
  authProbe: undefined,
  expect: () => Effect.void,
  compare: "none",
  capture: "full",
  mutates: false,
  reset: false,
  auth: "public",
  ...overrides,
})

type Finalizer = "record" | "wedge" | "die"

// AppLayer stand-in. Its finalizer is the fault under test; "app-built" and
// "app-finalizer" let order assertions see when the layer is built and closed.
const appLayer = (events: string[], finalizer: Finalizer) =>
  Layer.effectDiscard(
    Effect.sync(() => {
      events.push("app-built")
    }).pipe(
      Effect.andThen(
        Effect.addFinalizer(() => {
          if (finalizer === "wedge") return Effect.never
          if (finalizer === "die") return Effect.die(new Error("finalizer broke"))
          return Effect.sync(() => {
            events.push("app-finalizer")
          })
        }),
      ),
    ),
  )

const harness = (input: { app: Layer.Layer<never, unknown>; tmpdirError?: Error; boundMs?: number }) => {
  const events: string[] = []
  const logs: unknown[][] = []
  const modules = {
    AppLayer: input.app,
    memoMap: Layer.makeMemoMapUnsafe(),
    tmpdir: async () => {
      events.push("tmpdir-create")
      if (input.tmpdirError) throw input.tmpdirError
      return {
        path: undefined,
        [Symbol.asyncDispose]: async () => {
          events.push("tmpdir-dispose")
        },
      }
    },
    disposeAllInstances: async () => {
      events.push("disposeAllInstances")
    },
    resetDatabase: async () => {
      events.push("resetDatabase")
    },
  }
  const env: RunnerEnv = {
    modules: async () => modules as unknown as Runtime,
    cleanupBoundMs: input.boundMs ?? 50,
    log: (...args) => {
      logs.push(args)
    },
  }
  return { events, logs, env }
}

// withContext types TestLLMServer as a requirement even when project.llm is unset. These
// scenarios never enable the LLM, so the service is never read; the sentinel satisfies the
// type without starting a server.
const unusedLlm = null as unknown as TestLLMServer["Service"]

const logged = (logs: unknown[][]) => logs.map((args) => args.map(String).join(" "))

// Captures [trace] lines for the duration of run(). Restores console.log even on failure.
const traced = async <A>(run: () => Promise<A>) => {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  }
  try {
    return { value: await run(), lines }
  } finally {
    console.log = original
  }
}

describe("runner scope-close wiring (fault injection)", () => {
  test("a wedged AppLayer finalizer returns under the injected bound (withContext)", async () => {
    const h = harness({ app: appLayer([], "wedge") })
    const before = abandonedCleanups()
    const started = Date.now()

    const value = await Effect.runPromise(
      withContext(options(), scenario(), "t", () => Effect.succeed("used"), h.env).pipe(
        Effect.provideService(TestLLMServer, unusedLlm),
        Effect.scoped,
      ),
    )

    expect(value).toBe("used")
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(abandonedCleanups()).toBe(before + 1)
    expect(
      logged(h.logs).some((line) =>
        line.startsWith("[reset] t app scope close did not finish within 0.05s; continuing"),
      ),
    ).toBe(true)
  })

  test("a scenario timeout over a wedged AppLayer finalizer still returns a bounded failure (runScenario)", async () => {
    const h = harness({ app: appLayer([], "wedge") })
    const started = Date.now()

    const result = await Effect.runPromise(
      runScenario(
        options({ scenarioTimeout: Duration.millis(50) }),
        h.env,
      )(scenario({ seed: () => Effect.never })).pipe(Effect.provideService(TestLLMServer, unusedLlm)),
    )

    expect(result.status).toBe("fail")
    expect(result.status === "fail" && result.message).toContain("scenario timed out")
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(logged(h.logs).some((line) => line.includes("shared app scope close did not finish within 0.05s"))).toBe(
      true,
    )
  })

  test("a rejected AppLayer finalizer cannot mask the failing scenario cause (runScenario)", async () => {
    const h = harness({ app: appLayer([], "die") })

    const result = await Effect.runPromise(
      runScenario(
        options(),
        h.env,
      )(scenario({ seed: () => Effect.die(new Error("seed boom")) })).pipe(
        Effect.provideService(TestLLMServer, unusedLlm),
      ),
    )

    expect(result.status).toBe("fail")
    const message = result.status === "fail" ? result.message : ""
    expect(message).toContain("seed boom")
    expect(message).not.toContain("finalizer broke")
    // Proves the finalizer actually rejected and was logged, not silently skipped.
    expect(logged(h.logs).some((line) => line.includes("shared app scope close failed; continuing"))).toBe(true)
  })

  test("a rejected AppLayer finalizer does not replace a failing use (withContext)", async () => {
    const h = harness({ app: appLayer([], "die") })

    const exit = await Effect.runPromiseExit(
      withContext(options(), scenario(), "t", () => Effect.fail(new Error("use boom")), h.env).pipe(
        Effect.provideService(TestLLMServer, unusedLlm),
        Effect.scoped,
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
    expect(pretty).toContain("use boom")
    expect(pretty).not.toContain("finalizer broke")
  })

  test("finalizer order is use -> resetState -> AppLayer close -> tmpdir disposal (matches base)", async () => {
    const h = harness({ app: appLayer([], "record") })
    // Share the event log between the layer and the harness so one list shows the full order.
    const events = h.events
    const env: RunnerEnv = {
      ...h.env,
      modules: async () => ({ ...(await h.env.modules()), AppLayer: appLayer(events, "record") }) as unknown as Runtime,
    }

    const value = await Effect.runPromise(
      withContext(
        options(),
        scenario({ project: {}, reset: true }),
        "t",
        () =>
          Effect.sync(() => {
            events.push("use")
            return "used"
          }),
        env,
      ).pipe(Effect.provideService(TestLLMServer, unusedLlm), Effect.scoped),
    )

    expect(value).toBe("used")
    expect(events).toEqual([
      "tmpdir-create",
      "app-built",
      "use",
      "disposeAllInstances",
      "resetDatabase",
      "app-finalizer",
      "tmpdir-dispose",
    ])
  })

  test("a tmpdir acquisition failure still closes the AppLayer scope", async () => {
    const h = harness({ app: appLayer([], "record"), tmpdirError: new Error("tmpdir broke") })

    const traces = await traced(() =>
      Effect.runPromiseExit(
        withContext(
          options({ trace: true }),
          scenario({ project: {} }),
          "t",
          () => Effect.succeed("never"),
          h.env,
        ).pipe(Effect.provideService(TestLLMServer, unusedLlm), Effect.scoped),
      ),
    )

    const exit = traces.value
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("tmpdir broke")
    expect(h.events).not.toContain("use")
    expect(traces.lines.some((line) => line.includes("t app scope close start"))).toBe(true)
    expect(traces.lines.some((line) => line.includes("t app scope close done"))).toBe(true)
  })

  test("an AppLayer build failure closes the scope, including finalizers registered before the failure", async () => {
    const events: string[] = []
    const failing = Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          events.push("partial-finalizer")
        }),
      ).pipe(Effect.andThen(Effect.fail(new Error("layer build broke")))),
    )
    const h = harness({ app: failing })

    const exit = await Effect.runPromiseExit(
      withContext(options(), scenario(), "t", () => Effect.sync(() => events.push("use")), h.env).pipe(
        Effect.provideService(TestLLMServer, unusedLlm),
        Effect.scoped,
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("layer build broke")
    expect(events).toEqual(["partial-finalizer"])
  })
})
