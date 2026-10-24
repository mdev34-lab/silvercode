import fs from "fs/promises"
import path from "path"
import { expect, test } from "bun:test"
import { tmpdir } from "./fixture/tmpdir"

// @npmcli/agent snapshots proxies at import. Isolate before the child process
// imports npm, not in hooks that run after its dependency graph is evaluated.
test("mock-registry suite runs with isolated npm and proxy environment", async () => {
  await using home = await tmpdir()
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(npm_config_|home$|userprofile$|https?_proxy$|no_proxy$|all_proxy$|proxy$)/i.test(key),
    ),
  )
  const user = path.join(home.path, "user.npmrc")
  const global = path.join(home.path, "global.npmrc")
  await fs.writeFile(user, "")
  await fs.writeFile(global, "")
  const child = Bun.spawn([process.execPath, "test", "./test/fixture/npm-registry/suite.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...env,
      HOME: home.path,
      USERPROFILE: home.path,
      npm_config_userconfig: user,
      npm_config_globalconfig: global,
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
    if (code !== 0) throw new Error(`mock registry suite failed (${code})\n${stdout}\n${stderr}`)
    expect(code).toBe(0)
    expect(stderr).toContain("10 pass")
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
    await child.exited
  }
}, 30_000)
