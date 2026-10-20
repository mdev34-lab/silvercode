# #243 — initial request context: measured baseline, overhead inventory, reduction proposal

Research only in the original study. **No reduction was implemented by that study**, no product
source was touched by it, and no credentials, accounts, workflows or paid services were used.
This directory adds a reproducible fixture (`measure.ts`), the raw evidence it captured
(`results/`), and this proposal.

**Update at base `9948cb2` (see §11):** the measurements were reconciled with current head —
most of the §5 inventory had already landed — and one further scoped reduction from the
inventory (items 6 + 13, `gpt.txt` only) is implemented alongside this update. Machine-readable
current-head rows: [results/current-head.json](results/current-head.json). The original
`c8a2ae2c` evidence below is unchanged and is not regenerated.

Related: #243 (this issue), #239 (epic), #235 (agent effort), #241 (single context indicator),
#169 (provider prompt selection).

---

## 1. Verdict on the reported comparison

The issue quotes: _"o contexto inicial sem plugins/LSP/MCP é só 3k tokens com 13k do Alpha"_.

Measured under matched conditions (same model id, transport, tokenizer, empty project, plugins/LSP/MCP
off, same one-line prompt, fresh session):

|                                | AlphaCode `c8a2ae2c` | upstream opencode `1.19.0` |              delta |
| ------------------------------ | -------------------: | -------------------------: | -----------------: |
| system prompt                  |                4,284 |                      2,104 |             +2,180 |
| tool descriptions + schemas    |     8,208 (11 tools) |            4,412 (9 tools) |             +3,796 |
| user message                   |                    7 |                          7 |                  0 |
| **first conversation request** |           **12,499** |                  **6,523** | **+5,976 (1.92×)** |

- The **13k side is corroborated**: AlphaCode sends 12,499 tokens, within ~4% of the reported 13k.
- The **3k side is not reproducible as a full first request**. Every pinned upstream build measured
  sends 6,519–6,523 tokens. The only readings near 3k are positive subtotals: upstream's _system
  prompt alone_ is 2,104 tokens (2,111 with the user message), and an in-session UI counter may
  report a different scope again. The quoted comparison therefore mixes scopes: a full AlphaCode
  request against an upstream subtotal. Corrected comparison: **≈12.5k vs ≈6.5k, a 1.9× gap, not 4.3×**.
- **The near-3k goal is not met**, and it is not reachable by removing avoidable overhead alone.
  Section 6 states the measured result and the capability/policy cost of going lower; no subtotal is
  relabelled as full context.

Both products also issue a **title request before the first conversation request** (503 tokens of
system prompt, 0 tools, measured identically on both). "First outbound request of a session" and
"first conversation request" are different objects; this benchmark measures the latter (see §7).

---

## 2. Matched benchmark setup

Pinned manifest: [results/manifest.json](results/manifest.json).

| Axis                | Pinned value                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| AlphaCode version   | commit `c8a2ae2c` (`dev-vibecoded`), package `packages/opencode` (silvercode-ai 0.1.0)              |
| upstream version    | npm `opencode-ai@1.19.0` (`sha512-lddJ…`), linux-x64 binary; three other builds measured identical  |
| runtimes            | bun 1.3.14, node v22.22.3, Linux 6.1.158+ x64                                                       |
| provider            | inline `probe` provider, `@ai-sdk/openai-compatible` transport, local recording mock at `127.0.0.1` |
| credential          | `fixture-key-not-a-secret`; no live account, no real key, no network provider call                  |
| models              | `probe/gpt-5.2` (context limit 400k) and `probe/claude-sonnet-4-5` (200k)                           |
| tokenizer           | `gpt-tokenizer@4.0.0` (o200k_base), injectable via `--tokenizer`                                    |
| effort              | AlphaCode `agent.effort`: `medium` (default) unless the row says otherwise                          |
| plugins / LSP / MCP | `plugin: []`, `lsp: false`, `mcp: {}` on both                                                       |
| other config        | `share: disabled`, autoupdate disabled, models fetch disabled, pinned `HOME`/XDG                    |
| permissions         | product defaults, no deny rules                                                                     |
| session / cwd       | fresh session per run; empty scratch project outside any checkout; no AGENTS.md unless stated       |
| user prompt         | `Say hello in one word.`                                                                            |
| repeats             | primary scenario run in 3 fresh sessions → **identical totals (12,499 / 12,499 / 12,499)**          |

Not matchable, and therefore reported separately rather than silently equalised:

- AlphaCode-only: the `finish` tool and its mandatory end-of-turn contract; `tool_search` +
  `tool_search_regex` and the `<available_tools>` block; the review-loop system prompt; the effort
  policy text; the STE-lite reply style.
- upstream-only in the first request: `webfetch` is loaded instead of deferred.
- upstream's provider prompt text is compiled into the binary; it is measured from the captured
  request, not from source.

---

## 3. Measured results

All rows: `probe/gpt-5.2` unless stated, empty scratch project, plugins/LSP/MCP off, tokenizer
o200k_base. Raw machine-readable rows: [results/accounting.json](results/accounting.json); matched
delta view: [results/comparison.json](results/comparison.json).

| scenario                                                  | system |      tools | user |      total |
| --------------------------------------------------------- | -----: | ---------: | ---: | ---------: |
| AlphaCode, effort medium (×3 runs)                        |  4,284 | 8,208 (11) |    7 | **12,499** |
| AlphaCode, effort fast                                    |  4,215 | 8,208 (11) |    7 |     12,430 |
| AlphaCode, effort thorough                                |  4,273 | 8,208 (11) |    7 |     12,488 |
| AlphaCode, `tool_search: false`                           |  4,273 | 8,320 (11) |    7 |     12,600 |
| AlphaCode, `ste_lite: false`                              |  4,130 | 8,208 (11) |    7 |     12,345 |
| AlphaCode, project has AGENTS.md + CONTEXT.md             |  6,188 | 8,208 (11) |    7 |     14,403 |
| AlphaCode, project has **only** CONTEXT.md                | 10,079 | 8,208 (11) |    7 |     18,294 |
| AlphaCode, project has only CLAUDE.md (AGENTS.md content) |  6,198 | 8,208 (11) |    7 |     14,413 |
| AlphaCode, `claude-sonnet-4-5` model id                   |  4,358 | 8,503 (12) |    7 |     12,868 |
| upstream `1.19.0`                                         |  2,104 |  4,412 (9) |    7 |      6,523 |
| upstream `1.19.0`, `claude-sonnet-4-5`                    |  1,890 | 4,707 (10) |    7 |      6,604 |
| upstream `1.19.0`, project has AGENTS.md + CONTEXT.md     |  4,010 |  4,412 (9) |    7 |      8,429 |
| upstream `1.19.0`, project has only CONTEXT.md            |  7,900 |  4,412 (9) |    7 |     12,319 |

Instruction loading (AGENTS.md → CLAUDE.md → CONTEXT.md, first project-level match wins) costs the
same on both products: `+1,904` (AlphaCode) and `+1,906` (upstream) for this repository's AGENTS.md,
and `+5,795` / `+5,796` when CONTEXT.md is the first match. It is shared behaviour, not an
AlphaCode divergence — but it is the largest single project-dependent line item (§5, item 12).

Tokenizer sensitivity: recounting the captured primary requests with `cl100k_base` gives 12,502
(AlphaCode) and 6,510 (upstream) — the encoding choice between modern OpenAI BPEs moves nothing.
An Anthropic-family tokenizer was not measured offline (see §8).

Upstream version sensitivity: `1.19.0`, `0.0.0-dev-202610102323`, `0.0.0-dev-202610110139` and the
`tui-v2` dist-tag build `0.0.0-tui-v2-202606261840` all produce 6,519–6,523 tokens for the same
scenario. The "which upstream is V2" question does not change the first-request total.

---

## 4. Where the tokens are (raw breakdown)

### 4.1 AlphaCode system prompt — 4,284 tokens

| section                           |    tokens | source                                                                |
| --------------------------------- | --------: | --------------------------------------------------------------------- |
| provider prompt (`gpt.txt`)       |     2,327 | `packages/opencode/src/session/prompt/gpt.txt`                        |
| review loop                       |     1,355 | `.../prompt/review-loop.txt` (default primary agent only)             |
| STE-lite reply style              |       154 | `.../prompt/ste-lite.txt` (on by default, `ste_lite: false` disables) |
| effort policy block (medium)      |       141 | `EFFORT_PROCESS` in `src/session/prompt.ts` (fast 76, thorough 132)   |
| environment block                 |        98 | `SystemPrompt.environment`                                            |
| skills block (one built-in skill) |       156 | `SystemPrompt.skills` — `customize-opencode`                          |
| `<available_tools>` overview      |        13 | `ToolCatalog.overview`                                                |
| join/remainder                    |        40 | section separators                                                    |
| **total**                         | **4,284** |                                                                       |

Upstream's whole system prompt is 2,104 tokens: 1,889 provider prompt + 156 skills + 59 environment.
**AlphaCode's provider prompt alone (2,327) is larger than upstream's entire system prompt.**

Diffing the captured texts: `gpt.txt` is the upstream prompt plus ≈438 tokens of AlphaCode additions
— a "Task Management – Todo Planning and Execution Discipline" section and a rewritten review
paragraph that dispatches the `review` subagent instead of reviewing inline.

### 4.2 AlphaCode tools — 8,208 tokens over 11 tools

| tool              |    payload | description | schema | upstream payload |                   delta |
| ----------------- | ---------: | ----------: | -----: | ---------------: | ----------------------: |
| task              |      1,823 |       1,479 |    300 |              825 |                **+998** |
| bash              |      1,633 |       1,433 |    116 |            1,245 |                **+388** |
| todowrite         |      1,445 |       1,247 |    120 |              614 |                **+831** |
| finish            |      1,274 |         952 |    284 |                — | +1,274 (AlphaCode-only) |
| read              |        415 |         259 |    123 |              415 |                       0 |
| apply_patch       |        360 |         263 |     52 |              360 |                       0 |
| tool_search       |        357 |         231 |     83 |                — |   +357 (AlphaCode-only) |
| grep              |        280 |         149 |    103 |              280 |                       0 |
| tool_search_regex |        244 |         135 |     79 |                — |   +244 (AlphaCode-only) |
| glob              |        242 |         109 |    114 |              242 |                       0 |
| skill             |        144 |          75 |     48 |              144 |                       0 |
| webfetch          | (deferred) |           — |      — |              294 |                    −294 |

Descriptions dominate: 6,332 of the 8,208 tokens are prose, 1,422 are JSON schemas. Three tools
(`task`, `bash`, `todowrite`) carry 4,901 tokens between them, and their descriptions are
substantially longer than the same tools' descriptions upstream.

---

## 5. Ranked overhead inventory and proposed reductions

**Nothing below is implemented.** Each item is a proposal with a measured ceiling; every one needs an
explicit approval before any code changes, and items marked _estimate_ are not measured.

|   # | item                                                          | measured |       vs upstream | proposed action                                                                                                                                                                                                                                                                                       | gate                                                         |
| --: | ------------------------------------------------------------- | -------: | ----------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
|   1 | `task` tool payload                                           |    1,823 |              +998 | rewrite description to upstream shape (629) or defer the tool                                                                                                                                                                                                                                         | delegation semantics                                         |
|   2 | `review-loop.txt` in every default-primary prompt             |    1,355 |            +1,355 | move the scope contract into `todowrite`, keep the review prompt in the review/finish path, or omit at `fast`                                                                                                                                                                                         | process contract (#235/#231/#233)                            |
|   3 | `todowrite` payload                                           |    1,445 |              +831 | same rewrite after (2) lands                                                                                                                                                                                                                                                                          | todo discipline                                              |
|   4 | `finish` payload                                              |    1,274 |            +1,274 | compress the 952-token description; the contract itself must stay                                                                                                                                                                                                                                     | mandatory policy — cannot be removed                         |
|   5 | `tool_search` + `tool_search_regex`                           |      601 |              +601 | default off when the deferral set is empty, auto-enable on first MCP/custom tool. Note the honest number: with only `webfetch`/`attachment` deferrable today, disabling the pair makes the request **101 tokens larger** (measured 12,600), so this item saves nothing until the deferral set is real | feature discoverability                                      |
|   6 | `gpt.txt` AlphaCode additions                                 |     +438 |              +438 | dedupe against `todowrite`/`review-loop`                                                                                                                                                                                                                                                              | prompt ownership                                             |
|   7 | `bash` description                                            |    1,633 |              +388 | trim fork-added guidance                                                                                                                                                                                                                                                                              | shell guidance                                               |
|   8 | built-in skill listing                                        |      156 |                 0 | list built-ins on demand instead of every request                                                                                                                                                                                                                                                     | skills discoverability                                       |
|   9 | STE-lite reply style                                          |      154 |              +154 | keep as config, or flip the default                                                                                                                                                                                                                                                                   | style only, **zero code today** (`ste_lite: false` → 12,345) |
|  10 | effort policy block                                           |      141 |              +141 | compress the prose                                                                                                                                                                                                                                                                                    | effort contract (#235)                                       |
|  11 | environment block extras                                      |      +39 |               +39 | drop `Desktop directory` / `Workspace root` / `OS`+`Shell` lines                                                                                                                                                                                                                                      | low risk                                                     |
|  12 | CONTEXT.md auto-load                                          |   +5,795 |        0 (shared) | remove the deprecated entry from `instructionFiles` or require explicit `instructions`                                                                                                                                                                                                                | instruction compatibility; shared with upstream              |
|  13 | stale `multi_tool_use.parallel` reference in `gpt.txt` line 6 |      ~30 | 0 (also upstream) | fix the text — no such tool exists in either build                                                                                                                                                                                                                                                    | correctness                                                  |

Sum of the measured savings that are actually realizable, if items 1–4 and 6–11 and 13 were all
approved: 998 + 1,355 + 831 + 438 + 388 + 156 + 154 + 141 + 39 + 30 = **≈4,500 tokens**, taking
12,499 to ≈8,000 before the finish-description compression (item 4, estimated 400–700, not measured).
Item 5 is listed for completeness but saves nothing today (above). Item 12 saves 5,795 in affected
repositories (upstream too) and 0 in this repository.

Must not be reduced by counting tricks: permissions and the finish/review contract, tool
discoverability, or the size of the actual prompt content. Every number above is counted from the
captured request, not from a UI estimate.

---

## 6. Is the near-3k goal met?

**No.** Measured first conversation request: **12,499** tokens for AlphaCode against **6,523** for
the pinned upstream build.

- With every realizable measured item in §5 approved (plus item 4's estimated compression), the floor
  is ≈7,300–8,000 tokens — still ~2.5× the target.
- Reaching ≈3k requires going beyond overhead removal: the provider prompt (2,327) and the always
  loaded tool payload (8,208) are the mass. Keeping only `bash`/`read`/`grep`/`glob`/`apply_patch`
  loaded and deferring everything else still costs ≈2,900 tokens of tool payload (≈3,500 with the
  search pair kept for discoverability), and the provider prompt plus environment stays ≈2,400. A 3k
  total implies a much thinner provider prompt, no review-loop block, and at most two or three
  always-loaded tools.
- That is a **capability/policy change** (tool discoverability and process contracts), not overhead
  removal, and it is explicitly out of scope here: it needs its own approval, tests for result
  quality, and the review/finish contracts of #231/#233/#235 kept covered.

Report the measured result, not the goal: 12.5k now, ≈7.8k after approved overhead work, 3k only via
an approved capability change.

---

## 7. Measurement semantics for #241 (single indicator)

This issue supplies the count; #241 owns presentation. Boundaries for the number that feeds the bar:

- **What is counted**: the first _conversation_ provider-turn request — system prompt + session
  messages + tool descriptions/schemas — as captured before generation. Not the auto-title request
  (measured 503 tokens, 0 tools), not a summary/compaction request, and not a subtotal such as
  "system prompt only".
- **Estimated vs provider-reported**: the number above is a _tokenizer estimate_ (pinned encoding).
  Provider-reported input usage is a separate cross-check and must never be presented as the same
  thing. In this fixture the mock returns zero usage; obtaining real usage needs one live provider
  call, which this research deliberately did not make.
- **Denominator**: the active model's configured context limit (`limit.context`; 400,000 for the
  fixture's `probe/gpt-5.2`). If the model or limit is unknown, the percentage is _unknown_ — do not
  print a fabricated number, and do not silently reuse a stale limit after a model switch.
- **No second indicator**: do not add a second, independently computed sidebar/status counter. One
  bar, one computation path, optional numeric detail consistent with it.
- **Layout**: the reference screenshot's textual layout is not the required AlphaCode format.

---

## 8. Limits of this study

1. **"V2" identity is not confirmed.** Four pinned upstream builds measure identically (6,519–6,523),
   so the 3k figure is not explained by upstream version drift within what is obtainable here. If V2
   is a different distribution (preview, desktop/app build, private branch, or a different provider
   setup), confirm the pin and re-run the fixture — the protocol is fixed and cheap (~50 s).
2. **No provider-reported usage cross-check.** Requires a live credential against a real endpoint;
   explicitly out of scope for this research (`No live account generation`, no credentials).
3. **Tokenizer family.** o200k_base primary; cl100k_base agrees within 0.2%. An Anthropic-family
   tokenizer could shift absolute counts by a few percent; it was not measurable offline, and the
   `claude-sonnet-4-5` rows inherit that uncertainty.
4. **Transport framing.** Both products were measured through the same OpenAI-compatible surface, so
   per-message framing tokens added by a provider implementation (Anthropic messages, OpenAI
   responses) are not included. Counts are content-comparable across the two products and are a
   slight under-estimate of provider-reported input.
5. **Single environment.** Path length and the date string are part of the system prompt, so totals
   reproduce exactly only with the same working directory and date. The fixture pins both.
6. **One AlphaCode commit.** `c8a2ae2c`; effort/tool-search/instruction behaviour may change later.
7. **Harness artifact.** The mock never calls `finish`, so AlphaCode keeps nudging (5 requests,
   exit 1) while upstream finishes in 2. Only the first request is measured; the extra requests are a
   property of the mock, not a product finding.
8. **Plugins/LSP/MCP overhead is out of scope** by the issue's matched protocol. Their cost is
   additive and unmeasured here.
9. **The fixture must not run inside a checkout.** A project nested in this repository silently
   inherits its `AGENTS.md`/`.opencode` config through the upward search: measured contamination was
   +2,244 tokens. The fixture therefore defaults to a scratch directory under the OS temp dir.

---

## 9. Reproduction

```bash
# 0. repository workspace (already installed in this session)
bun install --frozen-lockfile --ignore-scripts

# 1. pinned tokenizer (any scratch directory)
npm i gpt-tokenizer@4.0.0

# 2. pinned upstream comparator (any scratch directory)
npm i opencode-ai@1.19.0

# 3. capture + account; ~50 s for the full matrix
bun run docs/research/243-initial-context/measure.ts \
  --tokenizer   <scratch>/node_modules/gpt-tokenizer/esm/main.js \
  --upstream-bin <scratch2>/node_modules/.bin/opencode

# single scenario
bun run docs/research/243-initial-context/measure.ts \
  --tokenizer <scratch>/node_modules/gpt-tokenizer/esm/main.js \
  --upstream-bin <scratch2>/node_modules/.bin/opencode \
  --scenario alpha-empty-gpt52-medium
```

Outputs, all under `results/`: `accounting.json` (per-scenario breakdown),
`comparison.json` (AlphaCode vs upstream matched deltas), and per-scenario
`evidence/<id>/{first-request.json, config.json, run.json}` plus the full request list
(`requests.json`) for the four full-evidence scenarios. The credentials never appear in the
evidence: only `content-type`, `accept` and `anthropic-version` headers are recorded, and the API
key is the literal fixture string in `config.json`.

---

## 10. Approvals requested before any implementation

1. **Confirm the comparator pin** ("V2"): if it is not `anomalyco/opencode` npm builds, name the
   version/home so the fixture can be pointed at it.
2. **Approve or reject the §5 inventory items** individually (or name a scoped subset). No reduction
   will be implemented without that approval, and each accepted item then needs focused tests as
   stated in the issue's acceptance criteria.
3. **Decide on upstream-parity tool descriptions** (items 1, 3, 6, 7 together account for ≈2,650
   measured tokens). This is the largest non-breaking reduction, but it changes instruction text the
   fork deliberately wrote; it needs a reviewer decision, not a mechanical copy.
4. **Decide on the CONTEXT.md auto-load** (item 12). 5,795 tokens in affected repositories; shared
   with upstream, so it should be coordinated rather than changed unilaterally.
5. **Agree the live cross-check** for provider-reported usage (needs a credential and one real
   provider turn) and whether it should gate any claim about the 3k goal.
6. **#241**: confirm the semantics of §7 (estimated vs provider-reported, single computation path,
   unknown-state handling) since this issue owns the number and #241 owns the presentation.

---

## 11. Reconciliation at `9948cb2` and the implemented scoped reduction

The brief for this follow-up states that PR #311 already reduced initial instructions once.
Re-running only the AlphaCode scenarios of the fixture above at base
`9948cb2787615bac73043c0d8a3ec9be11d91d54` (same tokenizer, prompt, mock provider, empty
scratch project, plugins/LSP/MCP off; upstream not re-run — its fixture rows are reused, per
the instruction not to regenerate what the fixture already answers) confirms that most of the
§5 inventory had already landed:

| scenario (gpt-5.2, effort medium)                          | system |      tools | user |     total |
| ---------------------------------------------------------- | -----: | ---------: | ---: | --------: |
| fixture study, AlphaCode `c8a2ae2c`                        |  4,284 | 8,208 (11) |    7 |    12,499 |
| current head `9948cb2`, before this change (×3, identical) |  2,880 | 3,717 (11) |    7 |     6,604 |
| current head, after this change (×3, identical)            |  2,609 | 3,717 (11) |    7 | **6,333** |
| upstream `1.19.0` (fixture, not re-run)                    |  2,104 |  4,412 (9) |    7 |     6,523 |

Reproduce the current-head rows (primary scenario shown; substitute the scenario id and
output directory to re-capture any row in `results/current-head.json`):

```bash
bun run docs/research/243-initial-context/measure.ts \
  --tokenizer <scratch>/node_modules/gpt-tokenizer/esm/main.js \
  --upstream-bin /bin/false \
  --scenario alpha-empty-gpt52-medium \
  --out <scratch-out>
```

(`/bin/false` is a deliberate non-comparator: the upstream rows are reused from the fixture,
not re-measured, and the AlphaCode scenarios never invoke the upstream binary.)

Already landed at current head, by inventory item (fixture → current head, per-tool payload):
item 1 `task` 1,823 → 770; item 3 `todowrite` 1,445 → 279; item 4 `finish` 1,274 → 492;
item 7 `bash` 1,633 → 631; item 2/10: the Review Loop policy (1,355) and the effort block (141)
no longer appear in the first request at all — only the 92-token todo scope contract is sent
before any file write, and the policy/effort text is deferred until the session has written
files. Net effect before this change: **12,499 → 6,604 (−5,895, −47.2%)**, i.e. current head was
already within +81 tokens (+1.2%) of the pinned upstream full request.

Implemented here (the remaining scoped, ungated inventory items):

- **Item 6 — `gpt.txt` dedupe.** The 392-token "Task Management – Todo Planning and Execution
  Discipline" section duplicated both the always-sent todo scope contract
  (`review-loop.txt`, 92 tokens) and the `todowrite` tool description (138 tokens). It is
  replaced by a ~110-token concise form that keeps the discipline itself (one specific,
  coherent, independently verifiable unit per todo; exactly one `in_progress`; mark completed
  immediately after verification; no batching or retrospective bookkeeping; update the list
  when the plan diverges; `finish` closing open todos is a safety net, not a substitute).
  The duplicated review-routing paragraph is compressed the same way, keeping the
  `review`-subagent dispatch, the runtime reviewer mapping, and the no-subagent fallback
  (findings first, by severity, with file/line references). `gpt.txt`: 2,327 → 2,056 tokens.
- **Item 13 — stale tool reference.** `gpt.txt` told the model to use
  `multi_tool_use.parallel`, a tool that exists in neither build. Replaced with the actual
  mechanism (independent calls in the same response).

Before/after under identical settings, tool schemas and tokenizer: **6,604 → 6,333 tokens
(−271, −4.1%)**, all of it system-prompt text; tool/schema tokens are unchanged (3,717), so
nothing was hidden from the count. Repo-instructions scenario after: 8,237 (was 8,508 at
current head). The `claude-sonnet-4-5` row is unchanged by this change (6,796), because
`anthropic.txt` was deliberately not edited (below). After this change AlphaCode's first
conversation request is 190 tokens (−2.9%) **below** the fixture's pinned upstream request —
with its unmatchable extras (`finish`, `tool_search` pair, scope contract, STE-lite, effort
machinery) still loaded and counted.

Checked and deliberately **not** implemented, with current-head measurements:

- Item 5 (`tool_search` pair, 300 tokens): disabling it at current head measures **7,006**
  (+402), because `webfetch`/`attachment` then load directly. It is a cost, not a saving,
  until the deferral set is real.
- Item 9 (STE-lite, 154 tokens): remains a config decision (`ste_lite: false` → 6,450 at
  current head before this change); flipping the product default is a style call, not made here.
- Item 8 (built-in skill listing, 156 tokens): kept. The listing is the only discoverability
  path for `customize-opencode`; there is no on-demand skill search to replace it with.
- Item 11 (env block extras, +39 vs upstream): kept. `Desktop directory` and
  `OS`/`Shell` are asserted by `test/session/system.test.ts` and carry real features.
- Item 12 (`CONTEXT.md` auto-load, +5,795 in affected projects, 0 in the empty benchmark):
  kept. It is shared with upstream, deprecated-but-compatible behaviour; §10.4 already
  reserves this for a coordinated decision.
- Other provider prompts (`anthropic.txt`, `beast.txt`, `gemini.txt`, `kimi.txt`) carry
  similar todo sections, but item 6 was scoped to `gpt.txt` and only the gpt path is in the
  pinned benchmark. Left for a separately approved pass.

**Near-3k goal: still not met, and not relabelled.** Measured result after this change:
6,333 tokens. The always-loaded tools alone are 3,717 tokens — already above 3k before any
system prompt — so reaching ≈3k still requires deferring/dropping most tools and a much
thinner provider prompt: a capability/policy change (tool discoverability, finish/review
contracts), not overhead removal. It remains out of scope without its own approval and
result-quality tests.

### 11.1 Semantics supplied to #241 at current head

The single context bar in `packages/tui/src/feature-plugins/sidebar/context.tsx` already
implements the §7 semantics and is covered by `packages/tui/test/feature-plugins/sidebar-context*.test.*`:

- **Count**: provider-reported usage of the last assistant message
  (`input + output + reasoning + cache.read + cache.write`). This is _not_ the tokenizer
  estimate of §1–§6/§11, and the two must never be presented as the same number; the
  initial-context estimate (6,333) does not feed the bar.
- **Denominator / percentage**: `limit.context` of _that message's own_ model
  (`findModel(last.providerID, last.modelID)`), percent `round(tokens / limit × 100)`,
  clamped for the glyph fill. A model switch therefore does not reuse a stale limit: the
  next assistant message is measured against its own model's limit, and until one exists
  the bar still reports the previous message's usage against its own model's limit —
  attribution, not fabrication.
- **Unknown state**: no assistant message with any non-zero usage, or an unresolvable /
  zero context limit, renders `usage unknown` with an empty bar — no fabricated `0%`.
- **Single indicator**: this issue adds no second counter. Pre-existing status-bar text in
  `packages/tui/src/component/prompt/index.tsx` and `subagent-footer.tsx` computes the same
  sum (with an `output > 0` gate instead of any-usage) — consolidating that presentation is
  #241's, deliberately not touched here.
