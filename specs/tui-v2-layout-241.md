# TUI v2 layout: simplify without hiding work or controls (#241)

Part of #239. This note is the small, annotated layout proposal the issue asks
for: what moves, what stays visible, how every control stays reachable from the
keyboard, and what is deliberately left alone. The renders quoted at the end are
produced by the tests, not drawn by hand (see _Verification_).

Principle: fewer labels is not the goal. A screen is simpler when the things a
user needs at a glance — the prompt, which session this is, which model and
effort will answer, whether work is running / waiting / failed / done, and
anything that needs attention — are findable without reading everything else.
Everything else may step back, but nothing is dropped.

## Layout map

The session route is a sidebar (docked when the terminal is wider than 120
columns, otherwise an overlay behind `session.sidebar.toggle`), a transcript,
and a bottom panel (prompt, or the permission / question prompt, or the subagent
footer in a child session) with a one-line status row under it.

| Need                     | Where it is shown                                                                 | Keyboard / menu path                              | Change in this issue                                   |
| ------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| Prompt, draft, cursor    | Bottom panel                                                                      | focused by default; `prompt.clear`, `tab` agents  | none (focus, typing, paste, shortcuts untouched)       |
| Session identity         | Sidebar title + id; **status line (left) when the sidebar is hidden**             | `session.sidebar.toggle`                          | status line names the session when the sidebar is off |
| Model + effort           | Prompt meta row `Build · Test Model TestProvider · medium`                        | model/effort dialogs (#235)                       | none                                                   |
| Work state               | Status line: `■ … esc interrupt` while busy; `Thinking`/tool spinners in the body | `esc` interrupt                                   | none                                                   |
| Failure / retry          | Status line `■ <message> [retrying attempt #N]`; error text in the transcript     | retry dialog on child entry, transcript           | none (verified it never looks idle)                    |
| Permission / question    | Replaces the prompt: `△ Permission required`, request, actions, hints             | `⇆` select, `enter`, `esc` reject, `ctrl+f`       | actions and hints wrap instead of clipping at 80 cols  |
| Subagent navigation      | `SubagentFooter` replaces the prompt in a child session                           | `session.subagent.stop`, `session.parent`, prev/next | label row and controls row wrap instead of overlapping |
| Context usage            | **Sidebar bar is primary**; status line / subagent footer show the numeric detail | `session.sidebar.toggle` at narrow widths         | all three read one measurement; unknown never numeric  |
| Newest output reachable  | **`↓ Jump to latest · <key>` chip** in the gap row above the prompt               | `session.last` (`ctrl+alt+g` / `end`), click      | new, shown only while scrolled away                    |
| Secondary commands       | Command palette (`ctrl+p commands` hint on the status line)                       | `ctrl+p`                                          | hint yields its slot to a retry notice while retrying  |

What moves: nothing is removed from the screen. One slot changes occupant: when
the sidebar is hidden the status line's left slot shows the session title
instead of the working directory (the directory is what the sidebar footer
shows when the sidebar is visible, so at normal width it was simply shown
twice). The directory stays in the sidebar footer and on the home screen.

## State by state

- **Idle / complete** — collapsed reasoning keeps its duration (`+ Thought:
  Planning the fix · 3.0s`), the finished turn shows `▣ Build · Test Model ·
  5.0s`, and the status line shows the context detail and `ctrl+p commands`.
- **Working** — the reasoning label streams as `⠸ Thinking: …`, running tools
  spin, and the status line swaps the directory/title slot for `■ esc
  interrupt`. Work state is never only a colour.
- **Permission** — the prompt is replaced by the request. At 80 columns the
  three actions sit on their own row and the `fullscreen / select / confirm`
  hints on the next, so `enter confirm` is never cut to `enter con`.
- **Error / retry** — the status line carries `■ Rate limit exceeded [retrying
  attempt #2]` plus `esc interrupt`, and the assistant row in the transcript
  carries the API error text. The `ctrl+p commands` hint is the one secondary
  control that yields its slot here; the palette itself still opens.
- **Multi-session (child)** — `Explore (1 of 2) 29.7K (15%)` identifies the
  subagent and its position; `Stop subagent escape escape · Parent up · Prev
  left · Next right` stay whole words on a second row at 80 columns.

## Context indicator (presentation only)

- The sidebar bar (`███░░░…`, 20 cells) is the indicator. The token count and
  percent under it, the compact `29.7K (15%)` in the status line and the same
  label in the subagent footer are optional detail.
- All of them are derived from `src/util/context-usage.ts` — one
  `contextUsageFrom` call, one `ContextUsage` value. Before this change the
  prompt and the subagent footer each had their own formula (which required an
  assistant message with `output > 0`), so the sidebar could say `30,000 tokens
  · 15% used` while the status line showed nothing, or vice versa.
- Unknown is explicit: an empty bar with the words `usage unknown`, and **no**
  count or percent anywhere. Unknown covers "nothing measured yet" and "usage
  exists but the model's context limit is not resolvable". There is no
  confidently empty state.
- Measurement semantics (what counts as the context, budgets, near-limit
  thresholds, aggregation across models) belong to #243. This issue adds no
  second indicator and changes no formula.

## Thinking labels are theme keys

The live label and the finished label were both hardcoded to `warning`. They
are now four optional theme keys, resolved with the same `#hex` / defs / theme
reference rules as every other colour:

```json
{
  "theme": {
    "thinkingStreaming": "accent",
    "thinkingStreamingStyle": { "italic": true },
    "thinkingCompleted": "textMuted",
    "thinkingCompletedStyle": { "bold": true, "dim": false },
    "thinkingOpacity": 0.6
  }
}
```

- Defaults: both colours fall back to `warning`, both styles to `{}`, so a theme
  file that predates the keys renders byte-for-byte as before.
- `thinkingOpacity` keeps its meaning (the label dims while its body is shown
  underneath); it applies to whichever colour is active.
- Styles map to renderer attribute bits (`bold`, `italic`, `dim`, `underline`)
  on both the streaming spinner label and the finished label.
- The finished label keeps the summary and the duration: `Thought: <summary> ·
  3.0s`. Streaming / collapse behaviour (`show` / `hide` modes, manual toggle)
  is untouched.

## Jump to latest

- While the transcript is scrolled more than one row away from its end, a
  one-row chip `↓ Jump to latest · ctrl+alt+g` appears right-aligned in the gap
  row between the transcript and the bottom panel. It covers no output and
  shifts nothing; it disappears as soon as the view is back at the end.
- Invoking it (click, or the advertised `session.last` binding) scrolls to the
  newest message. The prompt draft is not touched, and because the scrollbox is
  sticky-at-bottom again afterwards, further output follows automatically.
- New output arriving while the reader is scrolled up does not move the view;
  the chip simply stays until they choose to jump.
- The chip advertises the first configured `messages_last` binding, so a user
  who rebinds it sees their own key.

## Narrow-width fixes found by the renders

Both are visible in the _before_ renders below and both are regression-tested:

1. `PermissionPrompt` footer: at exactly 80 columns the action buttons and the
   key hints shared one row that needed ~89 columns; the hints clipped. The row
   now wraps (`flexWrap`), stacking hints under the actions when they do not fit.
2. `SubagentFooter`: the identity group and the control group shrank and
   word-wrapped into each other (`Explor(1 of  29.7K (15%Stop …`). Both groups
   now refuse to shrink and the row wraps, so controls move to a second row.

## Out of scope (left as is, on purpose)

- Home route layout, tips and footer (#229 / #230).
- Effort selector and the prompt meta row content (#235).
- Context measurement semantics, budgets, aggregation (#243).
- Sidebar content order and width, the sidebar footer, and the `LSP`/`MCP`
  counters (`routes/session/footer.tsx` is not mounted by the session route).
- Dialog, toast and which-key styling; the command palette's command list.
- Moving further status-line hints (`tab agents`, `ctrl+p commands`) into a
  menu: they are already the menu entry points and cost one short row.
- Rebinding `end`/`ctrl+alt+g` or making hidden scroll commands visible in the
  palette.

## Verification

All of the following run from `packages/tui` with local fixtures only:

- `test/cli/tui/layout-states.test.tsx` — real `<Session />` in idle, working,
  permission, error and multi-session states at 140×40 and 80×24; asserts every
  row fits the width and that identity, model + effort, work state, attention
  cues and all primary controls are whole words. Set `LAYOUT_CAPTURE_DIR=<dir>`
  to dump the frames (`<state>-<size>.txt`); that is how the renders below were
  produced (before = unmodified `src`, after = this change).
- `test/cli/tui/jump-to-latest.test.tsx` — 30-turn transcript at both sizes:
  chip hidden at the end, shown when scrolled away, new output does not steal
  the position, `session.last` and a mouse click return to the latest message
  with the draft intact, short transcripts never show the chip.
- `test/cli/tui/thinking-theme.test.tsx` — streaming and completed labels in two
  clashing themes at both sizes (colour + attribute bits), plus the
  backward-compatible `warning` default and the opacity dimming.
- `test/cli/tui/context-indicator.test.tsx` — empty / partial / near-limit /
  unknown at both sizes in two themes: bar glyphs, detail line and status-line
  label agree; unknown shows no number; subagent footer reads the same source.
- `test/theme.test.ts`, `test/feature-plugins/sidebar-context*.test.ts(x)` —
  key resolution, defaults and the moved pure helpers.

## Renders

Trailing spaces are stripped and runs of empty rows collapsed for readability;
the raw captures are 140×40 / 80×24 exactly.

### Permission, 80×24 — before

```
  ┃  Please fix the flaky scroll test
  ┃
     ⠸ bun test scroll.test.ts

  ┃  △ Permission required
  ┃    # Shell command
  ┃
  ┃   Allow once   Allow always   Reject  ctrl+f fullscreen  ⇆ select  enter con
  ┃
```

### Permission, 80×24 — after

```
  ┃  Please fix the flaky scroll test
  ┃
     ⠸ bun test scroll.test.ts

  ┃  △ Permission required
  ┃    # Shell command
  ┃
  ┃  $ bun test scroll.test.ts
  ┃
  ┃   Allow once   Allow always   Reject
  ┃
  ┃  ctrl+f fullscreen  ⇆ select  enter confirm
  ┃
```

### Multi-session (child), 80×24 — before

```
  ┃  Find every caller of scrollTo
  ┃
     ⠸ bun test scroll.test.ts

  ┃  Explor(1 of  29.7K (15%Stop      escape       Parent   Prev     Next
  ┃  e     2)               subagent  escape       up       left     right
  ┃
```

### Multi-session (child), 80×24 — after

```
  ┃  Find every caller of scrollTo
  ┃
     ⠸ bun test scroll.test.ts

  ┃  Explore (1 of 2) 29.7K (15%)
  ┃
  ┃  Stop subagent escape escape  Parent up  Prev left  Next right
  ┃
```

### Idle, 80×24 — before (no session identity on screen)

```
  ┃  Please fix the flaky scroll test
  ┃
     + Thought: Planning the fix · 3.0s

     Done. The test now waits for layout to settle.

     ▣  Build · Test Model · 5.0s

  ┃  Build · Test Model TestProvider · medium
  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
   /tmp/opencode/packages/tui             29.7K (15%) · $0.42  ctrl+p commands
```

### Idle, 80×24 — after

```
  ┃  Please fix the flaky scroll test
  ┃
     + Thought: Planning the fix · 3.0s

     Done. The test now waits for layout to settle.

     ▣  Build · Test Model · 5.0s

  ┃  Build · Test Model TestProvider · medium
  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
   Fix flaky scroll test                  29.7K (15%) · $0.42  ctrl+p commands
```

### Error / retry, 80×24 — after (unchanged behaviour, kept as evidence)

```
  ┃  Please fix the flaky scroll test
  ┃
  ┃  API error: Rate limit exceeded. Try again in 5s.
  ┃
     ▣  Build · Test Model

  ┃  Build · Test Model TestProvider · medium
  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
   ■ Rate limit exceeded [retrying attempt #2]                   esc interrupt
```

### Working, 140×40 — after (docked sidebar; context bar primary)

```
  Fix flaky scroll test                     ┃
  ses_01_main                               ┃  Please fix the flaky scroll test
                                            ┃
  Context
  ███░░░░░░░░░░░░░░░░░                         ⠸ Thinking: Planning the fix
  29,723 tokens · 15% used
  $0.42 spent                                    Looking at the scroll handler

                                               ⠸ bun test scroll.test.ts

                                               ▣  Build · Test Model

  ~/opencode/packages/tui:main              ┃  Build · Test Model TestProvider · medium
                                            ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  • SilverCode 0.0.0-test                    ■  esc interrupt                                         29.7K (15%) · $0.42  ctrl+p commands
```

### Permission, 140×40 — after (single row still fits)

```
                                            ┃  △ Permission required
                                            ┃    # Shell command
                                            ┃
                                            ┃  $ bun test scroll.test.ts
                                            ┃
  ~/opencode/packages/tui:main              ┃
                                            ┃   Allow once   Allow always   Reject           ctrl+f fullscreen  ⇆ select  enter confirm
  • SilverCode 0.0.0-test                   ┃
```

### Scrolled away, 140×40 — after (chip in the gap row, draft intact)

```
                                            ┃  Question 28
                                            ┃
                                               Reply 28
                                               line two
                                               line three
                                                                                                            ↓ Jump to latest · ctrl+alt+g
                                            ┃
                                            ┃  draft text
                                            ┃
  ~/opencode/packages/tui:main              ┃  Build · Test Model TestProvider · medium
                                            ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  • SilverCode 0.0.0-test                    /tmp/opencode/packages/tui                                        tab agents  ctrl+p commands
```
