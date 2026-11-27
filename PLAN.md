# Issue #866 plan

- [x] Inspect repository instructions, provider integration, issue, upstream Pollinations source/docs, and AI SDK v3 interfaces.
- [x] Record investigation limitations: no Pollinations credential is available and direct access to `gen.pollinations.ai` is blocked in this sandbox.
- [x] Add a Pollinations-only AI SDK middleware translating the affected text protocol into native reasoning, text, and validated tool-call events.
- [x] Add a sanitized observed-response transcription and deterministic streaming/non-streaming regression coverage.
- [x] Run focused Pollinations/provider HTTP tests, typecheck, Oxlint, and Prettier.
- [x] Review protocol ambiguity, fragmented streams, event ordering, tool allowlisting, and malformed-input behavior; add quoted-tag/ordinary-JSON guards.
- [x] Document unavailable live API and screenshot verification in the PR rather than presenting mocked output as live evidence.
- [ ] Open PR and link issue #866.
