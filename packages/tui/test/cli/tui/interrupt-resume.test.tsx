/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import type { GlobalEvent, Message, SessionStatus } from "@opencode-ai/sdk/v2"
import {
  assistantMessage,
  BASE,
  disposeSessionRoutes,
  mountSessionRoute,
  sessionInfo,
  textPart,
  userMessage,
} from "../../fixture/session-route"
import { captureFrame, waitFor } from "../../fixture/frame"
import { directory, json, type FetchRequest } from "../../fixture/tui-sdk"

// Diagnostics + regression for #292 (Refs #292): after ESC interrupts a run,
// the very next prompt in the same session must start a fresh run instead of
// inheriting the cancelled one's state.
//
// This is a TUI-level test: it mounts the real `<Session />` route on the
// shared event-injection harness, presses Escape twice on the real keymap so
// the prompt issues the abort request, replays the server's aborted message and
// idle status through the event stream, and then submits a follow-up prompt.
// The mocked HTTP boundary records every request, so the assertions read what
// the TUI actually sent rather than what the frame implies:
//   - exactly one abort per double-Escape, always for the routed session,
//   - the aborted assistant message stays in the transcript as interrupted,
//   - every follow-up prompt reaches `/session/:id/message` with its own text,
//   - no cancelled run is resurrected and no duplicate prompt is re-sent,
//   - the fresh run's own streaming output renders normally afterwards.
//
// Environment caveat: the harness replaces the HTTP boundary with a scripted
// server, so this covers the client half of the contract (interrupt -> abort ->
// status idle -> next prompt submitted/rendered) on every platform the suite
// runs on, including win32. It cannot observe a real server that keeps a
// cancelled run parked; that half is reported in the PR discussion, not here.

const SESSION_ID = "ses_interrupt_resume"
const INTERRUPT_HINT = "esc interrupt"
const ARMED_HINT = "again to interrupt"

type Setup = Awaited<ReturnType<typeof mountSessionRoute>>

afterEach(disposeSessionRoutes)

function event(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

const isPrompt = (request: FetchRequest) =>
  request.method === "POST" && request.pathname === `/session/${SESSION_ID}/message`
const isAbort = (request: FetchRequest) =>
  request.method === "POST" && request.pathname === `/session/${SESSION_ID}/abort`

const abortCount = (requests: FetchRequest[]) => requests.filter(isAbort).length

// The user-visible text each submitted prompt carried, read from the recorded
// request body so an empty or stale payload cannot pass as a successful prompt.
function promptsSent(requests: FetchRequest[]) {
  return requests.filter(isPrompt).map((request) => {
    const body: unknown = JSON.parse(request.body ?? "{}")
    if (typeof body !== "object" || body === null || !("parts" in body) || !Array.isArray(body.parts)) return ""
    const parts: unknown[] = body.parts
    return parts
      .flatMap((part) => {
        if (typeof part !== "object" || part === null) return []
        if (!("type" in part) || part.type !== "text") return []
        if (!("text" in part) || typeof part.text !== "string") return []
        return [part.text]
      })
      .join("")
  })
}

function statusEvent(status: SessionStatus): GlobalEvent {
  return event({ id: `evt_status`, type: "session.status", properties: { sessionID: SESSION_ID, status } })
}

function messageEvent(info: Message): GlobalEvent {
  return event({ id: `evt_message`, type: "message.updated", properties: { sessionID: SESSION_ID, info } })
}

function partEvent(part: ReturnType<typeof textPart>): GlobalEvent {
  return event({
    id: `evt_part`,
    type: "message.part.updated",
    properties: { sessionID: SESSION_ID, time: Date.now(), part },
  })
}

function abortedInfo(id: string, parentID: string) {
  return assistantMessage(id, SESSION_ID, {
    parentID,
    time: { created: BASE, completed: BASE + 1_000 },
    error: { name: "MessageAbortedError", data: { message: "Aborted" } },
  })
}

function respond(request: FetchRequest): Response | undefined {
  if (request.method !== "POST") return undefined
  if (request.pathname === `/session/${SESSION_ID}/abort`) return json(true)
  if (request.pathname === `/session/${SESSION_ID}/message`) return json(userMessage("msg_user_accepted", SESSION_ID))
  return undefined
}

// The routed session starts mid-run with one streaming assistant message, the
// state the reporter was in when they pressed ESC.
async function mountRunningSession() {
  const session = sessionInfo(SESSION_ID, { title: "Interrupt resume" })
  const firstUser = userMessage("msg_user_first", SESSION_ID)
  const firstAssistant = assistantMessage("msg_assistant_first", SESSION_ID, {
    parentID: firstUser.id,
    time: { created: BASE },
  })

  const harness = await mountSessionRoute({
    width: 140,
    height: 40,
    sessions: [session],
    status: { [SESSION_ID]: { type: "busy" } },
    messages: {
      [SESSION_ID]: [
        { info: firstUser, parts: [textPart("prt_user_first", firstUser, "First prompt")] },
        {
          info: firstAssistant,
          parts: [textPart("prt_assistant_first", firstAssistant, "Working on the first prompt")],
        },
      ],
    },
    respond,
  })

  await waitFor(
    harness.app,
    () => (harness.app.captureCharFrame().includes(INTERRUPT_HINT) ? true : undefined),
    undefined,
    "the running session never offered the interrupt hint",
  )
  return harness
}

// Double-Escape is the prompt's interrupt gesture: the first press only arms
// the double-press window, the second issues the abort for the routed session.
async function interrupt(harness: Setup, expectedAborts: number) {
  harness.app.mockInput.pressEscape()
  await waitFor(
    harness.app,
    () => (harness.app.captureCharFrame().includes(ARMED_HINT) ? true : undefined),
    undefined,
    "the first Escape never armed the interrupt",
  )
  expect(abortCount(harness.requests)).toBe(expectedAborts - 1)

  harness.app.mockInput.pressEscape()
  await waitFor(
    harness.app,
    () => (abortCount(harness.requests) === expectedAborts ? true : undefined),
    undefined,
    `the second Escape never issued abort #${expectedAborts}`,
  )
  expect(harness.requests.filter(isAbort).every((request) => request.pathname.includes(SESSION_ID))).toBe(true)
}

// The server's answer to an abort: the cancelled assistant message carries
// MessageAbortedError and the session returns to idle.
function finishInterrupted(harness: Setup, id: string, parentID: string) {
  harness.events.emit(messageEvent(abortedInfo(id, parentID)))
  harness.events.emit(statusEvent({ type: "idle" }))
}

async function submitPrompt(harness: Setup, text: string, expectedPrompts: number) {
  await harness.app.mockInput.typeText(text)
  harness.app.mockInput.pressEnter()
  await waitFor(
    harness.app,
    () => (promptsSent(harness.requests).length === expectedPrompts ? true : undefined),
    undefined,
    `prompt "${text}" never reached the server`,
  )
}

const occurrences = (frame: string, needle: string) => frame.split(needle).length - 1

// The transcript and the prompt footer settle in separate render passes, so a
// single captured frame can carry the interrupted marker while the footer still
// shows the previous status. Pump frames until both read the same state, which
// is what the user sees once the abort has landed.
function frameSettled(harness: Setup, probe: (frame: string) => boolean, label: string) {
  return waitFor(
    harness.app,
    () => {
      const frame = harness.app.captureCharFrame()
      return probe(frame) ? frame : undefined
    },
    undefined,
    label,
  )
}

describe("interrupt then a new prompt (#292)", () => {
  test("ESC interrupt keeps the cancelled turn in history and the next prompt starts a fresh run", async () => {
    const harness = await mountRunningSession()
    await interrupt(harness, 1)
    finishInterrupted(harness, "msg_assistant_first", "msg_user_first")

    // The cancelled turn is preserved and marked interrupted, and the session
    // is idle: the interrupt hint is gone and no run is resurrected on its own.
    const interrupted = await frameSettled(
      harness,
      (frame) => frame.includes("· interrupted") && !frame.includes(INTERRUPT_HINT),
      "the aborted turn was never marked interrupted on an idle session",
    )
    expect(interrupted).toContain("Working on the first prompt")
    expect(abortCount(harness.requests)).toBe(1)
    expect(promptsSent(harness.requests)).toEqual([])

    // The follow-up prompt must reach the server unchanged instead of being
    // short-circuited by the cancelled run's state.
    await submitPrompt(harness, "Second prompt", 1)
    expect(promptsSent(harness.requests)).toEqual(["Second prompt"])
    expect(abortCount(harness.requests)).toBe(1)

    // The fresh run streams its own turn normally, while the previous turn
    // keeps its interrupted marker exactly once.
    const secondUser = userMessage("msg_user_second", SESSION_ID, { time: { created: BASE + 10_000 } })
    const secondAssistant = assistantMessage("msg_assistant_second", SESSION_ID, {
      parentID: secondUser.id,
      time: { created: BASE + 10_000 },
    })
    harness.events.emit(messageEvent(secondUser))
    harness.events.emit(messageEvent(secondAssistant))
    harness.events.emit(partEvent(textPart("prt_assistant_second", secondAssistant, "Answering the second prompt")))
    harness.events.emit(statusEvent({ type: "busy" }))

    const running = await frameSettled(
      harness,
      (frame) => frame.includes("Answering the second prompt") && frame.includes(INTERRUPT_HINT),
      "the second run never started streaming",
    )
    expect(running).toContain("Working on the first prompt")
    expect(occurrences(running, "· interrupted")).toBe(1)
    // No duplicate run and no re-sent cancelled prompt.
    expect(promptsSent(harness.requests)).toEqual(["Second prompt"])
  })

  test("repeated interrupts and a prompt queued while running still restart the session", async () => {
    const harness = await mountRunningSession()

    // A prompt submitted while a run is streaming is queued by the server, not
    // dropped by the TUI, and must still carry its own text.
    await submitPrompt(harness, "Queued while running", 1)

    await interrupt(harness, 1)
    finishInterrupted(harness, "msg_assistant_first", "msg_user_first")
    await frameSettled(
      harness,
      (frame) => frame.includes("· interrupted") && !frame.includes(INTERRUPT_HINT),
      "the first interrupt never settled into an interrupted turn",
    )
    // Settling the abort must not replay the queued prompt or start a run of
    // its own: the cancelled run is gone for good.
    expect(await captureFrame(harness.app)).not.toContain(INTERRUPT_HINT)
    expect(promptsSent(harness.requests)).toEqual(["Queued while running"])

    await submitPrompt(harness, "After the first interrupt", 2)
    expect(promptsSent(harness.requests)).toEqual(["Queued while running", "After the first interrupt"])

    // Second run streams, then gets interrupted too.
    const retryUser = userMessage("msg_user_retry", SESSION_ID, { time: { created: BASE + 20_000 } })
    const retryAssistant = assistantMessage("msg_assistant_retry", SESSION_ID, {
      parentID: retryUser.id,
      time: { created: BASE + 20_000 },
    })
    harness.events.emit(messageEvent(retryUser))
    harness.events.emit(messageEvent(retryAssistant))
    harness.events.emit(partEvent(textPart("prt_assistant_retry", retryAssistant, "Answering after the interrupt")))
    harness.events.emit(statusEvent({ type: "busy" }))
    await frameSettled(
      harness,
      (frame) => frame.includes("Answering after the interrupt") && frame.includes(INTERRUPT_HINT),
      "the second run never started streaming",
    )

    await interrupt(harness, 2)
    finishInterrupted(harness, "msg_assistant_retry", "msg_user_retry")
    await frameSettled(
      harness,
      (frame) => occurrences(frame, "· interrupted") === 2 && !frame.includes(INTERRUPT_HINT),
      "the second interrupt never settled into a second interrupted turn",
    )
    expect(promptsSent(harness.requests)).toEqual(["Queued while running", "After the first interrupt"])

    // A third prompt after two interrupts still starts a fresh run.
    await submitPrompt(harness, "After the second interrupt", 3)
    expect(promptsSent(harness.requests)).toEqual([
      "Queued while running",
      "After the first interrupt",
      "After the second interrupt",
    ])
    expect(abortCount(harness.requests)).toBe(2)
  })
})
