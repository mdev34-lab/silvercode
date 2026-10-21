import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { ThreadStore } from "../src/store"
import type { WebChatThread } from "../src/types"

function tmpfile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webchat-store-"))
  return path.join(dir, "threads.json")
}

function thread(id: string): WebChatThread {
  return { id, model: "test-model", messages: [], createdAt: 1, updatedAt: 1 } as WebChatThread
}

describe("ThreadStore", () => {
  test("persists threads to a missing file (first run)", () => {
    const file = tmpfile()
    const store = new ThreadStore({ file })
    store.put(thread("t1"))
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"))
    expect(persisted.threads).toHaveLength(1)
    expect(persisted.threads[0].id).toBe("t1")
  })

  test("loads previously persisted threads", () => {
    const file = tmpfile()
    new ThreadStore({ file }).put(thread("t1"))
    const reopened = new ThreadStore({ file })
    expect(reopened.get("t1")?.id).toBe("t1")
    expect(reopened.all()).toHaveLength(1)
  })

  test("never flushes over a corrupt store file", () => {
    const file = tmpfile()
    const original = '{"threads":[{"id":"t1","model":"m","messages":[]'
    fs.writeFileSync(file, original, "utf8")

    const store = new ThreadStore({ file })
    // Reads degrade to an empty in-memory view...
    expect(store.all()).toEqual([])
    // ...but writes must not destroy the recoverable file.
    store.put(thread("t2"))
    store.remove("t2")
    store.clear()
    expect(fs.readFileSync(file, "utf8")).toBe(original)
  })

  test("a fresh store recovers once the corrupt file is replaced", () => {
    const file = tmpfile()
    fs.writeFileSync(file, "not json", "utf8")
    const degraded = new ThreadStore({ file })
    degraded.put(thread("t1"))
    expect(fs.readFileSync(file, "utf8")).toBe("not json")

    fs.writeFileSync(file, JSON.stringify({ threads: [thread("t0")] }), "utf8")
    const recovered = new ThreadStore({ file })
    expect(recovered.get("t0")?.id).toBe("t0")
    recovered.put(thread("t1"))
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"))
    expect(persisted.threads).toHaveLength(2)
  })
})
