import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { acquireProfileLock } from "../src/adapters/qwen/browser"
import { QWEN_WEB_PROFILE_LOCKFILE } from "../src/adapters/qwen/constants"

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qwen-lock-"))
}

const CHILD = `
import { acquireProfileLock } from "${path.resolve(import.meta.dir, "../src/adapters/qwen/browser").replaceAll("\\", "/")}"
const dir = process.argv[2]
try {
  await acquireProfileLock(dir, 2000)
  console.log("OK", process.pid)
  await new Promise((resolve) => setTimeout(resolve, 4000))
} catch (error) {
  console.log("BUSY", process.pid)
}
`

describe("Qwen profile lock", () => {
  test("takes over a stale lock from a dead process", async () => {
    const dir = tmpdir()
    const dead = Bun.spawnSync({ cmd: ["true"] })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, QWEN_WEB_PROFILE_LOCKFILE), String(dead.pid), "utf8")
    await acquireProfileLock(dir, 2000)
    expect(fs.readFileSync(path.join(dir, QWEN_WEB_PROFILE_LOCKFILE), "utf8")).toBe(String(process.pid))
  })

  test("waits then fails while a live process holds the lock", async () => {
    const dir = tmpdir()
    const sleeper = Bun.spawn({ cmd: ["sleep", "10"] })
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, QWEN_WEB_PROFILE_LOCKFILE), String(sleeper.pid), "utf8")
      await expect(acquireProfileLock(dir, 1200)).rejects.toThrow(/Another SilverCode process/)
    } finally {
      sleeper.kill()
    }
  })

  test("only one of several racing processes acquires the profile", async () => {
    const dir = tmpdir()
    const script = path.join(dir, "child.ts")
    fs.writeFileSync(script, CHILD, "utf8")
    const children = Array.from({ length: 4 }, () =>
      Bun.spawn({ cmd: [process.execPath, script, dir], stdout: "pipe", stderr: "pipe" }),
    )
    const outputs = await Promise.all(
      children.map(async (child) => {
        await child.exited
        return (await new Response(child.stdout).text()).trim()
      }),
    )
    const winners = outputs.filter((line) => line.startsWith("OK"))
    const blocked = outputs.filter((line) => line.startsWith("BUSY"))
    expect(winners).toHaveLength(1)
    expect(blocked).toHaveLength(3)
  }, 30000)
})
