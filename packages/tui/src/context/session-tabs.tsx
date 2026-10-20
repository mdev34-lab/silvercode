import { createContext, createEffect, on, useContext, type ParentProps } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { SessionTabs } from "../session-tabs"
import { useRoute } from "./route"
import { useSync } from "./sync"
import { useKV } from "./kv"

const KV_OPEN_TABS = "session_tabs"

export type SessionTabsApi = ReturnType<typeof createApi>

const Context = createContext<SessionTabsApi>()

export function SessionTabsProvider(props: ParentProps) {
  const route = useRoute()
  const sync = useSync()
  const kv = useKV()
  const [store, setStore] = createStore<SessionTabs.SessionTabsState>(SessionTabs.empty())
  const api = createApi({ route, sync, store, setStore })
  let restored = false

  // Every session route opens (or re-activates) its tab, whichever path navigated there.
  createEffect(
    on(
      () => (route.data.type === "session" ? route.data.sessionID : undefined),
      (sessionID) => {
        if (sessionID) return setStore(SessionTabs.open(unwrap(store), sessionID))
        if (store.active !== undefined) setStore("active", undefined)
      },
    ),
  )

  // Restore the saved tab list once, after the KV file and session list are loaded.
  // The route still decides the active tab; restored tabs are only added.
  createEffect(() => {
    if (restored || !kv.ready || sync.status === "loading") return
    restored = true
    const known = SessionTabs.restore(kv.get(KV_OPEN_TABS), (id) => sync.data.session.some((x) => x.id === id))
    if (known.length === 0) return
    setStore("open", [...new Set([...known, ...store.open])])
  })

  // Persist only after restore, so an early empty list cannot overwrite the saved one.
  createEffect(
    on(
      () => store.open.join("\n"),
      () => {
        if (!restored) return
        kv.set(KV_OPEN_TABS, [...store.open])
      },
    ),
  )

  // A tab needs attention when a background session finishes a run or is waiting
  // on a permission or question. The active tab never needs attention.
  const wasRunning = new Map<string, boolean>()
  createEffect(() => {
    const state = store.open.reduce((next, id) => {
      const status = sync.data.session_status[id]?.type
      const running = status === "busy" || status === "retry"
      const pending = (sync.data.permission[id]?.length ?? 0) > 0 || (sync.data.question[id]?.length ?? 0) > 0
      const finished = wasRunning.get(id) === true && !running
      wasRunning.set(id, running)
      return finished || pending ? SessionTabs.attend(next, id) : next
    }, unwrap(store))
    if (state.attention !== unwrap(store).attention) setStore("attention", state.attention)
  })

  return <Context.Provider value={api}>{props.children}</Context.Provider>
}

function createApi(input: {
  route: ReturnType<typeof useRoute>
  sync: ReturnType<typeof useSync>
  store: SessionTabs.SessionTabsState
  setStore: (next: SessionTabs.SessionTabsState) => void
}) {
  return {
    get open() {
      return input.store.open
    },
    get active() {
      return input.store.active
    },
    isAttention(sessionID: string) {
      return input.store.attention.includes(sessionID)
    },
    isRunning(sessionID: string) {
      const status = input.sync.data.session_status[sessionID]?.type
      return status === "busy" || status === "retry"
    },
    // Closing removes only the tab. The session and any running work stay alive,
    // and the draft and selection stay so reopening restores them.
    close(sessionID: string) {
      const wasActive = input.store.active === sessionID
      input.setStore(SessionTabs.close(unwrap(input.store), sessionID))
      if (!wasActive) return
      const next = input.store.active
      input.route.navigate(next ? { type: "session", sessionID: next } : { type: "home" })
    },
    select(sessionID: string) {
      if (!input.store.open.includes(sessionID)) return
      input.route.navigate({ type: "session", sessionID })
    },
    step(direction: 1 | -1) {
      const sessionID = SessionTabs.step(unwrap(input.store), direction)
      if (!sessionID) return
      input.route.navigate({ type: "session", sessionID })
    },
    draft(key: string) {
      const draft = unwrap(input.store.drafts)[key]
      return draft ? structuredClone(draft) : undefined
    },
    setDraft(key: string, draft: SessionTabs.TabDraft) {
      input.setStore(SessionTabs.saveDraft(unwrap(input.store), key, structuredClone(draft)))
    },
    selection(sessionID: string) {
      const selection = unwrap(input.store.selections)[sessionID]
      return selection ? structuredClone(selection) : undefined
    },
    setSelection(sessionID: string, selection: SessionTabs.TabSelection) {
      input.setStore(SessionTabs.saveSelection(unwrap(input.store), sessionID, SessionTabs.plainSelection(selection)))
    },
  }
}

// Non-throwing accessor: components that can render without a tab strip (for
// example isolated prompt tests) run with per-instance state only.
export function useOptionalSessionTabs() {
  return useContext(Context)
}

export function useSessionTabs() {
  const value = useContext(Context)
  if (!value) throw new Error("useSessionTabs must be used within a SessionTabsProvider")
  return value
}
