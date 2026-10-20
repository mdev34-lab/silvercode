# Context reduction contract

- Owner: core `SessionContextReduction` (packages/core/src/session/context-reduction.ts) is the only implementation. It is deterministic: the same history, envelope, model and policy give the same projection.
- Canonical history is never modified. Each provider request derives a projection from it; the next request starts again from canonical history, so nothing resets or diverges across turns.
- Runtime path: `packages/opencode/src/session/prompt.ts` runs the adapter (`session/context-reduction.ts`) right before the history is lowered to model messages. The model receives the reduced context through the normal request path, with no synthetic prompt instructions.
- Budget: measured against the usable window of the model, counting system prompt and tool definitions. Below `threshold` (default 0.8) the history is sent untouched.
- Rungs, cheapest first: duplicate outputs, stale error inputs, stale outputs, drop oldest. Recent turns and protected tools are never reduced.
- Config: `context.reduction.{enabled,threshold,error_turns}` and `context.protection.{recent_turns,tools,files}`.
- Reporting: one `session.next.context.prepared` event per request carries the report. Clients only render it; they never re-derive state.
