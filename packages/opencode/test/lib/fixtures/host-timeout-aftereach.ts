// Spawned with `bun test --timeout 800` by host-timeout.test.ts. The file's own beforeEach/afterEach set and
// reset a value, and the hung run's resource captures the value it saw and restores it on release. Bun runs a
// hook registered with onTestFinished after the file's afterEach, so a release that only ran there put the
// stale value back after the reset and the next test started contaminated. The run must be interrupted
// before the file's afterEach.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { hangWithLiveHandle } from "./host-timeout-keepalive"
import { testEffect } from "../effect"

class Resource extends Context.Service<Resource, {}>()("HostTimeoutAfterEachResource") {}

const key = "SILVERCODE_TEST_HOST_TIMEOUT_AFTEREACH_VALUE"
const seenAtStart: (string | undefined)[] = []
let captured: string | undefined

beforeEach(() => {
  seenAtStart.push(process.env[key])
  process.env[key] = "outer"
})
afterEach(() => {
  delete process.env[key]
})

const layer = Layer.effect(
  Resource,
  Effect.acquireRelease(
    Effect.sync(() => {
      captured = process.env[key]
      process.env[key] = "active"
      return {}
    }),
    () =>
      Effect.sync(() => {
        if (captured === undefined) delete process.env[key]
        else process.env[key] = captured
      }),
  ),
)

const it = testEffect(layer)

it.live("hangs until the host timeout abandons it", () =>
  Effect.gen(function* () {
    yield* Resource
    yield* hangWithLiveHandle
  }),
)

test("next test starts without the value the hung run restored", () => {
  expect(seenAtStart).toEqual([undefined, undefined])
})
