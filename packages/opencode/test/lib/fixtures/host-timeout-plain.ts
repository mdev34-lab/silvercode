// Control for host-timeout.test.ts: no testEffect, no Effect. A plain Bun test hangs forever and
// must be reported as timed out by `bun test --timeout`.
import { test } from "bun:test"

test("plain hang is abandoned by the host timeout", () => new Promise<void>(() => {}))
test("next plain test still runs", () => {})
