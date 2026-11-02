import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, Stream } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { RepetitionGuard } from "../../src/session/llm/repetition-guard"
import { SessionRetry } from "../../src/session/retry"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { it, testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"

const providerID = ProviderV2.ID.make("test")

// The issue #94 repro shape: one sentence regenerated verbatim, never
// reaching a tool call. 64 characters, so both guard rules apply to it.
const ISSUE_LINE = "The file I need is packages/core/src/fs-util.ts. Let me read it:"
// 28 characters: long enough for the line rule, too short for the fragment rule.
const SHORT_LINE = "Let me read that file again:"
// 67 characters with no newline: only the fragment rule can catch this loop.
const LOOP_FRAGMENT = "All work and no play makes Jack a dull boy, forever and ever done. "
// 53-character data row: repeated fixture rows inside a fenced block are the
// legitimate repetition the guard must leave alone.
const FIXTURE_ROW = "2024-01-15,completed,pending-review,needs-followup,ok"

const defaults = () => ({ thresholds: RepetitionGuard.resolveThresholds({}) })

describe("RepetitionGuard.resolveThresholds", () => {
  test("defaults to the issue #94 limits", () => {
    expect(RepetitionGuard.resolveThresholds({})).toEqual({
      lineRepeats: RepetitionGuard.DEFAULT_LINE_REPEATS,
      unitRepeats: RepetitionGuard.DEFAULT_UNIT_REPEATS,
    })
    expect(RepetitionGuard.DEFAULT_LINE_REPEATS).toBe(5)
    expect(RepetitionGuard.DEFAULT_UNIT_REPEATS).toBe(3)
    expect(RepetitionGuard.MIN_UNIT_CHARS).toBeGreaterThanOrEqual(50)
  })

  test("overrides win and 0 is preserved for disabling", () => {
    expect(RepetitionGuard.resolveThresholds({ lineRepeats: 2 })).toEqual({ lineRepeats: 2, unitRepeats: 3 })
    expect(RepetitionGuard.resolveThresholds({ lineRepeats: 0, unitRepeats: 0 })).toEqual({
      lineRepeats: 0,
      unitRepeats: 0,
    })
  })
})

describe("RepetitionGuard.guard", () => {
  const text = (t: string, id = "text-1") => LLMEvent.textDelta({ id, text: t })

  it.effect("passes normal prose with paragraphs and a repeated-row code block untouched", () =>
    Effect.gen(function* () {
      const input = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        text("Here is the fixture file you asked for.\n\n"),
        text("It has one row per day:\n\n"),
        text("```\n"),
        ...Array.from({ length: 8 }, () => text(`${FIXTURE_ROW}\n`)),
        text("```\n\n"),
        text("Eight identical rows, but that is data, not a loop.\n"),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      const collected = yield* RepetitionGuard.guard(Stream.fromIterable(input), defaults()).pipe(Stream.runCollect)
      expect(Array.from(collected)).toStrictEqual(input)
    }),
  )

  it.effect("aborts the issue #94 loop mid-generation with a clear error", () =>
    Effect.gen(function* () {
      // 100 repetitions of the repro sentence: the guard must fail the
      // stream long before the model finishes burning tokens.
      const deltas = Array.from({ length: 100 }, () => text(`${ISSUE_LINE}\n`))
      const source = Stream.concat(
        Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" })),
        Stream.fromIterable(deltas),
      )
      const emitted = yield* Ref.make(0)
      const error = yield* RepetitionGuard.guard(source, defaults()).pipe(
        Stream.tap(() => Ref.update(emitted, (n) => n + 1)),
        Stream.runDrain,
        Effect.flip,
      )
      expect(error).toBeInstanceOf(RepetitionGuard.RepetitionDetectedError)
      if (!(error instanceof RepetitionGuard.RepetitionDetectedError)) return
      expect(error.message).toContain(RepetitionGuard.REPETITION_MESSAGE)
      expect(error.detail).toContain("fragment")
      expect(error.detail).toContain("3 times")
      // Detected mid-stream: the overwhelming majority of the loop never
      // streamed past the guard.
      expect(yield* Ref.get(emitted)).toBeLessThan(10)
    }),
  )

  it.effect("aborts a loop of identical short lines at the line threshold", () =>
    Effect.gen(function* () {
      const deltas = Array.from({ length: 20 }, () => text(`${SHORT_LINE}\n`))
      const source = Stream.concat(
        Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" })),
        Stream.fromIterable(deltas),
      )
      const error = yield* RepetitionGuard.guard(source, defaults()).pipe(Stream.runDrain, Effect.flip)
      expect(error).toBeInstanceOf(RepetitionGuard.RepetitionDetectedError)
      if (!(error instanceof RepetitionGuard.RepetitionDetectedError)) return
      expect(error.detail).toContain(`the same line ("${SHORT_LINE}")`)
      expect(error.detail).toContain("5 times")
    }),
  )

  it.effect("aborts a loop with no newlines at all", () =>
    Effect.gen(function* () {
      const deltas = Array.from({ length: 10 }, () => text(LOOP_FRAGMENT))
      const source = Stream.concat(
        Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" })),
        Stream.fromIterable(deltas),
      )
      const error = yield* RepetitionGuard.guard(source, defaults()).pipe(Stream.runDrain, Effect.flip)
      expect(error).toBeInstanceOf(RepetitionGuard.RepetitionDetectedError)
    }),
  )

  it.effect("does not trip when a fragment repeats only twice", () =>
    Effect.gen(function* () {
      const input = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        text(LOOP_FRAGMENT),
        text(LOOP_FRAGMENT),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      const collected = yield* RepetitionGuard.guard(Stream.fromIterable(input), defaults()).pipe(Stream.runCollect)
      expect(Array.from(collected)).toStrictEqual(input)
    }),
  )

  it.effect("counts repetitions separated by blank lines", () =>
    Effect.gen(function* () {
      const deltas = Array.from({ length: 8 }, () => text(`${SHORT_LINE}\n\n`))
      const source = Stream.concat(
        Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" })),
        Stream.fromIterable(deltas),
      )
      const error = yield* RepetitionGuard.guard(source, defaults()).pipe(Stream.runDrain, Effect.flip)
      expect(error).toBeInstanceOf(RepetitionGuard.RepetitionDetectedError)
    }),
  )

  it.effect("leaves repeated content inside fenced code blocks to the generation cap", () =>
    Effect.gen(function* () {
      // Both rules would trip on this shape unfenced: identical 54-character
      // units, a hundred times. Inside a fence it is fixture data, so the
      // guard must let it through.
      const rows = Array.from({ length: 100 }, () => text(`${FIXTURE_ROW}\n`))
      const source = Stream.concat(
        Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" }), text("```\n")),
        Stream.concat(Stream.fromIterable(rows), Stream.make(text("```\n"), LLMEvent.finish({ reason: "stop" }))),
      )
      const collected = yield* RepetitionGuard.guard(source, defaults()).pipe(Stream.runCollect)
      expect(collected.length).toBe(105)
    }),
  )

  it.effect("never feeds fenced repetition to fragment detection after the fence closes", () =>
    Effect.gen(function* () {
      // Fenced rows followed by unfenced prose. The prose alone is well under
      // every threshold, but if the fenced rows were still resident in the
      // fragment window after the close, a scan could inspect them against
      // the new text. The fence boundary must start a fresh window.
      const rows = Array.from({ length: 20 }, () => text(`${FIXTURE_ROW}\n`))
      const prose = Array.from({ length: 6 }, (_, i) =>
        text(`Paragraph ${i} of the summary follows here, with varied wording.\n\n`),
      )
      const input = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        text("```\n"),
        ...rows,
        text("```\n"),
        ...prose,
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      const collected = yield* RepetitionGuard.guard(Stream.fromIterable(input), defaults()).pipe(Stream.runCollect)
      expect(Array.from(collected)).toStrictEqual(input)
    }),
  )

  it.effect("repeated verbatim fenced blocks stay exempt", () =>
    Effect.gen(function* () {
      // The same whole code block eight times in a row. Repetition that
      // spans fence boundaries is treated as legitimate output by design:
      // the exemption is structural (fenced bytes never enter the fragment
      // window), so the generation-length cap bounds this shape instead.
      const block = text("```\nAll quiet on the western front, nothing changed here at all.\n```\n")
      const source = Stream.concat(
        Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" })),
        Stream.concat(
          Stream.fromIterable(Array.from({ length: 8 }, () => block)),
          Stream.make(LLMEvent.textEnd({ id: "text-1" }), LLMEvent.finish({ reason: "stop" })),
        ),
      )
      const collected = yield* RepetitionGuard.guard(source, defaults()).pipe(Stream.runCollect)
      expect(collected.length).toBe(12)
    }),
  )

  it.effect("a real repetition after a closed fence still trips", () =>
    Effect.gen(function* () {
      // The fence reset must not over-suppress: once the block has closed,
      // a genuinely repetitive unfenced tail still aborts the stream.
      const rows = Array.from({ length: 12 }, () => text(`${FIXTURE_ROW}\n`))
      const loop = Array.from({ length: 10 }, () => text(`${ISSUE_LINE}\n`))
      const source = Stream.concat(
        Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" }), text("```\n")),
        Stream.concat(Stream.fromIterable(rows), Stream.concat(Stream.make(text("```\n")), Stream.fromIterable(loop))),
      )
      const error = yield* RepetitionGuard.guard(source, defaults()).pipe(Stream.runDrain, Effect.flip)
      expect(error).toBeInstanceOf(RepetitionGuard.RepetitionDetectedError)
    }),
  )

  it.effect("passes a long varied stream through window eviction", () =>
    Effect.gen(function* () {
      // 400 distinct 84-character lines: 33.6k characters, several times
      // the 8k fragment tail, forcing repeated tail trims and scans.
      // Varied content must pass through untouched.
      const lines = Array.from({ length: 400 }, (_, i) =>
        text(`Entry ${String(i).padStart(4, "0")}: the quick brown fox jumps over the lazy dog again ${i}\n`),
      )
      const input = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        ...lines,
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      const collected = yield* RepetitionGuard.guard(Stream.fromIterable(input), defaults()).pipe(Stream.runCollect)
      expect(Array.from(collected)).toStrictEqual(input)
    }),
  )

  it.effect("does not trip on a wall of separator characters", () =>
    Effect.gen(function* () {
      // Sixty unfenced 40-dash rows: periodic text, but not a loop worth
      // aborting — the line rule ignores lines without an alphanumeric, and
      // the fragment rule requires one in the confirmed unit.
      const rows = Array.from({ length: 60 }, () => text(`${"-".repeat(40)}\n`))
      const input = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        ...rows,
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      const collected = yield* RepetitionGuard.guard(Stream.fromIterable(input), defaults()).pipe(Stream.runCollect)
      expect(Array.from(collected)).toStrictEqual(input)
    }),
  )

  it.effect("detects a long verbatim unit loop", () =>
    Effect.gen(function* () {
      // A ~580-character unit with no newlines, repeated: two complete
      // copies plus 50 characters fit the 8 KB tail with room to spare.
      const unit = `${"This block of fixed summary wording repeats verbatim each time. ".repeat(9)}#`
      const source = Stream.concat(
        Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" })),
        Stream.fromIterable(Array.from({ length: 6 }, () => text(`${unit}\n`))),
      )
      const error = yield* RepetitionGuard.guard(source, defaults()).pipe(Stream.runDrain, Effect.flip)
      expect(error).toBeInstanceOf(RepetitionGuard.RepetitionDetectedError)
    }),
  )

  it.effect("detects a multi-line unit loop near the tail ceiling", () =>
    Effect.gen(function* () {
      // A ~4000-character unit of distinct lines (so the line rule stays
      // silent), repeated verbatim. Two complete copies plus 50 characters
      // of the third is 8042 characters, just inside the 8192-character
      // tail, so the fragment rule must confirm it.
      const unit = Array.from(
        { length: 74 },
        (_, i) => `Row ${String(i).padStart(4, "0")}: fixed narrative sentence that never varies.\n`,
      ).join("")
      const source = Stream.concat(
        Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" })),
        Stream.fromIterable(Array.from({ length: 3 }, () => text(unit))),
      )
      const error = yield* RepetitionGuard.guard(source, defaults()).pipe(Stream.runDrain, Effect.flip)
      expect(error).toBeInstanceOf(RepetitionGuard.RepetitionDetectedError)
    }),
  )

  it.effect("detects a unit loop whose unit contains its own ending", () =>
    Effect.gen(function* () {
      // A 300-character unit whose trailing marker also appears three
      // times inside it. The guard must confirm the loop at the true
      // 300-character period, not report a shorter coincidental one (or
      // miss the loop behind a nearer repetition).
      const marker = "Zq3-UnitProbe-77"
      expect(marker.length).toBe(16)
      const fill = (seed: string, n: number) => seed.repeat(Math.ceil(n / seed.length)).slice(0, n)
      const unit = [
        marker,
        fill("alpha filler copy one ", 64),
        marker,
        fill("bravo filler copy two ", 64),
        marker,
        fill("charlie filler copy three ", 108),
        marker,
      ].join("")
      expect(unit.length).toBe(300)
      const source = Stream.concat(
        Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" })),
        Stream.fromIterable(Array.from({ length: 3 }, () => text(unit))),
      )
      const error = yield* RepetitionGuard.guard(source, defaults()).pipe(Stream.runDrain, Effect.flip)
      expect(error).toBeInstanceOf(RepetitionGuard.RepetitionDetectedError)
      expect(error.detail).toContain("300-character fragment")
    }),
  )

  it.effect("leaves unit loops beyond the tail ceiling to the generation cap", () =>
    Effect.gen(function* () {
      // A ~4400-character unit: two complete copies plus 50 characters of
      // the third is 8906 characters, past the 8192-character tail, so the
      // fragment rule cannot confirm it and the generation cap remains the
      // backstop. Distinct lines keep the line rule below its threshold.
      const unit = Array.from(
        { length: 82 },
        (_, i) => `Row ${String(i).padStart(4, "0")}: fixed narrative sentence that never varies.\n`,
      ).join("")
      const source = Stream.concat(
        Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" })),
        Stream.concat(
          Stream.fromIterable(Array.from({ length: 3 }, () => text(unit))),
          Stream.make(LLMEvent.textEnd({ id: "text-1" }), LLMEvent.finish({ reason: "stop" })),
        ),
      )
      const collected = yield* RepetitionGuard.guard(source, defaults()).pipe(Stream.runCollect)
      expect(collected.length).toBe(7)
    }),
  )

  it.effect("does not feed an unclosed fence opener to fragment detection", () =>
    Effect.gen(function* () {
      // A fence line whose newline never arrives. The opener must be
      // recognized from its opening characters alone and nothing after it
      // may reach the fragment tail — the 600-character run would otherwise
      // confirm as a repeated unit and abort a stream that is still inside
      // an open code block.
      const source = Stream.concat(
        Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" }), text("```")),
        Stream.concat(
          Stream.fromIterable(Array.from({ length: 6 }, () => text("A".repeat(100)))),
          Stream.make(LLMEvent.textEnd({ id: "text-1" }), LLMEvent.finish({ reason: "stop" })),
        ),
      )
      const collected = yield* RepetitionGuard.guard(source, defaults()).pipe(Stream.runCollect)
      expect(collected.length).toBe(11)
    }),
  )

  it.effect("recognizes a fence opener split across deltas", () =>
    Effect.gen(function* () {
      // The marker arrives as `` then `js, then the newline: the held-back
      // prefix must resolve to a fence (with its info string) and suppress
      // the block, exactly as an unsplit opener would.
      const rows = Array.from({ length: 20 }, () => text(`${FIXTURE_ROW}\n`))
      const input = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        text("``"),
        text("`js\n"),
        ...rows,
        text("```\n"),
        text("After the block, ordinary prose continues with varied wording.\n"),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      const collected = yield* RepetitionGuard.guard(Stream.fromIterable(input), defaults()).pipe(Stream.runCollect)
      expect(Array.from(collected)).toStrictEqual(input)
    }),
  )

  it.effect("does not conflate lines that share a long opening", () =>
    Effect.gen(function* () {
      // Eight lines with the same 200-character opening, the same length,
      // but different tails. The stored key is only a prefix, so identity
      // must come from the full line: these are not repetitions.
      const opening =
        "The quick brown fox jumps over a lazy dog while packed wizards revolve quietly above jaded oxen, humming sparks of vexed craft dimming under pale moonlight that graced every numbered "
      const tails = ["alpha", "bravo", "china", "delta", "echo-", "foxtro", "golf--", "hotel-"]
      const input = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        ...tails.map((tail) => text(`${opening}${tail}\n`)),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      const collected = yield* RepetitionGuard.guard(Stream.fromIterable(input), defaults()).pipe(Stream.runCollect)
      expect(Array.from(collected)).toStrictEqual(input)
    }),
  )

  it.effect("resets between text parts", () =>
    Effect.gen(function* () {
      // 4 + 4 identical lines across two text parts: neither part reaches the
      // threshold, and state must not leak across the part boundary.
      const part = Array.from({ length: 4 }, () => text(`${SHORT_LINE}\n`))
      const input = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        ...part,
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.textStart({ id: "text-2" }),
        ...part,
        LLMEvent.textEnd({ id: "text-2" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      const collected = yield* RepetitionGuard.guard(Stream.fromIterable(input), defaults()).pipe(Stream.runCollect)
      expect(Array.from(collected)).toStrictEqual(input)
    }),
  )

  it.effect("aborts repeated reasoning deltas", () =>
    Effect.gen(function* () {
      const input = [
        LLMEvent.reasoningStart({ id: "r1" }),
        ...Array.from({ length: 20 }, () => LLMEvent.reasoningDelta({ id: "r1", text: `${SHORT_LINE}\n` })),
        LLMEvent.reasoningEnd({ id: "r1" }),
      ]
      const error = yield* RepetitionGuard.guard(Stream.fromIterable(input), defaults()).pipe(
        Stream.runDrain,
        Effect.flip,
      )
      expect(error).toBeInstanceOf(RepetitionGuard.RepetitionDetectedError)
    }),
  )

  it.effect("isolates interleaved reasoning IDs from each other and text", () =>
    Effect.gen(function* () {
      const input = [
        LLMEvent.reasoningStart({ id: "a" }),
        LLMEvent.reasoningStart({ id: "b" }),
        LLMEvent.textStart({ id: "t" }),
        ...Array.from({ length: 4 }, () => [
          LLMEvent.reasoningDelta({ id: "a", text: `${SHORT_LINE}\n` }),
          LLMEvent.reasoningDelta({ id: "b", text: `${SHORT_LINE}\n` }),
          LLMEvent.textDelta({ id: "t", text: `${SHORT_LINE}\n` }),
        ]).flat(),
        LLMEvent.reasoningEnd({ id: "a" }),
        LLMEvent.reasoningEnd({ id: "b" }),
        LLMEvent.textEnd({ id: "t" }),
      ]
      const collected = yield* RepetitionGuard.guard(Stream.fromIterable(input), defaults()).pipe(Stream.runCollect)
      expect(Array.from(collected)).toStrictEqual(input)
      const interrupted = [...input.slice(0, -3), LLMEvent.reasoningDelta({ id: "a", text: `${SHORT_LINE}\n` })]
      const error = yield* RepetitionGuard.guard(Stream.fromIterable(interrupted), defaults()).pipe(Stream.runDrain, Effect.flip)
      expect(error).toBeInstanceOf(RepetitionGuard.RepetitionDetectedError)
    }),
  )

  it.effect("flushes a final reasoning line and resets an ended ID", () =>
    Effect.gen(function* () {
      const delta = (text: string) => LLMEvent.reasoningDelta({ id: "a", text })
      const reset = [
        LLMEvent.reasoningStart({ id: "a" }),
        delta(`${SHORT_LINE}\n`.repeat(4)),
        LLMEvent.reasoningEnd({ id: "a" }),
        LLMEvent.reasoningStart({ id: "a" }),
        delta(`${SHORT_LINE}\n`.repeat(4)),
        LLMEvent.reasoningEnd({ id: "a" }),
      ]
      const collected = yield* RepetitionGuard.guard(Stream.fromIterable(reset), defaults()).pipe(Stream.runCollect)
      expect(Array.from(collected)).toStrictEqual(reset)
      const input = [
        LLMEvent.reasoningStart({ id: "a" }),
        delta(`${SHORT_LINE}\n`.repeat(4) + SHORT_LINE),
        LLMEvent.reasoningEnd({ id: "a" }),
      ]
      const error = yield* RepetitionGuard.guard(Stream.fromIterable(input), defaults()).pipe(
        Stream.runDrain,
        Effect.flip,
      )
      expect(error).toBeInstanceOf(RepetitionGuard.RepetitionDetectedError)
    }),
  )

  it.effect("leaves repeated fenced reasoning intact", () =>
    Effect.gen(function* () {
      const input = [
        LLMEvent.reasoningStart({ id: "a" }),
        LLMEvent.reasoningDelta({ id: "a", text: "\`\`" }),
        LLMEvent.reasoningDelta({ id: "a", text: "\`\n" + `${FIXTURE_ROW}\n`.repeat(20) + "\`\`\`\n" }),
        LLMEvent.reasoningEnd({ id: "a" }),
      ]
      const collected = yield* RepetitionGuard.guard(Stream.fromIterable(input), defaults()).pipe(Stream.runCollect)
      expect(Array.from(collected)).toStrictEqual(input)
    }),
  )

  it.effect("ignores tool-input deltas", () =>
    Effect.gen(function* () {
      const input = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
        ...Array.from({ length: 10 }, () =>
          LLMEvent.toolInputDelta({ id: "call-1", name: "lookup", text: ISSUE_LINE }),
        ),
        LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      const collected = yield* RepetitionGuard.guard(Stream.fromIterable(input), defaults()).pipe(Stream.runCollect)
      expect(Array.from(collected)).toStrictEqual(input)
    }),
  )

  it.effect("never trips when both thresholds are disabled", () =>
    Effect.gen(function* () {
      const deltas = Array.from({ length: 100 }, () => text(`${ISSUE_LINE}\n`))
      const source = Stream.concat(
        Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" })),
        Stream.fromIterable(deltas),
      )
      const collected = yield* RepetitionGuard.guard(source, {
        thresholds: { lineRepeats: 0, unitRepeats: 0 },
      }).pipe(Stream.runCollect)
      expect(collected.length).toBe(102)
    }),
  )

  it.effect("honors tightened thresholds", () =>
    Effect.gen(function* () {
      const source = Stream.concat(
        Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" })),
        Stream.make(text(`${SHORT_LINE}\n`), text(`${SHORT_LINE}\n`)),
      )
      const error = yield* RepetitionGuard.guard(source, {
        thresholds: { lineRepeats: 2, unitRepeats: 0 },
      }).pipe(Stream.runDrain, Effect.flip)
      expect(error).toBeInstanceOf(RepetitionGuard.RepetitionDetectedError)
    }),
  )
})

describe("repetition-guard retry behavior", () => {
  test("tripped guards surface as a clear non-retryable error, not a hidden failure", () => {
    const parsed = MessageV2.fromError(
      new RepetitionGuard.RepetitionDetectedError("the model streamed the same line 5 times in a row"),
      { providerID },
    )
    expect(parsed.name).toBe("UnknownError")
    const message =
      typeof parsed.data === "object" && parsed.data !== null && "message" in parsed.data
        ? parsed.data.message
        : undefined
    expect(message).toContain(RepetitionGuard.REPETITION_MESSAGE)
    expect(SessionRetry.retryable(parsed, "test")).toBeUndefined()
  })

  test("a loop whose text itself looks retryable is still never retried", () => {
    // The guard quotes the repeated line in its message; if that line
    // contains a retryable-looking phrase, the exclusion must still win.
    const parsed = MessageV2.fromError(
      new RepetitionGuard.RepetitionDetectedError(
        `the model streamed the same line ("Error: connection reset by peer while streaming") 5 times in a row`,
      ),
      { providerID },
    )
    expect(SessionRetry.retryable(parsed, "test")).toBeUndefined()
  })

  test("genuinely retryable errors still retry", () => {
    const parsed = MessageV2.fromError(new Error("Rate limit exceeded, please try again later"), { providerID })
    expect(SessionRetry.retryable(parsed, "test")).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Processor regression coverage: a tripped guard must end the turn with a
// clean "stop" (visible error, idle status) and must not re-subscribe/retry
// the looping stream.
// ---------------------------------------------------------------------------

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
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
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function agent(): Agent.Info {
  return {
    name: "work",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "work",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "work",
    agent: "work",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

function processorWithLLM(stream: () => Stream.Stream<LLMEvent, unknown>) {
  return testEffect(
    LayerNode.compile(root, [
      ...replacements,
      [
        LLM.node,
        Layer.succeed(
          LLM.Service,
          LLM.Service.of({
            stream,
          }),
        ),
      ],
    ]),
  )
}

// Counts subscriptions: every retry re-subscribes, so a tripped guard must
// leave this at exactly one (no retry loop over the runaway stream).
const subscriptions = { count: 0 }

// The stubbed LLM service returns the guarded stream itself, so the
// processor sees exactly what the real harness would produce.
const loopingStream = () =>
  RepetitionGuard.guard(
    Stream.concat(
      Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" })),
      Stream.fromIterable(
        Array.from({ length: 500 }, () => LLMEvent.textDelta({ id: "text-1", text: `${ISSUE_LINE}\n` })),
      ),
    ),
    defaults(),
  )

const itLooping = processorWithLLM(() => {
  subscriptions.count += 1
  return loopingStream()
})

itLooping.live("session.processor aborts a detected repetition loop without retrying", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        subscriptions.count = 0
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "runaway")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "runaway" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(subscriptions.count).toBe(1)
        expect(handle.message.error).toMatchObject({
          name: "UnknownError",
          data: { message: expect.stringContaining(RepetitionGuard.REPETITION_MESSAGE) },
        })
      }),
    { config: cfg },
  ),
)

const itNormal = processorWithLLM(() =>
  Stream.make(
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text-1" }),
    LLMEvent.textDelta({ id: "text-1", text: "hello" }),
    LLMEvent.textEnd({ id: "text-1" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ),
)

itNormal.live("session.processor leaves normal generation unaffected", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })

        expect(value).toBe("continue")
        expect(handle.message.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)
