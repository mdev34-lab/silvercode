import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import fs from "node:fs"
import { Database } from "bun:sqlite"
import { cliIt, withCliFixture } from "../../lib/cli-process"

const sessionIdOf = (
  result: { stdout: string },
  opencode: { parseJsonEvents: (s: string) => Array<Record<string, unknown>> },
) =>
  opencode
    .parseJsonEvents(result.stdout)
    .map((e) => e.sessionID)
    .find((v) => typeof v === "string") as string | undefined

const rootSessionIds = (dbPath: string) => {
  if (!fs.existsSync(dbPath)) return []
  const db = new Database(dbPath, { readonly: true })
  try {
    return (db.query("SELECT id FROM session WHERE parent_id IS NULL").all() as { id: string }[]).map((row) => row.id)
  } finally {
    db.close()
  }
}

describe("fixture session db isolation", () => {
  cliIt.live(
    "continues the same session within one fixture",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("first response")
        const first = yield* opencode.run("initial prompt", { timeoutMs: 20_000, format: "json" })
        opencode.expectExit(first, 0)
        const firstSessionID = sessionIdOf(first, opencode)
        expect(typeof firstSessionID).toBe("string")

        yield* llm.text("continued response")
        const second = yield* opencode.run("follow up", {
          timeoutMs: 20_000,
          format: "json",
          extraArgs: ["--continue"],
        })
        opencode.expectExit(second, 0)
        expect(second.stdout).toContain("continued response")
        const secondSessionID = sessionIdOf(second, opencode)
        expect(secondSessionID).toBe(firstSessionID)

        const hits = yield* llm.hits
        const continuedRequest = hits.find((hit) => JSON.stringify(hit.body).includes("follow up"))
        expect(continuedRequest).toBeDefined()
        expect(JSON.stringify(continuedRequest!.body)).toContain("initial prompt")
      }),
    60_000,
  )

  cliIt.live(
    "default fixture DBs are disjoint and override is respected",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("first response")
        const first = yield* opencode.run("disjoint db prompt", { timeoutMs: 20_000 })
        opencode.expectExit(first, 0)
        const defaultDb = path.join(home, "opencode-test.db")
        const firstRootIds = rootSessionIds(defaultDb)
        expect(firstRootIds.length).toBe(1)

        yield* Effect.scoped(
          withCliFixture(({ llm: llm2, home: home2, opencode: opencode2 }) =>
            Effect.gen(function* () {
              yield* llm2.text("second response")
              const second = yield* opencode2.run("disjoint db prompt two", { timeoutMs: 20_000 })
              opencode2.expectExit(second, 0)
              const secondDefaultDb = path.join(home2, "opencode-test.db")
              const secondRootIds = rootSessionIds(secondDefaultDb)
              expect(secondRootIds.length).toBe(1)
              expect(secondRootIds[0]).not.toBe(firstRootIds[0])
              expect(rootSessionIds(defaultDb)).toEqual(firstRootIds)
            }),
          ),
        )

        const overrideDb = path.join(home, "override.db")
        yield* llm.text("override response")
        const run = yield* opencode.run("override db prompt", { timeoutMs: 20_000, env: { OPENCODE_DB: overrideDb } })
        opencode.expectExit(run, 0)
        expect(rootSessionIds(overrideDb).length).toBe(1)
        expect(rootSessionIds(defaultDb)).toEqual(firstRootIds)
      }),
    90_000,
  )
})
