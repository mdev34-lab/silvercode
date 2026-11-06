/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import {
  BASE,
  assistantMessage,
  disposeSessionRoutes,
  mountSessionRoute,
  sessionInfo,
  settle,
  textPart,
  userMessage,
} from "../../fixture/session-route"
import { waitFor } from "../../fixture/frame"
import { directory, json } from "../../fixture/tui-sdk"

afterEach(disposeSessionRoutes)

// #815: a session longer than the old 100-message cache lost its oldest
// messages on hydration and on every live append, and copy/export built the
// transcript from that same window. These tests mount the real session route
// against a fixture that pages exactly like the server, so the assertions read
// painted pixels and real transcript output instead of store internals alone.

const SESSION = sessionInfo("ses_0815_long", { title: "Long session" })
const MARKER = "HISTORY-MARK-"

function timeline(count: number): { info: Message; parts: Part[] }[] {
  return Array.from({ length: count }, (_, index) => {
    const mark = String(index + 1).padStart(3, "0")
    const created = BASE + (index + 1) * 1_000
    const info =
      (index + 1) % 2 === 1
        ? userMessage(`msg_${mark}`, SESSION.id, { time: { created } })
        : assistantMessage(`msg_${mark}`, SESSION.id, { time: { created, completed: created + 500 } })
    return { info, parts: [textPart(`prt_${mark}`, info, `${MARKER}${mark}`)] }
  })
}

function occurrences(haystack: string, needle: string) {
  return haystack.split(needle).length - 1
}

function messageRequests(requests: { pathname: string; search: string }[]) {
  return requests.filter((request) => request.pathname === `/session/${SESSION.id}/message`)
}

async function scrollToTop(
  app: Awaited<ReturnType<typeof mountSessionRoute>>["app"],
  keymap: () => { dispatchCommand(name: string): void },
) {
  keymap().dispatchCommand("session.first")
  await settle(app)
}

async function painted(app: Awaited<ReturnType<typeof mountSessionRoute>>["app"], needle: string) {
  return waitFor(app, () => (app.captureCharFrame().includes(needle) ? true : undefined), 200, `missing ${needle}`)
}

describe("session history beyond the old 100-message window (#815)", () => {
  test("hydration loads the whole timeline and reopening keeps it", async () => {
    const rows = timeline(150)
    const first = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: rows },
    })
    await waitFor(first.app, () => (first.sync.data.message[SESSION.id]?.length === 150 ? true : undefined))

    // The newest output is painted and the oldest is not on screen yet, so the
    // pixel assertion below is about scrollback and not about a lucky viewport.
    expect(first.app.captureCharFrame()).toContain(`${MARKER}150`)
    expect(first.app.captureCharFrame()).not.toContain(`${MARKER}001`)

    // Every hydrated message keeps its parts; the old hydration deleted the
    // parts of everything outside the newest 100.
    expect(Object.keys(first.sync.data.part).length).toBe(150)
    expect(first.sync.data.part["msg_001"]).toHaveLength(1)

    // Oldest-to-newest navigation reaches the first persisted marker.
    await scrollToTop(first.app, first.keymap)
    await painted(first.app, `${MARKER}001`)

    // The hydration request asked for the complete timeline rather than a page.
    const requests = messageRequests(first.requests)
    expect(requests.length).toBeGreaterThan(0)
    for (const request of requests) expect(new URLSearchParams(request.search).has("limit")).toBe(false)

    first.app.renderer.destroy()
    await disposeSessionRoutes()

    // Reopening the same session must not hide older history.
    const reopened = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: rows },
    })
    await waitFor(reopened.app, () => (reopened.sync.data.message[SESSION.id]?.length === 150 ? true : undefined))
    expect(reopened.sync.data.part["msg_001"]).toHaveLength(1)
    await scrollToTop(reopened.app, reopened.keymap)
    await painted(reopened.app, `${MARKER}001`)
  })

  test("live appends no longer evict the oldest message or its parts", async () => {
    const rows = timeline(120)
    const { app, sync, events, keymap } = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: rows.slice(0, 60) },
    })
    await waitFor(app, () => (sync.data.message[SESSION.id]?.length === 60 ? true : undefined))

    // Grow the session past the removed 100-message ceiling one message at a
    // time, exactly as the live stream does.
    for (const entry of rows.slice(60)) {
      events.emit({
        directory,
        payload: {
          id: `evt_${entry.info.id}`,
          type: "message.updated",
          properties: { sessionID: SESSION.id, info: entry.info },
        },
      })
      for (const part of entry.parts) {
        events.emit({
          directory,
          payload: {
            id: `evt_part_${part.id}`,
            type: "message.part.updated",
            properties: { sessionID: SESSION.id, time: entry.info.time.created, part },
          },
        })
      }
    }
    await waitFor(app, () => (sync.data.message[SESSION.id]?.length === 120 ? true : undefined))

    // Nothing from the beginning was shifted out of the store...
    expect(sync.data.part["msg_001"]).toHaveLength(1)
    expect(sync.data.message[SESSION.id]?.[0]?.id).toBe("msg_001")

    // ...and it is still reachable in the TUI.
    await scrollToTop(app, keymap)
    await painted(app, `${MARKER}001`)
  })

  test("copy transcript includes the first and last messages with their parts", async () => {
    const written: string[] = []
    const { app, keymap } = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: timeline(150) },
      clipboard: { write: async (text) => void written.push(text) },
    })
    await settle(app)

    keymap().dispatchCommand("session.copy")
    await waitFor(app, () => (written.length > 0 ? true : undefined))

    const transcript = written[0] ?? ""
    expect(transcript).toContain(`${MARKER}001`)
    expect(transcript).toContain(`${MARKER}150`)
    expect(occurrences(transcript, MARKER)).toBe(150)
    expect(transcript).toContain(`Session ID:** ${SESSION.id}`)
  })

  test("export writes the complete transcript to disk", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "silvercode-export-"))
    // `openEditor` must stay out of the way: without an editor the export only
    // writes the file, which is exactly what this test reads back.
    const visual = process.env.VISUAL
    const editor = process.env.EDITOR
    delete process.env.VISUAL
    delete process.env.EDITOR
    try {
      const { app, keymap, requests } = await mountSessionRoute({
        width: 120,
        height: 40,
        sessions: [SESSION],
        messages: { [SESSION.id]: timeline(150) },
        paths: { cwd },
        clipboard: { write: async () => {} },
      })
      await settle(app)

      keymap().dispatchCommand("session.export")
      await waitFor(app, () => (app.captureCharFrame().includes("Export Options") ? true : undefined))
      await settle(app)
      app.mockInput.pressEnter()

      const file = path.join(cwd, `session-${SESSION.id.slice(0, 8)}.md`)
      await waitFor(app, () => (existsSync(file) ? true : undefined), 400, "export never wrote a file")

      const transcript = await readFile(file, "utf8")
      expect(transcript).toContain(`${MARKER}001`)
      expect(transcript).toContain(`${MARKER}150`)
      expect(occurrences(transcript, MARKER)).toBe(150)
      // The export reads the complete persisted timeline, not a cached page.
      const requests_ = messageRequests(requests)
      expect(requests_.length).toBeGreaterThan(0)
      for (const request of requests_) expect(new URLSearchParams(request.search).has("limit")).toBe(false)
    } finally {
      if (visual !== undefined) process.env.VISUAL = visual
      if (editor !== undefined) process.env.EDITOR = editor
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe("transcript request races and failures (#815 review)", () => {
  function markedMessages(sessionID: string, count: number, prefix: string) {
    return Array.from({ length: count }, (_, index) => {
      const mark = String(index + 1).padStart(3, "0")
      const created = BASE + (index + 1) * 1_000
      const info =
        (index + 1) % 2 === 1
          ? userMessage(`msg_${sessionID}_${mark}`, sessionID, { time: { created } })
          : assistantMessage(`msg_${sessionID}_${mark}`, sessionID, { time: { created, completed: created + 500 } })
      return { info, parts: [textPart(`prt_${sessionID}_${mark}`, info, `${prefix}${mark}`)] }
    })
  }

  test("removals during the transcript request are not resurrected", async () => {
    const rows = timeline(4)
    let release!: () => void
    const history = new Promise<Response>((resolve) => {
      release = () => resolve(json(rows))
    })
    let hydrated = false
    let requested = false
    const written: string[] = []
    const { app, events, sync, keymap } = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: rows },
      clipboard: { write: async (text) => void written.push(text) },
      respond: (request) => {
        if (request.method !== "GET" || request.pathname !== `/session/${SESSION.id}/message`) return undefined
        if (!hydrated) {
          hydrated = true
          return json(rows)
        }
        requested = true
        return history
      },
    })
    await waitFor(app, () => (sync.data.message[SESSION.id]?.length === 4 ? true : undefined))

    keymap().dispatchCommand("session.copy")
    await waitFor(app, () => (requested ? true : undefined))

    // Both removals land while the transcript request is open, so the persisted
    // snapshot it returns is older than the removals.
    events.emit({
      directory,
      payload: {
        id: "evt_removed_message",
        type: "message.removed",
        properties: { sessionID: SESSION.id, messageID: "msg_002" },
      },
    })
    events.emit({
      directory,
      payload: {
        id: "evt_removed_part",
        type: "message.part.removed",
        properties: { sessionID: SESSION.id, messageID: "msg_004", partID: "prt_004" },
      },
    })
    await waitFor(app, () =>
      sync.data.message[SESSION.id]?.length === 3 && sync.data.part["msg_004"]?.length === 0 ? true : undefined,
    )

    release()
    await waitFor(app, () => (written.length > 0 ? true : undefined))

    const transcript = written[0] ?? ""
    expect(transcript).toContain(`${MARKER}001`)
    expect(transcript).toContain(`${MARKER}003`)
    expect(transcript).not.toContain(`${MARKER}002`)
    expect(transcript).not.toContain(`${MARKER}004`)
    expect(occurrences(transcript, MARKER)).toBe(2)
  })

  for (const [name, failure] of Object.entries({
    "server error": () => json({ message: "unavailable" }, { status: 500 }),
    "network error": () => {
      throw new Error("socket closed")
    },
  })) {
    test(`a history ${name} fails copy and export instead of exporting the cache`, async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "silvercode-export-fail-"))
      const visual = process.env.VISUAL
      const editor = process.env.EDITOR
      delete process.env.VISUAL
      delete process.env.EDITOR
      try {
        const rows = timeline(4)
        let hydrated = false
        const written: string[] = []
        const { app, keymap } = await mountSessionRoute({
          width: 120,
          height: 40,
          sessions: [SESSION],
          messages: { [SESSION.id]: rows },
          paths: { cwd },
          clipboard: { write: async (text) => void written.push(text) },
          respond: (request) => {
            if (request.method !== "GET" || request.pathname !== `/session/${SESSION.id}/message`) return undefined
            if (!hydrated) {
              hydrated = true
              return json(rows)
            }
            return failure()
          },
        })
        await settle(app)

        // The cache holds the transcript, so a swallowed failure would still
        // hand over a "successful" partial export.
        keymap().dispatchCommand("session.copy")
        await painted(app, "Failed to copy session transcript")
        await settle(app)
        expect(written).toHaveLength(0)

        keymap().dispatchCommand("session.export")
        await waitFor(app, () => (app.captureCharFrame().includes("Export Options") ? true : undefined))
        await settle(app)
        app.mockInput.pressEnter()
        await painted(app, "Failed to export session")
        await settle(app)
        expect(existsSync(path.join(cwd, `session-${SESSION.id.slice(0, 8)}.md`))).toBe(false)
      } finally {
        if (visual !== undefined) process.env.VISUAL = visual
        if (editor !== undefined) process.env.EDITOR = editor
        await rm(cwd, { recursive: true, force: true })
      }
    })
  }

  test("export keeps the launched session when the route changes while the dialog is open", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "silvercode-export-nav-"))
    const visual = process.env.VISUAL
    const editor = process.env.EDITOR
    delete process.env.VISUAL
    delete process.env.EDITOR
    try {
      const other = sessionInfo("ses_zzzz_other", { title: "Other session" })
      const primaryRows = markedMessages(SESSION.id, 3, "SESSION-A-")
      const otherRows = markedMessages(other.id, 3, "SESSION-B-")
      const { app, keymap, navigate } = await mountSessionRoute({
        width: 120,
        height: 40,
        sessions: [SESSION, other],
        messages: { [SESSION.id]: primaryRows, [other.id]: otherRows },
        paths: { cwd },
        clipboard: { write: async () => {} },
      })
      await settle(app)

      keymap().dispatchCommand("session.export")
      await waitFor(app, () => (app.captureCharFrame().includes("Export Options") ? true : undefined))
      await settle(app)

      // The user moves to another session before confirming the dialog.
      navigate(other.id)
      await painted(app, "SESSION-B-001")
      app.mockInput.pressEnter()

      const file = path.join(cwd, `session-${SESSION.id.slice(0, 8)}.md`)
      await waitFor(app, () => (existsSync(file) ? true : undefined), 400, "export never wrote a file")

      const transcript = await readFile(file, "utf8")
      expect(transcript).toContain(`Session ID:** ${SESSION.id}`)
      expect(transcript).toContain("SESSION-A-001")
      expect(transcript).toContain("SESSION-A-003")
      expect(transcript).not.toContain("SESSION-B-")
      expect(existsSync(path.join(cwd, `session-${other.id.slice(0, 8)}.md`))).toBe(false)
    } finally {
      if (visual !== undefined) process.env.VISUAL = visual
      if (editor !== undefined) process.env.EDITOR = editor
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
