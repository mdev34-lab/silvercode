# #719 increment 1: origin selection qualification

Before choosing a selector, finish boundaries were rejected: delivery does not prove
independence, and neither a caller summary nor a compacted summary is verbatim origin.
The selected mechanism is explicit root user-message IDs, with one conservative
convenience case (exactly one root user message, no compaction). No keyword search,
first-message append, or whole-history fallback is used.

| Real case | Coverage | Declared gaps |
| --- | --- | --- |
| (a) fresh session | sole user message, verbatim text in store order | non-text attachments; compaction |
| (b) long multi-topic | explicitly selected user IDs only; unrelated messages excluded | selection completeness cannot be proven; no selection attaches nothing |
| (c) resumed earlier unit | earlier root IDs can be selected, irrespective of finish boundaries | same completeness gap; missing IDs explicit |
| (d) corrections | select request and correction IDs; sorted by store order, not caller order | omitted relevant steerings cannot be detected; always declare that uncertainty for multi-message histories |
| (e) compaction | surviving selected original text only; summaries never substituted | compaction and unavailable originals declared, never full certification |

An explicit selection is a relevance assertion by the dispatcher, not proof of
completeness. A message containing multiple topics cannot be safely split into
verbatim requirements automatically: select only messages appropriate to the unit,
or omit them and report the gap. This does not claim semantic relevance detection.
Root records are the only authority. Missing ancestry yields no origin, never a
child-session fallback. Every slice dispatch repeats root selection; pass the same
IDs and full requirements to slices. Incomplete origin requires the reviewer to
say "verified against available origin" and forbids full completion certification.
This is reviewer instruction, not a new machine-enforced verdict schema.

## Initial-head verification (4a07af6b; exposure gap repaired below)

- Bun 1.3.14: core effort/report tests 117/117, three consecutive runs;
  opencode task/finish/origin tests 179/179, three consecutive runs.
- Scoped TypeScript (changed opencode source/tests + ambient declarations): green.
  Schema (`tsgo`) and core (`tsc`) package checks: green.
- Full opencode package check also attempted: two diagnostics in the deliberately
  excluded TUI effort maps (`COUPLED_THINKING` and `TONES` lack ultra). No TUI files
  changed. This increment is not independently full-workspace typecheck clean.
- Scoped oxlint: exit 0 (warnings remain, no rules weakened).
- No workflow, timeout, assertion, or budget weakening. The three-slice bound is
  reviewer process guidance, not a new runtime quota. Incomplete-origin wording
  is reviewer guidance, not a new envelope parser/schema field.


## Exposure follow-up

The design-owner qualification established that schema extension already exposes
Ultra through the TUI cycle. The old exclusion was therefore unsafe, not merely
a deferred cosmetic change. Option (b) now completes the total utility maps and
selectable row without changing #717's first-three-row copy. See
[the full consumer matrix](719-effort-consumers.md). Full opencode and TUI package
typechecks now pass locally; the old TUI-map blocker above is historical.

## Explicit wire contract and test coverage

`task.origin_message_ids?: string[]` is intentionally part of the model-visible
JSON Schema/wire API, not hidden runtime metadata. Dispatchers select original
root user-message IDs and pass those IDs through task parameters to slice
reviewers. It is optional (existing callers remain valid), rejects non-arrays
and non-string items, and is consumed only for ultra review dispatches. The task
wire schema also admits the `ultra` effort enum member. The parameters snapshot
now records both intended changes; no other tool snapshot changed.

Each origin qualification row has explicit coverage in
`packages/opencode/test/tool/ultra-review.test.ts`:

| Row | Test coverage |
| --- | --- |
| (a) fresh | `fresh origin includes sole root request verbatim with provenance` |
| (b) multi-topic | `multi-topic selection ordered by root store, excludes unrelated topics and child records`; `no selection is not an indiscriminate dump or unconditional first-message append` |
| (c) resumed | `resumed earlier unit spans a finish boundary without attaching an intervening private topic` uses a completed finish tool part between the selected earlier request and resume steering |
| (d) corrections | `mid-work corrections retain root store order even when IDs are supplied backwards` checks request plus two corrections, exact text, provenance, and ordering |
| (e) compaction | `compaction attaches surviving selected originals only; missing originals and summaries cannot certify completion` selects an unavailable original plus a surviving correction, excluding summary and unrelated survivor |
| Missing origin | `missing origin always declares gaps, including a missing ID alongside a sole available user message` checks unknown root, empty history, missing-only/mixed IDs, and empty explicit selection; every case must be incomplete and forbid full certification |

No runtime origin algorithm was changed for these tests: they strengthen and
make explicit the documented conservative coverage contract.

Snapshot follow-up local verification: origin/parameters 71 tests and 16 snapshots
passed in three consecutive runs; broader opencode scope 259/259; core 118/118,
TUI 66/66, SDK 6/6. Full workspace typecheck passed all 17 tasks after the fix.
Scoped oxlint exited 0 (existing-style fixture assertion warnings retained).
