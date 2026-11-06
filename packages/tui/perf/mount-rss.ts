/**
 * Bounded-mount startup/RSS harness (#815).
 *
 * Mounts the real Session route with the real OpenTUI renderer against a
 * fixture that answers the messages endpoint exactly like the server (newest
 * page + `x-next-cursor`), and reports, per scenario:
 *
 * - `startup_ms`: process start → the newest message painted on screen;
 * - `rss_kib`: resident set after the first frame;
 * - `peak_rss_kib`: peak resident set sampled every 25 ms for the scenario;
 * - `messages`: what the store holds after the mount (the render window);
 * - `export_kib` / `export_peak_rss_kib`: the exported transcript size and the
 *   peak resident set while copy/export stream the whole timeline.
 *
 * This measures the TUI's own mount path in a real process with the real
 * renderer. It does not spawn the packaged binary over a PTY, so the numbers are
 * comparable across revisions of this repo (same harness), not across products.
 *
 * Usage (from `packages/tui`):
 *
 *   bun run perf/mount-rss.ts --count=150
 *   bun run perf/mount-rss.ts --count=5000 --export
 */

import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { mountSessionRoute, sessionInfo, settle } from "../test/fixture/session-route"
import { waitFor } from "../test/fixture/frame"
import { userMessage, assistantMessage, textPart, BASE } from "../test/fixture/session-route"

const started = performance.now()

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=")
    return [key, value] as const
  }),
)
const count = Number(args.get("count") ?? 150)
const wantExport = args.get("export") === "true"
const MARKER = "PERF-MESSAGE-"

const SESSION = sessionInfo("ses_perf_mount", { title: "Perf session" })

function timeline(size: number): { info: Message; parts: Part[] }[] {
  return Array.from({ length: size }, (_, index) => {
    const mark = String(index + 1).padStart(5, "0")
    const created = BASE + (index + 1) * 1_000
    const info =
      (index + 1) % 2 === 1
        ? userMessage(`msg_${mark}`, SESSION.id, { time: { created } })
        : assistantMessage(`msg_${mark}`, SESSION.id, { time: { created, completed: created + 500 } })
    return { info, parts: [textPart(`prt_${mark}`, info, `${MARKER}${mark} prompt ${mark} explanation text`)] }
  })
}

let peak = 0
const sampler = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss)
}, 25)
sampler.unref()

function kib(bytes: number) {
  return Math.round(bytes / 1024)
}

const rows = timeline(count)
const newest = `${MARKER}${String(count).padStart(5, "0")}`

const cwd = wantExport ? await mkdtemp(path.join(os.tmpdir(), "silvercode-perf-export-")) : undefined
const visual = process.env.VISUAL
const editor = process.env.EDITOR
delete process.env.VISUAL
delete process.env.EDITOR

const { app, sync, keymap } = await mountSessionRoute({
  width: 160,
  height: 48,
  sessions: [SESSION],
  messages: { [SESSION.id]: rows },
  ...(cwd ? { paths: { cwd }, clipboard: { write: async () => {} } } : {}),
})

try {
  await waitFor(app, () => (app.captureCharFrame().includes(newest) ? true : undefined), 120_000, "no first frame")
  const startup = performance.now() - started
  const mountRss = process.memoryUsage().rss

  let exportSize = 0
  let exportPeak = 0
  if (cwd) {
    const before = peak
    const file = path.join(cwd, `session-${SESSION.id.slice(0, 8)}.md`)
    keymap().dispatchCommand("session.export")
    await waitFor(app, () => (app.captureCharFrame().includes("Export Options") ? true : undefined))
    await settle(app)
    app.mockInput.pressEnter()
    await waitFor(app, () => (existsSync(file) ? true : undefined), 600_000, "export never wrote a file")
    exportSize = (await readFile(file)).byteLength
    exportPeak = Math.max(peak - before, process.memoryUsage().rss - before)
  }

  console.log(
    JSON.stringify({
      count,
      startup_ms: Math.round(startup),
      rss_kib: kib(mountRss),
      peak_rss_kib: kib(peak),
      store_messages: sync.data.message[SESSION.id]?.length ?? 0,
      paged: typeof (sync.session as { hasOlder?: unknown }).hasOlder === "function",
      export_kib: Math.round(exportSize / 1024),
      export_peak_rss_kib: kib(exportPeak),
    }),
  )
} finally {
  clearInterval(sampler)
  if (visual !== undefined) process.env.VISUAL = visual
  if (editor !== undefined) process.env.EDITOR = editor
  app.renderer.destroy()
  if (cwd) await rm(cwd, { recursive: true, force: true })
  process.exit(0)
}
