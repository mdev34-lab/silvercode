# Native ConPTY codepage probe (test-only diagnostic)

Diagnostic measurement only. Not a product fix. Runs as 6 test cases in normal CI on Windows; skipped on non-Windows. Applies no output decoder; every chunk is recorded as the backend delivered it.

## Node runtime

Node backend cases run through a bounded OS-temporary Node bridge that imports the actual `src/pty/pty.node.ts` wrapper. The import specifier is constructed as a `file:` URL so Windows drive paths remain valid ESM specifiers. They do not run node-pty under Bun.

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