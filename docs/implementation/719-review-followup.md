# Replacement for #720: six review findings

The feature's four-commit chain through b457230a was cherry-picked onto the new
Arena branch. #720 remains closed/unmerged; this does not reopen it. #717 must
land first, and the coordinator retains integration timing. No rebase performed.

1. **User depth restrictions.** `subagent_depth` is optional and nonnegative;
   absence is `undefined`, explicit lockdown is numeric `0`. There is no blocker
   distinguishing these. Only unset (legacy default `1`) is lifted to `2` for ultra
   review→review. `0`, explicit `1`, `2`, and values above `2` remain exact restrictions. The
   shared helper drives task dispatch and finish availability/#233 handoff.
   Paired real-tool matrices cover explicit zero/one and other limits, including a
   depth-zero ultra review caller refused under zero. No permission is relaxed.
2. **Origin once.** The reviewer passes the same `origin_message_ids`; the task
   tool attaches the record. The prompt explicitly says not to paste it again.
   Successful nested dispatch tests supply explicit IDs and assert one origin
   heading, alongside delivery of the canonical slice report in the task result.
3. **Synchronous slices.** The prompt requires `background: false` and waiting
   for every parseable envelope before synthesis; no fire-and-forget launch is
   evidence. A prompt-contract test pins these instructions.
4. **Honest origin claims.** Selection is **structural only for the automatic
   path; explicit selection is a dispatcher assertion**. There is no ID count
   cap or semantic-relevance validation, so completeness/relevance of an explicit
   list is not structurally certified. Incomplete-origin gaps remain mandatory.
5. **Depth-first refusal.** Before resolving the parent agent or reading caller
   messages, task checks the largest limit that could possibly apply. Every
   definite refusal (all non-ultra/non-review refusals, explicit zero, explicit
   limits, and ultra at depth >=2 with default cap) fails with the depth error and
   zero caller-message reads. Only the potentially permitted implicit-default-depth-1
   ultra→review band requires caller resolution to distinguish review from other
   agents. That lookup is necessary to avoid granting the exception to a
   non-review caller. Tests replace message storage with a failure and assert
   the depth error, zero reads, no permission question and no child creation.
6. **Prompt/finish symmetry.** Both resolve session selection first, then root
   ultra for an unset child, then config/default medium. Root ancestry is read
   only for an unset child. Real model-request tests exercise inherited ultra,
   child-medium override, and non-ultra root falling back to medium; finish
   regression tests cover the same precedence. Depth restrictions remain
   independent: ultra effort cannot override an explicit zero cap.

The superseded issue formula `max(config ?? 1, 2)` is no longer the rule: the
coordinator's explicit user-restriction ruling takes precedence. No alternate
limit/permission opt-out was added or removed. Fast/medium/thorough policy and
review pass budgets remain unchanged.

TUI exposure stays option (b), as previously reviewed. This review-fix delta
changes no TUI copy, component or tests. The #717 conflict resolutions remain:
take its details-free structure, use the four-level purpose-led test title,
and retain the Ultra assertion with #717's three purpose-led descriptions.

## Verification on the replacement branch

- Bun 1.3.14: opencode 310/310 across six relevant files, three consecutive
  runs (includes finish, task, origin, parameters, effort policy integration,
  and real model-request prompt delegation tests; 16 snapshots unchanged).
- Core 118/118, TUI 66/66, SDK 6/6 scoped tests, each three consecutive runs.
- Full workspace typecheck: all 17 tasks passed, no cache hits.
- Oxlint over all changed TypeScript/TSX files: exit 0, warnings retained;
  no errors, no rule or timeout/assertion/budget weakening.
- No workflow edits or GitHub comments. No TUI changes in the six-fix delta.
