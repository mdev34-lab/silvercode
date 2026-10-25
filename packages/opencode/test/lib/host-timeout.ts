// Single source of truth for the Bun host test timeout. Bun does not expose its configured
// default and bunfig.toml does not parse `timeout`, so test/preload.ts applies this value with
// setDefaultTimeout (which overrides the CLI flag) and the Effect helpers read the same value.
// 30000 matches the package test script. OPENCODE_TEST_HOST_TIMEOUT_MS lets a child fixture shrink it.
const fromEnv = Number(process.env.OPENCODE_TEST_HOST_TIMEOUT_MS)
export const HOST_DEFAULT_TIMEOUT_MS = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 30_000
