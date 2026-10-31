import { MessageID, SessionID, PartID } from "../../src/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { expect, test } from "bun:test"
import { reviewDepthLimit } from "../../src/tool/review-depth"
import { reviewOrigin } from "../../src/tool/review-origin"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

function message(id: string, text: string, sessionID = "root") {
  return {
    info: { id, sessionID, role: "user", time: { created: Number(id) } },
    parts: [{ type: "text", text }],
  } as SessionV1.WithParts
}

test("depth matrix: dispatch and availability share floor, never ceiling", () => {
  for (const effort of ["fast", "medium", "thorough", "ultra"] as const) {
    for (const configured of [undefined, 1, 2, 4]) {
      for (const caller of ["review", "code", undefined]) {
        for (const target of ["review", "general"]) {
          const expected =
            effort === "ultra" && caller === "review" && target === "review"
              ? Math.max(configured ?? 1, 2)
              : (configured ?? 1)
          const limit = reviewDepthLimit(configured, effort, caller, target)
          expect(limit).toBe(expected)
          for (const depth of [0, 1, 2, 3, 4]) {
            expect(depth < limit).toBe(depth < expected)
            expect(depth >= limit).toBe(!(depth < expected))
          }
        }
      }
    }
  }
})

test("fresh origin includes sole root request verbatim with provenance", () => {
  const text = "Request\n  preserve exact whitespace <xml>"
  const result = reviewOrigin("root", [message("1", text)])
  expect(result).toContain(text)
  expect(result).toContain("Root session root; user message 1; time 1")
  expect(result).toContain("Origin state: complete")
})

test("multi-topic selection ordered by root store, excludes unrelated topics and child records", () => {
  const result = reviewOrigin(
    "root",
    [message("1", "request"), message("2", "PRIVATE"), message("3", "correction"), message("4", "CHILD", "child")],
    ["3", "1", "4"],
  )
  expect(result.indexOf("request")).toBeLessThan(result.indexOf("correction"))
  expect(result).not.toContain("PRIVATE")
  expect(result).not.toContain("CHILD")
  expect(result).toContain("Selected root user message unavailable: 4")
  expect(result).toContain("verified against available origin")
  expect(result).toContain("Do not certify full completion")
})

test("no selection is not an indiscriminate dump or unconditional first-message append", () => {
  const result = reviewOrigin("root", [message("1", "PRIVATE FIRST"), message("2", "NEW TOPIC")])
  expect(result).not.toContain("PRIVATE FIRST")
  expect(result).not.toContain("NEW TOPIC")
  expect(result).toContain("No request of record selected")
  expect(reviewOrigin(undefined, [message("1", "PRIVATE")], ["1"])).not.toContain("PRIVATE")
  expect(reviewOrigin("root", [], ["missing"])).toContain("unavailable: missing")
})

test("compaction and non-text or synthetic parts declare gaps; never substitute summaries", () => {
  const user = message("1", "request")
  user.parts.push({ type: "compaction" } as SessionV1.Part)
  user.parts.push({ type: "text", text: "SUMMARY", synthetic: true } as SessionV1.Part)
  const result = reviewOrigin("root", [user], ["1"])
  expect(result).toContain("Compaction present")
  expect(result).toContain("part 1 not included")
  expect(result).not.toContain("SUMMARY")
  expect(result).toContain("Origin state: incomplete")
})

test("mid-work corrections retain root store order even when IDs are supplied backwards", () => {
  const result = reviewOrigin(
    "root",
    [
      message("1", "REQUEST: change only the cache module\n  Preserve this whitespace."),
      message("2", "CORRECTION: preserve the public API"),
      message("3", "STEERING: also test empty input"),
    ],
    ["3", "2", "1"],
  )
  expect(result).toContain("REQUEST: change only the cache module\n  Preserve this whitespace.")
  expect(result.indexOf("REQUEST:")).toBeLessThan(result.indexOf("CORRECTION:"))
  expect(result.indexOf("CORRECTION:")).toBeLessThan(result.indexOf("STEERING:"))
  for (const id of ["1", "2", "3"]) expect(result).toContain(`Root session root; user message ${id}; time ${id}`)
  expect(result).toContain("Origin state: incomplete")
  expect(result).toContain("Selection completeness is unverified")
})

test("resumed earlier unit spans a finish boundary without attaching an intervening private topic", () => {
  const finish: SessionV1.WithParts = {
    info: {
      id: MessageID.make("msg_finish"),
      sessionID: SessionID.make("ses_root"),
      role: "assistant",
      parentID: MessageID.make("msg_request"),
      time: { created: 2 },
      mode: "work",
      agent: "work",
      cost: 0,
      path: { cwd: "/", root: "/" },
      modelID: ModelV2.ID.make("test"),
      providerID: ProviderV2.ID.make("test"),
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: PartID.make("prt_finish"),
        messageID: MessageID.make("msg_finish"),
        sessionID: SessionID.make("ses_root"),
        type: "tool",
        tool: "finish",
        callID: "finish-call",
        state: {
          status: "completed",
          input: { reason: "success" },
          output: "Delivered earlier unit",
          title: "Finished",
          metadata: {},
          time: { start: 2, end: 3 },
        },
      },
    ],
  }
  const result = reviewOrigin(
    "ses_root",
    [
      message("1", "EARLIER REQUEST: repair cache invalidation", "ses_root"),
      finish,
      message("2", "UNRELATED PRIVATE TOPIC", "ses_root"),
      message("3", "RESUME: keep that repair but preserve the old API", "ses_root"),
    ],
    ["3", "1"],
  )
  expect(result).toContain("EARLIER REQUEST: repair cache invalidation")
  expect(result).toContain("RESUME: keep that repair but preserve the old API")
  expect(result.indexOf("EARLIER REQUEST:")).toBeLessThan(result.indexOf("RESUME:"))
  expect(result).not.toContain("UNRELATED PRIVATE TOPIC")
  expect(result).not.toContain("Delivered earlier unit")
  expect(result).toContain("Origin state: incomplete")
  expect(result).toContain("verified against available origin")
})

test("compaction attaches surviving selected originals only; missing originals and summaries cannot certify completion", () => {
  const compacted = {
    info: { sessionID: "root", role: "user" },
    parts: [{ type: "compaction" }, { type: "text", text: "COMPACTED SUMMARY IS NOT VERBATIM", synthetic: true }],
  } as SessionV1.WithParts
  const result = reviewOrigin(
    "root",
    [compacted, message("2", "SURVIVING CORRECTION: keep API compatibility"), message("3", "UNRELATED SURVIVOR")],
    ["1", "2"],
  )
  expect(result).toContain("SURVIVING CORRECTION: keep API compatibility")
  expect(result).not.toContain("COMPACTED SUMMARY IS NOT VERBATIM")
  expect(result).not.toContain("UNRELATED SURVIVOR")
  expect(result).toContain("Compaction present")
  expect(result).toContain("Selected root user message unavailable: 1")
  expect(result).toContain("Origin state: incomplete")
  expect(result).not.toContain("Origin state: complete")
  expect(result).toContain("Do not certify full completion")
})

test("missing origin always declares gaps, including a missing ID alongside a sole available user message", () => {
  const cases = [
    reviewOrigin(undefined, [message("1", "CHILD OR UNKNOWN")], ["1"]),
    reviewOrigin("root", [], ["missing"]),
    reviewOrigin("root", [message("1", "UNSELECTED")], ["missing"]),
    reviewOrigin("root", [message("1", "UNSELECTED")], ["1", "missing"]),
    reviewOrigin("root", [message("1", "UNSELECTED")], []),
    reviewOrigin("root", []),
  ]
  for (const result of cases) {
    expect(result).toContain("Gap:")
    expect(result).toContain("Origin state: incomplete")
    expect(result).not.toContain("Origin state: complete")
    expect(result).toContain("verified against available origin")
    expect(result).toContain("Do not certify full completion")
  }
  expect(cases[0]).not.toContain("CHILD OR UNKNOWN")
  expect(cases[2]).toContain("Selected root user message unavailable: missing")
  expect(cases[2]).not.toContain("UNSELECTED")
  expect(cases[3]).toContain("Selected root user message unavailable: missing")
})
