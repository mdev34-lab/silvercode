import { execFile, type ChildProcess } from "child_process"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Effect } from "effect"
import { Repository } from "@opencode-ai/core/repository"
import { tmpdir } from "./tmpdir"

// Configuration passed to every fixture git process with -c. Inline values keep
// the process count down, and core.fsmonitor=false stops the globally enabled
// fsmonitor on Windows runners from reaching the fixture. The other git fixtures
// in this repo disable fsmonitor for the same reason.
const config = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "user.email=test@opencode.test",
  "-c",
  "user.name=Test",
]

// Absolute budget for building one fixture remote. Bun SIGTERMs children still
// running when a test hits its budget, and that cancellation resurfaces in the
// next test as an unhandled error (#278). Canceling here keeps the failure and
// its cleanup inside the test that owns it. The budget sits far above a healthy
// setup and below the budgets of the tests using this fixture.
// PR #549 windows attempts burned the full 10s on process STARTUP alone
// (recorded phases: init 1.2s, commit 1.8s per spawn, push starved at 4.8s).
// On a healthy runner the whole setup lands in ~1s, so 30s only bites a
// genuinely stuck spawn; assertions and failure classes are unchanged.
const setupBudget = 30_000

// Scoped fixture remote for tests. The temporary root is acquired first so its
// finalizer runs last: the repositories are removed once every git process the
// fixture started has exited, and they are removed even when setup fails.
// `acquireUseRelease` skips its release when the acquire never completes, which
// is how a setup that ran out of budget left processes and directories behind.
export function withRemote<A, E, R>(body: (fixture: Remote) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
    )
    const processes = yield* Effect.acquireRelease(
      Effect.sync(() => gitProcesses()),
      (group) => Effect.promise(() => group.settle()),
    )
    const fixture = yield* Effect.promise(() => gitRemote(processes, root.path))
    return yield* body(fixture)
  })
}

export async function gitRemote(processes: GitProcesses, root: string, options?: { setupBudget?: number }) {
  const origin = path.join(root, "origin.git")
  const source = path.join(root, "source")
  const remote = pathToFileURL(origin).href
  // One deadline shared by every setup process, so a slow phase is canceled by
  // the fixture instead of by the runner after the test has been reported.
  // Bun leaves an AbortSignal.timeout timer unfired while child processes are
  // running, so the budget aborts through an explicit timer instead.
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), options?.setupBudget ?? setupBudget)
  const signal = deadline.signal
  const started = Date.now()
  const phases: string[] = []
  const step = (name: string, cwd: string, ...args: string[]) =>
    record(phases, name, processes.run(cwd, [...config, ...args], { signal }))

  // `--initial-branch=main` replaces the `branch -M main` and `symbolic-ref
  // HEAD` launches this fixture used to need. Process startup, not git work, is
  // what makes the fixture slow on Windows CI.
  try {
    await step("initOrigin", root, "init", "--bare", "--initial-branch=main", origin)
    await step("initSource", root, "init", "--initial-branch=main", source)
    await fs.writeFile(path.join(source, "README.md"), "one\n")
    await step("add", source, "add", "README.md")
    await step("commit", source, "commit", "-m", "initial")
    await step("addRemote", source, "remote", "add", "origin", remote)
    await step("push", source, "push", "-u", "origin", "main")
  } finally {
    // A live timer would hold the test process open for the whole budget.
    clearTimeout(timer)
  }
  console.error(`[git-fixture] setup=${Date.now() - started}ms ${phases.join(" ")}`)

  const fixture = {
    root,
    source,
    remote,
    reference: { ...Repository.parseRemote("owner/repo"), remote },
    processes,
    git(cwd: string, ...args: string[]) {
      return processes.run(cwd, [...config, ...args])
    },
    async commit(content: string, message: string) {
      await fs.writeFile(path.join(source, "README.md"), content)
      await fixture.git(source, "add", "README.md")
      await fixture.git(source, "commit", "-m", message)
      await fixture.git(source, "push")
    },
    async branch(name: string, content: string) {
      await fixture.git(source, "checkout", "-b", name)
      await fs.writeFile(path.join(source, "README.md"), content)
      await fixture.git(source, "add", "README.md")
      await fixture.git(source, "commit", "-m", name)
      await fixture.git(source, "push", "-u", "origin", name)
    },
  }
  return fixture
}

export type Remote = Awaited<ReturnType<typeof gitRemote>>
export type GitProcesses = ReturnType<typeof gitProcesses>

// Tracks the git processes a fixture starts so teardown can end them and wait
// for them. The runner SIGTERMs a child still alive when a test hits its budget,
// and that rejection resurfaces after the test is over as the canceled
// `git push -u origin main` in #278. Cleanup also deleted the repositories while
// such a process still held them.
export function gitProcesses() {
  const children = new Set<ChildProcess>()
  const finished = new Set<Promise<unknown>>()
  return {
    get pending() {
      return children.size
    },
    get tracked() {
      return finished.size
    },
    run(cwd: string, args: string[], options?: { signal?: AbortSignal }) {
      const done = new Promise<void>((resolve, reject) => {
        const child = execFile("git", args, { cwd, signal: options?.signal }, (error) => {
          children.delete(child)
          if (error) reject(error)
          else resolve()
        })
        children.add(child)
      })
      // A cancellation nobody awaits any more, because the test that started it
      // is already over, must not come back as an unhandled rejection.
      // Keep only unsettled promises, and observe both outcomes without changing
      // the result returned to the caller. Teardown still awaits every live child.
      const observed = done.then(
        () => {
          finished.delete(observed)
        },
        () => {
          finished.delete(observed)
        },
      )
      finished.add(observed)
      return done
    },
    async settle() {
      for (const child of children) child.kill("SIGTERM")
      await Promise.allSettled(finished)
      children.clear()
      finished.clear()
    },
  }
}

// Times one setup phase and, when it fails, names it along with the phases that
// did finish.
function record(phases: string[], name: string, run: Promise<void>) {
  const started = Date.now()
  return run.then(
    () => void phases.push(`${name}=${Date.now() - started}ms`),
    (cause) => {
      const completed = phases.join(" ") || "nothing"
      throw new Error(`git fixture ${name} failed after ${Date.now() - started}ms (completed: ${completed})`, { cause })
    },
  )
}
