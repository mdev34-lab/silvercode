// Diagnostic only, DO NOT MERGE. Refs #613.
// Question: on Windows, can a directory rename fail right after the same directory's files were read with
// Bun.file(...).text(), which is how the skill refresh test reads SKILL.md just before the next refresh renames the root?
// Each variant renames a directory with one file after a different kind of read and prints a fixed-label summary line.
import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

const rounds = 300

async function variant(name: string, read: (file: string) => Promise<unknown>) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "rename-probe-"))
  const codes = new Map<string, number>()
  let ok = 0
  for (let i = 0; i < rounds; i++) {
    const from = path.join(base, `a${i}`)
    const to = path.join(base, `b${i}`)
    await fs.mkdir(from)
    await fs.writeFile(path.join(from, "SKILL.md"), "# Old")
    await read(path.join(from, "SKILL.md"))
    try {
      await fs.rename(from, to)
      ok++
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown"
      codes.set(code, (codes.get(code) ?? 0) + 1)
    }
  }
  await fs.rm(base, { recursive: true, force: true })
  const failed = Array.from(codes.entries()).map(([code, count]) => `${code}=${count}`).join(",") || "none"
  console.log(`[rename-probe] platform=${process.platform} variant=${name} rounds=${rounds} ok=${ok} failed=${failed}`)
  return ok
}

test("rename-after-read probe (diagnostic, always passes)", async () => {
  const total =
    (await variant("bun-file-text", (file) => Bun.file(file).text())) +
    (await variant("bun-file-exists", (file) => Bun.file(file).exists())) +
    (await variant("node-readfile", (file) => fs.readFile(file, "utf8"))) +
    (await variant("no-read-control", async () => {}))
  expect(total).toBeGreaterThanOrEqual(0)
}, 60_000)
