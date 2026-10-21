import { describe, expect } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { adjust } from "effect/testing/TestClock"
import { LLMEvent } from "@opencode-ai/llm"
import { ProviderError } from "@/provider/error"
import { ReasoningWatchdog } from "@/session/llm/reasoning-watchdog"
import { it } from "../lib/effect"

const TIMEOUT = "1 minute"

const start = (id = "reasoning-1") => LLMEvent.reasoningStart({ id })
const delta = (text: string, id = "reasoning-1") => LLMEvent.reasoningDelta({ id, text })
const text = (value: string) => LLMEvent.textDelta({ id: "text-1", text: value })
const end = (id = "reasoning-1") => LLMEvent.reasoningEnd({ id })
const step = () => LLMEvent.stepStart({ index: 0 })

const hanging = (...events: LLMEvent[]) => Stream.concat(Stream.fromIterable(events), Stream.never)

const pending = (fiber: Fiber.Fiber<unknown, unknown>) => Effect.sync(() => expect(fiber.pollUnsafe()).toBeUndefined())

describe("reasoning inactivity watchdog", () => {
  it.effect("fails when an open reasoning trace stops streaming tokens", () =>
    Effect.gen(function* () {
      const fiber = yield* ReasoningWatchdog.guard(hanging(start(), delta("thinking"))).pipe(
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* adjust(TIMEOUT)
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)

      expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
      expect(error.message).toContain("reasoning stream timed out")
    }),
  )

  it.effect("resets the deadline only when another reasoning token arrives", () =>
    Effect.gen(function* () {
      const source = Stream.concat(
        Stream.concat(
          Stream.make(start(), delta("first")),
          Stream.fromEffect(Effect.sleep("40 seconds").pipe(Effect.as(delta("second")))),
        ),
        Stream.never,
      )
      const fiber = yield* ReasoningWatchdog.guard(source).pipe(
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* adjust("40 seconds")
      yield* pending(fiber)
      yield* adjust("40 seconds")
      yield* pending(fiber)
      yield* adjust("20 seconds")

      const error = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
    }),
  )

  it.effect("resets the deadline when a visible token arrives", () =>
    Effect.gen(function* () {
      const source = Stream.concat(
        Stream.concat(
          Stream.make(start(), delta("thinking")),
          Stream.fromEffect(Effect.sleep("40 seconds").pipe(Effect.as(text("answer")))),
        ),
        Stream.never,
      )
      const fiber = yield* ReasoningWatchdog.guard(source).pipe(
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* adjust("40 seconds")
      yield* pending(fiber)
      yield* adjust("40 seconds")
      yield* pending(fiber)
      yield* adjust("20 seconds")

      const error = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
    }),
  )

  it.effect("does not reset the deadline for control events", () =>
    Effect.gen(function* () {
      const source = Stream.concat(
        Stream.concat(
          Stream.make(start(), delta("thinking")),
          Stream.fromEffect(Effect.sleep("40 seconds").pipe(Effect.as(step()))),
        ),
        Stream.never,
      )
      const fiber = yield* ReasoningWatchdog.guard(source).pipe(
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* adjust("40 seconds")
      yield* pending(fiber)
      yield* adjust("20 seconds")

      const error = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
    }),
  )

  it.effect("stays armed after the matching reasoning trace closes", () =>
    Effect.gen(function* () {
      const fiber = yield* ReasoningWatchdog.guard(hanging(start(), delta("done"), end())).pipe(
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* adjust(TIMEOUT)
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
    }),
  )

  it.effect("fails when the provider holds the stream open with zero events", () =>
    Effect.gen(function* () {
      const fiber = yield* ReasoningWatchdog.guard(hanging()).pipe(
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* adjust(TIMEOUT)
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
      expect(error.message).toContain("reasoning stream timed out")
    }),
  )

  it.effect("fails when text-only generation stalls", () =>
    Effect.gen(function* () {
      const fiber = yield* ReasoningWatchdog.guard(hanging(text("partial answer"))).pipe(
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* adjust(TIMEOUT)
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
    }),
  )

  it.effect("does not reset the deadline for empty reasoning deltas", () =>
    Effect.gen(function* () {
      const fiber = yield* ReasoningWatchdog.guard(hanging(start(), delta(""))).pipe(
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* adjust(TIMEOUT)
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
    }),
  )

  it.effect("recognizes summarized reasoning options and bypasses the guard", () =>
    Effect.gen(function* () {
      expect(ReasoningWatchdog.hasSummary({ reasoningSummary: "auto" })).toBe(true)
      expect(ReasoningWatchdog.hasSummary({ reasoningConfig: { display: "summarized" } })).toBe(true)
      expect(ReasoningWatchdog.hasSummary({ modelParams: { thinking: { display: "summarized" } } })).toBe(true)
      expect(ReasoningWatchdog.hasSummary({ thinking: { type: "adaptive" } }, { api: { id: "claude-opus-4-6" } })).toBe(
        true,
      )
      expect(ReasoningWatchdog.hasSummary({ thinking: { type: "enabled" } })).toBe(false)

      const fiber = yield* ReasoningWatchdog.guard(hanging(start(), delta("summary")), {
        summarized: true,
      }).pipe(Stream.runDrain, Effect.forkScoped({ startImmediately: true }))

      yield* adjust("2 minutes")
      yield* pending(fiber)
      yield* Fiber.interrupt(fiber)
    }),
  )
})
