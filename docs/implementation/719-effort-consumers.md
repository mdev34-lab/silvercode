# #719 exposure qualification: option (b)

The initial increment wrongly treated the schema extension as private backend
plumbing. `AgentEffort.levels` already drives the TUI cycle, while color and
thinking consumers index total maps. Missing entries were both type errors and a
runtime exposure bug. This follow-up deliberately chooses **(b), safe selectable
exposure**, not private plumbing. It is still a draft, Refs #719, not full issue
acceptance.

## Consumer matrix

| Consumer | Ultra qualification / implementation | Coverage |
| --- | --- | --- |
| Schema `levels`, `Level`, `resolve` | Fourth ordered literal, closed decoder, fallback unchanged | core `agent-effort`, `ultra-effort` tests |
| Core v1/v2 config and migration | Shared schema accepts/preserves scalar ultra, named-agent objects remain distinct; both descriptions updated | existing core tests enumerate every schema level through config/migration |
| Generated SDK `AgentEffortLevel` / `Config.agent.effort` | Stale generated union synchronized with schema | SDK `agent-effort` typed config test + SDK typecheck |
| Core pass limit / validation gate | Until-clean/full; fast/medium/thorough unchanged | core policy tests |
| Core review loop budget | Medium alone bounded; ultra uses existing until-clean path, not a new budget | policy/report tests and ultra task/finish integration tests |
| Session metadata reader/writer and child persistence | Shared schema decoder accepts ultra; task stamps inherited effective effort before execution | opencode ultra dispatch/finish matrices; TUI session persistence integration |
| Task depth / finish availability and #233 | One helper applies ultra review→review floor only, preserves config >2; other nesting/handoff unchanged | paired real-tool matrices + existing writing-child handoff tests |
| Task/finish Work routing advice | Existing thorough-specific non-programming General advice is not expanded; other workflow/complexity routing is unchanged. Ultra's new behavior in this increment is review depth/origin, not a new non-programming dispatch policy | existing task/finish routing regression suites plus ultra tool matrices |
| Prompt `EFFORT_PROCESS[effort]` | Total four-key map; ultra actual behavior only | `review-delegation` post-write prompt tests for medium and ultra |
| TUI `metadataLevel`, `configLevel`, `resolveEffort`, `defaultLevel`, metadata merge | Accept ultra from each precedence tier, preserve unrelated metadata | utility all-schema-level matrix; local context tests |
| TUI home state file / session pending writes / new-session metadata | Ultra survives selection, session PATCH, home restart, and seeds new sessions; config inheritance remains implicit | renderer/persistence integration tests |
| `nextLevel`, local cycle | fast → medium → thorough → ultra → fast, no missing value | cycle assertion + all-schema-level utility matrix |
| `TONES` → `effortColor` | Ultra dark `#bc8cff`, light `#8250df`; transparent backgrounds use theme text as before | exact RGBA tests for dark/light/transparent surfaces |
| `effortBadge` → selector chips | Same approved purple, contrasting black/white ink | utility contrast assertions + actual renderer span color assertions |
| `COUPLED_THINKING` → local model variants | Ultra high when supported; never clobbers explicit default/off or configured variants | utility guards + selector/local renderer integration |
| Selector `ENTRIES` / `/effort` action | Added only Ultra row: title Ultra, approved one-line description, no details; all first-three-row copy left for #717 | four-row renderer, keyboard selection, PATCH, chip tests |
| Prompt effort label/color / thinking label | Ultra label renders with approved purple; config/current metadata consumed safely | actual prompt renderer span + local context tests |
| Finish transcript status | String-based effort detail; no closed-key lookup or infinite pass serialization | all-schema-level utility finish-status matrix |
| `/help` effort enumeration | Ultra added to advertised levels | help test checks every schema level |
| ACP `thought_level`, provider reasoning effort variants | These are model thinking variants, not AgentEffort policy levels; no schema-driven cycle/map to extend | no change; kept separate deliberately |
| `docs/research/243-initial-context/measure.ts` | Historical experiment's three-level input, not a product schema consumer or selectable surface | no product exposure; unchanged |

No selector copy from #717 was duplicated: the existing three descriptions and
details are untouched. Only the new Ultra row uses the approved #719 text.

## Old-head failure attribution

Both platform annotations at 4a07af6b identify `@opencode-ai/tui#test`, not an
opencode headless CLI or ProjectV2 task. Restoring the old-head utility/selector
source and tests locally reproduces exactly:

`agent effort resolution > cycles the dial fast → medium → thorough → fast`

Expected `fast`, received `ultra` (42 pass, 1 fail across those two files).
This directly verifies a deterministic effort exposure regression. It does not
prove those CI jobs had no additional failures: their full logs redirect to
blocked Actions/blob-storage hosts, and annotations contain no test names. Neither
#718 nor the #485 ProjectV2 family is assumed to explain either old CI failure.

## Local verification

- Full opencode `tsc`, TUI/core/schema/SDK scoped package typechecks: green.
- Full TUI suite: 791 pass, 4 skip, 0 fail (existing asynchronous KV diagnostics
  appeared; no timeout/assertion changes).
- Three consecutive scoped runs: core 118/118, opencode 193/193, TUI
  66/66, SDK 6/6. Every added/changed test file is included.
- No workflow edits, GitHub comments, weakened assertions, timeouts, or budgets.
