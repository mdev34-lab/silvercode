import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { renameReplace, writeJsonAtomic } from "../../src/util/persistence"

function transient(code: string) {
  const error = new Error("renaming refused") as NodeJS.ErrnoException
  error.code = code
  return error
}

describe("renameReplace", () => {
  test("retries a transient EPERM until the destination handle is released", async () => {
    let calls = 0
    const renames: [string, string][] = []
    await renameReplace("a.tmp", "b.json", async (source, dest) => {
      calls++
      renames.push([source, dest])
      if (calls < 3) throw transient("EPERM")
    })
    expect(calls).toBe(3)
    expect(renames).toEqual([
      ["a.tmp", "b.json"],
      ["a.tmp", "b.json"],
      ["a.tmp", "b.json"],
    ])
  })

  test("treats EBUSY and EACCES as transient too", async () => {
    let calls = 0
    await renameReplace("a.tmp", "b.json", async () => {
      calls++
      if (calls === 1) throw transient("EBUSY")
      if (calls === 2) throw transient("EACCES")
    })
    expect(calls).toBe(3)
  })

  test("does not retry a permanent error like ENOENT", async () => {
    let calls = 0
    await expect(
      renameReplace("a.tmp", "b.json", async () => {
        calls++
        throw transient("ENOENT")
      }),
    ).rejects.toThrow("renaming refused")
    expect(calls).toBe(1)
  })

  test("gives up after the backoff budget instead of retrying forever", async () => {
    let calls = 0
    await expect(
      renameReplace("a.tmp", "b.json", async () => {
        calls++
        throw transient("EPERM")
      }),
    ).rejects.toThrow("renaming refused")
    expect(calls).toBe(12)
  }, 10_000)
})

describe("writeJsonAtomic", () => {
  test("replaces an existing file and round-trips the value", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "persistence-test-"))
    try {
      const file = path.join(dir, "state.json")
      await writeJsonAtomic(file, { first: 1 })
      await writeJsonAtomic(file, { second: 2 })
      expect(await Bun.file(file).json()).toEqual({ second: 2 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
