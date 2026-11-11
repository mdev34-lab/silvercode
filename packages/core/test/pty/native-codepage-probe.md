# Native ConPTY codepage probe (test-only diagnostic)

Diagnostic measurement only. Not a product fix. Runs as 6 test cases in normal CI on Windows; skipped on non-Windows. Applies no output decoder; every chunk is recorded as the backend delivered it.

## Node runtime

Node backend cases run through a bounded OS-temporary Node bridge that imports the actual `src/pty/pty.node.ts` wrapper. The import specifier is constructed as a `file:` URL (`sourceUrl`) so Windows drive paths remain valid ESM specifiers. They do not run node-pty under Bun.

Host-side node runtime tests use `useNodeExecutable` so the generated bridge passes its own `process.execPath` to the PTY wrapper; otherwise the literal file is passed through unchanged. This matters on Windows because a literal executable name is looked up without appending `.exe`, so bare `node` can fail there even when Node is available. Native `Add-Type` behavior plus the two pipe fixtures remain unknown on this host.

## Generic extra-fd pipe control

The host-side EPIPE control uses a generic Node writable pipe and never stdin: it spawns `node` with explicit `stdio: ["ignore", "pipe", "pipe", "pipe"]`, so descriptor 3 is a separate inherited pipe and descriptor 0 is `ignore`. In the positive arm the grandchild closes descriptor 3 and acknowledges over stdout; the parent writes 16 MiB to `child.stdio[3]` only after that ack and expects an asynchronous `EPIPE`. In the negative arm the grandchild leaves descriptor 3 open, acknowledges, and must report `NO_ERROR` while it stays alive. A third arm keeps a genuine external Node child alive without ever acknowledging and must report `ACK_TIMEOUT`. All arms share one 4000 ms deadline measured from the start of the control, so the ack wait and the error wait are bounded by that same total rather than by a budget that restarts after the ack, and the grandchild self-exits after 4500 ms so a killed or failing control cannot leave it behind. Every arm sets the documented `net.Socket.allowHalfOpen` property before the child closes its end so Node does not auto-end the writable side on readable EOF; they do not mutate private stream fields, emit errors, or accept a synchronous throw as EPIPE. Cleanup kills only a still-live `ChildProcess` object and settles inside a separate 1000 ms deadline that is proven only by a real `close` event: an `exit` event is not proof that the stdio pipes are done, a failed kill is recorded as a kill error instead of a join, and a missed deadline reports `joined: false` instead of a fake join. The outer harness reads the report under its own 5000 ms bound with a child `error` handler, keeps the ack capture at 4096 bytes and the report capture at 8192 bytes, and drains both the grandchild stderr and the control stderr so no pipe can block a child.

Source contract: Windows libuv `fs__close` calls `_close(fd)` only for `fd > 2` and returns success without closing for 0-2, so descriptor 3 is a real close while `fs.closeSync(0)` is a no-op. See [Node v24.0.0 `deps/uv/src/win/fs.c`](https://github.com/nodejs/node/blob/v24.0.0/deps/uv/src/win/fs.c) and the pinned [`net.Socket.allowHalfOpen` documentation](https://nodejs.org/docs/latest-v24.x/api/net.html#socketallowhalfopen). This host runs Linux; Windows runtime behavior remains unproven here.

## Running

From `packages/core`:

```bash
bun test test/pty/native-codepage-probe.test.ts
```

From `packages/core/test/pty`:

```powershell
bun test native-codepage-probe.test.ts
```

Select a backend or mode (Windows PowerShell):

```powershell
$env:PROBE_BACKEND = "node"
$env:PROBE_MODE = "baseline"
bun test native-codepage-probe.test.ts
```

The package test command remains `bun test --timeout 15000 --only-failures`; each case declares its own 30000 ms budget. Do not increase timeouts.

Per-case guard is 20s; per-test budget is 30s.

Cleanup shares one 5000 ms deadline for the whole joined cleanup: the tree kill runs first, then the bridge is asked to shut down only while it is still alive, then the bridge is killed and the close is joined with whatever budget is left. Each bridge and PTY pid is killed at most once, and repeated cleanup calls return the same joined promise instead of paying the deadline again. The cleanup fails closed: it is recorded as a cleanup failure, and fails the case, when the deadline is missed, when the bridge and PTY pids cannot be resolved, or when the PTY child termination cannot be confirmed. Termination is confirmed only by a confirmed PTY exit, by a taskkill tree that covered the child, or by a liveness probe that answers ESRCH for a positive pid; an accepted kill signal is not a proof of death and is confirmed by a bounded probe inside the same deadline. The liveness probe is tri-state: only ESRCH proves a pid is gone, only EPERM proves it is alive, and every other error, including an invalid pid, is unknown and never satisfies the cleanup. A stdin transport error raised by the intentional cleanup is recorded separately and is not reported as a measurement failure. These checks describe the taskkill tree and the liveness contract only; they make no claim about what the operating system reaped.

## Paths

Test imports resolve to `../../src/pty/...` relative to this directory. The helper is `native-codepage-probe-helper.ps1`.

## Results lifecycle

Results are written only to a bounded OS temporary directory and removed after a bounded JSON diagnostic is logged. The diagnostic includes raw escaped `output` and `chunks` under the 256 KiB capture cap, plus lengths and observations. No result files are committed or retained in the test tree.

## Inputs and privacy

Inputs are synthetic and non-sensitive (file name `ação-日本.txt`, text `ação-日本 ok`). No private owner data or source logs are included.

## Startup handshake

The harness responds only to a top-level DA1 query (`CSI c` or `CSI 0 c`) with a bounded VT100 DA1 response (`ESC[?1;2c`). Bytes inside OSC or DCS sequences are not treated as queries, including when the query-like text is split across chunks. This addresses the observed PowerShell startup query; it is measurement harness behavior, not a product fix.

## Root-cause status

The PowerShell startup-query explanation remains an unproven hypothesis. The harness now records DA response counts, startup-marker visibility, and PID identities, but Linux cannot establish Windows ConPTY behavior.

## Native Node boundary (unresolved)

On Windows CI the Node backend produces output only up to and including `PROBE_STAGE helper-startup`: no `PROBE_CP` stage is recorded, the helper never reaches `PROBE_DONE`, and the case ends on the 20s guard. The Bun backend reaches `PROBE_DONE` in the same run.

The recorded `procPid`/`wrapperPid` of 0 is a measurement artifact, not a finding: `@lydell/node-pty` copies the agent pid into the terminal at construction and only refreshes it on `ready_datapipe`, so the wrapper reads a pid that is still 0. This explains the recorded number only. It is not a claim about why the Node backend stalls, and it is not treated as evidence for any cause.

To narrow the boundary, the helper now emits `PROBE_STAGE add-type-start`/`add-type-end` around the `Add-Type` compile and `PROBE_STAGE cp-before-start`/`cp-before-end` around the first codepage read. A failed phase emits one bounded `PROBE_ERROR` line and then rethrows, so the helper still exits nonzero and the failing phase is named instead of inferred.

These markers are emitted after the startup marker, so the startup responder gate is unchanged: the harness still answers the DA1 query exactly as before, and the phase markers never enable or disable the responder.

This is a measurement improvement, not a root cause. The cause of the Node-backend stall is still unknown: this host never executes native Windows ConPTY, and nothing in the recorded output proves what the child was waiting for.

## Bridge failure diagnostics

A bridge that exits before it reports a spawn now fails with the bounded stderr it wrote, its exit code, its signal, and its runtime version instead of an empty stderr. On that early-exit path the diagnostic is built when the child's stdio closes, not when it exits, so stderr written after the bridge exited is included; the drain is bounded by the existing 5s startup deadline. The `child` error path reports the stderr available at that moment, and the startup deadline path reports whatever is available if the close event has not arrived in time. The bridge reports its runtime before it imports the PTY wrapper, so a bridge that dies while loading it still names the runtime it died in. The stderr capture is bounded twice: the stream capture keeps the newest bytes up to the capture cap, and the diagnostic keeps the newest 4096 characters of that capture, so the head of a longer capture is dropped on purpose.

## Startup failure cleanup ownership

When the bridge never reports a spawn, the startup failure path tree-kills the bridge before it is killed itself. The numeric pid of the bridge child is targeted only while no exit or signal has been observed for that `ChildProcess`: both `exitCode` and `signalCode` must still be null. Once either is set, that number may already belong to an unrelated process, so it is never targeted. The close-time drain of the early-exit path widens exactly that window, so the observed-exit check is what keeps the numeric pid out of the tree kill.

This is the observed-exit contract of the `ChildProcess`, not an OS ownership handle. It does not close the race between the OS reaping the process and the exit event being delivered, and it provides no way to prove what happened to descendants of a bridge that was already reaped. Those descendants remain unknown and unproved, and no cleanup proof is claimed for them.

The pid in question is the bridge child's own pid. It is unrelated to the copied `proc.pid` of the PTY child, which is a different value with a different lifetime.

Both observed-exit arms are covered by host-side controls: a bridge child that exits with a code, a bridge child that terminates itself with `SIGTERM`, and a live bridge child that is still tree-killed when the startup deadline is exceeded.

The path keeps the existing bounds: the 5s startup deadline and the 5s cleanup budget.

## Native execution status

Native Windows ConPTY is NOT executed on this Linux host. Off-Windows runs skip all 6 native cases. Native behavior remains unknown; this is not a product fix.

## Interpretation bounds

- ConPTY may consume OSC title sequences; absence in captured output is not proof of loss.
- Raw CP437 payload has different provenance from UTF-8 and legitimate wide output and is labeled separately.
- Standalone `├` before-exit latency is UNVERIFIED as written.
- Helper must exit 0 with no write errors; CP stages are parsed as preconditions.
- Wide, UTF-8, and OSC outcomes are observational only; native ConPTY behavior remains unknown on this host.
- Capture completion uses `PROBE_DONE` marker presence plus balanced sections and the after-commands CP stage; trailing ConPTY VT after the marker is valid and is not interpreted as whole-output text.
- Standalone before-exit latency remains an explicit unverified gap.

## Review correction note

V2 tightens measurement preconditions: typed finite CP stages, mode-specific codepage checks, balanced control markers, `truncated === false`, zero cmd exits, bounded cleanup, and `PROBE_DONE` as the final completion marker. It does not claim a Windows ConPTY UTF-8 repair.