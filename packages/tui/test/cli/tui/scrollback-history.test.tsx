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
  rows,
  scrollBox,
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
// transcript from that same window. The fix is not a bigger cache: the mount is
// bounded to the newest page, older pages arrive through the endpoint's
// `before` cursor, and copy/export read every persisted page themselves. These
// tests mount the real session route against a fixture that pages exactly like
// the server, so the assertions read painted pixels and real transcript output
// instead of store internals alone.

const SESSION = sessionInfo("ses_0815_long", { title: "Long session" })
const MARKER = "HISTORY-MARK-"
// The mount page, matching `PAGE_SIZE` in the sync store.
const PAGE = 100

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

function params(request: { search: string }) {
  return new URLSearchParams(request.search)
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

// Wheel over the transcript (right of the docked sidebar at the normal size).
async function wheel(
  app: Awaited<ReturnType<typeof mountSessionRoute>>["app"],
  times: number,
) {
  for (let i = 0; i < times; i++) await app.mockMouse.scroll(app.renderer.width - 10, 5, "up")
  await settle(app)
}

type Mounted = Awaited<ReturnType<typeof mountSessionRoute>>["app"]

// The transcript's own scroll window. Paging tests below drive it to the top the
// way a scrollbar drag or a held key does — one call per window, instead of
// replaying hundreds of wheel steps whose height depends on the layout.
function scrollBoxOf(app: Mounted) {
  const box = scrollBox(app)
  if (!box) throw new Error("session route rendered no scroll box")
  return box
}

async function scrollWindowToTop(app: Mounted) {
  scrollBoxOf(app).scrollTo(0)
  await settle(app)
}

function firstVisibleMarker(list: string[]) {
  return list.map((row) => row.match(/HISTORY-MARK-\d{3}/)?.[0]).find((mark) => mark !== undefined)
}

function rowOf(list: string[], needle: string) {
  return list.findIndex((row) => row.includes(needle))
}

describe("bounded mount and on-demand older history (#815)", () => {
  test("the mount loads the newest page only and the oldest arrives on demand", async () => {
    const messages = timeline(150)
    const first = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: messages },
    })
    await waitFor(first.app, () => (first.sync.data.message[SESSION.id]?.length === PAGE ? true : undefined))

    // The newest output is painted and the oldest is not on screen yet, so the
    // pixel assertion about scrollback is about loading, not a lucky viewport.
    await painted(first.app, `${MARKER}150`)
    expect(first.app.captureCharFrame()).not.toContain(`${MARKER}001`)

    // Bounded: the mount window is the newest page, with that page's parts and
    // a cursor to the rest of the timeline.
    expect(first.sync.data.message[SESSION.id]?.[0]?.id).toBe("msg_051")
    expect(Object.keys(first.sync.data.part).length).toBe(PAGE)
    expect(first.sync.data.part["msg_051"]).toHaveLength(1)
    expect(first.sync.session.hasOlder(SESSION.id)).toBe(true)

    // Bounded by a real page request, not by fetching everything and trimming.
    const hydration = messageRequests(first.requests)[0]
    expect(hydration && params(hydration).get("limit")).toBe(String(PAGE))
    expect(hydration && params(hydration).has("before")).toBe(false)

    // Oldest-to-newest navigation reaches the first persisted marker.
    await scrollToTop(first.app, first.keymap)
    await waitFor(first.app, () => (first.sync.data.message[SESSION.id]?.length === 150 ? true : undefined))
    await painted(first.app, `${MARKER}001`)
    expect(first.sync.data.part["msg_001"]).toHaveLength(1)
    expect(first.sync.session.hasOlder(SESSION.id)).toBe(false)
    const older = messageRequests(first.requests).filter((request) => params(request).has("before"))
    expect(older.length).toBeGreaterThan(0)
    expect(older[0] && params(older[0]).get("limit")).toBe(String(PAGE))

    first.app.renderer.destroy()
    await disposeSessionRoutes()

    // Reopening the same session stays bounded and still reaches the oldest.
    const reopened = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: messages },
    })
    await waitFor(reopened.app, () => (reopened.sync.data.message[SESSION.id]?.length === PAGE ? true : undefined))
    expect(reopened.sync.data.message[SESSION.id]?.[0]?.id).toBe("msg_051")
    await scrollToTop(reopened.app, reopened.keymap)
    await waitFor(reopened.app, () => (reopened.sync.data.message[SESSION.id]?.length === 150 ? true : undefined))
    await painted(reopened.app, `${MARKER}001`)
  })

  test("scrolling up through several pages reaches the oldest message", async () => {
    const messages = timeline(250)
    const { app, sync } = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: messages },
    })
    await waitFor(app, () => (sync.data.message[SESSION.id]?.length === PAGE ? true : undefined))

    // A wheel step really does move the transcript.
    const box = scrollBoxOf(app)
    const parked = box.scrollTop
    await wheel(app, 1)
    expect(box.scrollTop).toBeLessThan(parked)

    // Scrolling to the top of the window loads exactly one page per step, and
    // each page has to arrive on the waiting budget this suite uses everywhere
    // (the default `waitFor`), not on a longer one.
    for (const expected of [200, 250]) {
      await scrollWindowToTop(app)
      await waitFor(app, () =>
        (sync.data.message[SESSION.id]?.length ?? 0) >= expected
          ? true
          : undefined,
      )
    }
    expect(sync.data.message[SESSION.id]?.length).toBe(250)
    expect(sync.data.message[SESSION.id]?.[0]?.id).toBe("msg_001")
    expect(Object.keys(sync.data.part).length).toBe(250)
    expect(sync.session.hasOlder(SESSION.id)).toBe(false)

    // And the oldest message is what the reader now sees.
    await scrollWindowToTop(app)
    await painted(app, `${MARKER}001`)
  })

  test("first message drains a page that is already in flight", async () => {
    const messages = timeline(150)
    let release!: () => void
    const older = new Promise<Response>((resolve) => {
      release = () => resolve(json(messages.slice(0, 50)))
    })
    let hydrated = false
    let held = false
    const { app, sync, keymap } = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: messages },
      respond: (request) => {
        if (request.method !== "GET" || request.pathname !== `/session/${SESSION.id}/message`) return undefined
        if (!hydrated) {
          hydrated = true
          return undefined
        }
        held = true
        return older
      },
    })
    await waitFor(app, () => (sync.data.message[SESSION.id]?.length === PAGE ? true : undefined))

    // The reader is at the top, so an older page is already loading.
    await scrollWindowToTop(app)
    await waitFor(app, () => (held ? true : undefined))
    await settle(app)

    // Home must wait for that page and keep going: it may not report "nothing
    // older" just because another page read is in flight, which used to leave
    // the reader on the oldest *loaded* message instead of the oldest one.
    keymap().dispatchCommand("session.first")
    await settle(app)
    release()

    await waitFor(app, () => (sync.data.message[SESSION.id]?.length === 150 ? true : undefined))
    await waitFor(app, () => (sync.session.hasOlder(SESSION.id) === false ? true : undefined))
    await painted(app, `${MARKER}001`)
  })

  test("first message keeps draining when a page only repeats rows", async () => {
    // Stable id cursors: the page after the newest one repeats rows the store
    // already holds (a duplicate window) while older history still exists.
    const messages = timeline(250)
    const { app, sync, keymap, requests } = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: messages },
      respond: (request) => {
        if (request.method !== "GET" || request.pathname !== `/session/${SESSION.id}/message`) return undefined
        const before = new URLSearchParams(request.search).get("before")
        if (!before) return json(messages.slice(150), { headers: { "x-next-cursor": "msg_151" } })
        if (before === "msg_151") return json(messages.slice(150, 200), { headers: { "x-next-cursor": "msg_101" } })
        if (before === "msg_101") return json(messages.slice(100, 150), { headers: { "x-next-cursor": "msg_051" } })
        if (before === "msg_051") return json(messages.slice(50, 100), { headers: { "x-next-cursor": "msg_001" } })
        return json(messages.slice(0, 50))
      },
    })
    await waitFor(app, () => (sync.data.message[SESSION.id]?.length === PAGE ? true : undefined))

    // The first older page adds nothing but still moves the cursor: that is
    // progress, not the end of the timeline.
    keymap().dispatchCommand("session.first")
    await waitFor(app, () => (sync.data.message[SESSION.id]?.length === 250 ? true : undefined))
    await waitFor(app, () => (sync.session.hasOlder(SESSION.id) === false ? true : undefined))
    expect(sync.data.message[SESSION.id]?.[0]?.id).toBe("msg_001")
    expect(new Set(sync.data.message[SESSION.id]?.map((info) => info.id)).size).toBe(250)
    await painted(app, `${MARKER}001`)
  })

  test("paging keeps its place when a persisted row disappears", async () => {
    const messages = timeline(250)
    const { app, sync, keymap, pages } = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: messages },
      // The stable id cursor the server returns. The offset cursor below moves
      // when the timeline loses a row and re-delivers one the reader has.
      cursor: "id",
    })
    await waitFor(app, () => (sync.data.message[SESSION.id]?.length === PAGE ? true : undefined))

    // A row *older than the page boundary* disappears before the older pages
    // are read. An offset cursor (the reader's position counted in rows) then
    // slides: the next page starts one row too late and repeats a message.
    messages.splice(9, 1)

    keymap().dispatchCommand("session.first")
    await waitFor(app, () => (sync.session.hasOlder(SESSION.id) === false ? true : undefined))

    // No page may serve a message twice...
    const served = pages.flatMap((page) => page.ids)
    expect(served.length).toBeGreaterThan(PAGE)
    expect(new Set(served).size).toBe(served.length)

    // ...and every persisted row is still reachable, oldest first.
    const ids = sync.data.message[SESSION.id]?.map((info) => info.id) ?? []
    expect(ids.length).toBe(249)
    expect(new Set(ids).size).toBe(249)
    expect(ids[0]).toBe("msg_001")
    expect(ids).not.toContain("msg_010")
    expect(ids).toContain("msg_009")
    expect(ids).toContain("msg_011")
    expect(ids).toContain("msg_052")
  })

  for (const [name, fail] of Object.entries({
    "server error": () => json({ message: "unavailable" }, { status: 500 }),
    "network error": (): Response => {
      throw new Error("socket closed")
    },
  })) {
    test(`first message reports a ${name} on an older page and retries to the oldest`, async () => {
      const messages = timeline(150)
      let hydrated = false
      let broken = true
      const { app, sync, keymap } = await mountSessionRoute({
        width: 120,
        height: 40,
        sessions: [SESSION],
        messages: { [SESSION.id]: messages },
        respond: (request) => {
          if (request.method !== "GET" || request.pathname !== `/session/${SESSION.id}/message`) return undefined
          if (!hydrated) {
            hydrated = true
            return undefined
          }
          if (!broken) return undefined
          return fail()
        },
      })
      await waitFor(app, () => (sync.data.message[SESSION.id]?.length === PAGE ? true : undefined))

      keymap().dispatchCommand("session.first")

      // The failure is reported, and the reader is not dropped at the oldest
      // *loaded* message as if it were the first one.
      await painted(app, "Failed to load older messages")
      await settle(app)
      expect(sync.data.message[SESSION.id]?.length).toBe(PAGE)
      expect(sync.session.hasOlder(SESSION.id)).toBe(true)
      expect(app.captureCharFrame()).not.toContain(`${MARKER}001`)

      // The cursor was not consumed by the failure, so the next attempt retries
      // the same page and reaches the real oldest message.
      broken = false
      keymap().dispatchCommand("session.first")
      await waitFor(app, () => (sync.data.message[SESSION.id]?.length === 150 ? true : undefined))
      await waitFor(app, () => (sync.session.hasOlder(SESSION.id) === false ? true : undefined))
      await painted(app, `${MARKER}001`)
    })
  }

  test("a failed hydration is retried instead of looking like an empty session", async () => {
    const messages = timeline(150)
    let broken = true
    const { app, sync, keymap } = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: messages },
      respond: (request) => {
        if (request.method !== "GET" || request.pathname !== `/session/${SESSION.id}/message`) return undefined
        if (!broken) return undefined
        return json({ message: "unavailable" }, { status: 500 })
      },
    })
    await settle(app)

    // The mount's read failed: sync must stay quiet (#26560) and must not record
    // an empty timeline as this session's complete history.
    expect(sync.data.message[SESSION.id]?.length ?? 0).toBe(0)
    expect(sync.session.hasOlder(SESSION.id)).toBe(false)

    broken = false
    await sync.session.sync(SESSION.id)
    await waitFor(app, () => (sync.data.message[SESSION.id]?.length === PAGE ? true : undefined))
    expect(sync.session.hasOlder(SESSION.id)).toBe(true)

    keymap().dispatchCommand("session.first")
    await waitFor(app, () => (sync.session.hasOlder(SESSION.id) === false ? true : undefined))
    expect(sync.data.message[SESSION.id]?.length).toBe(150)
    await painted(app, `${MARKER}001`)
  })

  test("wheel scrolling into the top loads the next page", async () => {
    // A wheel-only walk of a 100-message window does not fit this suite's
    // default per-test budget (measured: over five seconds of wheel steps), so
    // the multi-page test walks with the scroll window and this one keeps the
    // wheel path honest: the wheel moves the transcript and, crossing into the
    // prefetch zone, is what loads the page.
    const messages = timeline(150)
    const { app, sync } = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: messages },
    })
    await waitFor(app, () => (sync.data.message[SESSION.id]?.length === PAGE ? true : undefined))

    const box = scrollBoxOf(app)
    const parked = box.scrollTop
    await wheel(app, 1)
    expect(box.scrollTop).toBeLessThan(parked)

    // Park just outside the one-viewport prefetch zone, then let the wheel
    // cross into it.
    box.scrollTo(box.viewport.height + 4)
    await settle(app)
    expect(sync.data.message[SESSION.id]?.length).toBe(PAGE)

    await wheel(app, 3)
    await waitFor(app, () => (sync.data.message[SESSION.id]?.length === 150 ? true : undefined))
    expect(sync.session.hasOlder(SESSION.id)).toBe(false)
    expect(sync.data.message[SESSION.id]?.[0]?.id).toBe("msg_001")
  })

  test("copy and export keep a prompt the server has not persisted yet", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "silvercode-export-live-"))
    const visual = process.env.VISUAL
    const editor = process.env.EDITOR
    delete process.env.VISUAL
    delete process.env.EDITOR
    try {
      // A brand-new session: the persisted timeline is empty, and the only
      // message is the prompt the reader just sent.
      const written: string[] = []
      const { app, events, sync, keymap } = await mountSessionRoute({
        width: 120,
        height: 40,
        sessions: [SESSION],
        messages: { [SESSION.id]: [] },
        paths: { cwd },
        clipboard: { write: async (text) => void written.push(text) },
      })
      await settle(app)

      const prompt = userMessage("msg_live_prompt", SESSION.id, { time: { created: BASE + 1_000 } })
      events.emit({
        directory,
        payload: {
          id: "evt_live_prompt",
          type: "message.updated",
          properties: { sessionID: SESSION.id, info: prompt },
        },
      })
      events.emit({
        directory,
        payload: {
          id: "evt_live_prompt_part",
          type: "message.part.updated",
          properties: {
            sessionID: SESSION.id,
            time: prompt.time.created,
            part: textPart("prt_live_prompt", prompt, "LIVE-PROMPT-TEXT"),
          },
        },
      })
      await waitFor(app, () => (sync.data.message[SESSION.id]?.length === 1 ? true : undefined))
      await painted(app, "LIVE-PROMPT-TEXT")

      keymap().dispatchCommand("session.copy")
      await waitFor(app, () => (written.length > 0 ? true : undefined))
      expect(written[0]).toContain("LIVE-PROMPT-TEXT")

      keymap().dispatchCommand("session.export")
      await waitFor(app, () => (app.captureCharFrame().includes("Export Options") ? true : undefined))
      await settle(app)
      app.mockInput.pressEnter()

      const file = path.join(cwd, `session-${SESSION.id.slice(0, 8)}.md`)
      await waitFor(app, () => (existsSync(file) ? true : undefined), 400, "export never wrote a file")
      expect(await readFile(file, "utf8")).toContain("LIVE-PROMPT-TEXT")
    } finally {
      if (visual !== undefined) process.env.VISUAL = visual
      if (editor !== undefined) process.env.EDITOR = editor
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("an older page prepends without moving what the reader is looking at", async () => {
    const messages = timeline(150)
    let release!: () => void
    const older = new Promise<Response>((resolve) => {
      release = () => resolve(json(messages.slice(0, 50)))
    })
    let hydrated = false
    let held = false
    const { app, sync } = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: messages },
      respond: (request) => {
        if (request.method !== "GET" || request.pathname !== `/session/${SESSION.id}/message`) return undefined
        if (!hydrated) {
          hydrated = true
          return undefined
        }
        held = true
        return older
      },
    })
    await waitFor(app, () => (sync.data.message[SESSION.id]?.length === PAGE ? true : undefined))

    // Scroll to the top so the page request fires; its response is held, so the
    // frame captured here is what the reader must keep seeing.
    await scrollWindowToTop(app)
    await waitFor(app, () => (held ? true : undefined))
    await settle(app)

    const before = await rows(app)
    const anchor = firstVisibleMarker(before)
    expect(anchor).toBeDefined()
    const anchorRow = rowOf(before, anchor as string)
    expect(anchorRow).toBeGreaterThanOrEqual(0)

    release()
    await waitFor(app, () => (sync.data.message[SESSION.id]?.length === 150 ? true : undefined))
    await settle(app)
    await settle(app)

    // The prepend did not scroll the reader: same message, same row, and the
    // older rows sit above the viewport instead of pushing it down.
    const after = await rows(app)
    expect(firstVisibleMarker(after)).toBe(anchor as string)
    expect(rowOf(after, anchor as string)).toBe(anchorRow)
    expect(firstVisibleMarker(after)).not.toBe(`${MARKER}001`)
  })

  test("live appends no longer evict the oldest message or its parts", async () => {
    const messages = timeline(120)
    const { app, sync, events, keymap } = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: messages.slice(0, 60) },
    })
    await waitFor(app, () => (sync.data.message[SESSION.id]?.length === 60 ? true : undefined))

    // Grow the session past the removed 100-message ceiling one message at a
    // time, exactly as the live stream does.
    for (const entry of messages.slice(60)) {
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
    const { app, keymap, sync } = await mountSessionRoute({
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
    // The transcript came from the pages, not from the bounded store.
    expect(sync.data.message[SESSION.id]?.length).toBe(PAGE)
  })

  test("export writes the complete transcript to disk while the store stays bounded", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "silvercode-export-"))
    // `openEditor` must stay out of the way: without an editor the export only
    // writes the file, which is exactly what this test reads back.
    const visual = process.env.VISUAL
    const editor = process.env.EDITOR
    delete process.env.VISUAL
    delete process.env.EDITOR
    try {
      const { app, keymap, requests, sync } = await mountSessionRoute({
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
      // The export reads every persisted page, newest page first, walking
      // `before` — it does not depend on what the mount window holds.
      const requests_ = messageRequests(requests)
      const paged = requests_.filter((request) => params(request).has("before"))
      expect(paged.length).toBeGreaterThan(0)
      for (const request of requests_) {
        if (params(request).has("before")) expect(params(request).get("limit")).toBe(String(PAGE))
      }
      expect(sync.data.message[SESSION.id]?.length).toBe(PAGE)
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
    const messages = timeline(4)
    let release!: () => void
    const history = new Promise<Response>((resolve) => {
      release = () => resolve(json(messages))
    })
    let hydrated = false
    let requested = false
    const written: string[] = []
    const { app, events, sync, keymap } = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: messages },
      clipboard: { write: async (text) => void written.push(text) },
      respond: (request) => {
        if (request.method !== "GET" || request.pathname !== `/session/${SESSION.id}/message`) return undefined
        if (!hydrated) {
          hydrated = true
          return json(messages)
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

  test("a part that changes type during the transcript request exports the live part", async () => {
    // The transcript now walks older pages, so the part that changes type can
    // live in one of them (message 2 is outside the mount window here). That is
    // also the realistic shape of the defect: the persisted page carries the
    // part's older row, the live stream carries a newer part with the same id
    // but a different type, and only the live one may reach the transcript.
    const messages = timeline(150)
    let release!: () => void
    const older = new Promise<Response>((resolve) => {
      release = () => resolve(json(messages.slice(0, 50)))
    })
    let requests = 0
    let requested = false
    const written: string[] = []
    const { app, events, sync, keymap } = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: messages },
      clipboard: { write: async (text) => void written.push(text) },
      respond: (request) => {
        if (request.method !== "GET" || request.pathname !== `/session/${SESSION.id}/message`) return undefined
        requests++
        // 1: hydration, 2: the transcript's newest page — both answered by the
        // fixture. 3: the older page the transcript needs, held open.
        if (requests < 3) return undefined
        requested = true
        return older
      },
    })
    await waitFor(app, () => (sync.data.message[SESSION.id]?.length === PAGE ? true : undefined))

    keymap().dispatchCommand("session.copy")
    await waitFor(app, () => (requested ? true : undefined))

    // Same part id, different type. The live projection is the newest version
    // of that part, so the persisted text row must not overwrite it — and the
    // stale text must not reach the transcript either.
    events.emit({
      directory,
      payload: {
        id: "evt_type_change",
        type: "message.part.updated",
        properties: {
          sessionID: SESSION.id,
          time: BASE + 2_000,
          part: {
            id: "prt_002",
            sessionID: SESSION.id,
            messageID: "msg_002",
            type: "tool",
            tool: "live-tool",
            callID: "call_live",
            state: {
              status: "completed",
              input: { probe: "live" },
              output: "LIVE-TOOL-OUTPUT",
              title: "live-tool",
              metadata: {},
              time: { start: BASE + 1_000, end: BASE + 2_000 },
            },
          },
        },
      },
    })
    await waitFor(app, () => (sync.data.part["msg_002"]?.[0]?.type === "tool" ? true : undefined))

    release()
    await waitFor(app, () => (written.length > 0 ? true : undefined))

    const transcript = written[0] ?? ""
    expect(transcript).toContain("**Tool: live-tool**")
    expect(transcript).not.toContain(`${MARKER}002`)
    expect(transcript).toContain(`${MARKER}001`)
    expect(transcript).toContain(`${MARKER}150`)
    expect(occurrences(transcript, MARKER)).toBe(149)
  })

  test("the live part wins over the persisted row with the same id (route change during the request)", async () => {
    // Same defect, seen from the mounted window: the request is open, the user
    // navigates away, and the live update for that part (now off-screen) turns
    // a prose part into a tool call. The transcript must follow the live part.
    const messages = timeline(4)
    messages[1] = { info: messages[1]!.info, parts: [textPart("prt_002", messages[1]!.info, "STALE-TEXT")] }
    const other = sessionInfo("ses_zzzz_other", { title: "Other session" })
    const otherInfo = userMessage("msg_other", other.id, {})
    let release!: () => void
    const history = new Promise<Response>((resolve) => {
      release = () => resolve(json(messages))
    })
    let hydrated = false
    let requested = false
    const written: string[] = []
    const { app, events, keymap, navigate } = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION, other],
      messages: {
        [SESSION.id]: messages,
        [other.id]: [{ info: otherInfo, parts: [textPart("prt_other", otherInfo, "OTHER-SESSION")] }],
      },
      clipboard: { write: async (text) => void written.push(text) },
      respond: (request) => {
        if (request.method !== "GET" || request.pathname !== `/session/${SESSION.id}/message`) return undefined
        if (!hydrated) {
          hydrated = true
          return undefined
        }
        requested = true
        return history
      },
    })
    await settle(app)

    keymap().dispatchCommand("session.copy")
    await waitFor(app, () => (requested ? true : undefined))

    // Leave the session so the update cannot repaint the row it changes; the
    // command already bound this session, so its transcript is unaffected.
    navigate(other.id)
    await painted(app, "OTHER-SESSION")

    events.emit({
      directory,
      payload: {
        id: "evt_type_change_nav",
        type: "message.part.updated",
        properties: {
          sessionID: SESSION.id,
          time: BASE + 2_000,
          part: {
            id: "prt_002",
            sessionID: SESSION.id,
            messageID: "msg_002",
            type: "tool",
            tool: "live-tool",
            callID: "call_live",
            state: {
              status: "completed",
              input: { probe: "live" },
              output: "LIVE-TOOL-OUTPUT",
              title: "live-tool",
              metadata: {},
              time: { start: BASE + 1_000, end: BASE + 2_000 },
            },
          },
        },
      },
    })
    await settle(app)

    release()
    await waitFor(app, () => (written.length > 0 ? true : undefined), 400, "copy never produced a transcript")

    const transcript = written[0] ?? ""
    expect(transcript).toContain("**Tool: live-tool**")
    expect(transcript).not.toContain("STALE-TEXT")
    expect(transcript).toContain(`${MARKER}001`)
    expect(transcript).toContain(`${MARKER}004`)
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
        const messages = timeline(4)
        let hydrated = false
        const written: string[] = []
        const { app, keymap } = await mountSessionRoute({
          width: 120,
          height: 40,
          sessions: [SESSION],
          messages: { [SESSION.id]: messages },
          paths: { cwd },
          clipboard: { write: async (text) => void written.push(text) },
          respond: (request) => {
            if (request.method !== "GET" || request.pathname !== `/session/${SESSION.id}/message`) return undefined
            if (!hydrated) {
              hydrated = true
              return json(messages)
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

  test("copy and export can read overlapping pages without interfering", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "silvercode-export-overlap-"))
    const visual = process.env.VISUAL
    const editor = process.env.EDITOR
    delete process.env.VISUAL
    delete process.env.EDITOR
    try {
      const messages = timeline(150)
      const held: { release: () => void }[] = []
      let hydrated = false
      const written: string[] = []
      const { app, keymap } = await mountSessionRoute({
        width: 120,
        height: 40,
        sessions: [SESSION],
        messages: { [SESSION.id]: messages },
        paths: { cwd },
        clipboard: { write: async (text) => void written.push(text) },
        respond: (request) => {
          if (request.method !== "GET" || request.pathname !== `/session/${SESSION.id}/message`) return undefined
          if (!hydrated) {
            hydrated = true
            return undefined
          }
          // Only the two newest pages are held; the `before` page after them
          // falls through to the fixture and is answered immediately.
          if (held.length >= 2) return undefined
          return new Promise<Response>((resolve) => {
            held.push({
              // Each read starts from the newest page, so both resolve the same
              // persisted rows — exactly the overlap the old single tracker
              // registry could not describe.
              release: () => resolve(json(messages.slice(100), { headers: { "x-next-cursor": "100" } })),
            })
          })
        },
      })
      await settle(app)

      keymap().dispatchCommand("session.copy")
      await waitFor(app, () => (held.length === 1 ? true : undefined))

      keymap().dispatchCommand("session.export")
      await waitFor(app, () => (app.captureCharFrame().includes("Export Options") ? true : undefined))
      await settle(app)
      app.mockInput.pressEnter()
      await waitFor(app, () => (held.length === 2 ? true : undefined))

      // Release the export's page first: each read owns its own tracker and its
      // own cursor walk, so the order they settle in cannot leak one into the
      // other.
      held[1]?.release()
      await settle(app)
      held[0]?.release()

      const file = path.join(cwd, `session-${SESSION.id.slice(0, 8)}.md`)
      await waitFor(app, () => (existsSync(file) ? true : undefined), 400, "export never wrote a file")
      await waitFor(app, () => (written.length > 0 ? true : undefined))

      const copied = written[0] ?? ""
      const exported = await readFile(file, "utf8")
      expect(occurrences(copied, MARKER)).toBe(150)
      expect(occurrences(exported, MARKER)).toBe(150)
      expect(copied).toContain(`${MARKER}001`)
      expect(copied).toContain(`${MARKER}150`)
      expect(exported).toContain(`${MARKER}001`)
      expect(exported).toContain(`${MARKER}150`)
    } finally {
      if (visual !== undefined) process.env.VISUAL = visual
      if (editor !== undefined) process.env.EDITOR = editor
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("releasing a held transcript page after teardown stays safe", async () => {
    const messages = timeline(150)
    const held: { release: () => void }[] = []
    let hydrated = false
    const written: string[] = []
    const { app, keymap } = await mountSessionRoute({
      width: 120,
      height: 40,
      sessions: [SESSION],
      messages: { [SESSION.id]: messages },
      clipboard: { write: async (text) => void written.push(text) },
      respond: (request) => {
        if (request.method !== "GET" || request.pathname !== `/session/${SESSION.id}/message`) return undefined
        if (!hydrated) {
          hydrated = true
          return undefined
        }
        if (held.length > 0) return undefined
        return new Promise<Response>((resolve) => {
          held.push({
            release: () => resolve(json(messages.slice(100), { headers: { "x-next-cursor": "100" } })),
          })
        })
      },
    })
    await settle(app)

    keymap().dispatchCommand("session.copy")
    await waitFor(app, () => (held.length === 1 ? true : undefined))

    app.renderer.destroy()
    await disposeSessionRoutes()
    held[0]?.release()
    // The late response must not touch destroyed render state. A transcript the
    // command had already promised may still land, but never a partial one.
    await Bun.sleep(200)
    expect(written.length <= 1).toBe(true)
    if (written.length === 1) expect(occurrences(written[0] ?? "", MARKER)).toBe(150)
  })

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
