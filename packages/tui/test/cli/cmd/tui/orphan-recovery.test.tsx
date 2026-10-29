/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent, TextPart, ReasoningPart } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const sessionID = "ses_orphan_test"
const messageID = "msg_orphan_test"
const partID = "prt_orphan_test"
const session = { id: sessionID, title: "test", time: { created: 0, updated: 0 }, version: "1", directory: "/tmp" }
const assistant = {
  id: messageID,
  sessionID,
  role: "assistant",
  agent: "work",
  modelID: "model",
  providerID: "test",
  mode: "work",
  parentID: "msg_user",
  path: { cwd: "/tmp", root: "/tmp" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1 },
}
function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

test.each([
  { type: "text" as const, snapshot: "", recovery: true, expected: "streamed secret" },
  { type: "reasoning" as const, snapshot: "streamed", recovery: true, expected: "streamed secret" },
  { type: "text" as const, snapshot: "streamed", recovery: false, expected: "streamed" },
  { type: "text" as const, snapshot: "", recovery: false, expected: "" },
])("live terminal $type recovery=$recovery snapshot=$snapshot", async ({ type, snapshot, recovery, expected }) => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)
  const initial = { id: partID, sessionID, messageID, type, text: "", time: { start: 1 } } as TextPart | ReasoningPart
  try {
    emit(global({ id: "start", type: "message.part.updated", properties: { sessionID, time: 1, part: initial } }))
    emit(
      global({
        id: "delta",
        type: "message.part.delta",
        properties: { sessionID, messageID, partID, field: "text", delta: "streamed secret" },
      }),
    )
    await wait(
      () =>
        sync.data.part[messageID]?.[0]?.type === type &&
        (sync.data.part[messageID][0] as TextPart).text === "streamed secret",
    )
    const identity = sync.data.part[messageID][0]
    emit(
      global({
        id: "end",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 2,
          part: {
            ...initial,
            text: snapshot,
            time: { start: 1, end: 2 },
            // Provider metadata must never be interpreted as recovery provenance.
            metadata: { "opencode.orphaned": true },
            ...(recovery ? { recovery: "orphaned" as const } : {}),
          },
        },
      }),
    )
    await wait(() => (sync.data.part[messageID]?.[0] as TextPart).time?.end === 2)
    expect(sync.data.part[messageID][0]).toBe(identity)
    expect(sync.data.part[messageID][0]).toMatchObject({ text: expected, time: { start: 1, end: 2 } })
    emit(
      global({
        id: "late",
        type: "message.part.delta",
        properties: { sessionID, messageID, partID, field: "text", delta: " stale" },
      }),
    )
    emit(
      global({
        id: "stale",
        type: "message.part.updated",
        properties: { sessionID, time: 3, part: { ...initial, text: "streamed secret plus stale" } },
      }),
    )
    await Bun.sleep(30)
    expect(sync.data.part[messageID][0]).toMatchObject({ text: expected, time: { start: 1, end: 2 } })
  } finally {
    app.renderer.destroy()
  }
})

test("hydration settles orphan reasoning without losing its stream", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const part: ReasoningPart = { id: partID, sessionID, messageID, type: "reasoning", text: "", time: { start: 1 } }
  const terminal = { ...part, time: { start: 1, end: 2 }, recovery: "orphaned" as const }
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return json([{ info: assistant, parts: [terminal] }])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)
  try {
    emit(global({ id: "start", type: "message.part.updated", properties: { sessionID, time: 1, part } }))
    emit(
      global({
        id: "delta",
        type: "message.part.delta",
        properties: { sessionID, messageID, partID, field: "text", delta: "reasoning" },
      }),
    )
    await wait(() => (sync.data.part[messageID]?.[0] as ReasoningPart)?.text === "reasoning")
    await sync.session.sync(sessionID)
    expect(sync.data.part[messageID][0]).toMatchObject({ text: "reasoning", time: { start: 1, end: 2 } })
  } finally {
    app.renderer.destroy()
  }
})
