import { expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
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

// Diagnostic matrix (assertion-free, no ownership claim): where does the host timeout stop on Windows?
// Children append markers to a file synchronously, so the record survives a kill that loses piped output.
//  clean-plain   : bare bun:test, hung promise, scratch cwd outside the repo (no bunfig/preloads)
//  clean-effect  : the exact repo testEffect + Effect (resolved explicitly), same hang, 50ms finalizer, scratch cwd
//  preloaded     : the existing plain fixture from the package cwd (preloads present)
test("control: host timeout matrix with markers", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "host-timeout-matrix-"))
  const copies: string[] = []
  try {
    const ancestors: string[] = []
    for (let dir = scratch; ; dir = path.dirname(dir)) {
      for (const name of ["bunfig.toml", "package.json"]) if (existsSync(path.join(dir, name))) ancestors.push(path.join(dir, name))
      if (path.dirname(dir) === dir) break
    }
    console.log(`matrix: ${process.platform} bun ${Bun.version} scratch-ancestor bunfig/package files: ${JSON.stringify(ancestors)}`)
    const posix = (value: string) => value.replaceAll("\\", "/")
    const effectEntry = posix(Bun.resolveSync("effect", import.meta.dir))
    const testEffect = posix(path.resolve(import.meta.dir, "effect.ts"))
    console.log(`matrix: effect resolved to ${effectEntry}`)
    const head = `import { test } from "bun:test"
import { appendFileSync } from "node:fs"
const mark = (m: string) => appendFileSync(process.env.MARK_FILE!, (Date.now() - Number(process.env.T0)) + " " + m + "\\n")
const arm = () => { mark("body-enter"); setTimeout(() => mark("timer-100"), 100); setTimeout(() => mark("timer-1200"), 1200) }
`
    writeFileSync(
      path.join(scratch, "clean-plain.ts"),
      head +
        `test("hang", () => new Promise<void>(() => arm()))
test("next", () => { mark("next-test") })
`,
    )
    writeFileSync(
      path.join(scratch, "clean-effect.ts"),
      head +
        `import { Context, Effect, Layer } from "${effectEntry}"
import { testEffect } from "${testEffect}"
class Resource extends Context.Service<Resource, {}>()("MatrixResource") {}
const layer = Layer.effect(
  Resource,
  Effect.acquireRelease(Effect.sync(() => { mark("acquired"); return {} }), () =>
    Effect.promise(async () => { mark("finalizer-start"); await new Promise((r) => setTimeout(r, 50)); mark("finalizer-end") })),
)
const it = testEffect(layer)
it.live("hang", () => Effect.gen(function* () { arm(); yield* Resource; yield* Effect.never }))
test("next", () => { mark("next-test") })
`,
    )
    // Same generated file text, but placed inside the package so the package cwd, bunfig and preloads apply.
    const inPackage = (name: string) => {
      const target = path.join(import.meta.dir, "fixtures", "__matrix-" + name + ".ts")
      writeFileSync(target, readFileSync(path.join(scratch, name + ".ts"), "utf8"))
      copies.push(target)
      return target
    }
    // No live handles: the body only writes one marker synchronously, then never settles.
    writeFileSync(
      path.join(scratch, "notimer-plain.ts"),
      head +
        `test("hang", () => new Promise<void>(() => { mark("body-enter") }))
test("next", () => { mark("next-test") })
`,
    )
    // The original control text, with nothing added (no marker, no timer), run from scratch.
    writeFileSync(
      path.join(scratch, "original-plain.ts"),
      `import { test } from "bun:test"
test("plain hang is abandoned by the host timeout", () => new Promise<void>(() => {}))
test("next plain test still runs", () => {})
`,
    )
    const runs = [
      { name: "clean-plain", file: path.join(scratch, "clean-plain.ts"), cwd: scratch },
      { name: "clean-effect", file: path.join(scratch, "clean-effect.ts"), cwd: scratch },
      { name: "preloaded-plain", file: path.join(import.meta.dir, "fixtures", "host-timeout-plain.ts"), cwd },
      { name: "package-plain-marked", file: inPackage("clean-plain"), cwd },
      { name: "package-effect-marked", file: inPackage("clean-effect"), cwd },
      { name: "scratch-notimer", file: path.join(scratch, "notimer-plain.ts"), cwd: scratch },
      { name: "package-notimer", file: inPackage("notimer-plain"), cwd },
      { name: "scratch-original", file: path.join(scratch, "original-plain.ts"), cwd: scratch },
    ]
    for (const run of runs) {
      const markFile = path.join(scratch, run.name + ".marks")
      writeFileSync(markFile, "")
      const started = Date.now()
      const out = await collectDeadlineChild([process.execPath, "test", "--timeout", String(HOST_TIMEOUT_MS), run.file], run.cwd, 8000, {
        MARK_FILE: markFile,
        T0: String(started),
      })
      console.log(
        `matrix ${run.name}: timedOut=${out.timedOut} elapsed=${Date.now() - started}ms exit=${out.code}\nmarks: ${JSON.stringify(readFileSync(markFile, "utf8").trim().split("\n"))}\nstdout: ${out.stdout.slice(-800)}\nstderr: ${out.stderr.slice(-800)}`,
      )
    }
  } finally {
    for (const file of copies) rmSync(file, { force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}, 120000)
