import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useSync } from "./sync"
import { useEvent } from "./event"
import path from "path"
import { useTuiPaths } from "./runtime"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { effectiveVariant } from "../util/model"
import * as ModelHealth from "../util/model-health"
import { RGBA } from "@opentui/core"
import { readJson, writeJsonAtomic } from "../util/persistence"
import { errorMessage } from "../util/error"
import { useTheme } from "./theme"
import { useToast } from "../ui/toast"
import { useRoute } from "./route"
import { usePermission } from "./permission"
import { supportsVision } from "../util/model"
import {
  coupledThinking,
  defaultLevel,
  effortRecord,
  isRecord,
  mergeEffortMetadata,
  metadataLevel,
  nextLevel,
  resolveEffort,
  type Level,
} from "../util/agent-effort"

export type LocalTheme = {
  secondary: RGBA
  accent: RGBA
  success: RGBA
  warning: RGBA
  primary: RGBA
  error: RGBA
  info: RGBA
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: providerID,
    modelID: rest.join("/"),
  }
}

// Decides which model update must be pushed to a session when the current
// selection differs from the session's stored selection while a task is
// running. Returns undefined when nothing must be sent, which keeps the
// push idempotent and avoids touching idle sessions. The stored selection
// is agent-scoped, so a selection for a different agent than the one the
// session is running never pushes.
export function selectionUpdate(input: {
  providerID?: string
  modelID?: string
  variant?: string
  agent?: string
  busy?: boolean
  session?: { id: string; agent?: string; model?: { providerID: string; id: string; variant?: string } }
}) {
  if (!input.providerID || !input.modelID || !input.session || !input.busy) return undefined
  if (input.agent && input.session.agent && input.session.agent !== input.agent) return undefined
  const sameModel =
    input.session.model?.providerID === input.providerID && input.session.model?.id === input.modelID
  const rowVariant = effectiveVariant(input.session.model?.variant)
  const variant = effectiveVariant(input.variant)
  if (sameModel && rowVariant === variant) return undefined
  return {
    sessionID: input.session.id,
    model: { providerID: input.providerID, id: input.modelID, variant },
  }
}

export function recentModels(
  model: { providerID: string; modelID: string },
  recent: { providerID: string; modelID: string }[],
) {
  const seen = new Set<string>()
  return [model, ...recent]
    .filter((item) => {
      const key = `${item.providerID}/${item.modelID}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
    .map((item) => ({ providerID: item.providerID, modelID: item.modelID }))
}

// Effective effort for the active session: a pending local write wins over
// the synced row, the persisted session selection wins over configuration,
// and configuration wins over the schema default. A session without a row
// (a brand-new session) falls straight through to configuration, so new work
// starts from the configured default and a lookup can never leak another
// session's pending selection into the current one.
export function effortSelection(input: { override?: unknown; metadata?: unknown; config?: unknown }): Level {
  return metadataLevel(input.override) ?? resolveEffort({ metadata: input.metadata, config: input.config })
}

// Computes the session metadata update for a selection. Returns undefined
// when the effective record already carries the level, which keeps repeated
// selections idempotent. The merge base unions the pending overlay over the
// synced row so two rapid selections cannot lose the first write (or any
// concurrently synced key) before its sync event lands.
export function effortUpdateFor(input: { sessionID: string; override?: unknown; metadata?: unknown; level: Level }) {
  const base =
    input.override !== undefined && input.metadata !== undefined
      ? { ...(isRecord(input.metadata) ? input.metadata : {}), ...(isRecord(input.override) ? input.override : {}) }
      : (input.override ?? input.metadata)
  if (metadataLevel(base) === input.level) return undefined
  return { sessionID: input.sessionID, metadata: mergeEffortMetadata(base, input.level) }
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()
    const theme = useTheme().theme
    const route = useRoute()
    const paths = useTuiPaths()
    const args = useArgs()
    const event = useEvent()
    const permission = usePermission()

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider?.find((item) => item.id === model.providerID)
      return !!provider?.models?.[model.modelID]
    }

    function getFirstValidModel(...modelFns: (() => { providerID: string; modelID: string } | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    function createAgent() {
      const agents = createMemo(
        () => sync.data.agent?.filter((agent) => agent.mode !== "subagent" && !agent.hidden) ?? [],
      )
      const visibleAgents = createMemo(() => sync.data.agent?.filter((agent) => !agent.hidden) ?? [])
      const [agentStore, setAgentStore] = createStore({
        current: undefined as string | undefined,
      })
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((x) => x.name === agentStore.current) ?? agents().at(0)
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          setAgentStore("current", name)
        },
        move(direction: 1 | -1) {
          batch(() => {
            const current = this.current()
            if (!current) return
            let next = agents().findIndex((x) => x.name === current.name) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setAgentStore("current", value.name)
          })
        },
        color(name: string) {
          const index = visibleAgents().findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            // already validated by config, just satisfying TS here
            return theme[color as keyof typeof theme] as RGBA
          }
          return colors()[index % colors().length]
        },
      }
    }

    const agent = createAgent()

    function createModel() {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        model: Record<
          string,
          {
            providerID: string
            modelID: string
          }
        >
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        variant: Record<string, string | undefined>
        // Provenance for the variant record: the value the effort dial
        // machine-coupled for a model key. A stored value that matches it is
        // still machine-owned (so a later effort change may re-couple);
        // anything else is an explicit selector choice and stays protected.
        coupled: Record<string, string | undefined>
      }>({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
        coupled: {},
      })

      const filePath = path.join(paths.state, "model.json")
      const state = {
        pending: false,
        writes: Promise.resolve() as Promise<unknown>,
      }

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        // Serialize saves and absorb failures: a write that races process
        // shutdown or a removed state directory must not surface as an
        // unhandled rejection.
        const write = state.writes.then(() =>
          writeJsonAtomic(filePath, {
            recent: modelStore.recent,
            favorite: modelStore.favorite,
            variant: modelStore.variant,
            coupled: modelStore.coupled,
          }),
        )
        state.writes = write.catch((error) => console.error("Failed to write model state", { error }))
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const value = x as Record<string, unknown>
          if (Array.isArray(value.recent)) setModelStore("recent", value.recent)
          if (Array.isArray(value.favorite)) setModelStore("favorite", value.favorite)
          if (typeof value.variant === "object" && value.variant !== null)
            setModelStore("variant", value.variant as Record<string, string | undefined>)
          if (typeof value.coupled === "object" && value.coupled !== null)
            setModelStore("coupled", value.coupled as Record<string, string | undefined>)
        })
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
        })

      const fallbackModel = createMemo(() => {
        if (args.model) {
          const { providerID, modelID } = parseModel(args.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        if (sync.data.config?.model) {
          const { providerID, modelID } = parseModel(sync.data.config.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        for (const item of modelStore.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        const provider = sync.data.provider?.[0]
        if (!provider) return undefined
        const defaultModel = sync.data.provider_default?.[provider.id]
        const firstModel = Object.values(provider.models ?? {})[0]
        const model = defaultModel ?? firstModel?.id
        if (!model) return undefined
        return {
          providerID: provider.id,
          modelID: model,
        }
      })

      const currentModel = createMemo(() => {
        const a = agent.current()
        return (
          getFirstValidModel(
            () => a && modelStore.model[a.name],
            () => a && a.model,
            fallbackModel,
          ) ?? undefined
        )
      })

      // Cached health of favorite models. Only favorites are ever probed, one at a time, in the
      // background; the picker reads the cache and never waits on a probe.
      const [health, setHealth] = createStore<Record<string, ModelHealth.HealthEntry | undefined>>({})
      const healthKey = (model: { providerID: string; modelID: string }) => `${model.providerID}/${model.modelID}`
      let probing = false
      async function probeNext() {
        if (probing || !modelStore.ready) return
        const now = Date.now()
        const target = modelStore.favorite
          .filter((item) => isModelValid(item))
          .map((item) => ({ item, due: ModelHealth.due(health[healthKey(item)]) }))
          .filter((entry) => entry.due <= now)
          .sort((a, b) => a.due - b.due)[0]?.item
        if (!target) return
        probing = true
        const key = healthKey(target)
        try {
          const result = await sdk.client.provider
            .probe({ providerID: target.providerID, modelID: target.modelID })
            .then((response) => response.data?.outcome ?? ("transient" as const))
            .catch(() => "transient" as const)
          setHealth(key, ModelHealth.next(health[key], result, Date.now()))
        } finally {
          probing = false
        }
      }
      const probeTimer = setInterval(() => void probeNext(), 15_000)
      onCleanup(() => clearInterval(probeTimer))

      return {
        current: currentModel,
        health(model: { providerID: string; modelID: string }) {
          const entry = health[healthKey(model)]
          return { status: ModelHealth.status(entry, Date.now()), checked: entry ? ModelHealth.age(entry, Date.now()) : undefined }
        },
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        parsed: createMemo(() => {
          const value = currentModel()
          if (!value) {
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
              vision: false,
            }
          }
          const provider = sync.data.provider?.find((item) => item.id === value.providerID)
          const info = provider?.models?.[value.modelID]
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
            vision: supportsVision(info),
          }
        }),
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...val })
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: "Add a favorite model to use this shortcut",
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...next })
          setModelStore("recent", recentModels(next, modelStore.recent))
          save()
        },
        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const a = agent.current()
            if (!a) return
            setModelStore("model", a.name, model)
            if (options?.recent) {
              setModelStore("recent", recentModels(model, modelStore.recent))
              save()
            }
          })
        },
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          selected() {
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerID}/${m.modelID}`
            return modelStore.variant[key]
          },
          current() {
            const v = this.selected()
            // An explicit selector choice — including explicit default/off —
            // always wins over configuration, and only a value the model
            // actually offers is shown.
            if (v) return this.list().includes(v) ? v : undefined
            // Display-only fallback: surface the effective configured agent
            // variant without writing it as an explicit selection. It applies
            // only under the existing matching rules (the agent's configured
            // model is the active model and that model offers the variant).
            const info = agent.current()
            const configured = info?.variant
            const m = currentModel()
            if (!configured || !info?.model || !m) return undefined
            if (info.model.providerID !== m.providerID || info.model.modelID !== m.modelID) return undefined
            return this.list().includes(configured) ? configured : undefined
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const provider = sync.data.provider?.find((item) => item.id === m.providerID)
            const info = provider?.models?.[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined, source: "user" | "session" | "coupled" = "user") {
            const m = currentModel()
            if (!m) return
            const key = `${m.providerID}/${m.modelID}`
            const stored = value ?? "default"
            setModelStore("variant", key, stored)
            // Provenance follows the write: the effort dial records its own
            // coupled value so successive effort changes can re-couple it; a
            // direct selector choice clears ownership so every explicit
            // choice (including default/off) stays protected; a session
            // restore keeps ownership only for the exact coupled value it
            // mirrors.
            if (source === "coupled") setModelStore("coupled", key, stored)
            if (source === "user") setModelStore("coupled", key, undefined)
            if (source === "session" && modelStore.coupled[key] !== stored) setModelStore("coupled", key, undefined)
            save()
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const current = this.current()
            if (!current) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
          // Applies the coupled thinking default for an effort change. It is
          // only a default: an explicit selector choice (including explicit
          // default/off) or a configured agent variant is never overwritten,
          // and models without the coupled variant keep their behavior. A
          // stored value that still matches the machine-coupled marker is
          // machine-owned, so successive effort changes re-couple it until
          // the selector is really used.
          couple(effort: Level) {
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerID}/${m.modelID}`
            const stored = modelStore.variant[key]
            const wanted = coupledThinking({
              effort,
              variants: this.list(),
              chosen: stored !== undefined && modelStore.coupled[key] !== stored ? stored : undefined,
              configured: agent.current()?.variant,
            })
            if (wanted === undefined) return undefined
            this.set(wanted, "coupled")
            return wanted
          },
        },
      }
    }

    const model = createModel()

    function createSession() {
      const [sessionStore, setSessionStore] = createStore<{
        ready: boolean
        pinned: string[]
      }>({
        ready: false,
        pinned: [],
      })

      const filePath = path.join(paths.state, "session.json")
      const state = {
        pending: false,
        writes: Promise.resolve() as Promise<unknown>,
      }

      function save() {
        if (!sessionStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        const write = state.writes.then(() =>
          writeJsonAtomic(filePath, {
            pinned: sessionStore.pinned,
          }),
        )
        state.writes = write.catch((error) => console.error("Failed to write session state", { error }))
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const pinned = (x as Record<string, unknown>).pinned
          if (Array.isArray(pinned))
            setSessionStore(
              "pinned",
              pinned.filter((item): item is string => typeof item === "string"),
            )
        })
        .catch(() => {})
        .finally(() => {
          setSessionStore("ready", true)
          if (state.pending) save()
        })

      const slots = createMemo(() => {
        const existing = new Set(
          (sync.data.session ?? []).filter((x) => x.parentID === undefined).map((x) => x.id),
        )
        return sessionStore.pinned.filter((id) => existing.has(id)).slice(0, 9)
      })

      function prune(sessionID: string) {
        batch(() => {
          if (sessionStore.pinned.includes(sessionID)) {
            setSessionStore(
              "pinned",
              sessionStore.pinned.filter((x) => x !== sessionID),
            )
          }
          save()
        })
      }

      const offDeleted = event.on("session.deleted", (evt) => {
        prune(evt.properties.info.id)
      })
      onCleanup(offDeleted)

      return {
        get ready() {
          return sessionStore.ready
        },
        pinned() {
          return sessionStore.pinned
        },
        slots,
        isPinned(sessionID: string) {
          return sessionStore.pinned.includes(sessionID)
        },
        togglePin(sessionID: string) {
          batch(() => {
            const exists = sessionStore.pinned.includes(sessionID)
            const next = exists
              ? sessionStore.pinned.filter((x) => x !== sessionID)
              : [...sessionStore.pinned, sessionID]
            setSessionStore("pinned", next)
            save()
          })
        },
        quickSwitch(slot: number) {
          const target = slots()[slot - 1]
          if (!target) return
          if (route.data.type === "session" && route.data.sessionID === target) return
          route.navigate({ type: "session", sessionID: target })
        },
      }
    }

    const session = createSession()

    function createEffort() {
      // Session-scoped optimistic metadata overlay. Entries are keyed by
      // session ID, so a selection made in one session can never surface in
      // another, and each write merges over the synced row (session.update
      // replaces metadata wholesale) until the server event confirms it.
      const pending = new Map<string, Record<string, unknown>>()
      // Tail of the in-flight session.update chain per session (see set()).
      const writes = new Map<string, Promise<void>>()
      const [pendingVersion, setPendingVersion] = createSignal(0)

      // Home default for new sessions, persisted for the TUI in the state
      // directory. `stored` is the optimistic display value while `persisted`
      // tracks what the file actually holds, so a failed write can roll the
      // display back to a value that was really saved instead of reporting a
      // selection that never landed.
      const defaultFile = path.join(paths.state, "effort.json")
      const [stored, setStored] = createSignal<Level | undefined>()
      let persisted: Level | undefined
      let touched = false
      let defaultSequence = 0

      let defaultWrites = readJson<unknown>(defaultFile)
        .then((value) => {
          const level = metadataLevel(value)
          if (!level) throw new Error("Invalid agent effort default")
          persisted = level
          // A selection made while the file was still loading wins over the
          // file: the user's choice is newer than what was on disk.
          if (!touched) setStored(level)
        })
        .catch((error) => {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
          toast.show({
            variant: "warning",
            message: `Failed to load the agent effort default: ${errorMessage(error)}`,
            duration: 3000,
          })
        })

      function persistDefault(level: Level) {
        touched = true
        setStored(level)
        const attempt = ++defaultSequence
        // Wait for the initial read before writing so it cannot replace a
        // newer rollback baseline. Then persist rapid selections in order.
        const write = defaultWrites.then(() => writeJsonAtomic(defaultFile, effortRecord(level)))
        defaultWrites = write.catch(() => {})
        write.then(
          () => {
            persisted = level
          },
          (error) => {
            // Only the newest selection owns the displayed default; an older
            // failed write must not roll back a newer choice.
            if (attempt !== defaultSequence) return
            setStored(persisted)
            toast.show({
              variant: "warning",
              message: `Failed to save the agent effort default: ${errorMessage(error)}`,
              duration: 3000,
            })
          },
        )
      }

      function activeSessionID() {
        return route.data.type === "session" ? route.data.sessionID : undefined
      }

      // Drop overlay entries once the synced row reflects the written level
      // AND no write for the session is still queued or in flight: an older
      // in-flight write will still move the row, so a row that merely equals
      // the latest choice right now is not confirmation yet.
      createEffect(() => {
        pendingVersion()
        for (const [sessionID, metadata] of pending) {
          if (writes.has(sessionID)) continue
          const row = sync.session.get(sessionID)
          if (row && metadataLevel(row.metadata) === metadataLevel(metadata)) pending.delete(sessionID)
        }
      })

      return {
        current(): Level {
          const sessionID = activeSessionID()
          const row = sessionID ? sync.session.get(sessionID) : undefined
          // Subscribe renders to the optimistic overlay: a pending local
          // write must be visible immediately, before the sync event that
          // confirms it lands on the session row.
          pendingVersion()
          // Home has no session to override, so the persisted new-session
          // default (then configuration) is what a new session would use.
          if (!sessionID) return defaultLevel({ selected: stored(), config: sync.data.config })
          return effortSelection({
            override: pending.get(sessionID),
            metadata: row?.metadata,
            config: sync.data.config,
          })
        },
        // Whether the selection is session-scoped right now. On the home
        // route the persisted default is authoritative for new work.
        scoped() {
          return activeSessionID() !== undefined
        },
        // Metadata a session created right now starts from, so the home
        // default is stored on the session (and enforced by the server)
        // rather than only being displayed. Undefined when the user never
        // picked one, which leaves the configured default in charge.
        newSessionMetadata() {
          const level = stored()
          return level ? effortRecord(level) : undefined
        },
        // Show a newly created session's inherited selection immediately:
        // its row syncs a moment later, and reading through the same overlay
        // as a session write keeps the label from flashing the old default.
        seed(sessionID: string, metadata: Record<string, unknown> | undefined) {
          if (!metadata) return
          if (metadataLevel(sync.session.get(sessionID)?.metadata) === metadataLevel(metadata)) return
          pending.set(sessionID, metadata)
          setPendingVersion((version) => version + 1)
        },
        set(level: Level) {
          const sessionID = activeSessionID()
          if (!sessionID) {
            // Home selection: a failed default write rolls the value back and
            // reports the failure, so the label never claims a level that is
            // not actually persisted.
            persistDefault(level)
            model.variant.couple(level)
            return
          }
          const row = sync.session.get(sessionID)
          if (!row) {
            toast.show({
              variant: "warning",
              message: "Session is still loading; agent effort unchanged.",
              duration: 3000,
            })
            return
          }
          const update = effortUpdateFor({
            sessionID,
            override: pending.get(sessionID),
            metadata: row.metadata,
            level,
          })
          if (update) {
            pending.set(sessionID, update.metadata)
            setPendingVersion((version) => version + 1)
            // session.update replaces metadata wholesale and carries no
            // revision, so concurrent PATCHes can complete out of order and
            // let an older write overwrite the newer choice. Serialize the
            // writes per session: each starts only after the previous one
            // settled, so the server applies them in selection order and the
            // last choice always wins. A failed write never blocks the queue.
            const previous = writes.get(sessionID) ?? Promise.resolve()
            const next: Promise<void> = previous
              .then(() => sdk.client.session.update({ sessionID, metadata: update.metadata }, { throwOnError: true }))
              .then(
                () => {},
                (error) => {
                  // Only roll back this write: a newer selection may already
                  // have replaced the overlay for the same session.
                  if (pending.get(sessionID) === update.metadata) {
                    pending.delete(sessionID)
                    setPendingVersion((version) => version + 1)
                  }
                  toast.show({
                    variant: "warning",
                    message: `Failed to save agent effort: ${errorMessage(error)}`,
                    duration: 3000,
                  })
                },
              )
              .finally(() => {
                if (writes.get(sessionID) === next) {
                  writes.delete(sessionID)
                  // Re-evaluate the overlay now that the queue is idle.
                  setPendingVersion((version) => version + 1)
                }
              })
            writes.set(sessionID, next)
          }
          model.variant.couple(level)
        },
        cycle() {
          this.set(nextLevel(this.current()))
        },
      }
    }

    const effort = createEffort()

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (status?.status === "connected") {
          // Disable: disconnect the MCP
          await sdk.client.mcp.disconnect({ name })
        } else {
          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
          await sdk.client.mcp.connect({ name })
        }
      },
    }

    createEffect(() => {
      const value = agent.current()
      if (!value?.model) return
      if (isModelValid(value.model)) return
      toast.show({
        variant: "warning",
        message: `Agent ${value.name}'s configured model ${value.model.providerID}/${value.model.modelID} is not valid`,
        duration: 3000,
      })
    })

    // While a task is running in the visible session, push model/thinking
    // effort selection changes to the server so they apply at the next agent
    // turn instead of waiting for the next user message. Comparing against the
    // synced session row keeps this idempotent and per-session.
    let lastAttempt: string | undefined
    createEffect(
      on(
        () => {
          const current = model.current()
          const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
          return {
            providerID: current?.providerID,
            modelID: current?.modelID,
            variant: model.variant.current(),
            agent: agent.current()?.name,
            session: sessionID ? sync.session.get(sessionID) : undefined,
            status: sessionID ? sync.data.session_status[sessionID]?.type : undefined,
          }
        },
        (state) => {
          const update = selectionUpdate({
            providerID: state.providerID,
            modelID: state.modelID,
            variant: state.variant,
            agent: state.agent,
            busy: state.status === "busy",
            session: state.session,
          })
          if (!update) {
            lastAttempt = undefined
            return
          }
          // A rejected push must not retry itself on every unrelated signal
          // change; the same update is attempted once until the selection or
          // the stored row actually moves.
          const attempt = JSON.stringify(update)
          if (attempt === lastAttempt) return
          lastAttempt = attempt
          void sdk.client.session
            .update(update, { throwOnError: true })
            .catch((error) => {
              toast.show({
                variant: "warning",
                message: `Failed to apply model to the running session: ${errorMessage(error)}`,
                duration: 3000,
              })
            })
        },
        { defer: true },
      ),
    )

    const result = {
      model,
      agent,
      mcp,
      session,
      effort,
      permission,
    }
    return result
  },
})
