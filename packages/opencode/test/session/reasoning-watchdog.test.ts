import { describe, expect } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { adjust } from "effect/testing/TestClock"
import { LLMEvent } from "@opencode-ai/llm"
import { ProviderError } from "@/provider/error"
import { ReasoningWatchdog } from "@/session/llm/reasoning-watchdog"
import { it } from "../lib/effect"
import { streamText, tool } from "ai"
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test"
import z from "zod"
import { LLMAISDK } from "@/session/llm/ai-sdk"

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

  it.effect("does not time out while a local tool executes, then rearms after its result", () =>
    Effect.gen(function* () {
      const source = Stream.concat(
        Stream.concat(
          Stream.make(LLMEvent.toolCall({ id: "call-1", name: "bash", input: {} })),
          Stream.fromEffect(
            Effect.sleep("2 minutes").pipe(
              Effect.as(LLMEvent.toolError({ id: "call-1", name: "bash", message: "finished with error" })),
            ),
          ),
        ),
        Stream.never,
      )
      const fiber = yield* ReasoningWatchdog.guard(source, { executableTools: new Set(["bash"]) }).pipe(
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* adjust("90 seconds")
      yield* pending(fiber)
      yield* adjust("30 seconds")
      yield* pending(fiber)
      yield* adjust("59 seconds")
      yield* pending(fiber)
      yield* adjust("1 second")
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
    }),
  )

  it.effect("waits for every overlapping local tool and ignores unmatched settlements", () =>
    Effect.gen(function* () {
      const source = Stream.concat(
        Stream.make(
          LLMEvent.toolCall({ id: "a", name: "bash", input: {} }),
          LLMEvent.toolCall({ id: "b", name: "bash", input: {} }),
        ),
        Stream.concat(
          Stream.fromEffect(
            Effect.sleep("90 seconds").pipe(Effect.as(LLMEvent.toolError({ id: "a", name: "bash", message: "done" }))),
          ),
          Stream.concat(
            Stream.make(LLMEvent.toolError({ id: "unknown", name: "bash", message: "unmatched" })),
            Stream.concat(
              Stream.fromEffect(
                Effect.sleep("90 seconds").pipe(
                  Effect.as(LLMEvent.toolResult({ id: "b", name: "bash", result: { type: "text", value: "done" } })),
                ),
              ),
              Stream.never,
            ),
          ),
        ),
      )
      const fiber = yield* ReasoningWatchdog.guard(source, { executableTools: new Set(["bash"]) }).pipe(
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* adjust("90 seconds")
      yield* pending(fiber)
      yield* adjust("90 seconds")
      yield* pending(fiber)
      yield* adjust("59 seconds")
      yield* pending(fiber)
      yield* adjust("1 second")
      expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toBeInstanceOf(ProviderError.ResponseStreamError)
    }),
  )

  for (const providerExecuted of [true, false]) {
    it.effect(`does not suspend for ${providerExecuted ? "provider-executed" : "unavailable"} tool calls`, () =>
      Effect.gen(function* () {
        const source = hanging(
          LLMEvent.toolCall({ id: "a", name: providerExecuted ? "bash" : "remote", input: {}, providerExecuted }),
        )
        const fiber = yield* ReasoningWatchdog.guard(source, { executableTools: new Set(["bash"]) }).pipe(
          Stream.runDrain,
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* adjust(TIMEOUT)
        expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toBeInstanceOf(ProviderError.ResponseStreamError)
      }),
    )
  }

  it.effect("keeps the token deadline while tool arguments are still being generated", () =>
    Effect.gen(function* () {
      const source = hanging(
        LLMEvent.toolInputStart({ id: "a", name: "bash" }),
        LLMEvent.toolInputDelta({ id: "a", name: "bash", text: "{" }),
      )
      const fiber = yield* ReasoningWatchdog.guard(source, { executableTools: new Set(["bash"]) }).pipe(
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* adjust(TIMEOUT)
      expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toBeInstanceOf(ProviderError.ResponseStreamError)
    }),
  )

  it.effect("keeps explicit cancellation effective during a tool", () =>
    Effect.gen(function* () {
      const fiber = yield* ReasoningWatchdog.guard(hanging(LLMEvent.toolCall({ id: "a", name: "bash", input: {} })), {
        executableTools: new Set(["bash"]),
      }).pipe(Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
      yield* adjust("2 minutes")
      yield* pending(fiber)
      yield* Fiber.interrupt(fiber)
      expect(fiber.pollUnsafe()?._tag).toBe("Failure")
    }),
  )

  it.live("allows an actual AI SDK execute callback to outlast the token deadline", () =>
    Effect.gen(function* () {
      let executions = 0
      const model = new MockLanguageModelV3({
        doStream: {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "actual-call", toolName: "slow", input: "{}" },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ]),
        },
      })
      const result = streamText({
        model,
        prompt: "Use slow",
        tools: {
          slow: tool({
            inputSchema: z.object({}),
            execute: async () => {
              executions++
              await new Promise((resolve) => setTimeout(resolve, 1000))
              return "completed"
            },
          }),
        },
      })
      const state = LLMAISDK.adapterState()
      const events = yield* ReasoningWatchdog.guard(
        Stream.fromAsyncIterable(result.fullStream, (error) => error).pipe(
          Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
          Stream.flatMap((events) => Stream.fromIterable(events)),
        ),
        { timeout: "250 millis", executableTools: new Set(["slow"]) },
      ).pipe(Stream.runCollect)
      expect(executions).toBe(1)
      expect(model.doStreamCalls).toHaveLength(1)
      expect(events.filter((event) => event.type === "tool-call")).toHaveLength(1)
      expect(events.filter((event) => event.type === "tool-result")).toHaveLength(1)
      expect(events.some((event) => event.type === "tool-error")).toBe(false)
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
