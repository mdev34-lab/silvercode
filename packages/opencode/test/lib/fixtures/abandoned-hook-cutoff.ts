// Issue 1B probe: when a defecting finalizer exceeds Bun's CLI `--timeout` hook budget (1100ms
// under `--timeout 800`), Bun cuts off `afterEach` (`a beforeEach/afterEach hook timed out for
// this test`) and skips `onTestFinished`. Verifies the run key is still removed once the finalizer
// settles and throws, with the defect surfaced on stderr and zero unhandled errors.
import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { inflightOwnedRunCount } from "../owned-deadline"
import { testEffect } from "../effect"
import { hangWithLiveHandle } from "./abandoned-keepalive"

class CutoffProbe extends Context.Service<CutoffProbe, {}>()("AbandonedHookCutoffProbe") {}

const envKey = "SILVERCODE_TEST_ABANDONED_HOOK_CUTOFF_ENV"
const previousEnv = process.env[envKey]

const restoreEnv = () => {
  if (previousEnv === undefined) delete process.env[envKey]
  else process.env[envKey] = previousEnv
}

const cutoffDefectLayer = Layer.effect(
  CutoffProbe,
  Effect.acquireRelease(
    Effect.sync(() => {
      process.env[envKey] = "active"
      return {}
    }),
    () =>
      Effect.promise(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1100))
        restoreEnv()
        throw new Error("defect after hook timeout cutoff")
      }),
  ),
)

const it = testEffect(cutoffDefectLayer)

it.live("host-abandoned run whose defecting finalizer is cut by hook timeout", () =>
  Effect.gen(function* () {
    yield* CutoffProbe
    yield* hangWithLiveHandle
  }),
)

test(
  "follow-up test sees key cleared from runs once cut-off defecting finalizer settles",
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(process.env[envKey]).toBe(previousEnv)
    expect(inflightOwnedRunCount()).toBe(0)
  },
  3000,
)
