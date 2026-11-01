import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { SessionTabs } from "../../src/session-tabs"
import type { PromptInfo } from "../../src/prompt/history"

const A = "ses_a"
const B = "ses_b"
const C = "ses_c"

function prompt(input: string): PromptInfo {
  return { input, parts: [] }
}

describe("session tab state", () => {
  test("opening sessions makes each its own tab and activates the newest", () => {
    const state = [A, B].reduce(SessionTabs.open, SessionTabs.empty())
    expect(state.open).toEqual([A, B])
    expect(state.active).toBe(B)
  })

  test("drafts and selections stay attached to the session that owns them", () => {
    let state = [A, B].reduce(SessionTabs.open, SessionTabs.empty())
    state = SessionTabs.saveDraft(state, A, { prompt: prompt("draft for A"), cursor: 3 })
    state = SessionTabs.saveDraft(state, B, { prompt: prompt("draft for B"), cursor: 5 })
    state = SessionTabs.saveSelection(state, A, { model: { providerID: "p", modelID: "model-a" }, agent: "plan" })
    state = SessionTabs.saveSelection(state, B, { model: { providerID: "p", modelID: "model-b" }, agent: "build" })

    expect(state.drafts[A]?.prompt.input).toBe("draft for A")
    expect(state.drafts[B]?.prompt.input).toBe("draft for B")
    expect(state.selections[A]?.model?.modelID).toBe("model-a")
    expect(state.selections[B]?.agent).toBe("build")
  })

  test("switching tabs never changes another session's draft", () => {
    let state = [A, B].reduce(SessionTabs.open, SessionTabs.empty())
    state = SessionTabs.saveDraft(state, A, { prompt: prompt("keep me"), cursor: 7 })
    for (let round = 0; round < 3; round++) {
      state = SessionTabs.open(state, A)
      state = SessionTabs.open(state, B)
    }
    expect(state.drafts[A]).toEqual({ prompt: prompt("keep me"), cursor: 7 })
    expect(state.drafts[B]).toBeUndefined()
  })

  test("an empty prompt removes the saved draft", () => {
    let state = SessionTabs.saveDraft(SessionTabs.empty(), A, { prompt: prompt("x"), cursor: 1 })
    state = SessionTabs.saveDraft(state, A, { prompt: prompt(""), cursor: 0 })
    expect(state.drafts).toEqual({})
  })

  test("closing a tab keeps its session draft and selection so reopening restores them", () => {
    let state = [A, B].reduce(SessionTabs.open, SessionTabs.empty())
    state = SessionTabs.saveDraft(state, A, { prompt: prompt("unsent"), cursor: 6 })
    state = SessionTabs.saveSelection(state, A, { variant: "high" })
    state = SessionTabs.close(state, A)
    expect(state.open).toEqual([B])
    expect(state.drafts[A]?.prompt.input).toBe("unsent")

    state = SessionTabs.open(state, A)
    expect(state.open).toEqual([B, A])
    expect(state.active).toBe(A)
    expect(state.drafts[A]?.cursor).toBe(6)
    expect(state.selections[A]?.variant).toBe("high")
  })

  test("closing the active tab moves to the neighbour at the same position", () => {
    const state = [A, B, C].reduce(SessionTabs.open, SessionTabs.empty())
    const middle = SessionTabs.open(state, B)
    expect(SessionTabs.close(middle, B).active).toBe(C)
    expect(SessionTabs.close(SessionTabs.open(state, C), C).active).toBe(B)
  })

  test("closing the last tab leaves no active tab", () => {
    const state = SessionTabs.close(SessionTabs.open(SessionTabs.empty(), A), A)
    expect(state.open).toEqual([])
    expect(state.active).toBeUndefined()
  })

  test("closing a background tab does not change the active tab", () => {
    const state = SessionTabs.close([A, B].reduce(SessionTabs.open, SessionTabs.empty()), A)
    expect(state.active).toBe(B)
  })

  test("next and previous step through tabs and wrap around", () => {
    const state = [A, B, C].reduce(SessionTabs.open, SessionTabs.empty())
    expect(SessionTabs.step(SessionTabs.open(state, A), 1)).toBe(B)
    expect(SessionTabs.step(SessionTabs.open(state, C), 1)).toBe(A)
    expect(SessionTabs.step(SessionTabs.open(state, A), -1)).toBe(C)
    expect(SessionTabs.step(SessionTabs.empty(), 1)).toBeUndefined()
  })

  test("attention flags only background tabs and is cleared when the tab is opened", () => {
    const state = [A, B].reduce(SessionTabs.open, SessionTabs.empty())
    const flagged = SessionTabs.attend(state, A)
    expect(flagged.attention).toEqual([A])
    expect(SessionTabs.attend(flagged, A)).toBe(flagged)
    expect(SessionTabs.attend(state, B)).toBe(state)
    expect(SessionTabs.attend(state, C)).toBe(state)
    expect(SessionTabs.open(flagged, A).attention).toEqual([])
    expect(SessionTabs.open(flagged, A).active).toBe(A)
  })

  test("attention never moves the active tab", () => {
    const state = [A, B].reduce(SessionTabs.open, SessionTabs.empty())
    expect(SessionTabs.attend(state, A).active).toBe(B)
  })

  test("restoring keeps saved order, drops unknown sessions, and ignores bad entries", () => {
    const known = (id: string) => id !== "ses_gone"
    expect(SessionTabs.restore([B, "ses_gone", A, B, 42, "not-a-session"], known)).toEqual([B, A])
    expect(SessionTabs.restore({ open: [A] }, known)).toEqual([])
    expect(SessionTabs.restore(undefined, known)).toEqual([])
  })
})

describe("session tab layout", () => {
  test("a normal width shows every tab with room for full titles", () => {
    const view = SessionTabs.layout({ count: 3, active: 1, width: 120 })
    expect(view).toEqual({ start: 0, end: 3, titleWidth: 28 })
  })

  test("a narrow width keeps the active tab visible and every visible title readable", () => {
    const view = SessionTabs.layout({ count: 6, active: 4, width: 40 })
    expect(view.start).toBeLessThanOrEqual(4)
    expect(view.end).toBeGreaterThan(4)
    expect(view.titleWidth).toBeGreaterThanOrEqual(4)
    // The visible cells must fit inside the strip (room is width minus reserved cells).
    const cells = (view.end - view.start) * (view.titleWidth + 6)
    expect(cells).toBeLessThanOrEqual(40 - 6)
  })

  test("the strip with no tabs is empty and still valid", () => {
    expect(SessionTabs.layout({ count: 0, active: -1, width: 40 })).toEqual({
      start: 0,
      end: 0,
      titleWidth: expect.any(Number),
    })
  })
})

describe("session tab titles", () => {
  test("truncation keeps the leading characters and marks the cut", () => {
    expect(SessionTabs.truncate("Investigate flaky tests", 10)).toBe("Investiga…")
    expect(SessionTabs.truncate("short", 10)).toBe("short")
    expect(SessionTabs.truncate("abc", 1)).toBe("…")
    expect(SessionTabs.truncate("abc", 0)).toBe("")
  })
})

describe("saveSelection", () => {
  test("stores a store-backed selection as plain values that structuredClone accepts", () => {
    const [store] = createStore({ model: { providerID: "p", modelID: "m" }, agent: "work", variant: "high" })
    expect(() => structuredClone(store.model)).toThrow()
    const next = SessionTabs.saveSelection(SessionTabs.empty(), "ses_1", store)
    expect(structuredClone(next.selections.ses_1)).toStrictEqual({
      model: { providerID: "p", modelID: "m" },
      agent: "work",
      variant: "high",
    })
  })

  test("keeps an absent model absent", () => {
    const next = SessionTabs.saveSelection(SessionTabs.empty(), "ses_1", { agent: "work" })
    expect(next.selections.ses_1).toStrictEqual({ model: undefined, agent: "work" })
  })
})
