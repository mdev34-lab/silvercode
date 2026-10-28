import path from "path"
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/tmpdir"

// The tracer reads the environment in the preload, before any test file is
// imported, so every case runs in a child process. The child asserts the native
// behavior itself; this file asserts on the child's outcome and trace lines.
const packageRoot = path.resolve(import.meta.dir, "../..")
const tracer = path.resolve(import.meta.dir, "abort-trace.ts")

const childTest = `import { test, expect } from "bun:test"
import { traceAborts, restoreAborts } from ${JSON.stringify(tracer)}

const install = () => {
  const controller = new AbortController()
  const work = Bun.sleep(20).then(() => controller.abort())
  return { controller, work }
}

test("aborts a signal created inside a helper", async () => {
  const { controller, work } = install()
  await work
  expect(controller.signal.aborted).toBe(true)
})

test("abort() still forwards a reason", () => {
  const controller = new AbortController()
  const reason = Object.assign(new Error("stopped"), { name: "AbortError" })
  controller.abort(reason)
  expect(controller.signal.reason).toBe(reason)
})

test("subclasses keep their prototype and instanceof chain", () => {
  class Extended extends AbortController {
    extra() {
      return 1
    }
  }
  const controller = new Extended()
  expect(controller instanceof Extended).toBe(true)
  expect(controller instanceof AbortController).toBe(true)
  expect(controller.extra()).toBe(1)
  expect(Object.getPrototypeOf(controller)).toBe(Extended.prototype)
  expect(Object.prototype.hasOwnProperty.call(controller, "abort")).toBe(false)
  controller.abort()
  expect(controller.signal.aborted).toBe(true)
})

test("a failing logger never prevents the abort", () => {
  const original = console.error
  console.error = () => {
    throw new Error("logger failed")
  }
  try {
    const controller = new AbortController()
    controller.abort()
    expect(controller.signal.aborted).toBe(true)
  } finally {
    console.error = original
  }
})

test("installing twice does not double wrap", () => {
  traceAborts()
  const controller = new AbortController()
  controller.abort()
  controller.abort()
  expect(controller.signal.aborted).toBe(true)
})

test("restoreAborts puts the native constructor and abort back", () => {
  restoreAborts()
  const controller = new AbortController()
  controller.abort()
  expect(controller.signal.aborted).toBe(true)
  expect(Object.prototype.hasOwnProperty.call(controller, "abort")).toBe(false)
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
    // Bound the child: it is killed on timeout and again in finally, so a host
    // timeout on this test cannot leave it running.
    timeout: 25_000,
    killSignal: "SIGKILL",
  })
  try {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    return { code, stderr, file }
  } finally {
    child.kill()
    await child.exited
  }
}

describe("abort trace", () => {
  test("is silent and the child assertions hold when the flag is unset", async () => {
    const result = await run(undefined)

    expect(result.stderr).toContain("6 pass")
    expect(result.stderr).toContain("0 fail")
    expect(result.code).toBe(0)
    expect(result.stderr).not.toContain("[abort-trace]")
  }, 30_000)

  test("names the creation site and keeps native behavior when the flag is set", async () => {
    const result = await run("1")

    expect(result.stderr).toContain("6 pass")
    expect(result.stderr).toContain("0 fail")
    expect(result.code).toBe(0)
    const lines = result.stderr.split("\n").filter((line) => line.startsWith("[abort-trace]"))
    expect(lines.length).toBeGreaterThanOrEqual(1)
    // Creation site: the helper in the child file that owns the signal, not this
    // file and not the tracer. Bun truncates the stack at the promise
    // continuation that calls abort(), so the abort site is best effort.
    expect(lines[0]).toContain(`creation at install (${result.file}:`)
    expect(lines[0]).toMatch(/\d+ms after creation/)
    // Double install and repeated abort() of one signal log each abort once.
    expect(new Set(lines.map((line) => line.split(" ")[2])).size).toBe(lines.length)
  }, 30_000)
})
