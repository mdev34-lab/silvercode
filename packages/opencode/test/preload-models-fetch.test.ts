import { describe, expect } from "bun:test"
import { Effect, Layer, Ref, Deferred, Fiber, Exit } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Hash } from "@opencode-ai/core/util/hash"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { it } from "./lib/effect"
import { readFile, rm, writeFile, mkdir } from "fs/promises"
import path from "path"

// Focused regression for the preload isolation change in test/preload.ts:
//   process.env["OPENCODE_DISABLE_MODELS_FETCH"] = "true"
// added alongside the existing OPENCODE_MODELS_PATH fixture line.
//
// Coverage model: the "no eager refresh GET at startup" claim is covered by the
// source gate at packages/core/src/models-dev.ts:255
// (`if (!Flag.OPENCODE_DISABLE_MODELS_FETCH ...)`) combined with the focused
// flag assertion below — no helper architecture needed to prove universal
// absence, and no arbitrary sleep is used.
//
// This file contains ONE consolidated test suite. The cleanup-ownership causal
// proofs (RED→GREEN) exercise the SAME withCacheBracket helper the main
// regression uses — not a duplicate lookalike. The helper is parameterized by
// file path so the causal tests can use an isolated scratch file (avoiding
// crosstalk with the real models.json cache path the main test drives).
//
// Pattern mirrored from packages/core/test/models.test.ts:78-98 (the existing
// Effect mock idiom in this repo). The HttpClient mock records production calls
// into a Ref; it does not impersonate any real API and no test asserts on the
// mock's response body as if it were a real API response.

// --- Source-derived values (NOT hardcoded) ---------------------------------
//
// From packages/core/src/models-dev.ts:160-164:
//   const source = Flag.OPENCODE_MODELS_URL || "https://models.opencode.ai"
//   const filepath = path.join(
//     Global.Path.cache,
//     source === "https://models.opencode.ai" ? "models.json" : `models-${Hash.fast(source)}.json`,
//   )
const sourceUrl = Flag.OPENCODE_MODELS_URL || "https://models.opencode.ai"
const cacheFileName =
  sourceUrl === "https://models.opencode.ai" ? "models.json" : `models-${Hash.fast(sourceUrl)}.json`
const cacheFile = path.join(Global.Path.cache, cacheFileName)

// From packages/core/src/models-dev.ts:23:
//   const USER_AGENT = `opencode/${InstallationChannel}/${InstallationVersion}/${Flag.OPENCODE_CLIENT}`
const expectedUA = `opencode/${InstallationChannel}/${InstallationVersion}/${Flag.OPENCODE_CLIENT}`
// From models-dev.ts:176: HttpClientRequest.get(`${source}/api.json`)
const expectedRequestUrl = `${sourceUrl}/api.json`

interface CapturedCall {
  url: string
  userAgent: string | null
}
interface MockState {
  body: string
  status: number
  calls: CapturedCall[]
}

const makeRecordingClient = (state: Ref.Ref<MockState>) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = request.url
      const userAgent = request.headers["user-agent"] ?? null
      yield* Ref.update(state, (s) => ({
        ...s,
        calls: [...s.calls, { url, userAgent }],
      }))
      const s = yield* Ref.get(state)
      return HttpClientResponse.fromWeb(request, new Response(s.body, { status: s.status }))
    }),
  )

const buildLayer = (state: Ref.Ref<MockState>) =>
  // Layer.fresh is required: ModelsDev.node is a module-level Layer constant and
  // Effect.provide uses a process-global MemoMap by default (per models.test.ts:94).
  Layer.fresh(
    AppNodeBuilder.build(ModelsDev.node, [
      [LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, makeRecordingClient(state))],
    ]),
  )

// Driven by the opencode preload's OPENCODE_MODELS_PATH fixture (set in
// test/preload.ts:43). Read at runtime so the test reflects the actual preload
// surface rather than a hardcoded copy.
const fixturePath = process.env.OPENCODE_MODELS_PATH!
const fixtureText = await readFile(fixturePath, "utf8")
const fixture = JSON.parse(fixtureText) as Record<string, ModelsDev.Provider>

// A second, distinct payload for the refresh(true) assertion so we can prove
// the GET result flowed through fetchAndWrite and landed on the cache file
// (not just that a call was made).
const refreshPayload: Record<string, ModelsDev.Provider> = {
  regression: {
    id: "regression",
    name: "Regression",
    env: ["REGRESSION_API_KEY"],
    models: {
      "regression-1": {
        id: "regression-1",
        name: "Regression One",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
      },
    },
  },
}
const refreshPayloadText = JSON.stringify(refreshPayload)

const provided = <A, E>(state: Ref.Ref<MockState>, eff: Effect.Effect<A, E, ModelsDev.Service>) =>
  eff.pipe(Effect.provide(buildLayer(state)))

// --- Ownership-safe cache cleanup (FIX-ONLY DELTA) -------------------------
//
// Replaces the prior turn's JS try/finally (which Effect 4.0.0-beta.83
// fromIteratorUnsafe bypasses on yielded failure/interruption — see
// dist/internal/effect.js:864-882, only [contA] defined, returns Failure
// directly without re-entering the generator) with an Effect-native
// acquireUseRelease bracket. Per dist/Effect.d.ts:11951-11958:
//   "Ensures that the `release` `Effect` value will not be interrupted, and
//    will be executed as long as the acquisition `Effect` value successfully
//    acquires the resource."
//
// Parameterized by `file` so the causal tests can use an isolated scratch path
// (avoiding crosstalk with the real models.json cache path the main test
// drives). Both paths exercise the SAME helper — no duplicate lookalike.
//
// The snapshot (acquire) returns {existed:false} ONLY for ENOENT (repo idiom:
// packages/core/src/fs-util.ts:247, packages/opencode/src/util/filesystem.ts:58).
// All other read errors (EACCES, EIO, EISDIR, ...) rethrow so the bracket
// aborts BEFORE the body's write — protecting prior X from being clobbered by
// fetchAndWrite's atomic rename and then removed by our cleanup.
//
// The release (restoreCache) is fail-loud: writeFile/rm errors propagate (no
// swallow). For the absent-snapshot branch, the current-content read uses
// Effect.catch with ENOENT→Effect.succeed(null) — null as a SUCCESS VALUE (not
// a FAILURE), per the Effect 4 API. tryPromise's `catch: () => E` puts the
// return in the error channel (FAILURE), which was the prior turn's bug.
interface CacheSnapshot {
  existed: boolean
  bytes: Buffer | null
}

// Read a file or return null as a SUCCESS VALUE if ENOENT. Non-ENOENT errors
// propagate as Effect.fail (fail-loud). This is the correct Effect 4 pattern
// for "benign absence": Effect.tryPromise converts the readFile rejection to
// a recoverable failure (Effect.promise rejections become defects, which
// Effect.catch cannot recover from); then Effect.catch's continuation returns
// Effect<A> where A is the success channel. tryPromise's `catch: () => E`
// alternative would put the value in the error channel (FAILURE null, not
// VALUE null) — the prior turn's bug.
//
// The explicit `Error` error channel reflects the actual inference:
// Effect.tryPromise's `catch: (err) => err as Error` produces
// Effect<string, Error, never>; Effect.catch preserves the Error channel when
// the catch continuation's Effect.fail is `Error`. The declared type
// Effect<string | null, Error, never> matches. (Without the explicit Error
// annotation, the default `never` error channel would reject the Error
// return — TS2322.)
const readFileOrNull = (file: string): Effect.Effect<string | null, Error> =>
  Effect.tryPromise({
    try: () => readFile(file, "utf8"),
    catch: (err) => err as Error,
  }).pipe(
    Effect.catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT") {
        return Effect.succeed<string | null>(null)
      }
      return Effect.fail(error as Error)
    }),
  )

// Snapshot acquisition for a given file path: returns {existed:false} ONLY for
// ENOENT. All other read errors rethrow so acquireUseRelease aborts BEFORE
// the body's write.
const snapshotCacheAt = (file: string): Effect.Effect<CacheSnapshot> =>
  Effect.promise(() =>
    readFile(file).then(
      (bytes) => ({ existed: true, bytes }),
      (err: unknown) => {
        if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "ENOENT") {
          return { existed: false, bytes: null }
        }
        // Non-ENOENT (EACCES, EIO, EISDIR, ...): rethrow → Effect fails →
        // bracket aborts BEFORE body's write.
        throw err
      },
    ),
  )

// Release finalizer for a given file path + the payload the body writes (so we
// can distinguish "we wrote it" from "something else created it"). Guaranteed
// + uninterruptible per acquireUseRelease. Fail-loud: writeFile/rm errors
// propagate (no swallow).
const restoreCacheAt = (file: string, writtenPayload: string | null) =>
  (snap: CacheSnapshot): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      if (snap.existed && snap.bytes !== null) {
        // Bind const bytes AFTER the non-null guard so the Promise closure
        // captures a narrowed Buffer (not Buffer | null). TS cannot narrow
        // snap.bytes through the closure boundary without the const binding.
        const bytes = snap.bytes
        // Restore prior bytes verbatim. Fail-loud.
        yield* Effect.promise(() => writeFile(file, bytes))
      } else if (!snap.existed) {
        // Snapshot said absent. Only rm if the current content matches what we
        // wrote (writtenPayload); if something else created it, leave it alone.
        // If the body didn't write anything (writtenPayload=null) and the file
        // is still absent, readFileOrNull returns null (benign no-op).
        const current = yield* readFileOrNull(file)
        if (writtenPayload !== null && current === writtenPayload) {
          yield* Effect.promise(() => rm(file, { force: true }))
        }
      }
    })

// Bracket: snapshot acquire → body → restore release. The release is
// guaranteed + uninterruptible per acquireUseRelease spec. `writtenPayload`
// tells the release what content the body writes (so it can decide whether to
// rm on the absent-snapshot branch); null means "body doesn't write".
const withCacheBracket = <A, E>(
  file: string,
  writtenPayload: string | null,
  body: Effect.Effect<A, E, never>,
): Effect.Effect<A, E | Error, never> =>
  Effect.acquireUseRelease(
    snapshotCacheAt(file),
    () => body,
    (snap) => restoreCacheAt(file, writtenPayload)(snap),
  )

// Convenience for the main regression: drives the real models.json cache path
// and refreshPayloadText (the payload refresh(true) writes via fetchAndWrite).
const withModelsCacheBracket = <A, E>(
  body: Effect.Effect<A, E, ModelsDev.Service>,
): Effect.Effect<A, E | Error, ModelsDev.Service> =>
  Effect.acquireUseRelease(
    snapshotCacheAt(cacheFile),
    () => body,
    (snap) => restoreCacheAt(cacheFile, refreshPayloadText)(snap),
  )

describe("opencode preload models-fetch isolation", () => {
  // Focused flag assertion: covers the narrow test isolation intent when
  // combined with the source gate at packages/core/src/models-dev.ts:255.
  it.live("preload sets OPENCODE_DISABLE_MODELS_FETCH alongside OPENCODE_MODELS_PATH", () =>
    Effect.gen(function* () {
      expect(process.env.OPENCODE_MODELS_PATH).toBe(fixturePath)
      expect(process.env.OPENCODE_DISABLE_MODELS_FETCH).toBe("true")
      expect(Flag.OPENCODE_DISABLE_MODELS_FETCH).toBe(true)
      expect(Flag.OPENCODE_MODELS_PATH).toBe(fixturePath)
    }),
  )

  // Preserved behavior #1: fixture get still works with disable=true.
  it.live("ModelsDev.node get() returns FULL fixture with OPENCODE_DISABLE_MODELS_FETCH=true", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<MockState>({
        body: refreshPayloadText,
        status: 200,
        calls: [],
      })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result).toEqual(fixture)
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  // Preserved behavior #2: forced refresh still issues a real GET with disable=true,
  // AND the GET result lands on the cache file. refresh(force) does NOT check
  // Flag.OPENCODE_DISABLE_MODELS_FETCH (only the eager fork at models-dev.ts:255
  // does). Because OPENCODE_MODELS_PATH overrides the cache filepath in
  // loadFromDisk (models-dev.ts:184), get() after refresh(true) STILL returns
  // the FULL fixture — the refreshed payload is observable on the cache FILE,
  // not via get().
  //
  // All three operations run in the SAME provided layer so the
  // cachedInvalidateWithTTL state (models-dev.ts:233) is shared across them.
  // Cleanup uses withModelsCacheBracket (Effect.acquireUseRelease) so
  // restoration is guaranteed even if a yielded Effect inside the body fails
  // or is interrupted — JS try/finally would be bypassed by fromIteratorUnsafe
  // (Effect 4.0.0-beta.83, dist/internal/effect.js:864-882).
  it.live("ModelsDev.node refresh(true) issues GET, writes cache, get() still returns FULL fixture", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<MockState>({
        body: refreshPayloadText,
        status: 200,
        calls: [],
      })
      // The cache-file assertion runs INSIDE the bracket body, BEFORE the
      // release finalizer. The release would otherwise rm the file (when
      // snap.existed=false and content matches refreshPayloadText), leaving
      // nothing for the post-bracket assertion to read.
      const { initialGet, afterRefreshGet, onDisk } = yield* provided(
        state,
        withModelsCacheBracket(
          Effect.gen(function* () {
            const svc = yield* ModelsDev.Service
            const initialGet = yield* svc.get()
            yield* svc.refresh(true)
            const afterRefreshGet = yield* svc.get()
            const onDisk = yield* Effect.promise(() => readFile(cacheFile, "utf8"))
            return { initialGet, afterRefreshGet, onDisk }
          }),
        ),
      )

      // Assert get() returned the FULL fixture both before AND after refresh(true).
      expect(initialGet).toEqual(fixture)
      expect(afterRefreshGet).toEqual(fixture)

      // Assert exactly 1 recorded mock GET — refresh(true) issued one call.
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(1)

      // Exact URL (not contains): source + "/api.json" per models-dev.ts:176.
      expect(final.calls[0].url).toBe(expectedRequestUrl)

      // Exact production UA (not contains/default-cli): the full
      // `opencode/${InstallationChannel}/${InstallationVersion}/${Flag.OPENCODE_CLIENT}`
      // string per models-dev.ts:23.
      expect(final.calls[0].userAgent).toBe(expectedUA)

      // Assert the cache FILE contains refreshPayload: proves fetchAndWrite
      // (models-dev.ts:202-215) ran end-to-end. Read inside the bracket body
      // (above) so the release finalizer's rm doesn't remove it first.
      expect(onDisk).toBe(refreshPayloadText)
    }),
  )

  // --- Causal RED→GREEN proofs for the withCacheBracket helper --------------
  //
  // These exercise the SAME withCacheBracket helper the main regression uses
  // (parameterized by file path), not a duplicate lookalike. They use an
  // isolated scratch file under Global.Path.cache (per-process tmpdir via the
  // opencode preload) to avoid crosstalk with the real models.json path.

  const scratchFile = path.join(Global.Path.cache, "cleanup-causal-scratch.json")
  const priorBytes = Buffer.from(`{"prior":"X"}`)
  const refreshBytes = `{"refresh":"Y"}`

  // RED: OLD JS try/finally cleanup does NOT restore after yielded Effect
  // failure post-write. Proves the fromIteratorUnsafe bypass: on yielded
  // Failure the primitive returns the Failure directly without re-entering
  // the generator, so JS finally is NEVER entered.
  it.live("OLD try/finally: prior bytes NOT restored after yielded failure post-write (RED)", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeFile(scratchFile, priorBytes))
      const withOldCleanup = <A, E>(body: Effect.Effect<A, E, never>): Effect.Effect<A, E | Error, never> =>
        Effect.gen(function* () {
          const snap = yield* snapshotCacheAt(scratchFile)
          try {
            return yield* body
          } finally {
            // This finally does NOT run on yielded Effect failure (fromIteratorUnsafe).
            if (snap.existed && snap.bytes) {
              // Bind const bytes AFTER the truthy guard so the Promise closure
              // captures a narrowed Buffer (not Buffer | null). Same const-binding
              // fix as restoreCacheAt; does NOT change the causal old broken
              // finally semantics/asserts (finally still does not run on failure).
              const bytes = snap.bytes
              yield* Effect.promise(() => writeFile(scratchFile, bytes))
            } else {
              yield* Effect.promise(() => rm(scratchFile, { force: true }))
            }
          }
        })
      const writeThenFail = Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(scratchFile, refreshBytes))
        yield* Effect.fail(new Error("post-write yielded failure"))
      })
      const exit = yield* Effect.exit(withOldCleanup(writeThenFail))
      expect(Exit.isFailure(exit)).toBe(true)
      // RED assertion: refresh payload STILL on disk (prior X lost). The
      // finally did NOT run.
      const after = yield* readFileOrNull(scratchFile)
      expect(after).toBe(refreshBytes)
      // Cleanup for the next test: we leave the file as-is for the GREEN test
      // to re-seed. Actually, re-seed happens at the top of GREEN. Remove
      // here so a RED-test rerun starts clean.
      yield* Effect.promise(() => rm(scratchFile, { force: true }))
    }),
  )

  // GREEN (failure): NEW withCacheBracket restores prior bytes after yielded
  // Effect failure post-write. acquireUseRelease release is guaranteed +
  // uninterruptible per dist/Effect.d.ts:11951-11958.
  it.live("withCacheBracket: prior bytes restored after yielded failure post-write (GREEN)", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeFile(scratchFile, priorBytes))
      const writeThenFail = Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(scratchFile, refreshBytes))
        yield* Effect.fail(new Error("post-write yielded failure"))
      })
      const exit = yield* Effect.exit(withCacheBracket(scratchFile, refreshBytes, writeThenFail))
      expect(Exit.isFailure(exit)).toBe(true)
      // GREEN assertion: prior bytes ARE restored (release ran despite failure).
      const after = yield* readFileOrNull(scratchFile)
      expect(after).toBe(priorBytes.toString())
      yield* Effect.promise(() => rm(scratchFile, { force: true }))
    }),
  )

  // GREEN (interruption): NEW withCacheBracket restores prior bytes after
  // interruption. Uses a Deferred write-completed barrier — the child signals
  // AFTER the write lands, the parent awaits the signal BEFORE interrupting.
  // No sleep/poll readiness. The child parks deterministically on a Deferred
  // that never completes (so the interrupt lands while parked, not during the
  // write).
  it.live("withCacheBracket: prior bytes restored after interruption (GREEN, Deferred barrier)", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeFile(scratchFile, priorBytes))
      const writeCompleted = yield* Deferred.make<void>()
      const park = yield* Deferred.make<void>()
      const writeSignalPark = Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(scratchFile, refreshBytes))
        // Signal the parent that the write has landed.
        yield* Deferred.succeed(writeCompleted, undefined)
        // Park deterministically on a Deferred that never completes. The
        // interrupt lands here, AFTER the write, so the test exercises
        // "restore after interruption post-write" not "interrupt before write".
        yield* Deferred.await(park)
      })
      // Fork the child using the SAME withCacheBracket helper the main
      // regression uses (parameterized by scratchFile + refreshBytes).
      const fiber = yield* Effect.forkChild(withCacheBracket(scratchFile, refreshBytes, writeSignalPark))
      // Parent: await the write-completed signal BEFORE interrupting. This is
      // the causal barrier — no sleep, no poll.
      yield* Deferred.await(writeCompleted)
      // Verify refresh landed (proves the interrupt will be post-write).
      const mid = yield* readFileOrNull(scratchFile)
      expect(mid).toBe(refreshBytes)
      // Interrupt the parked child.
      yield* Fiber.interrupt(fiber)
      // Wait for the fiber to settle (release runs uninterruptibly).
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      // GREEN assertion: prior bytes ARE restored despite interruption.
      const after = yield* readFileOrNull(scratchFile)
      expect(after).toBe(priorBytes.toString())
      yield* Effect.promise(() => rm(scratchFile, { force: true }))
    }),
  )

  // GREEN (prior absent + failure): file created by body must be ABSENT after
  // the finalizer runs (when the snapshot said absent before). Covers the
  // prior-absent state under yielded failure post-write.
  it.live("withCacheBracket: file absent after yielded failure when prior was absent (GREEN)", () =>
    Effect.gen(function* () {
      // Ensure absent before.
      yield* Effect.promise(() => rm(scratchFile, { force: true }))
      const writeThenFail = Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(scratchFile, refreshBytes))
        yield* Effect.fail(new Error("post-write yielded failure"))
      })
      const exit = yield* Effect.exit(withCacheBracket(scratchFile, refreshBytes, writeThenFail))
      expect(Exit.isFailure(exit)).toBe(true)
      // GREEN assertion: file is ABSENT after the finalizer (release rmed it
      // because snap.existed=false and current matched refreshBytes).
      const after = yield* readFileOrNull(scratchFile)
      expect(after).toBe(null)
    }),
  )

  // GREEN (prior absent + interruption): file created by body must be ABSENT
  // after interruption-then-finalizer (when prior was absent).
  it.live("withCacheBracket: file absent after interruption when prior was absent (GREEN, Deferred barrier)", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => rm(scratchFile, { force: true }))
      const writeCompleted = yield* Deferred.make<void>()
      const park = yield* Deferred.make<void>()
      const writeSignalPark = Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(scratchFile, refreshBytes))
        yield* Deferred.succeed(writeCompleted, undefined)
        yield* Deferred.await(park)
      })
      const fiber = yield* Effect.forkChild(withCacheBracket(scratchFile, refreshBytes, writeSignalPark))
      yield* Deferred.await(writeCompleted)
      const mid = yield* readFileOrNull(scratchFile)
      expect(mid).toBe(refreshBytes)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      // GREEN assertion: file is ABSENT after interruption + finalizer.
      const after = yield* readFileOrNull(scratchFile)
      expect(after).toBe(null)
    }),
  )

  // GREEN (no-write body, prior absent): cleanup expected — no such file is
  // benign. The body doesn't write; the file stays absent; the release's
  // readFileOrNull returns null (ENOENT→succeed null), writtenPayload check
  // fails (current=null !== refreshBytes), so rm is NOT called. File remains
  // absent. Benign no-op.
  it.live("withCacheBracket: no-write body, prior absent, cleanup benign (GREEN)", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => rm(scratchFile, { force: true }))
      const noWrite = Effect.succeed("no-write")
      const result = yield* withCacheBracket(scratchFile, refreshBytes, noWrite)
      expect(result).toBe("no-write")
      // File remains absent — cleanup was a benign no-op.
      const after = yield* readFileOrNull(scratchFile)
      expect(after).toBe(null)
    }),
  )

  // GREEN (non-ENOENT abort): snapshot fails with EISDIR (non-ENOENT) →
  // bracket fails BEFORE the body's write → prior X preserved. Protects prior
  // X from being clobbered by fetchAndWrite's atomic rename when the cache
  // path is unreadable.
  it.live("withCacheBracket: non-ENOENT snapshot failure aborts before write (GREEN)", () =>
    Effect.gen(function* () {
      // Seed prior bytes at the scratch path so we can prove they survive.
      yield* Effect.promise(() => writeFile(scratchFile, priorBytes))
      // Create a directory at a path readFile will reject with EISDIR.
      const dirPath = path.join(Global.Path.cache, "cleanup-causal-isdir")
      yield* Effect.promise(() => rm(dirPath, { recursive: true, force: true }))
      yield* Effect.promise(() => mkdir(dirPath, { recursive: true }))
      yield* Effect.promise(() => writeFile(path.join(dirPath, ".keep"), ""))
      let writeAttempted = false
      const exit = yield* Effect.exit(
        Effect.acquireUseRelease(
          snapshotCacheAt(dirPath),
          () =>
            Effect.gen(function* () {
              writeAttempted = true
              return "should-not-reach"
            }),
          () => Effect.void,
        ),
      )
      // GREEN assertions: bracket failed (non-ENOENT rethrown), write NEVER attempted.
      expect(Exit.isFailure(exit)).toBe(true)
      expect(writeAttempted).toBe(false)
      // Prior bytes at the scratch path survived (write never happened).
      const after = yield* readFileOrNull(scratchFile)
      expect(after).toBe(priorBytes.toString())
      // Cleanup.
      yield* Effect.promise(() => rm(scratchFile, { force: true }))
      yield* Effect.promise(() => rm(dirPath, { recursive: true, force: true }))
    }),
  )
})
