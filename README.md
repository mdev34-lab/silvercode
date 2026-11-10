# silvercode

[![test](https://github.com/mdev34-lab/silvercode/actions/workflows/test.yml/badge.svg?branch=dev-vibecoded)](https://github.com/mdev34-lab/silvercode/actions/workflows/test.yml)

SilverCode is an OpenCode fork for coding runs on weak or free models and unreliable provider connections. It does not assume the model is strong or the stream stays alive. The harness adds planning and review agents, a finish contract, an effort policy, truncation-aware retries, and a bounded headless retry policy around the model.

## What this fork adds

### Agents

The built-in agents are defined in `packages/opencode/src/agent/agent.ts`:

- `work`: primary general-purpose agent for arbitrary folders and mixed-file workspaces. It can delegate to `code`, `think`, `general`, `explore`, and `review`.
- `code`: software-engineering specialist with LSP and repository context. In Work's programming workflow it returns its implementation to Work, which owns review. It cannot delegate to `work` or another `code`.
- `think`: planning specialist that researches the codebase and web, writes plan documents, and cannot edit code.
- `explore`: fast, read-only codebase search and question answering.
- `review`: independent reviewer. It verifies with read-only inspection and non-destructive commands, cannot edit, and returns a structured `<silvercode-review>` verdict.
- `general`: subagent for multi-step research and parallel units of work.

### Finish contract

A reply is not complete just because the model stopped generating. The model must call `finish` exactly once at the end of every reply, including greetings and answers that used no tools. The call declares `success`, `waiting_for_subagent`, `subagent_wait`, or `failure`, and includes a concise result. If a turn ends without a successful `finish`, the runtime sends a warning nudge and continues the turn, bounded by `MAX_FINISH_NUDGES = 3` plus one stagnation nudge.

`finish` is also the enforcement checkpoint for review. It evaluates the persisted review state for the current turn. Repeated `finish` calls do not waive a required review. The result is labelled with the honest delivery state: `approved` only after a clean independent review, or `unreviewed`, `findings-open`, `budget-exhausted`, `review-blocked`, or `review-pending`.

`finish` accepts optional validation evidence with categories `syntax`, `smoke`, `tests`, `typecheck`, and `parity`. This evidence is agent-reported and recorded as `metadata.validation`; the runtime does not execute or verify those checks.

### Effort policy

The effort dial controls review passes and the validation gate. Set it in `opencode.json`:

```json
{
  "agent": {
    "effort": "medium"
  }
}
```

- `fast`: no required review, minimal validation gate. Delivery is `unreviewed` unless a review actually happened.
- `medium` (default): at least one clean synchronous review, at most two completed passes, standard validation gate (`tests`).
- `thorough`: review until clean with no finite cap, every known finding including Minor must be fixed, full validation gate (`tests`, `typecheck`, `parity`).

The effective level resolves from an explicit `task()` override, the child's persisted selection, the parent's selection, the root session selection, `agent.effort`, then `medium`. The selection is persisted on the session, and changing it affects the next generation step and the next `finish` call. See `specs/agent-effort.md`.

### Stream and retry handling

- The LLM route layer tracks protocol-terminal events. A clean EOF without one is treated as proxy or gateway truncation and fails into the retry pipeline instead of completing silently (issue #407, `packages/llm/src/route/client.ts`).
- The OpenCode Zen adapter detects a stream that ends before the completion frame, turns it into an in-band stream error, and supports a configurable `chunkTimeout` stall guard (`packages/opencode/src/provider/opencode-zen.ts`). Zero-cost Zen models are routed through this adapter.
- If a stream dies after the provider issued tool calls, the failure becomes `StreamInterruptedAfterToolCallError` and is not sent down the normal retry path, because re-issuing the request would replay those tool side effects. Text-only attempts stay on the normal retry path (`packages/opencode/src/session/processor.ts`).
- That error has an automatic resume path when every issued tool call has a persisted completed result: the runtime reports `Stream interrupted; resuming from persisted tool results`, waits a bounded backoff (`resumeAttempt < RETRY_MAX_RETRIES = 5`), and rebuilds the next request from storage. The backoff is interruptible with Esc/Ctrl+C. Missing, running, pending, or errored tool results fail closed: no auto-resume, the error surfaces, and the user continues the conversation manually (`processor.ts`, `packages/opencode/src/session/retry.ts`).
- Headless `silvercode run` turns cap a single provider retry delay at 60 seconds and fail immediately with the original error when a `retry-after` window exceeds that ceiling (issue #555). Interactive TUI and `--mini` sessions keep unbounded retry reporting. `OPENCODE_EXPERIMENTAL_RETRY_MAX_DELAY_MS` overrides the ceiling for headless runs. See `docs/headless-retry.md`.

### Context reduction

Before each provider request, the runtime derives a deterministic projection of canonical history. The canonical history is never modified, and the next request starts again from it. The projection runs only above the configured threshold (default `0.8`) and uses progressively stronger rungs: duplicate outputs, stale error inputs, stale outputs, then oldest turns. Recent turns and protected tools are never reduced. Configure it under `context.reduction` and `context.protection`. See `docs/context-reduction.md`.

## Installation

There are no published GitHub Releases yet, so build from source:

```bash
git clone https://github.com/mdev34-lab/silvercode.git
cd silvercode
bun install
./packages/opencode/script/build.ts --single
```

The binary is written to `./packages/opencode/dist/silvercode-ai-<platform>/bin/silvercode`. The executable is named `silvercode`.

The repository also contains an `install` script for the future release path. Once a release is published, the intended one-liner is `curl -fsSL https://github.com/mdev34-lab/silvercode/releases/latest/download/install | bash`. No release exists yet, so that URL returns 404 today; build from source until then. The script installs to `~/.opencode/bin`.

## Usage

```bash
silvercode                              # open the TUI in the current project
silvercode run "fix the failing test"   # non-interactive run
silvercode run --continue               # continue the last session
silvercode run --model provider/model   # select a model
silvercode run --format json            # stream raw JSON events
silvercode --mini                       # interactive split-footer mode
silvercode serve                        # run the HTTP server
```

Other CLI commands include `models`, `providers`, `session`, `stats`, `db`, `export`, `import`, `github`, `pr`, `mcp`, `acp`, `upgrade`, and `uninstall`. Run `silvercode --help` or a command's `--help` for the current flags.

## Configuration and data

Project configuration is read from `opencode.json` or `opencode.jsonc` and the project `.opencode/` directory. Global configuration and data use the existing OpenCode XDG paths, normally `~/.config/opencode` and `~/.local/share/opencode`. The install script places the binary in `~/.opencode/bin`.

Sessions are stored in a project-scoped SQLite database. The database path is selected by `Database.path()` and can be overridden with `OPENCODE_DB`. The default file is under the global data directory.

## Current limitations

- Zero-shot endurance is the goal, not a guarantee. A weak model can still stop early; the finish nudge keeps the turn moving but cannot make the model correct.
- The generic truncation guard only applies when a provider protocol declares a terminal event. Tool-call stream interruptions auto-resume only when every issued tool call has a persisted completed result, within a bounded retry budget; unfinished tool work (missing, running, pending, or errored results) stops and requires manual continuation.
- Post-crash continuation recovery is not automatic. Session history is durable in SQLite, and explicit `run` or resume can continue from projected history, but the runtime does not infer that ambiguous provider work is safe to retry after a crash.
- Validation evidence is not executed by the harness. `finish` records what the agent reports; it does not run tests, typecheck, or parity checks.
- No prebuilt binaries, npm package, or published releases yet. Build from source.
- Windows CI runs the same unit suite as Linux with a 40-minute timeout and the file watcher disabled; Linux is the platform used for the reference checks.

## Documentation

- `specs/agent-effort.md`: effort levels, review passes, validation gates, and delivery status.
- `specs/explore-agent.md`: read-only explore agent design.
- `docs/headless-retry.md`: headless retry ceiling and transport contract.
- `docs/context-reduction.md`: deterministic context reduction.
- `docs/releasing.md`: release process and version checks.
- `AGENTS.md`: repository conventions for contributors.

## License

MIT. See `LICENSE`.
