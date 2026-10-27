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
      const started = Date.now()
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
      // Carry the child's own output into the failure: a guard hit with no output says nothing.
      if (timedOut)
        throw new Error(
          [
            `child ${probe.fixture} hit the ${CHILD_GUARD_MS}ms guard (elapsed ${Date.now() - started}ms, exit ${code})`,
            `bun ${Bun.version} ${process.platform} ${path.basename(process.execPath)}`,
            `stdout (last 3000): ${stdout.slice(-3000)}`,
            `stderr (last 3000): ${stderr.slice(-3000)}`,
          ].join("\n"),
        )
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

// Diagnostic control, not an ownership claim: does Bun's own host timeout fire for a plain hung test on this
// platform within a bounded wait? It records the observation and asserts nothing about the outcome.
test("control: plain Bun host timeout observation", async () => {
  const started = Date.now()
  const { stdout, stderr, code, timedOut } = await collectDeadlineChild(
    [process.execPath, "test", "--timeout", String(HOST_TIMEOUT_MS), path.join(import.meta.dir, "fixtures", "host-timeout-plain.ts")],
    cwd,
    8000,
  )
  console.log(
    `host-timeout control: ${process.platform} bun ${Bun.version} timedOut=${timedOut} elapsed=${Date.now() - started}ms exit=${code}\nstdout: ${stdout.slice(-1500)}\nstderr: ${stderr.slice(-1500)}`,
  )
}, 20000)
