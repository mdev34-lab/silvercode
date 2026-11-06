import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
  SnapshotFileDiff,
  SessionNextContextPrepared,
  ConsoleState,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "./project"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useTuiStartup } from "./runtime"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onMount } from "solid-js"
import path from "path"
import { useKV } from "./kv"
import { usePermission } from "./permission"
import { applyPartDelta, applyPartUpdated, mergePartInPlace, mergePartText } from "../util/part"

const emptyConsoleState: ConsoleState = {
  consoleManagedProviders: [],
  switchableOrgCount: 0,
}

function search<T>(items: T[], target: string, key: (item: T) => string) {
  let left = 0
  let right = items.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = key(items[middle])
    if (value === target) return { found: true, index: middle }
    if (value < target) left = middle + 1
    else right = middle - 1
  }
  return { found: false, index: left }
}

function compareMessage(a: Message, b: Message) {
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

const messageKey = (message: Message) => message.time.created + message.id

// Bounded mount (#815 review): the transcript opens with the newest page and
// older pages arrive on demand through the endpoint's `before` cursor. This is
// the mount/render budget, not a display cap — every persisted message stays
// reachable and the transcript reads pages directly instead of the store.
const PAGE_SIZE = 100

type Tracker = { messages: Set<string>; parts: Set<string> }
// One older page: how many rows it added, and the cursor to the page before it.
// `added` is progress, not exhaustion — a page can add nothing (its rows are
// already loaded, or were removed live) while `cursor` still points at older
// history.
type OlderPage = { added: number; cursor?: string }
type MessageWithParts = { info: Message; parts: Part[] }

export const {
  context: SyncContext,
  use: useSync,
  provider: SyncProvider,
} = createSimpleContext({
  name: "Sync",
  init: () => {
    const startup = useTuiStartup()
    const kv = useKV()
    const permission = usePermission()
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      capabilities: {
        backgroundSubagents: boolean
      }
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: SnapshotFileDiff[]
      }
      session_context: {
        [sessionID: string]: SessionNextContextPrepared["data"]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      capabilities: {
        backgroundSubagents: true,
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      session_context: {},
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()

    const fullSyncedSessions = new Set<string>()
    const syncingSessions = new Map<string, Promise<void>>()
    // Per session: the `x-next-cursor` of the oldest row loaded so far. Present
    // means older persisted rows exist and can be fetched with `before`.
    const olderCursors = new Map<string, string | undefined>()
    const loadingOlder = new Map<string, Promise<OlderPage>>()
    // Every in-flight read of a session's messages registers a tracker here, so
    // live events that land while the request is open can tell the merge which
    // rows and parts moved underneath it (hydration, older pages and transcript
    // reads share the same protection).
    const trackedRequests = new Map<string, Set<Tracker>>()
    const track = (sessionID: string) => {
      const tracker: Tracker = { messages: new Set<string>(), parts: new Set<string>() }
      const active = trackedRequests.get(sessionID) ?? new Set<Tracker>()
      active.add(tracker)
      trackedRequests.set(sessionID, active)
      return {
        tracker,
        release: () => {
          active.delete(tracker)
          if (active.size === 0) trackedRequests.delete(sessionID)
        },
      }
    }
    const touchMessage = (sessionID: string, messageID: string) => {
      for (const tracker of trackedRequests.get(sessionID) ?? []) tracker.messages.add(messageID)
    }
    const touchPart = (sessionID: string, partID: string) => {
      for (const tracker of trackedRequests.get(sessionID) ?? []) tracker.parts.add(partID)
    }
    // Merges one persisted page with what the store already holds, for reads
    // that run while live events can still land:
    // - a message or part removed while the request was open stays removed;
    // - a part the live stream touched wins as-is, including a type change,
    //   because the live projection is the newest version of that part;
    // - a persisted text/reasoning part only fills content the live copy does
    //   not have yet (streamed text is never rolled back).
    const mergePage = (sessionID: string, persisted: MessageWithParts[], tracker: Tracker) => {
      const current = store.message[sessionID] ?? []
      return persisted.flatMap((entry) => {
        const liveInfo = current.find((info) => info.id === entry.info.id)
        if (tracker.messages.has(entry.info.id) && !liveInfo) return []
        const live = store.part[entry.info.id] ?? []
        const parts = entry.parts.flatMap((part) => {
          const livePart = live.find((item) => item.id === part.id)
          if (tracker.parts.has(part.id)) return livePart ? [livePart] : []
          if (!livePart || livePart.type !== part.type) return [part]
          if (part.type === "text" || part.type === "reasoning") return [mergePartText(livePart, part)]
          return [livePart]
        })
        return [
          {
            info: liveInfo ?? entry.info,
            parts: [...parts, ...live.filter((part) => !parts.some((item) => item.id === part.id))],
          },
        ]
      })
    }
    const newest = (rows: MessageWithParts[]) =>
      rows.reduce<MessageWithParts | undefined>((last, row) => (!last || compareMessage(row.info, last.info) > 0 ? row : last), undefined)

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    function listSessions() {
      return sdk.client.session
        .list({ start: Date.now() - 30 * 24 * 60 * 60 * 1000, ...sessionListQuery() })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))
    }

    event.subscribe((event, { directory, workspace }) => {
      switch (event.type) {
        case "server.instance.disposed":
          void bootstrap()
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          if (permission.mode === "yolo") {
            void sdk.client.permission.reply({
              requestID: request.id,
              reply: "once",
              directory,
              workspace,
            })
            break
          }
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.next.moved": {
          const result = search(store.session, event.properties.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.directory = event.properties.location.directory
              session.path = event.properties.subdirectory
              session.workspaceID = event.properties.location.workspaceID
              session.time.updated = event.properties.timestamp
            }),
          )
          break
        }

        case "session.next.context.prepared": {
          // The runtime's own measurement of the request it sends. Consumers render this report
          // rather than deriving a second context state of their own.
          setStore("session_context", event.properties.sessionID, event.properties)
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          touchMessage(event.properties.info.sessionID, event.properties.info.id)
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = search(messages, messageKey(event.properties.info), messageKey)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }
        case "message.removed": {
          touchMessage(event.properties.sessionID, event.properties.messageID)
          const messages = store.message[event.properties.sessionID]
          if (!messages) break
          const index = messages.findIndex((message) => message.id === event.properties.messageID)
          if (index !== -1) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          const incoming = event.properties.part
          touchPart(incoming.sessionID, incoming.id)
          const parts = store.part[incoming.messageID]
          if (!parts) {
            setStore("part", incoming.messageID, [incoming])
            break
          }
          // Mutate the existing part in place (via the store draft) so keyed
          // `<For>` components over `part[messageID]` keep their identity and
          // are not remounted for every streamed snapshot/delta — remounting
          // rebuilds the markdown/syntax tree per token and shows up as
          // aggressive redraw/flicker while streaming.
          setStore(
            "part",
            incoming.messageID,
            produce((draft) => {
              applyPartUpdated(draft, incoming)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = search(parts, event.properties.partID, (part) => part.id)
          if (!result.found) break
          touchPart(event.properties.sessionID, event.properties.partID)
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              applyPartDelta(draft, event.properties.partID, event.properties.field, event.properties.delta)
            }),
          )
          break
        }

        case "message.part.removed": {
          touchPart(event.properties.sessionID, event.properties.partID)
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = search(parts, event.properties.partID, (part) => part.id)
          if (result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      const capabilitiesPromise = sdk.client.experimental.capabilities
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => undefined)
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      await Promise.all([
        providersPromise,
        providerListPromise,
        capabilitiesPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ])
        .then(async () => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const capabilitiesResponse = capabilitiesPromise
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            capabilitiesResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const capabilities = responses[2]
            const consoleState = responses[3]
            const agents = responses[4]
            const config = responses[5]
            const sessions = responses[6]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("capabilities", "backgroundSubagents", capabilities?.backgroundSubagents === true)
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          void Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            consoleStatePromise.then((consoleState) => setStore("console_state", reconcile(consoleState))),
            sdk.client.command.list({ workspace }).then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", reconcile(x.data ?? []))),
            sdk.client.mcp.status({ workspace }).then((x) => setStore("mcp", reconcile(x.data ?? {}))),
            sdk.client.experimental.resource
              .list({ workspace })
              .then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status({ workspace }).then((x) => setStore("formatter", reconcile(x.data ?? []))),
            sdk.client.session.status({ workspace }).then((x) => {
              setStore("session_status", reconcile(x.data ?? {}))
            }),
            sdk.client.provider.auth({ workspace }).then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get({ workspace }).then((x) => setStore("vcs", reconcile(x.data))),
            project.workspace.sync(),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          console.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) {
            exit(e)
          } else {
            throw e
          }
        })
    }

    onMount(() => {
      void bootstrap()
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (startup.skipInitialLoading) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) return
          const syncing = syncingSessions.get(sessionID)
          if (syncing) return syncing
          const tracking = track(sessionID)
          const tracker = tracking.tracker
          const task = (async () => {
            const [session, messages, todo, diff] = await Promise.all([
              sdk.client.session.get({ sessionID }, { throwOnError: true }),
              // Bounded mount: the newest page only. `x-next-cursor` on the
              // response says whether older rows exist, and is what `more()`
              // passes back as `before` — the timeline is never truncated, it is
              // paginated (#815).
              sdk.client.session.messages({ sessionID, limit: PAGE_SIZE }),
              sdk.client.session.todo({ sessionID }),
              sdk.client.session.diff({ sessionID }),
            ])
            // A failed hydration leaves `response` undefined; it also means
            // there is no cursor to walk (the #26560 path: sync must not crash).
            olderCursors.set(sessionID, messages.response?.headers.get("x-next-cursor") ?? undefined)
            setStore(
              produce((draft) => {
                const match = search(draft.session, sessionID, (s) => s.id)
                if (match.found) draft.session[match.index] = session.data!
                if (!match.found) draft.session.splice(match.index, 0, session.data!)
                draft.todo[sessionID] = todo.data ?? []
                const currentMessages = draft.message[sessionID] ?? []
                const infos = (messages.data ?? []).flatMap((message) => {
                  if (!tracker.messages.has(message.info.id)) return [message.info]
                  const current = currentMessages.find((item) => item.id === message.info.id)
                  return current ? [current] : []
                })
                infos.push(
                  ...currentMessages.filter(
                    (message) => tracker.messages.has(message.id) && !infos.some((item) => item.id === message.id),
                  ),
                )
                infos.sort(compareMessage)
                const hydrated = new Set(infos.map((info) => info.id))
                for (const message of messages.data ?? []) {
                  // A message a live removal took out while hydration was in
                  // flight must not have its parts resurrected by the stale
                  // snapshot.
                  if (tracker.messages.has(message.info.id) && !hydrated.has(message.info.id)) {
                    delete draft.part[message.info.id]
                    continue
                  }
                  const currentParts = draft.part[message.info.id] ?? []
                  const parts = message.parts.flatMap((part) => {
                    const current = currentParts.find((item) => item.id === part.id)
                    if (tracker.parts.has(part.id)) return current ? [current] : []
                    if (current && part.type === current.type && (part.type === "text" || part.type === "reasoning")) {
                      return [mergePartInPlace(current, mergePartText(current, part))]
                    }
                    return [part]
                  })
                  parts.push(
                    ...currentParts.filter(
                      (part) => tracker.parts.has(part.id) && !parts.some((item) => item.id === part.id),
                    ),
                  )
                  draft.part[message.info.id] = parts
                }
                draft.message[sessionID] = infos
                draft.session_diff[sessionID] = diff.data ?? []
              }),
            )
            fullSyncedSessions.add(sessionID)
          })().finally(() => {
            syncingSessions.delete(sessionID)
            tracking.release()
          })
          syncingSessions.set(sessionID, task)
          return task
        },
        // One older page of persisted history, prepended to the store. Reports
        // how many messages it added and the cursor to the page before it, so a
        // caller can tell progress from exhaustion: an empty `cursor` is the
        // start of the timeline, while `added === 0` with a cursor means this
        // page only carried rows the store already had (or rows removed live).
        async more(sessionID: string): Promise<OlderPage> {
          const pending = loadingOlder.get(sessionID)
          if (pending) return pending
          const cursor = olderCursors.get(sessionID)
          if (!cursor) return { added: 0 }
          const tracking = track(sessionID)
          const task = (async () => {
            const page = await sdk.client.session.messages(
              { sessionID, limit: PAGE_SIZE, before: cursor },
              { throwOnError: true },
            )
            // The oldest loaded timestamp can move while this request is open
            // (live appends, removals); merge against the store as it is now.
            const rows = mergePage(sessionID, page.data ?? [], tracking.tracker)
            const known = new Set((store.message[sessionID] ?? []).map((info) => info.id))
            const added = rows.filter((entry) => !known.has(entry.info.id))
            const next = page.response.headers.get("x-next-cursor") ?? undefined
            olderCursors.set(sessionID, next)
            if (added.length === 0) return { added: 0, cursor: next }
            setStore(
              produce((draft) => {
                draft.message[sessionID] = [
                  ...added.map((entry) => entry.info),
                  ...(draft.message[sessionID] ?? []),
                ].sort(compareMessage)
                for (const entry of added) draft.part[entry.info.id] = entry.parts
              }),
            )
            return { added: added.length, cursor: next }
          })().finally(() => {
            loadingOlder.delete(sessionID)
            tracking.release()
          })
          loadingOlder.set(sessionID, task)
          return task
        },
        // Whether the server said older persisted rows exist beyond what the
        // store holds right now.
        hasOlder(sessionID: string) {
          return olderCursors.get(sessionID) !== undefined
        },
        // One page of the complete persisted timeline, newest page first, with
        // `before` walking older. Copy and export assemble the transcript from
        // these pages, so they read every persisted message without loading it
        // into the render store and never inherit the mount window (#815).
        async historyPage(sessionID: string, before?: string) {
          const tracking = track(sessionID)
          try {
            // `throwOnError` keeps a 500 or a transport failure from arriving
            // as an empty body: the caller must fail the transcript instead of
            // exporting whatever the cache happens to hold.
            const page = await sdk.client.session.messages(
              { sessionID, limit: PAGE_SIZE, ...(before ? { before } : {}) },
              { throwOnError: true },
            )
            const rows = mergePage(sessionID, page.data ?? [], tracking.tracker)
            // A prompt sent while the request was open is not projected yet and
            // only exists in the store. The newest page is missing every row
            // newer than its newest row; when the server has nothing persisted
            // at all (a session whose only message is that prompt) it is missing
            // the whole store.
            const last = newest(rows)
            const pending = before
              ? []
              : (store.message[sessionID] ?? [])
                  .filter((info) => !last || compareMessage(info, last.info) > 0)
                  .map((info) => ({ info, parts: store.part[info.id] ?? [] }))
            return {
              rows: [...rows, ...pending].sort((a, b) => compareMessage(a.info, b.info)),
              cursor: page.response.headers.get("x-next-cursor") ?? undefined,
            }
          } finally {
            tracking.release()
          }
        },
      },
      bootstrap,
    }
    return result
  },
})
