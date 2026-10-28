import path from "path"
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/tmpdir"

// The tracer reads the environment in the preload, before any test file is
// imported, so both cases run in a child process: one with the flag unset, one
// with it set. Neither run may change the outcome of the test that aborts.
const packageRoot = path.resolve(import.meta.dir, "../..")

const childTest = `import { test } from "bun:test"

// Mirrors the #560 shape: a signal is created inside install-like code, then
// aborted later from an interruption path, after the work it guarded started.
const install = () => {
  const controller = new AbortController()
  const work = Bun.sleep(20).then(() => controller.abort())
  return { controller, work }
}

test("aborts a signal created inside a helper", async () => {
  const { controller, work } = install()
  await work
  if (!controller.signal.aborted) throw new Error("signal was not aborted")
})

test("abort() still accepts and forwards a reason", () => {
  const controller = new AbortController()
  const reason = Object.assign(new Error("stopped"), { name: "AbortError" })
  controller.abort(reason)
  if (controller.signal.reason !== reason) throw new Error("reason was not forwarded")
  if (!controller.signal.aborted) throw new Error("signal did not abort")
})
`

const run = async (trace: string | undefined) => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "abort-child.test.ts")
  await Bun.write(file, childTest)
  const env = { ...process.env }
  if (trace === undefined) delete env["OPENCODE_TRACE_TEST_ABORTS"]
  else env["OPENCODE_TRACE_TEST_ABORTS"] = trace
  const child = Bun.spawn([process.execPath, "test", file], {
    cwd: packageRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr, file }
}

describe("abort trace", () => {
  test("is silent and does not change abort behavior when the flag is unset", async () => {
    const result = await run(undefined)

    expect(result.code).toBe(0)
    // Bun's test reporter writes to stderr, so both cases assert on the same stream.
    expect(result.stderr).toContain("2 pass")
    expect(result.stderr).not.toContain("[abort-trace]")
  }, 30_000)

  test("names the creation site and the abort site when the flag is set", async () => {
    const result = await run("1")

    // The traced run reports the same result as the untraced one: the trace only
    // observes, so a diagnostic run still shows the real failure.
    expect(result.code).toBe(0)
    expect(result.stderr).toContain("2 pass")
    const lines = result.stderr.split("\n").filter((line) => line.startsWith("[abort-trace]"))
    expect(lines).toHaveLength(2)
    // Creation site: the helper in the child file that owns the signal, not this
    // file and not the tracer.
    expect(lines[0]).toContain(`creation at install (${result.file}:`)
    expect(lines[0]).toMatch(/\d+ms after creation/)
    // Bun truncates the stack at the promise continuation that calls abort(), so
    // that site is best effort. A synchronous abort() still resolves to a site.
    expect(lines[1]).toContain("abort #2")
    expect(lines[1]).toContain(`aborted at <anonymous> (${result.file}:`)
  }, 30_000)
})
