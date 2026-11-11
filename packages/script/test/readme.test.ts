import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// README quickstarts are copy-pasted verbatim, so a `git clone <url>` that
// checks out into one directory while the next line does `cd` into another
// fails for every reader at the very first step (the alphacode→silvercode
// rename left `git clone …/alphacode.git` followed by `cd silvercode`).
// Verify the shell snippets we publish as a unit rather than by eye.

const root = join(import.meta.dir, "..", "..", "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

// Windows CI checks the repository out with CRLF line endings, so every
// newline in the fence and the snippets has to tolerate a preceding `\r`.
function bashBlocks(markdown: string): string[][] {
  return [...markdown.matchAll(/```(?:bash|sh)\r?\n([\s\S]*?)```/g)].map((match) =>
    match[1]!
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  )
}

const DIRECTORY = (url: string) => {
  const base = url
    .replace(/\.git$/, "")
    .split("/")
    .pop()
  if (!base) throw new Error(`cannot derive a directory from ${url}`)
  return base
}

describe("README shell snippets", () => {
  const readme = read("README.md")

  test("every clone step is followed by a cd into the directory it creates", () => {
    const blocks = bashBlocks(readme)
    expect(blocks.length).toBeGreaterThan(0)

    let clones = 0
    for (const lines of blocks) {
      for (const [index, line] of lines.entries()) {
        const clone = line.match(/^git clone (\S+)(?: (\S+))?$/)
        if (!clone) continue
        clones++
        const expected = clone[2] ?? DIRECTORY(clone[1]!)
        const cd = lines.slice(index + 1).find((next) => next.startsWith("cd "))
        expect(`${clone[1]} -> ${cd}`).toBe(`${clone[1]} -> cd ${expected}`)
      }
    }
    expect(clones).toBeGreaterThan(0)
  })

  test("the snippet parser works on CRLF checkouts", () => {
    // This is how the README arrives on Windows runners; a fence regex that
    // requires a bare `\n` right after the language tag finds no blocks there.
    const crlf = "```bash\r\ngit clone https://example.com/thing.git\r\ncd thing\r\n```\r\n"
    const blocks = bashBlocks(crlf)
    expect(blocks).toEqual([["git clone https://example.com/thing.git", "cd thing"]])
  })

  test("the install one-liner points at the live repository", () => {
    const installs = [...readme.matchAll(/curl -fsSL (\S+)\/install \| bash/g)].map((m) => m[1]!)
    expect(installs.length).toBeGreaterThan(0)
    for (const base of installs) {
      expect(base).toBe("https://github.com/mdev34-lab/silvercode/releases/latest/download")
    }
  })
})
