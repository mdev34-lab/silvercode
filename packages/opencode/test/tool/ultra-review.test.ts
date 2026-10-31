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
