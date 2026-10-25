/**
 * Regression tests for the Review subagent's parseable final report envelope.
 *
 * See packages/core/src/review-report.ts for the contract and
 * packages/opencode/src/agent/prompt/review.txt for the emitted shape.
 */

import { describe, expect, test } from "bun:test"
import { ReviewReport } from "@opencode-ai/core/review-report"
import { parseReviewVerdict } from "@opencode-ai/core/review-loop"

const report: ReviewReport.Info = {
  version: 1,
  revision: "a1b2c3d..e4f5a6b",
  assessment: "needs-fixes",
  summary: "The error path swallows failures.",
  findings: [
    {
      severity: "important",
      title: "Swallowed error",
      file: "src/parse.ts",
      line: 42,
      detail: "The catch block drops the cause; propagate it.",
    },
    { severity: "minor", title: "Naming", file: "src/parse.ts", detail: "Prefer `cause` over `e`." },
  ],
}

function envelope(overrides: Record<string, unknown> = {}, body: Record<string, unknown> = report) {
  return `<silvercode-review>\n${JSON.stringify({ ...body, ...overrides }, null, 2)}\n</silvercode-review>`
}

/** The pre-rename literal, exactly as integration fixtures written before the rename build it. */
function legacyEnvelope(overrides: Record<string, unknown> = {}, body: Record<string, unknown> = report) {
  return `<alphacode-review>\n${JSON.stringify({ ...body, ...overrides }, null, 2)}\n</alphacode-review>`
}

const delivered = ReviewReport.extract([`### Issues\n\n- Important: swallowed error\n\n${envelope()}`])

describe("review report extraction", () => {
  test("1. normal review with one report envelope", () => {
    expect(delivered.ok).toBe(true)
    if (!delivered.ok) return
    expect(delivered.report).toEqual(report)
    expect(delivered.analysis).toBe("### Issues\n\n- Important: swallowed error")
  })

  test("1a. legacy pre-rename envelopes from older sessions still deliver", () => {
    const delivery = ReviewReport.extract([`### Issues\n\n- Important: swallowed error\n\n${legacyEnvelope()}`])
    expect(delivery.ok).toBe(true)
    if (!delivery.ok) return
    expect(delivery.report).toEqual(report)
    expect(delivery.analysis).toBe("### Issues\n\n- Important: swallowed error")
  })

  test("1b. canonical emission is unchanged: envelope() still writes the silvercode tag", () => {
    expect(ReviewReport.envelope(report)).toBe(
      `<silvercode-review>\n${JSON.stringify(report, null, 2)}\n</silvercode-review>`,
    )
  })

  test("1c. the missing-envelope failure keeps naming the canonical tag", () => {
    // The other suites assert this exact phrase; compatibility must not reword it.
    const delivery = ReviewReport.extract(["Looks good overall."])
    expect(delivery.ok).toBe(false)
    if (delivery.ok) return
    expect(delivery.failure.reason).toBe("missing")
    expect(delivery.failure.message).toBe("no <silvercode-review> report envelope was found")
  })

  test("1d. a truncated legacy opening tag stays an explicit failure that names the tag", () => {
    const delivery = ReviewReport.extract([`Assessment: Approved\n\n<alphacode-review>\n{"version": 1}\n`])
    expect(delivery.ok).toBe(false)
    if (delivery.ok) return
    expect(delivery.failure.reason).toBe("malformed")
    expect(delivery.failure.message).toContain("<alphacode-review>")
  })

  test("1e. tags never pair across spellings", () => {
    const delivery = ReviewReport.extract([`<silvercode-review>\n{"version": 1}\n</alphacode-review>`])
    expect(delivery.ok).toBe(false)
    if (delivery.ok) return
    expect(delivery.failure.reason).toBe("malformed")
    expect(delivery.failure.message).toContain("<silvercode-review>")
  })

  test("1f. mixed sessions: the last complete envelope wins across tag spellings", () => {
    const legacyThenCanonical = ReviewReport.extract([
      legacyEnvelope({}, { ...report, summary: "legacy copy" }),
      envelope({}, { ...report, summary: "canonical copy" }),
    ])
    expect(legacyThenCanonical.ok).toBe(true)
    if (!legacyThenCanonical.ok) return
    expect(legacyThenCanonical.report.summary).toBe("canonical copy")
    // The superseded envelope of either spelling stays in the human-readable analysis.
    expect(legacyThenCanonical.analysis).toContain("legacy copy")

    const canonicalThenLegacy = ReviewReport.extract([
      envelope({}, { ...report, summary: "canonical copy" }),
      legacyEnvelope({}, { ...report, summary: "legacy copy" }),
    ])
    expect(canonicalThenLegacy.ok).toBe(true)
    if (!canonicalThenLegacy.ok) return
    expect(canonicalThenLegacy.report.summary).toBe("legacy copy")
    expect(canonicalThenLegacy.analysis).toContain("canonical copy")
  })

  test("2. multiple text parts followed by an empty text part still deliver the report", () => {
    const delivery = ReviewReport.extract([`Analysis\n\n${envelope()}`, "", "   "])
    expect(delivery.ok).toBe(true)
    if (!delivery.ok) return
    expect(delivery.report.assessment).toBe("needs-fixes")
    expect(delivery.analysis).toBe("Analysis")
  })

  test("3. report appearing before the final text part is found in the complete output", () => {
    const delivery = ReviewReport.extract(["Preamble.", envelope(), "Closing observations."])
    expect(delivery.ok).toBe(true)
    if (!delivery.ok) return
    expect(delivery.report).toEqual(report)
    expect(delivery.analysis).toBe("Preamble.\n\nClosing observations.")
  })

  test("4. missing report envelope is an explicit delivery failure", () => {
    const delivery = ReviewReport.extract(["Looks good overall.", ""])
    expect(delivery.ok).toBe(false)
    if (delivery.ok) return
    expect(delivery.failure.reason).toBe("missing")
  })

  test("5. malformed report envelope is an explicit delivery failure", () => {
    const notJson = ReviewReport.extract([`<silvercode-review>not json at all</silvercode-review>`])
    expect(notJson.ok).toBe(false)
    if (!notJson.ok) expect(notJson.failure.reason).toBe("malformed")

    const truncated = ReviewReport.extract([`<silvercode-review>\n{"version": 1}\n`])
    expect(truncated.ok).toBe(false)
    if (!truncated.ok) expect(truncated.failure.reason).toBe("malformed")

    const wrongShape = ReviewReport.extract([envelope({}, { version: 1, revision: "x", assessment: "maybe" })])
    expect(wrongShape.ok).toBe(false)
    if (!wrongShape.ok) expect(wrongShape.failure.reason).toBe("malformed")
  })

  test("6. valid review with zero findings", () => {
    const delivery = ReviewReport.extract([
      envelope({}, { ...report, assessment: "approved", summary: "Nothing to report.", findings: [] }),
    ])
    expect(delivery.ok).toBe(true)
    if (!delivery.ok) return
    expect(delivery.report.assessment).toBe("approved")
    expect(delivery.report.findings).toEqual([])
  })

  test("7. long human-readable analysis around the report is preserved", () => {
    const analysis = `${"Detailed analysis.\n\n".repeat(40)}### Assessment\n\nAssessment: Needs fixes`
    const delivery = ReviewReport.extract([`${analysis}\n\n${envelope()}`, "postscript"])
    expect(delivery.ok).toBe(true)
    if (!delivery.ok) return
    expect(delivery.analysis).toContain("Detailed analysis.")
    expect(delivery.analysis).toContain("Assessment: Needs fixes")
    expect(delivery.analysis).toContain("postscript")
    expect(delivery.analysis).not.toContain("<silvercode-review>")
    expect(delivery.report).toEqual(report)
  })

  test("8. unknown or older report schema versions are rejected clearly", () => {
    const newer = ReviewReport.extract([envelope({ version: 2 })])
    expect(newer.ok).toBe(false)
    if (!newer.ok) {
      expect(newer.failure.reason).toBe("schema")
      expect(newer.failure.message).toContain("version 2")
      expect(newer.failure.message).toContain("version 1")
    }

    const legacy = ReviewReport.extract([envelope({ version: 0 })])
    expect(legacy.ok).toBe(false)
    if (!legacy.ok) expect(legacy.failure.reason).toBe("schema")

    const unversioned = ReviewReport.extract([envelope({ version: undefined }, { ...report, version: undefined })])
    expect(unversioned.ok).toBe(false)
    if (!unversioned.ok) expect(unversioned.failure.reason).toBe("malformed")
  })

  test("duplicated envelopes: the last complete one is canonical by protocol", () => {
    const delivery = ReviewReport.extract([envelope({}, { ...report, assessment: "approved" }), envelope()])
    expect(delivery.ok).toBe(true)
    if (!delivery.ok) return
    expect(delivery.report.assessment).toBe("needs-fixes")
    // Superseded envelope copies remain part of the human-readable analysis.
    expect(delivery.analysis).toContain('"approved"')
  })

  test("tolerates extra properties a model adds to the report", () => {
    const delivery = ReviewReport.extract([envelope({ specCompliance: "issues", notes: "extra context" })])
    expect(delivery.ok).toBe(true)
    if (!delivery.ok) return
    expect(delivery.report).toEqual(report)
  })
})

/**
 * Mixed integration simulation: the merged tree ships a core that emits the
 * post-rename tag while integration-only suites written before the rename
 * build the old literal and resolve it through the shared extractor. Both
 * spellings have to parse with one parser — renaming those fixtures instead
 * would hide the compatibility contract this block pins.
 */
describe("rename compatibility with pre-rename integration fixtures", () => {
  // Byte-for-byte the shape `packages/tui/test/cli/tui/review-finish.test.tsx` builds.
  function preRenameEnvelope(body: Record<string, unknown>): string {
    return `<alphacode-review>\n${JSON.stringify(body, null, 2)}\n</alphacode-review>`
  }

  const fixture: ReviewReport.Info = {
    version: 1,
    revision: "uncommitted",
    assessment: "needs-fixes",
    summary: "Two issues need attention before merge.",
    findings: [
      { severity: "minor", title: "Unused variable", file: "src/util.ts", line: 10 },
      { severity: "critical", title: "SQL injection risk", file: "src/db.ts", line: 42 },
    ],
  }

  test("a pre-rename integration fixture parses through the shared extractor", () => {
    const delivery = ReviewReport.extract([`## Review\n\nI checked the diff.\n\n${preRenameEnvelope(fixture)}`])
    expect(delivery.ok).toBe(true)
    if (!delivery.ok) return
    expect(delivery.report).toEqual(fixture)
    expect(delivery.analysis).toBe("## Review\n\nI checked the diff.")
  })

  test("mixed fixtures in one session: the post-rename envelope wins when it comes last", () => {
    const delivery = ReviewReport.extract([
      preRenameEnvelope(fixture),
      `<silvercode-review>\n${JSON.stringify({ ...fixture, assessment: "approved" }, null, 2)}\n</silvercode-review>`,
    ])
    expect(delivery.ok).toBe(true)
    if (!delivery.ok) return
    expect(delivery.report.assessment).toBe("approved")
    expect(delivery.analysis).toContain("Two issues need attention before merge.")
  })

  test("a legacy delivery normalizes to the canonical tag on render", () => {
    const delivery = ReviewReport.extract([`Analysis.\n\n${preRenameEnvelope(fixture)}`])
    expect(delivery.ok).toBe(true)
    if (!delivery.ok) return
    const rendered = ReviewReport.render(delivery)
    expect(rendered).toContain("<silvercode-review>")
    expect(rendered).not.toContain("<alphacode-review>")
    const reparsed = ReviewReport.extract([rendered])
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    expect(reparsed.report).toEqual(fixture)
    expect(reparsed.analysis).toBe(delivery.analysis)
  })
})

describe("review report rendering", () => {
  test("rendered output round-trips through extraction and keeps the analysis", () => {
    expect(delivered.ok).toBe(true)
    if (!delivered.ok) return
    const rendered = ReviewReport.render(delivered)
    const parsed = ReviewReport.extract([rendered])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.report).toEqual(delivered.report)
    expect(parsed.analysis).toBe(delivered.analysis)
  })

  test("delivery failure messages are explicit and preserve a bounded analysis", () => {
    const message = ReviewReport.failureMessage({
      sessionID: "ses_review",
      failure: { reason: "missing", message: "no <silvercode-review> report envelope was found" },
      analysis: "x".repeat(2000),
    })
    expect(message).toContain("Review delivery failed")
    expect(message).toContain("ses_review")
    expect(message).toContain("Re-dispatch the review")
    expect(message).toContain("[truncated]")
    expect(message.length).toBeLessThan(2000)
  })
})

describe("verdict parsing with the report envelope", () => {
  test("the envelope assessment is canonical over contradicting prose", () => {
    expect(
      parseReviewVerdict(
        `Assessment: Needs fixes\n\n${envelope({}, { ...report, assessment: "approved", findings: [] })}`,
      ),
    ).toBe("approved")
  })

  test("a legacy envelope's assessment is canonical over contradicting prose", () => {
    expect(
      parseReviewVerdict(
        `Assessment: Needs fixes\n\n${legacyEnvelope({}, { ...report, assessment: "approved", findings: [] })}`,
      ),
    ).toBe("approved")
  })

  test("a detected-but-invalid envelope never falls back to prose parsing", () => {
    // Malformed JSON in the envelope + contradicting prose assessment.
    expect(
      parseReviewVerdict(`Assessment: Approved\n\n<silvercode-review>{ not json </silvercode-review>`),
    ).toBeUndefined()
    // Unsupported schema version + contradicting prose assessment.
    expect(parseReviewVerdict(`Assessment: Approved\n\n${envelope({ version: 2 })}`)).toBeUndefined()
    // Opening tag without a closing tag + contradicting prose assessment.
    expect(parseReviewVerdict(`Assessment: Approved\n\n<silvercode-review>\n{"version": 1}\n`)).toBeUndefined()
    // Wrong envelope shape + contradicting prose assessment.
    expect(
      parseReviewVerdict(`Assessment: Approved\n\n${envelope({}, { version: 1, revision: "x", assessment: "maybe" })}`),
    ).toBeUndefined()
  })

  test("prose reports without an envelope keep the tolerant fallback", () => {
    expect(parseReviewVerdict("### Assessment\n\n**Ready to proceed?** Approved")).toBe("approved")
    expect(parseReviewVerdict("- Verdict — Needs fixes")).toBe("needs-fixes")
    expect(parseReviewVerdict("The implementation looks good, but no final assessment was emitted.")).toBeUndefined()
  })
})

for (const mention of [
  "Mention <silvercode-review> in prose.",
  "Mention </silvercode-review> in prose.",
  "Mention <alphacode-review> in prose.",
]) {
  test(`render preserves report despite literal tag mention: ${mention}`, () => {
    const initial = ReviewReport.extract([envelope(), mention])
    expect(initial.ok).toBe(true)
    if (!initial.ok) return
    const reparsed = ReviewReport.extract([ReviewReport.render(initial)])
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    expect(reparsed.report).toEqual(report)
    expect(reparsed.analysis).toContain(mention)
  })
}
test("literal tags inside JSON strings survive extraction", () => {
  const tagged = { ...report, summary: "Mention <silvercode-review> and </silvercode-review> literally." }
  const parsed = ReviewReport.extract([ReviewReport.envelope(tagged)])
  expect(parsed.ok).toBe(true)
  if (parsed.ok) expect(parsed.report).toEqual(tagged)
})
test("a malformed final complete report never falls back to older approval", () => {
  const parsed = ReviewReport.extract([
    envelope({ assessment: "approved", findings: [] }),
    "<silvercode-review>not json</silvercode-review>",
  ])
  expect(parsed.ok).toBe(false)
})

for (const tag of ReviewReport.TAGS) {
  for (const summary of [
    `Literal <${tag}> opener`,
    `Literal </${tag}> closer`,
    `Escaped quote \" then <${tag}> and </${tag}>`,
  ]) {
    test(`literal JSON tag data roundtrips: ${summary}`, () => {
      const tagged = { ...report, summary }
      const initial = ReviewReport.extract([
        `Prose <${tag}> mention.`,
        ReviewReport.envelope(tagged),
        `Prose </${tag}> mention.`,
      ])
      expect(initial.ok).toBe(true)
      if (!initial.ok) return
      expect(initial.report).toEqual(tagged)
      const next = ReviewReport.extract([ReviewReport.render(initial)])
      expect(next.ok).toBe(true)
      if (next.ok) expect(next.report).toEqual(tagged)
    })
  }
}

for (const broken of [
  '{"summary":"unterminated',
  '{"summary":"unterminated <silvercode-review>',
  '{"summary":"trailing\\',
  '{"summary":"escaped\\"',
]) {
  test(`malformed quoted latest report cannot revive older approval: ${broken}`, () => {
    const parsed = ReviewReport.extract([
      envelope({ assessment: "approved", findings: [] }),
      `<silvercode-review>${broken}</silvercode-review>`,
    ])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.failure.reason).toBe("malformed")
  })
}

for (const suffix of [' " prose <silvercode-review> mention', ' " prose <alphacode-review> mention']) {
  test(`malformed completed candidate survives later unmatched prose: ${suffix}`, () => {
    const parsed = ReviewReport.extract([
      envelope({ assessment: "approved", findings: [] }),
      '<silvercode-review>{"summary":"unterminated</silvercode-review>' + suffix,
    ])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.failure.reason).toBe("malformed")
  })
}
test("a later valid report supersedes a malformed quoted completed candidate", () => {
  const parsed = ReviewReport.extract([
    '<silvercode-review>{"summary":"unterminated</silvercode-review> " prose <silvercode-review> mention',
    envelope(),
  ])
  expect(parsed.ok).toBe(true)
  if (parsed.ok) expect(parsed.report).toEqual(report)
})

for (const broken of [
  '{"summary":"unterminated',
  '{"summary":"bad\\',
  '{"summary":"bad\\"',
  '{"summary":"unterminated <silvercode-review>',
]) {
  for (const suffix of [
    "",
    ' " prose <silvercode-review> mention',
    ' " prose <alphacode-review> mention',
    ' " prose <silvercode-review>not json</silvercode-review>',
    ' " trailing prose',
    " </alphacode-review>",
  ]) {
    test(`latest malformed candidate invariant: ${broken} / ${suffix}`, () => {
      const latest = `<silvercode-review>${broken}</silvercode-review>${suffix}`
      const prior = envelope({ assessment: "approved", findings: [] })
      expect(ReviewReport.extract([prior, latest]).ok).toBe(false)
      const replaced = ReviewReport.extract([prior, latest, envelope()])
      expect(replaced.ok).toBe(true)
      if (replaced.ok) expect(replaced.report).toEqual(report)
    })
  }
}
