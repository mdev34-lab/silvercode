# Background work and UI lifetime

The interactive TUI splits into two processes on POSIX: the UI (renderer,
input, attention) and the server worker (sessions, tools, LLM traffic). The
worker is spawned in its own process group, so terminal job-control signals
reach the UI only. UI foreground state and the lifetime of active work are
separate: backgrounding the UI never pauses or kills a running session, and
returning never starts a job twice.

## Supported surface and decisions

The supported surface is the interactive TUI (`silvercode`, default command)
with the embedded server worker under `bun`. The cases below are the
implemented contract; anything not listed is not promised.

| Case | Behavior |
| --- | --- |
| Minimize / blur the terminal window | Work continues. Both processes keep running; nothing is signalled. Attention (sound, native or terminal notification) fires live on blur for permission, question, completion and error events — see `notifications.md`. |
| `ctrl+z` (`terminal.suspend`) | Work continues. The UI suspends itself; SIGTSTP targets the UI's process group only. Resume with `fg`. |
| Return to the UI (`fg`) | Current state and result are shown, with no duplicate run starts. Events produced while suspended are queued by the worker's IPC channel and delivered on resume; the run itself was never interrupted, so there is nothing to restart. Attention signals for events that arrived while suspended fire on resume. |
| Close the terminal window / terminal disconnect (SIGHUP) | **Quit**, not hide-to-background. The UI's SIGHUP handler shuts the worker down (RPC shutdown, then terminate) and exits. In-flight work is abandoned; the transcript up to that point is persisted. For unattended runs use `silvercode serve` and `silvercode attach`, whose server outlives any UI. |
| `ctrl+c` (SIGINT) | Quit. SIGINT reaches only the UI, which asks the worker to shut down gracefully and then terminates it. |
| UI killed without cleanup (SIGKILL/OOM/crash) | No orphan. On POSIX the worker watches the IPC channel to the UI (which closes the instant the UI process dies) plus a PID-liveness probe fallback; when the owner is gone the worker shuts itself down gracefully (hard-exit bound of 5s) and exits. On Windows neither signal observes a hard-killed owner (#480), so the UI puts the worker in a kill-on-close Job Object instead and the OS terminates it with the owner (#442). |
| OS suspend (laptop sleep, cgroup freeze) | Not supported as continued work. The kernel freezes both processes; work resumes when the OS resumes. Nothing is promised across the freeze. |
| Terminal closed *while the UI is suspended* | Unsupported corner. If the terminal emulator sends SIGCONT after SIGHUP (xterm-style), the UI resumes, delivers the hangup and shuts the worker down. If it does not (e.g. `ssh host silvercode` with no shell), the worker finishes the current run and stays idle waiting for its owner; resume the UI or `kill` the worker. Prefer `serve` + `attach` for unattended work. |

## Boundaries that are not this lifecycle

- **Compiled single-binary builds** host the worker as a thread in the UI
  process. There is no process boundary: `ctrl+z` suspends work with the UI and
  closing the window ends both. The guarantees above apply to subprocess-worker
  builds (`bun` and packaged installers that spawn the worker).
- **`silvercode run` and `--mini`** execute in one process; suspending them
  suspends the work. They are batch surfaces, not background surfaces.
- **Windows** keeps its existing console semantics: no process-group job
  control, `terminal.suspend` disabled. Owner-death cleanup does not rely on the
  worker's watchdog there: the UI assigns every spawned worker to a Job Object
  with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so the OS kills the worker when the
  UI process dies, hard kill included. The assignment is best-effort (nested
  jobs are unavailable on some configurations); when it fails the worker keeps
  its watchdog as the fallback.

## Failure paths

- Worker crash mid-run: bounded restart (3 attempts) as before; in-flight RPC
  calls are rejected, never replayed, so no work is executed twice. A run that
  was executing in the crashed worker does not resurrect itself.
- Long suspensions: the worker keeps streaming events into the IPC channel
  while the UI is stopped; they are buffered and delivered on resume. Very long
  suspensions of very chatty runs grow the worker's send queue in memory.
