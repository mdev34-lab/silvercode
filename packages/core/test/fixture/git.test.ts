import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { gitProcesses, gitRemote, type Remote, withRemote } from "./git"
import { tmpdir } from "./tmpdir"

const it = testEffect(Layer.empty)

// These tests each stand up a full git remote fixture; a loaded Windows runner
// can spend 9s+ on that setup alone, so the suite budget matches test/git.test.ts.
setDefaultTimeout(45_000)

// A git process that stays alive until something cancels it. It stands in for
// the `git push -u origin main` that was still running when the Windows test
// budget expired in #278.
const blocked = (fixture: Remote) => fixture.git(fixture.source, "hash-object", "--stdin", "-w")

describe("Git fixture", () => {
  test("awaits the pushed remote before setup resolves", async () => {
    await using root = await tmpdir()
    const processes = gitProcesses()
    // gitRemote stays inside the try: when setup itself fails (budget abort),
    // the finally still settles any children it managed to start before the
    // temporary root is disposed (#278).
    try {
      const fixture = await gitRemote(processes, root.path)
      const origin = path.join(root.path, "origin.git")

      // Nothing may still be running when setup hands the fixture to a test.
      expect(processes.pending).toBe(0)
      expect((await $`git --git-dir=${origin} rev-parse --verify main`.quiet()).exitCode).toBe(0)
      expect(await fs.readFile(path.join(origin, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n")
      expect(await fs.readFile(path.join(fixture.source, "README.md"), "utf8")).toBe("one\n")
    } finally {
      await processes.settle()
    }
  })

  test("drops settled promises after repeated successful and failed processes", async () => {
    await using root = await tmpdir()
    const processes = gitProcesses()
    expect(processes.tracked).toBe(0)
    try {
      const fixture = await gitRemote(processes, root.path)

      for (let index = 0; index < 20; index++) {
        await fixture.git(fixture.source, "rev-parse", "--verify", "HEAD")
        expect(processes.tracked).toBe(0)
        const failed = fixture.git(fixture.source, "rev-parse", "--verify", "refs/heads/missing").then(
          () => false,
          () => true,
        )
        expect(processes.tracked).toBe(1)
        expect(await failed).toBe(true)
        expect(processes.tracked).toBe(0)
        expect(processes.pending).toBe(0)
      }
    } finally {
      await processes.settle()
    }
    // 40 sequential git spawns; windows CreateProcess + AV cost blows past
    // bun's 5s default (#487). The test must also outlive the fixture's 30s
    // setup budget, or the runner cancels mid-setup and reopens #278.
  }, 60_000)

  test("cancels its own setup when the budget expires", async () => {
    await using root = await tmpdir()
    const processes = gitProcesses()
    try {
      const failure = await gitRemote(processes, root.path, { setupBudget: 1 }).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )

      // The fixture ends the slow phase itself and names it, instead of leaving
      // the test runner to SIGTERM that process once the test is already over.
      expect(failure).toMatch(/^git fixture \w+ failed after \d+ms \(completed: .*\)$/)
      expect(processes.pending).toBe(0)
    } finally {
      await processes.settle()
    }
  })

  test("ends an in-flight process when its deadline aborts", async () => {
    await using root = await tmpdir()
    const processes = gitProcesses()
    const deadline = new AbortController()
    try {
      const fixture = await gitRemote(processes, root.path)
      setTimeout(() => deadline.abort(), 100)
      const canceled = processes.run(fixture.source, ["hash-object", "--stdin", "-w"], { signal: deadline.signal }).then(
        () => false,
        () => true,
      )
      expect(processes.pending).toBe(1)

      // This is how the setup budget ends a phase that is still running, without
      // waiting for the test runner to do it after the test has been reported.
      expect(await canceled).toBe(true)
      expect(processes.pending).toBe(0)
    } finally {
      await processes.settle()
    }
  })

  test("ends and awaits a process still running at teardown", async () => {
    await using root = await tmpdir()
    const processes = gitProcesses()
    try {
      const fixture = await gitRemote(processes, root.path)
      const canceled = blocked(fixture).then(
        () => false,
        () => true,
      )
      expect(processes.pending).toBe(1)
      expect(processes.tracked).toBe(1)

      await processes.settle()

      expect(processes.pending).toBe(0)
      expect(processes.tracked).toBe(0)
      // Whoever started the process still sees the cancellation; teardown does not
      // let it resurface as an unhandled rejection.
      expect(await canceled).toBe(true)
      await processes.settle()
      expect(processes.pending).toBe(0)
    } finally {
      await processes.settle()
    }
  })

  it.effect("settles fixture processes before removing the temporary root", () =>
    Effect.gen(function* () {
      const fixture = yield* withRemote((remote) =>
        Effect.gen(function* () {
          void blocked(remote).catch(() => undefined)
          expect(remote.processes.pending).toBe(1)
          return yield* Effect.fail(remote)
        }),
      ).pipe(Effect.flip, Effect.scoped)

      expect(fixture.processes.pending).toBe(0)
      expect(yield* Effect.promise(() => exists(fixture.root))).toBe(false)
    }),
  )

  it.effect("removes the temporary root when the test body fails", () =>
    Effect.gen(function* () {
      const root = yield* withRemote((fixture) => Effect.fail(fixture.root)).pipe(Effect.flip, Effect.scoped)

      expect(yield* Effect.promise(() => exists(root))).toBe(false)
    }),
  )
})

function exists(directory: string) {
  return fs.stat(directory).then(
    () => true,
    () => false,
  )
}
