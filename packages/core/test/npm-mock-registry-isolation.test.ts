import fs from "fs/promises"
import path from "path"
import { expect, test } from "bun:test"
import { tmpdir } from "./fixture/tmpdir"

test("mock-registry fault tests ignore hostile inherited npm configuration", async () => {
  await using tmp = await tmpdir()
  const rc = path.join(tmp.path, "host.npmrc")
  await fs.writeFile(rc, "registry=http://127.0.0.1:1/\n")
  const child = Bun.spawn([process.execPath, "test", "./test/npm-mock-registry.test.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      HOME: tmp.path,
      USERPROFILE: tmp.path,
      npm_config_cache: path.join(tmp.path, "shared-cache"),
      NPM_CONFIG_USERCONFIG: rc,
      npm_config_registry: "http://127.0.0.1:1/",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => child.kill(), 20_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`mock registry child failed (${code})\n${stdout}\n${stderr}`)
    expect(code).toBe(0)
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
    await child.exited
  }
}, 30_000)
