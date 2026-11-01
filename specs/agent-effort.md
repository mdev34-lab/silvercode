# Agent effort

The agent effort dial controls how much process a task gets before its result is
delivered. There are exactly three levels and two switches — no other knobs.

## Levels

| Level              | Review passes                | Validation gate |
| ------------------ | ---------------------------- | --------------- |
| `fast`             | none required                | minimal         |
| `medium` (default) | at least one; bounded by two | standard        |
| `thorough`         | until-clean, no finite cap   | full            |

- **`fast`** delivers as soon as the work is done. No independent review is
  required; the delivery is honestly labelled `unreviewed` unless a review
  actually happened.
- **`medium`** requires at least one clean synchronous review of the current
  tree before delivery. Only blocking findings (Critical/Important, or a
  Needs-fixes report with no findings) or work landed after the last review
  force another pass; after two passes the result is delivered with an honest
  exhausted/open-findings status instead of looping forever.
- **`thorough`** keeps requiring a clean, current independent review until one
  exists. When the reviewer genuinely cannot run (permission, missing agent, or
  the subagent depth limit), a successful finish remains blocked. Only a
  declared failure can deliver as `review-blocked`; a depth-limited child hands
  its unreviewed writes to its parent as `review-pending`. Neither status is
  approval.

## Configuration

The canonical setting is the nested `agent.effort` scalar in `opencode.json`:

```json
{
  "agent": {
    "effort": "fast"
  }
}
```

- Omitted, the level is `medium`. Invalid values are rejected at load time.
- The setting is a policy, not an agent: it is never enumerated as a named
  agent, and named agent definitions live separately under `agents` (or the
  legacy `agent` map). Both survive together in mixed documents; when a legacy
  document and a native v2 document define the same agent or provider, the
  native definition wins.
- A legacy named agent literally called `effort` (object-valued entry) keeps
  migrating as a named agent, not as the policy.

## Effective level precedence

For any given task the effective level is resolved in this order:

1. an explicit `task()` override;
2. the child's persisted selection when resuming an owned child;
3. the parent's persisted selection for a new child;
4. the root session's persisted selection;
5. the `agent.effort` configuration;
6. `medium`.

The selection persists on the session (including forks, which copy the
selection) and siblings stay independent: one child's level never leaks into
another. A task dispatched by a parent that does not own the child (for
example, a `task_id` from another parent) neither reads nor writes that child's
selection, and no effort is published for it in the task metadata.

## TUI default for new sessions

The TUI's home screen owns one extra piece of state: the default a newly created
session starts from. Selecting a level on home (the selector behind `/effort`)
persists it to `effort.json` in the app state directory as
`{"agentEffort": "<level>"}`, and a new session is created with that level in its
`metadata.agentEffort`. Nothing else changes: enforcement still reads the
session, so the persisted default becomes the new session's own selection rather
than a second policy layer.

- Effective default: the persisted `effort.json` value, then `agent.effort`,
  then `medium`.
- A selection made on home is stored on the file only — it never overwrites the
  selection of an existing session, and a selection made inside a session is
  stored on that session only.
- A failed write is reported (a warning toast) and the displayed default rolls
  back to the last value that really landed, so the label never claims a level
  that was not persisted.
- The selector marks the level that is in effect and labels its scope
  ("Default for new sessions" on home, "Stored on this session" inside a
  session). Level names are always rendered as text next to their hue.

## Where enforcement lives

`finish` is the only enforcement checkpoint. It evaluates the persisted
history of the current user turn and, when the effective level requires an
independent review that has not happened, declines the call with recoverable
feedback. Repeating `finish` never waives a required review: the decision
depends only on the persisted review state. The reviewer must run
synchronously (`subagent_type: "review"`, `background: false`); a background
review, a failed review, a malformed report, or a review of a different turn
does not count. A `subagent_wait` ending is a provisional `waiting` yield, and
read-only turns are exempt with a status distinct from approval. A declared
`failure` still requires review when a reviewer can run; when dispatch is
unavailable it can deliver honestly as `review-blocked` instead.

A background child's delegated writes are accounted when its completion
notification lands; a `finish` issued before that lands sees the turn as
write-free and is exempt, and the next turn is gated on the recorded writes.

## Validation evidence

The `finish` tool accepts an optional agent-reported validation declaration:

```json
{
  "checks": [{ "category": "syntax", "status": "passed", "detail": "biome check" }]
}
```

- Categories: `syntax`, `smoke`, `tests`, `typecheck`, `parity`. Statuses:
  `passed`, `failed`, `not-run`, `not-applicable`.
- The minimal gate is satisfied by either applicable check (syntax **or**
  smoke) passing, or by both being explicitly not-applicable. The standard
  gate requires `tests`; the full gate requires `tests`, `typecheck`, and
  `parity` (an explicit not-applicable satisfies a category).
- A `failed` check fails the report regardless of everything else. Empty,
  all-not-run, or missing evidence stays `incomplete`, and incomplete or
  failed evidence stays visible in the result even when review is clean.
- Nothing here is executed or verified: these checks are reported evidence
  only, recorded as `metadata.validation` with `source: "agent-reported"`.

## Delivery status

`metadata.review` on a finished task carries the honest delivery labels:
`effort`, `disposition` (`reviewed` or `unreviewed`), `reviews`, an optional
finite `maxIterations`, `termination`, `openFindings`, `blockingFindings`,
`workSinceReview`, and an optional `unavailableReason`. `termination` is one
of `approved`, `unreviewed`, `findings-open`, `budget-exhausted`,
`review-blocked`, `review-pending`, `not-required`, or `waiting`. `reviewed`
means a valid independent review was performed — not that the current tree is
clean; the termination and stale/open fields carry that distinction. The old
`review-unavailable` value remains readable only for legacy transcripts.

## Legacy compatibility

The older `review_loop.max_iterations` configuration remains readable by older
tooling but does not override the effort policy: the pass budget belongs to
the level (`medium` is two, `thorough` is until-clean). Legacy transcripts
with the old nudge/cap metadata remain readable, but the old
skip-on-repeat-finish behavior is gone.
