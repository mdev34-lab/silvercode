import { describe, expect, test } from "bun:test"
import { GlobalBus, type GlobalEvent } from "@/bus/global"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function published(type: string): GlobalEvent {
  const event: GlobalEvent = { payload: { type, properties: {} } }
  GlobalBus.emitEvent(event)
  return event
}

describe("GlobalBus replay log", () => {
  test("assigns ascending ids to payloads that lack them", async () => {
    const a = published("test.a")
    await sleep(2)
    const b = published("test.b")
    expect(typeof a.payload.id).toBe("string")
    expect(typeof b.payload.id).toBe("string")
    expect(a.payload.id < b.payload.id).toBe(true)
  })

  test("normalizes present-but-unusable ids so every event is resumable", () => {
    const cursor = published("test.cursor")

    const undef: GlobalEvent = { payload: { id: undefined, type: "test.undef", properties: {} } }
    GlobalBus.emitEvent(undef)
    expect(typeof undef.payload.id).toBe("string")

    const numeric: GlobalEvent = { payload: { id: 42, type: "test.numeric", properties: {} } }
    GlobalBus.emitEvent(numeric)
    expect(typeof numeric.payload.id).toBe("string")

    // A usable id is kept as-is. This one deliberately sorts OLDER than
    // any generated id so it cannot leak into other tests' replays.
    const kept: GlobalEvent = {
      payload: { id: "evt_000000000001aaaaaaaaaaaaaa", type: "test.kept", properties: {} },
    }
    GlobalBus.emitEvent(kept)
    expect(kept.payload.id).toBe("evt_000000000001aaaaaaaaaaaaaa")

    // And the normalized events replay from a real cursor like any other.
    const replay = GlobalBus.sinceEvents(cursor.payload.id)
    expect(replay.complete).toBe(true)
    const types = replay.events.map((event) => event.payload.type)
    expect(types).toContain("test.undef")
    expect(types).toContain("test.numeric")
  })

  test("sinceEvents replays exactly the events after the cursor", async () => {
    const before = published("test.before")
    await sleep(2)
    const after1 = published("test.after1")
    const after2 = published("test.after2")

    const result = GlobalBus.sinceEvents(before.payload.id)
    expect(result.complete).toBe(true)
    const types = result.events.map((event) => event.payload.type)
    expect(types).toContain("test.after1")
    expect(types).toContain("test.after2")
    expect(types).not.toContain("test.before")
    // replay order is publication order
    expect(types.indexOf("test.after1")).toBeLessThan(types.indexOf("test.after2"))
  })

  test("a cursor at or beyond the newest event replays nothing, completely", () => {
    const newest = published("test.newest")
    const result = GlobalBus.sinceEvents(newest.payload.id)
    expect(result.complete).toBe(true)
    expect(result.events).toEqual([])
  })

  test("a cursor older than the retained log is reported incomplete", () => {
    // evt_ + 12 hex chars of (ms*0x1000+counter): an ancient timestamp is a
    // valid id shape that predates anything retained.
    const ancient = "evt_000000000001aaaaaaaaaaaaaa"
    const result = GlobalBus.sinceEvents(ancient)
    expect(result.complete).toBe(false)
    expect(result.events).toEqual([])
  })

  test("eviction keeps the log bounded and invalidates old cursors", async () => {
    // Push the log past capacity. 2000 is the retention cap; publishing well
    // past it must evict `old` and shrink the log back.
    const old = published("test.evict.old")
    await sleep(2)
    for (let i = 0; i < 2100; i++) published("test.evict.fill")
    const newest = published("test.evict.newest")

    const evicted = GlobalBus.sinceEvents(old.payload.id)
    expect(evicted.complete).toBe(false)

    const retained = GlobalBus.sinceEvents(newest.payload.id)
    expect(retained.complete).toBe(true)
    expect(retained.events).toEqual([])
  })
})
