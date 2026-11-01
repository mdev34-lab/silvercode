# Review text TUI captures

These captures use only synthetic fixture data. `single` is a completed review in one text part; `multipart` is the same kind of report across two parts; `streaming` is an incomplete reviewer stream; `ordinary` is a non-review assistant response. They are evidence for the draft, not a screenshot of a user's project.

Each `.ansi` is the actual terminal byte stream emitted by the OpenTUI **live** renderer and `AssistantMessageRow`, running `packages/tui/test/cli/tui/review-text-capture.tsx` under a 100×24 pseudo-terminal. The PNGs are screenshots of those streams replayed in xterm.js (the alternate-screen exit at the end is omitted to leave the last frame visible). They are not manually drawn UI mockups. The synthetic runtime uses the repository's TUI test contexts; no provider or project data is involved.

For example, from `packages/tui` with Bun installed:

```sh
script -q -e -c 'stty cols 100 rows 24; bun test/cli/tui/review-text-capture.tsx multipart' /dev/null > multipart.ansi
```
