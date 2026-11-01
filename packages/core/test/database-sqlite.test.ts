import type { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { Sqlite } from "@opencode-ai/core/database/sqlite"
import { layer } from "@opencode-ai/core/database/sqlite.bun"

describe("Sqlite", () => {
  test("finalizes statements so closing releases the connection", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient
        // Run more distinct statements than the 20 that bun:sqlite's query() cache can finalize on close.
        yield* Effect.forEach(
          Array.from({ length: 25 }, (_, index) => index),
          (index) => sql.unsafe(`SELECT ${index} AS value`),
        )
        const native = (yield* Sqlite.Native) as Database
        // sqlite3_close fails while any statement is unfinalized; the default close would instead leave
        // a zombie connection that keeps the database files open until garbage collection.
        expect(() => native.close(true)).not.toThrow()
      }).pipe(Effect.provide(layer({ filename: ":memory:" })), Effect.scoped),
    )
  })
})
