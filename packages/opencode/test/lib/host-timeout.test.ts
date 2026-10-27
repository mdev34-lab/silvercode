import { expect, test } from "bun:test"
import path from "node:path"
import { collectDeadlineChild } from "./owned-deadline-child"

const cwd = path.resolve(import.meta.dir, "../..")
// Passed to the child as the host timeout, because Bun ignores bunfig and only reads the flag.
const HOST_TIMEOUT_MS = 800
// Hang guard for the spawned fixture, not an ownership budget. The child has to load the
// package preload and the Effect runtime before its first test starts (measured ~1.8s on a
// 2-core host), so the guard stays far above startup and above HOST_TIMEOUT_MS.
const CHILD_GUARD_MS = 15000

test(
  "testEffect owns runs abandoned by a host-level Bun timeout",
  async () => {
    for (const probe of [
      { fixture: "host-timeout.ts", restored: "next Bun test sees the restored environment value", pass: 1, fail: 2 },
      {
        fixture: "host-timeout-shared.ts",
        restored: "next Bun test sees the restored shared environment value",
        pass: 3,
        fail: 2,
      },
    ]) {
      const { stdout, stderr, code, timedOut } = await collectDeadlineChild(
        [
          process.execPath,
          "test",
          "--timeout",
          String(HOST_TIMEOUT_MS),
          path.join(import.meta.dir, "fixtures", probe.fixture),
        ],
        cwd,
        CHILD_GUARD_MS,
      )
      const output = stdout + stderr
      expect(timedOut).toBe(false)
      expect(code).toBe(1)
      // The host timeout stays the failure Bun reports for the abandoned test.
      expect(output).toContain(`this test timed out after ${HOST_TIMEOUT_MS}ms`)
      // The finalizer ran before Bun started the next test, which saw the previous value.
      expect(output).toContain(`(pass) ${probe.restored}`)
      // Settled runs keep reporting their own failure.
      expect(output).toContain("error: expected settled failure")
      expect(output).toContain(`${probe.pass} pass`)
      expect(output).toContain(`${probe.fail} fail`)
    }
  },
  CHILD_GUARD_MS * 2 + 10000,
)
