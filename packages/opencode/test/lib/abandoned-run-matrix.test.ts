import { expect, test } from "bun:test"
import path from "node:path"
import { collectDeadlineChild } from "./owned-deadline-child"

const cwd = path.resolve(import.meta.dir, "../..")
const HOST_TIMEOUT_MS = 800
// Spawn guard for child Bun processes (loads package preload + Effect runtime before tests run).
const CHILD_GUARD_MS = 15000

type MatrixProbe = {
  fixture: string
  extraArgs?: string[]
  pass: number
  fail: number
  mustContain: string[]
  mustNotContain?: string[]
}

const probes: MatrixProbe[] = [
  {
    fixture: "abandoned-explicit.ts",
    pass: 1,
    fail: 2,
    mustContain: [
      "(fail) explicit timeout abandons hung Effect.never with 250ms release",
      "this test timed out after 800ms",
      "(pass) next Bun test sees 250ms release joined and outer afterEach uncontaminated",
      "(fail) settled failure still rethrows via Cause.squash",
      "expected settled failure",
    ],
  },
  {
    fixture: "abandoned-shared.ts",
    pass: 5,
    fail: 3,
    mustContain: [
      "(pass) settled shared run acquires and releases cleanly",
      "(pass) next test observes settled shared release with Success exit",
      "(fail) settled shared body failure closes scope with Failure exit and rethrows via Cause.squash",
      "expected shared body failure",
      "(pass) next test observes settled shared body failure release with Failure exit",
      "(fail) abandoned shared body run joins 250ms Scope.close before next test",
      "this test timed out after 800ms",
      "(pass) next test observes abandoned shared release with Failure exit",
      "(fail) abandoned partial Layer.buildWithMemoMap closes already-built memoMap scope",
      "(pass) subsequent shared run reuses clean memoMap after partial interruption",
    ],
  },
  {
    fixture: "abandoned-host-timeout.ts",
    extraArgs: ["--timeout", String(HOST_TIMEOUT_MS)],
    pass: 2,
    fail: 2,
    mustContain: [
      "(fail) host timeout abandons isolated run with no per-test option",
      "(pass) next test sees isolated host-timed-out layer finalized",
      "(fail) host timeout abandons shared run with no per-test option",
      "(pass) next test sees shared host-timed-out layer finalized",
      `this test timed out after ${HOST_TIMEOUT_MS}ms`,
    ],
  },
  {
    fixture: "abandoned-defect-explicit.ts",
    pass: 1,
    fail: 1,
    mustContain: [
      "explicit abandoned finalizer threw",
      "(fail) abandoned explicit-timeout run whose finalizer throws",
      "this test timed out after 800ms",
      "(pass) next test passes and observes restored env and file afterEach",
    ],
  },
  {
    fixture: "abandoned-defect-multiple.ts",
    extraArgs: ["--timeout", String(HOST_TIMEOUT_MS)],
    pass: 2,
    fail: 2,
    mustContain: [
      "first abandoned finalizer defect",
      "second abandoned finalizer defect",
      "(fail) host-abandoned run with two throwing finalizers",
      "(pass) next test after multi-defect host timeout passes",
      "shared abandoned finalizer threw",
      "(fail) shared explicit-timeout run whose 250ms finalizer throws",
      "(pass) next test after shared finalizer defect passes",
    ],
  },
  {
    fixture: "abandoned-concurrent.ts",
    pass: 1,
    fail: 2,
    mustContain: [
      "Cannot call onTestFinished() here",
      "(fail) concurrent caller 1 fails before fiber starts",
      "(fail) concurrent caller 2 fails before fiber starts",
      "(pass) serial follow-up sees zero orphan fibers and empty keyed map",
    ],
  },
  {
    fixture: "abandoned-aftereach-skip.ts",
    extraArgs: ["--timeout", String(HOST_TIMEOUT_MS)],
    pass: 2,
    fail: 2,
    mustContain: [
      "defect survived throwing afterEach",
      "suite afterEach boom",
      "(fail) suite whose afterEach throws on the timed-out test > abandoned run whose suite afterEach throws skipping onTestFinished",
      "(pass) suite whose afterEach throws on the timed-out test > next test after throwing afterEach observes restored env and zero leaked keys",
      "defect survived timed-out afterEach",
      "a beforeEach/afterEach hook timed out for this test",
      "(fail) suite whose afterEach hits Bun hook timeout on the timed-out test > abandoned run whose suite afterEach hits hook timeout skipping onTestFinished",
      "(pass) suite whose afterEach hits Bun hook timeout on the timed-out test > next test after timed-out afterEach observes restored env and zero leaked keys",
    ],
  },
  {
    fixture: "abandoned-hook-cutoff.ts",
    extraArgs: ["--timeout", String(HOST_TIMEOUT_MS)],
    pass: 1,
    fail: 1,
    mustContain: [
      "(fail) host-abandoned run whose defecting finalizer is cut by hook timeout",
      "a beforeEach/afterEach hook timed out for this test",
      "defect after hook timeout cutoff",
      "(pass) follow-up test sees key cleared from runs once cut-off defecting finalizer settles",
    ],
  },
  {
    fixture: "abandoned-undefined-defect.ts",
    pass: 1,
    fail: 3,
    mustContain: [
      "(fail) raced unawaited runOwned dying with undefined in finalizer fails instead of passing green",
      "(fail) raced unawaited runOwned failing with undefined fails instead of passing green",
      "(fail) abandoned explicit-timeout run whose finalizer dies with undefined",
      "(pass) follow-up test observes zero inflight runs after undefined defects",
    ],
  },
  {
    fixture: "abandoned-dynamic-hooks.ts",
    pass: 3,
    fail: 3,
    mustContain: [
      "body dynamic afterEach boom",
      "(fail) dynamic afterEach inside testEffect body runs after fiber join even when it throws",
      "(pass) next test after throwing body dynamic afterEach sees joined release and no unhandled error",
      "post-runOwned dynamic afterEach boom",
      "(fail) dynamic afterEach registered after direct runOwned call runs after fiber join",
      "(pass) next test after post-runOwned throwing dynamic afterEach sees joined release",
      "overlapping run 1 finalizer defect",
      "overlapping run 2 finalizer defect",
      "(fail) two overlapping runOwned runs both defecting surface both defects and leak neither key",
      "(pass) follow-up test after overlapping runOwned defects sees zero leaked keys",
    ],
  },
]

test(
  "abandoned testEffect probe matrix joins finalizers, attributes finalizer throws, and emits no unhandled errors",
  async () => {
    for (const probe of probes) {
      const started = Date.now()
      const { stdout, stderr, code, timedOut } = await collectDeadlineChild(
        [process.execPath, "test", ...(probe.extraArgs ?? []), path.join(import.meta.dir, "fixtures", probe.fixture)],
        cwd,
        CHILD_GUARD_MS,
      )
      const output = stdout + stderr
      if (timedOut) {
        throw new Error(
          [
            `child ${probe.fixture} hit the ${CHILD_GUARD_MS}ms guard (elapsed ${Date.now() - started}ms, exit ${code})`,
            `bun ${Bun.version} ${process.platform}`,
            `stdout (last 3000): ${stdout.slice(-3000)}`,
            `stderr (last 3000): ${stderr.slice(-3000)}`,
          ].join("\n"),
        )
      }
      expect(code).toBe(1)
      expect(output).not.toContain("Unhandled error")
      expect(output).not.toMatch(/^\s*\d+\s+errors?\b/m)
      for (const expected of probe.mustContain) {
        expect(output).toContain(expected)
      }
      for (const forbidden of probe.mustNotContain ?? []) {
        expect(output).not.toContain(forbidden)
      }
      expect(output).toContain(`${probe.pass} pass`)
      expect(output).toContain(`${probe.fail} fail`)
    }
  },
  CHILD_GUARD_MS * probes.length + 10000,
)
