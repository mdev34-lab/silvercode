# Review text TUI captures

These captures use only synthetic fixture data. `single` is a completed review in one text part; `multipart` is the same kind of report across two parts; `streaming` is an incomplete reviewer stream; `ordinary` is a non-review assistant response. They are evidence for the draft, not a screenshot of a user's project.

Each `.ansi` is the actual terminal byte stream emitted by the OpenTUI **live** renderer and `AssistantMessageRow`, running `packages/tui/test/cli/tui/review-text-capture.tsx` under a 100×24 pseudo-terminal. The PNGs are screenshots of those streams replayed in xterm.js (the alternate-screen exit at the end is omitted to leave the last frame visible). They are not manually drawn UI mockups. The synthetic runtime uses the repository's TUI test contexts; no provider or project data is involved.

For example, from `packages/tui` with Bun installed:

```sh
script -q -e -c 'stty cols 100 rows 24; bun test/cli/tui/review-text-capture.tsx multipart' /dev/null > multipart.ansi
```

The four streams were recorded again from code at `d75acc0` after the conservative delivery-boundary changes. They were byte-for-byte identical to the committed streams; the PNGs were regenerated from the fresh recordings. These examples do not demonstrate the unresolved cross-message history case or background-review provenance.

## Execution history captures

The seven `history/` PNGs and `.ansi` files use synthetic data only. They were recorded with the live OpenTUI renderer and the actual `UserMessageRow` / `AssistantMessageRow` components in `packages/tui/test/cli/tui/review-history-capture.tsx`. The text and finish cases show the later report in one execution; nudge uses the runtime's exact synthetic nudge; separate uses a second real user request; boundary includes a completed finish before the next turn; streaming and malformed show the ordinary fallback. The synthetic harness supplies the same message/part state as the real-route tests; it is not a capture of a user's project or the complete Session route.

For example, from `packages/tui`:

```sh
script -q -e -c 'stty cols 120 rows 48; bun test/cli/tui/review-history-capture.tsx nudge' /dev/null > nudge.ansi
```

The PNGs are screenshots of these actual terminal streams replayed at 120×48 in xterm.js, with the alternate-screen exit omitted so the last frame stays visible. These streams were freshly recorded from production rendering code at `e3b6dcf`, using the shared reactive execution index in the synthetic component harness; the streams are byte-for-byte identical to the earlier captures. The PNGs were regenerated from those fresh recordings. This is not a full Session-route capture.
