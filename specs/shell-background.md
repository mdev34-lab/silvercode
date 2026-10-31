# Shell auto-backgrounding (#726)

Long shell commands have a survival path: a command that outlives the inline
window is promoted to a background job instead of being killed, and the agent
keeps a non-blocking way to inspect and stop it.

## Contract

- **Promotion, not re-execution.** The threshold fires on the same child process
  the tool call spawned. Nothing is killed, restarted, or replayed; the output
  fiber keeps streaming into the same bounded buffers.
- **Only unbounded calls promote.** `timeout` passed by the caller stays a
  caller-set deadline with the existing kill semantics. Promotion applies solely
  when the deadline came from the tool's own window.
- **Threshold.** `bashBackgroundThresholdMs`, falling back to the older
  `bashDefaultTimeoutMs` (the same knob's previous name: how long a command may
  occupy the call), then 5 minutes.
- **Notification.** The owning session is woken through the background-result
  path the task tool uses: wait on the job, then prompt with a synthetic
  `<shell_background>` envelope. Cancellation and teardown produce terminal
  envelopes too; a teardown cancel is delivered silently so the session being
  stopped is not resurrected.
- **Bounded capture.** Background output reuses the inline machinery
  (`Truncate.limits`, the TUI preview, and the spill file), so a chatty process
  cannot grow memory without limit.

## Registry use

Jobs live in the existing `BackgroundJob` registry (`type: "shell"`), with
`metadata.sessionId` owned by the calling session so teardown walks
(`SessionRunState.cancelBackgroundJobs`, `Session.remove`) sweep them like any
other job the session owns. The registry entry records status and terminal
output; a per-registry handle map holds the live snapshot and the kill for the
running process, which is what makes `status` non-blocking and `cancel` real.

## Tool surface

`shell_background` with `action`:

| Action   | Behavior                                                                 |
| -------- | ------------------------------------------------------------------------ |
| `list`   | the calling session's shell jobs, newest first                            |
| `status` | current status plus partial output; returns immediately                   |
| `output` | output captured so far, bounded by the truncation limits                  |
| `cancel` | claims the cancellation, then kills the process tree                      |

No TUI surface is added: the job list is already exposed by the experimental
server route, and the model-facing envelopes carry everything the agent needs.
