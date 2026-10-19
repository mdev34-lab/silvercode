# Session tabs (issue #240)

Status: implemented in the interactive TUI (`packages/tui`). Surface: **TUI only**.
The web/webchat surface is not covered.

Base: silvercode tip `945c1b3e6` (see "Base and upstream" below).

## Base and upstream

- Fork base for this work: `945c1b3e6`. That commit is not on the public
  `mdev34-lab/silvercode` remote; the tree was taken from the uploaded
  integration zip and committed as a local base so the patch applies to it.
- The brief's earlier base `9948cb2` differs from the tip tree: the #242 worker
  and owner-watch changes, `terminal.suspend` wording, `docs/tui/background.md`,
  `turbo.json` test task names, and unrelated qwen-web/webchat/prompt changes.
- Upstream OpenCode version: **v1.18.19**, the last upstream sync in fork history
  (`1a1b7a96e`). The reference screenshot is a terminal UI; this repo has no
  desktop/app package, so no desktop tab behaviour is assumed.

## Behaviour

- One tab per open session, in the TUI tab strip above the session view. The
  strip is shown whenever at least one tab is open, including on the home screen.
- Opening: any navigation to a session opens (or re-activates) its tab. The
  session list, `--session`, and `--continue` all go through the same route.
- Selecting: click a tab, or `ctrl+pagedown` / `ctrl+pageup` for next/previous.
- Closing: `<leader>w` (leader is `ctrl+x`) or the palette command "Close session
  tab". Closing removes only the tab. The session, its messages, any running
  work, its unsent draft and its model/agent choice are kept. Reopen the session
  from the session list.
- Drafts: each session has its own unsent prompt and cursor. The home screen has
  its own draft slot. An empty prompt clears the saved draft.
- Model/agent choice: saved per session when the user leaves it, and re-applied
  when the user returns. A session with no saved choice falls back to its last
  user message, as before.
- Running state: a session that is busy or retrying shows a green dot.
- Attention: a background tab shows a yellow diamond when its session finishes a
  run (busy to idle) or is waiting on a permission or question. Attention never
  moves focus. It clears when the tab is opened.
- Narrow widths: tabs are windowed around the active tab with `‹n` / `›n` overflow
  counts. Titles are truncated with an ellipsis. Each visible tab keeps at least a
  4-character title.
- Restore: the list of open tabs is saved in the TUI KV store (`session_tabs`) and
  restored at startup in saved order. Sessions that no longer exist are dropped.
  Restore never changes the route; the startup route still decides the active tab.

## Surfaces and the detached worker (#242)

- Tab switching never signals the server worker. The worker runs in its own
  process group, so `ctrl+z` (SIGTSTP), `ctrl+c`, and terminal close (SIGHUP) reach
  only the UI. A background session keeps running while another tab is active.
- Attention is set from sync events, not from the render loop. Whether an event
  that arrives while the UI is suspended is raised on resume is not tested here.
- Closing a tab is not the same as closing the terminal. Terminal close (SIGHUP)
  still quits the UI and shuts the worker down, as documented in
  `docs/tui/background.md`. Tab shortcuts avoid `ctrl+z` and `ctrl+c`.

## Changes that are visible outside tabs

- Prompt drafts are keyed by session. Previously a single module-level slot
  carried one session's draft into whichever prompt mounted next; that leak is the
  bug the state-isolation regression covers.
- Deleting the active session now moves to a neighbouring tab, or home if none is
  left (previously always home).

## Where the code is

- `packages/tui/src/session-tabs/model.ts`: pure state (open, active, attention,
  drafts, selections), layout and truncation. No Solid, no I/O.
- `packages/tui/src/context/session-tabs.tsx`: provider. Watches the route, the
  sync session status and permission/question queues, and persists the tab list.
- `packages/tui/src/component/session-tabs-bar.tsx`: the strip.
- `packages/tui/src/component/prompt/index.tsx`: per-session draft and selection
  save/restore. Replaces the old module-level `stashed` slot.
- `packages/tui/src/app.tsx`: provider wiring, the bar, the three commands, and the
  deleted-session handling.
- `packages/tui/src/config/keybind.ts`: `session_tab_next` (`ctrl+pagedown`),
  `session_tab_prev` (`ctrl+pageup`), `session_tab_close` (`<leader>w`).

## Tests

- `packages/tui/test/session-tabs/model.test.ts`: state isolation, close/reopen,
  attention, restore, layout, truncation.
- `packages/tui/test/session-tabs/keybind.test.ts`: shortcut defaults and command
  names.
- `packages/tui/test/cli/tui/session-tabs.test.tsx`: renders the production
  composer and bar against a fake server. Covers draft isolation across repeated
  switches, background busy/attention without focus change, close and reopen
  without cancel or delete, normal and narrow layout, and restore.

## Deliberately left out

- Per-workspace grouping. One tab per session only.
- Persisting unsent drafts across a TUI restart. Drafts live for the life of the
  UI process; the tab list persists.
- Attention for sessions that have no open tab. The existing notification plugin
  still fires for them.
- Per-session effort. Effort is already stored on the session server-side.
- Web/webchat tabs.
- Keystroke-level end-to-end test in the full App harness (see the design note).
