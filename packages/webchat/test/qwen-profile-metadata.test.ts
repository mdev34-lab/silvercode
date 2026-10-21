import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { writeProfileMetadata } from "../src/adapters/qwen/browser"

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qwen-meta-"))
}

describe("Qwen profile metadata", () => {
  test("writes valid JSON via atomic replace, leaving no temp file", () => {
    const dir = tmpdir()
    writeProfileMetadata(dir, { authenticated: true, loginAt: "2026-01-01T00:00:00Z" })
    const files = fs.readdirSync(dir)
    expect(files.some((name) => name.endsWith(".tmp"))).toBe(false)
    const file = files.find((name) => name.endsWith(".json"))
    expect(file).toBeDefined()
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file!), "utf8"))
    expect(parsed).toMatchObject({ version: 1, authenticated: true, loginAt: "2026-01-01T00:00:00Z" })
  })

  test("patches merge over existing metadata", () => {
    const dir = tmpdir()
    writeProfileMetadata(dir, { authenticated: true, loginAt: "2026-01-01T00:00:00Z" })
    writeProfileMetadata(dir, { lastSeenAt: "2026-01-02T00:00:00Z" })
    const file = fs.readdirSync(dir).find((name) => name.endsWith(".json"))!
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))
    expect(parsed).toMatchObject({
      authenticated: true,
      loginAt: "2026-01-01T00:00:00Z",
      lastSeenAt: "2026-01-02T00:00:00Z",
    })
  })
})
