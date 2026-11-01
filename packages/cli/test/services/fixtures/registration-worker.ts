// Isolated process: register's ownership watcher can signal this worker,
// never the test runner. A sentinel requests normal scoped finalization.
import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
const awaitClose = () => existsSync(process.argv[3])
import { NodeFileSystem } from "@effect/platform-node"
const { Service, layer } = await import("../../../src/services/daemon")
await Effect.runPromise(
  Effect.gen(function* () {
    const daemon = yield* Service
    yield* daemon.register({ _tag: "TcpAddress", hostname: "127.0.0.1", port: Number(process.argv[2]) })
    process.stdout.write("ready\n")
    while (!awaitClose()) yield* Effect.sleep("20 millis")
  }).pipe(Effect.scoped, Effect.provide(layer.pipe(Layer.provide(NodeFileSystem.layer)))),
)
