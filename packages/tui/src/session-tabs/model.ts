import type { PromptInfo } from "../prompt/history"

/**
 * Pure state for the session tab strip. A tab is a UI handle on a session:
 * opening, selecting, or closing one never touches the session or its server
 * work. Everything a tab owns (unsent draft, cursor, model/agent choice) is
 * keyed by session ID so tabs cannot read or write each other's state.
 */

export type TabSelection = {
  model?: { providerID: string; modelID: string }
  agent?: string
  variant?: string
}

export type TabDraft = {
  prompt: PromptInfo
  cursor: number
}

export type SessionTabsState = {
  open: string[]
  active: string | undefined
  attention: string[]
  drafts: Record<string, TabDraft>
  selections: Record<string, TabSelection>
}

// Prompt draft key for the home screen, which has no session yet. Session IDs
// always start with `ses`, so this cannot collide with a tab.
export const HOME_DRAFT_KEY = "home"

export function empty(): SessionTabsState {
  return { open: [], active: undefined, attention: [], drafts: {}, selections: {} }
}

// Opens (or re-activates) a tab for a session. Used both for explicit opens and
// for every route change onto a session, so any navigation path yields a tab.
export function open(state: SessionTabsState, sessionID: string): SessionTabsState {
  return {
    ...state,
    open: state.open.includes(sessionID) ? state.open : [...state.open, sessionID],
    active: sessionID,
    attention: state.attention.filter((id) => id !== sessionID),
  }
}

// Removes a tab only. The session, its messages, its running work, its draft,
// and its selection all stay in place so the tab can be reopened unchanged.
export function close(state: SessionTabsState, sessionID: string): SessionTabsState {
  const index = state.open.indexOf(sessionID)
  if (index === -1) return state
  const rest = state.open.filter((id) => id !== sessionID)
  const active = state.active === sessionID ? (rest[Math.min(index, rest.length - 1)] ?? undefined) : state.active
  return { ...state, open: rest, active, attention: state.attention.filter((id) => id !== sessionID) }
}

// Cyclic neighbour in tab order. Returns undefined when there are no tabs.
export function step(state: SessionTabsState, direction: 1 | -1): string | undefined {
  const count = state.open.length
  if (count === 0) return undefined
  const index = state.open.indexOf(state.active ?? "")
  if (index === -1) return direction === 1 ? state.open[0] : state.open[count - 1]
  return state.open[(index + direction + count) % count]
}

// Flags a background tab that needs the user. Never changes the active tab.
export function attend(state: SessionTabsState, sessionID: string): SessionTabsState {
  if (sessionID === state.active || !state.open.includes(sessionID)) return state
  if (state.attention.includes(sessionID)) return state
  return { ...state, attention: [...state.attention, sessionID] }
}

// An empty prompt means "no draft"; saving one removes the entry.
export function saveDraft(state: SessionTabsState, key: string, draft: TabDraft): SessionTabsState {
  if (draft.prompt.input === "" && draft.prompt.parts.length === 0) {
    if (!(key in state.drafts)) return state
    const { [key]: _removed, ...drafts } = state.drafts
    return { ...state, drafts }
  }
  return { ...state, drafts: { ...state.drafts, [key]: draft } }
}

export function saveSelection(state: SessionTabsState, sessionID: string, selection: TabSelection): SessionTabsState {
  return { ...state, selections: { ...state.selections, [sessionID]: selection } }
}

// Restored tabs keep their saved order. Sessions that no longer exist are
// dropped; the active tab is never restored because the route decides it.
export function restore(saved: unknown, known: (sessionID: string) => boolean): string[] {
  if (!Array.isArray(saved)) return []
  const ids = saved.filter((id): id is string => typeof id === "string" && id.startsWith("ses"))
  return [...new Set(ids)].filter(known)
}

// Fits a title into a tab's cell budget, keeping the first characters readable.
export function truncate(title: string, max: number): string {
  if (max <= 0) return ""
  const chars = Array.from(title)
  if (chars.length <= max) return title
  if (max === 1) return "…"
  return chars.slice(0, max - 1).join("") + "…"
}

const MIN_CELL = 12
const CHROME = 7
const RESERVED = 6 // "+" button and overflow markers

// Which tabs fit in the strip and how long their titles may be. Keeps the active
// tab in view and never gives a visible tab less room than a readable title.
export function layout(input: { count: number; active: number; width: number }) {
  const room = Math.max(0, input.width - RESERVED)
  const capacity = Math.max(1, Math.min(input.count, Math.floor(room / MIN_CELL)))
  const anchor = Math.max(0, input.active)
  const start = Math.min(Math.max(0, anchor - Math.floor(capacity / 2)), Math.max(0, input.count - capacity))
  const end = Math.min(input.count, start + capacity)
  const cell = Math.floor(room / Math.max(1, end - start))
  return { start, end, titleWidth: Math.min(32, Math.max(4, cell - CHROME)) }
}
