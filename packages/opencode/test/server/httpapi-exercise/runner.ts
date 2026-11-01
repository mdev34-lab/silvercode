import { Flag } from "@opencode-ai/core/flag/flag"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Duration, Effect, Exit, Layer, Scope } from "effect"
import { TestLLMServer } from "../../lib/llm-server"
import type { Config } from "../../../src/config/config"

import type { MessageV2 } from "../../../src/session/message-v2"
import { MessageID, PartID } from "../../../src/session/schema"
import { boundedCleanup, CLEANUP_BOUND_MS } from "./cleanup"
import { call, callAuthProbe, disposeApps } from "./backend"
import { original } from "./environment"
import { runtime, type Runtime } from "./runtime"
import type { ActiveScenario, Options, ProjectOptions, Result, Scenario, ScenarioContext, SeededContext } from "./types"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

/**
 * Injection point for the runner's module graph, cleanup bound and log sink.
 * Production uses defaultRunnerEnv; tests pass fake modules and a short bound to
 * drive the real scope wiring deterministically.
 */
export type RunnerEnv = {
  modules: () => Promise<Runtime>
  cleanupBoundMs: number
  log: (...args: unknown[]) => void
}

export const defaultRunnerEnv: RunnerEnv = {
  modules: runtime,
  cleanupBoundMs: CLEANUP_BOUND_MS,
  log: (...args) => console.error(...args),
}

const boundedWith = (env: RunnerEnv, label: string, promise: Promise<unknown>) =>
  boundedCleanup(label, promise, { boundMs: env.cleanupBoundMs, log: env.log })

export function runScenario(options: Options, env: RunnerEnv = defaultRunnerEnv) {
  return (scenario: Scenario) => {
    if (scenario.kind === "todo") return Effect.succeed({ status: "skip", scenario } as Result)
    return runActive(options, scenario, env).pipe(
      Effect.timeoutOrElse({
        duration: options.scenarioTimeout,
        orElse: () => Effect.die(new Error(`scenario timed out after ${Duration.format(options.scenarioTimeout)}`)),
      }),
      Effect.as({ status: "pass", scenario } as Result),
      Effect.catchCause((cause) => Effect.succeed({ status: "fail" as const, scenario, message: Cause.pretty(cause) })),
      Effect.scoped,
    )
  }
}

function runActive(options: Options, scenario: ActiveScenario, env: RunnerEnv) {
  if (options.mode === "auth") return runAuth(scenario)

  return withContext(
    options,
    scenario,
    "shared",
    (ctx) =>
      Effect.gen(function* () {
        yield* trace(options, scenario, "request start")
        const result = yield* call(scenario, ctx)
        yield* trace(options, scenario, `response ${result.status}`)
        yield* trace(options, scenario, "expect start")
        yield* scenario.expect(ctx, ctx.state, result)
        yield* trace(options, scenario, "expect done")
      }),
    env,
  )
}

function runAuth(scenario: ActiveScenario) {
  return Effect.gen(function* () {
    const result = yield* callAuthProbe(scenario, "missing")
    if (scenario.auth === "protected") {
      if (result.status !== 401) throw new Error(`auth expected 401, got ${result.status}`)
      const authed = yield* callAuthProbe(scenario, "valid")
      if (authed.status === 401) throw new Error("auth rejected valid credentials")
      return
    }

    if (result.status === 401) throw new Error("auth expected public access, got 401")
    if (result.timedOut) throw new Error("auth expected public access, probe timed out")
  })
}

/**
 * Runs `use` inside the scenario context. Verified order (Effect 4, see runner-cleanup.test.ts):
 *   use -> llm.reset -> resetState (if scenario.reset) -> AppLayer scope close -> tmpdir disposal.
 * acquireRelease registers the tmpdir release on the enclosing (Effect.scoped) scope, so it runs
 * last, as it did at base. The AppLayer scope is created here, not by Effect.scoped, so its close is bounded.
 */
export function withContext<A, E>(
  options: Options,
  scenario: ActiveScenario,
  label: string,
  use: (ctx: SeededContext<unknown>) => Effect.Effect<A, E>,
  env: RunnerEnv = defaultRunnerEnv,
) {
  return Effect.gen(function* () {
    const appScope = yield* Scope.make()
    return yield* withContextScope(options, scenario, label, appScope, use, env)
  })
}

function withContextScope<A, E>(
  options: Options,
  scenario: ActiveScenario,
  label: string,
  appScope: Scope.Closeable,
  use: (ctx: SeededContext<unknown>) => Effect.Effect<A, E>,
  env: RunnerEnv,
) {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      yield* trace(options, scenario, `${label} context acquire start`)
      const llm = scenario.project?.llm ? yield* TestLLMServer : undefined
      const project = scenario.project
      const dir = project
        ? yield* Effect.promise(async () => (await env.modules()).tmpdir(projectOptions(project, llm?.url)))
        : undefined
      yield* trace(options, scenario, `${label} context acquire done`)
      return { dir, llm }
    }),
    (ctx) =>
      Effect.gen(function* () {
        yield* trace(options, scenario, `${label} tmpdir cleanup start`)
        // Finalizers run uninterruptibly, so an Effect timeout could not bound
        // this either: boundedCleanup() races the disposal against a plain timer.
        // After a scenario timeout the run must move on even if cleanup is
        // wedged. Effect.ignore still guards a synchronous throw from the
        // asyncDispose call itself.
        yield* Effect.promise(async () => {
          const disposal = ctx.dir?.[Symbol.asyncDispose]()
          if (disposal) await boundedWith(env, `${label} tmpdir disposal`, disposal)
        }).pipe(Effect.ignore)
        yield* trace(options, scenario, `${label} tmpdir cleanup done`)
      }),
  ).pipe(
    Effect.flatMap((context) =>
      Effect.gen(function* () {
        yield* trace(options, scenario, `${label} runtime start`)
        const modules = yield* Effect.promise(() => env.modules())
        const app = yield* Layer.buildWithMemoMap(modules.AppLayer, modules.memoMap, appScope)
        yield* trace(options, scenario, `${label} runtime done`)
        const path = context.dir?.path
        const instance = path
          ? yield* trace(options, scenario, `${label} instance load start`).pipe(
              Effect.andThen(
                modules.InstanceStore.Service.use((store) => store.load({ directory: path })).pipe(
                  Effect.provide(app),
                  Effect.catchCause((cause) =>
                    Effect.sleep("100 millis").pipe(
                      Effect.andThen(
                        modules.InstanceStore.Service.use((store) => store.load({ directory: path })).pipe(
                          Effect.provide(app),
                        ),
                      ),
                      Effect.catchCause(() => Effect.failCause(cause)),
                    ),
                  ),
                ),
              ),
              Effect.tap(() => trace(options, scenario, `${label} instance load done`)),
            )
          : undefined
        const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(Effect.provideService(modules.InstanceRef, instance), Effect.provide(app))
        const directory = () => {
          if (!context.dir?.path) throw new Error("scenario needs a project directory")
          return context.dir.path
        }
        const llm = () => {
          if (!context.llm) throw new Error("scenario needs fake LLM")
          return context.llm
        }
        const base: ScenarioContext = {
          directory: context.dir?.path,
          headers: (extra) => ({
            ...(context.dir?.path ? { "x-opencode-directory": context.dir.path } : {}),
            ...extra,
          }),
          file: (name, content) =>
            Effect.promise(() => {
              return Bun.write(`${directory()}/${name}`, content)
            }).pipe(Effect.asVoid),
          session: (input) =>
            run(modules.Session.Service.use((svc) => svc.create({ title: input?.title, parentID: input?.parentID }))),
          sessionGet: (sessionID) =>
            run(modules.Session.Service.use((svc) => svc.get(sessionID))).pipe(
              Effect.catchCause(() => Effect.succeed(undefined)),
            ),
          project: () =>
            Effect.sync(() => {
              if (!instance) throw new Error("scenario needs a project directory")
              return instance.project
            }),
          message: (sessionID, input) =>
            Effect.gen(function* () {
              const info: SessionV1.User = {
                id: MessageID.ascending(),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: "work",
                model: input?.model
                  ? {
                      providerID: ProviderV2.ID.make(input.model.providerID),
                      modelID: ModelV2.ID.make(input.model.modelID),
                    }
                  : {
                      providerID: ProviderV2.ID.opencode,
                      modelID: ModelV2.ID.make("test"),
                    },
              }
              const part: SessionV1.TextPart = {
                id: PartID.ascending(),
                sessionID,
                messageID: info.id,
                type: "text",
                text: input?.text ?? "hello",
              }
              yield* run(
                modules.Session.Service.use((svc) =>
                  Effect.gen(function* () {
                    yield* svc.updateMessage(info)
                    yield* svc.updatePart(part)
                  }),
                ),
              )
              return { info, part }
            }),
          messages: (sessionID) =>
            run(modules.Session.Service.use((svc) => svc.messages({ sessionID }).pipe(Effect.orDie))),
          todos: (sessionID, todos) => run(modules.Todo.Service.use((svc) => svc.update({ sessionID, todos }))),
          worktree: (input) => run(modules.Worktree.Service.use((svc) => svc.create(input).pipe(Effect.orDie))),
          worktreeRemove: (directory) =>
            run(modules.Worktree.Service.use((svc) => svc.remove({ directory })).pipe(Effect.ignore)),
          llmText: (value) => Effect.suspend(() => llm().text(value)),
          llmWait: (count) => Effect.suspend(() => llm().wait(count)),
          tuiRequest: (request) => Effect.sync(() => modules.Tui.submitTuiRequest(request)),
        }
        yield* trace(options, scenario, `${label} seed start`)
        const state = yield* scenario.seed(base)
        yield* trace(options, scenario, `${label} seed done`)
        yield* trace(options, scenario, `${label} use start`)
        const result = yield* use({ ...base, state })
        yield* trace(options, scenario, `${label} use done`)
        return result
      }).pipe(Effect.ensuring(context.llm ? context.llm.reset : Effect.void)),
    ),
    Effect.ensuring(scenario.reset ? resetState(env) : Effect.void),
    Effect.ensuring(
      Effect.gen(function* () {
        yield* trace(options, scenario, `${label} app scope close start`)
        // Closing the scope runs the AppLayer finalizers, which Effect.scoped
        // used to close without any bound. Failures are logged by boundedCleanup.
        yield* Effect.promise(() =>
          boundedWith(env, `${label} app scope close`, Effect.runPromise(Scope.close(appScope, Exit.void))),
        )
        yield* trace(options, scenario, `${label} app scope close done`)
      }),
    ),
  )
}

function trace(options: Options, scenario: ActiveScenario, phase: string) {
  return Effect.sync(() => {
    if (!options.trace) return
    console.log(`[trace] ${scenario.name}: ${phase}`)
  })
}

function projectOptions(
  project: ProjectOptions,
  llmUrl: string | undefined,
): { git?: boolean; config?: Partial<ConfigV1.Info> } {
  if (!project.llm || !llmUrl) return { git: project.git, config: project.config }
  const fake = fakeLlmConfig(llmUrl)
  return {
    git: project.git,
    config: {
      ...fake,
      ...project.config,
      provider: {
        ...fake.provider,
        ...project.config?.provider,
      },
    },
  }
}

function fakeLlmConfig(url: string): Partial<ConfigV1.Info> {
  return {
    agent: {
      work: { finishTool: false },
      general: { finishTool: false },
      plan: { finishTool: false },
    },
    model: "test/test-model",
    small_model: "test/test-model",
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: {
          apiKey: "test-key",
          baseURL: url,
        },
      },
    },
  }
}

const resetState = (env: RunnerEnv) =>
  Effect.promise(async () => {
    const modules = await env.modules()
    Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
    Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
    await boundedWith(env, "disposeApps", disposeApps())
    await boundedWith(env, "disposeAllInstances", modules.disposeAllInstances())
    await boundedWith(env, "resetDatabase", modules.resetDatabase())
    await Bun.sleep(25)
  })
