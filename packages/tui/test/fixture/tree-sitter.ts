import { MockTreeSitterClient } from "@opentui/core/testing"
import { beforeEach } from "bun:test"

// Core caches the tree-sitter client that every `code` and `markdown` renderable shares on a
// Symbol-keyed bag, and hands out the cached instance before building one.
const SINGLETON_CACHE: unique symbol = Symbol.for("@opentui/core/singleton")
const TREE_SITTER_CLIENT_KEY = "tree-sitter-client"

/**
 * Test preload (see bunfig.toml): answer syntax highlighting from core's mock client instead of
 * the real tree-sitter worker.
 *
 * The real client spawns a worker that has to answer INIT inside core's 10s initialization
 * budget, and a loaded CI runner misses that budget often enough to matter. The client then
 * rejects every highlight, and a `code` block drawn with `drawUnstyledText={false}` - the
 * reasoning bodies in the session route - keeps its text hidden until highlighting resolves, so
 * tests that wait for a painted frame time out on unrendered content instead of on a real
 * regression. The mock resolves on the next tick with an empty highlight set: same text, same
 * layout, no worker, which is what these tests assert.
 *
 * Re-applied before every test because core drops the cached client once the last renderer in the
 * process is destroyed, and the next mount would otherwise build a real one.
 */
function mockTreeSitterClient() {
  const client = new MockTreeSitterClient({ autoResolveTimeout: 0 })
  client.setMockResult({ highlights: [] })
  Reflect.set(singletonCache(), TREE_SITTER_CLIENT_KEY, client)
}

function singletonCache() {
  const cached: unknown = Reflect.get(globalThis, SINGLETON_CACHE)
  if (cached instanceof Object) return cached
  const created = {}
  Reflect.set(globalThis, SINGLETON_CACHE, created)
  return created
}

beforeEach(mockTreeSitterClient)
