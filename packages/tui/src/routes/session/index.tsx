import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
  useContext,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { useRoute, useRouteData } from "../../context/route"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useEvent } from "../../context/event"
import { SplitBorder } from "../../ui/border"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { Spinner } from "../../component/spinner"
import {
  createSyntaxStyleMemo,
  generateSubtleSyntax,
  selectedForeground,
  textAttributes,
  useTheme,
} from "../../context/theme"
import { BoxRenderable, ScrollBoxRenderable, addDefaultParsers, TextAttributes, RGBA } from "@opentui/core"
import { Prompt, type PromptRef } from "../../component/prompt"
import type {
  AssistantMessage,
  Part,
  Provider,
  ToolPart,
  UserMessage,
  TextPart,
  ReasoningPart,
  SessionStatus,
} from "@opencode-ai/sdk/v2"
import { ReviewReport } from "@opencode-ai/core/review-report"
import { useLocal } from "../../context/local"
import { Locale } from "../../util/locale"
import { webSearchProviderLabel } from "../../util/tool-display"
import { useRenderer, type JSX } from "@opentui/solid"
import { useTerminalDimensions } from "../../util/terminal-dimensions"
import { useSDK } from "../../context/sdk"
import { useEditorContext } from "../../context/editor"
import { openEditor } from "../../editor"
import { useDialog } from "../../ui/dialog"
import { DialogAlert } from "../../ui/dialog-alert"
import { TodoItem } from "../../component/todo-item"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { Sidebar } from "./sidebar"
import { SubagentFooter } from "./subagent-footer.tsx"
import { filetype } from "../../util/filetype"
import parsers from "../../parsers-config"
import { errorMessage } from "../../util/error"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import stripAnsi from "strip-ansi"
import { usePromptRef } from "../../context/prompt"
import { useEpilogue } from "../../context/epilogue"
import { normalizePath } from "../../util/path"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import * as Model from "../../util/model"
import { pauseMarker } from "../../util/pause"
import { elapsed, useClock } from "../../util/clock"
import { formatTranscript } from "../../util/transcript"
import { formatGenerationMetrics } from "../../util/generation-metrics"
import { sessionEpilogue } from "../../util/presentation"
import { setPreLayoutSiblingMargin } from "../../util/layout"
import { useTuiConfig } from "../../config"
import { useClipboard } from "../../context/clipboard"
import { nextThinkingMode, reasoningOpen, reasoningSummary, useThinkingMode, type ThinkingMode } from "../../context/thinking"
import { getScrollAcceleration } from "../../util/scroll"
import { collapseToolOutput } from "../../util/collapse-tool-output"
import { capOutputLines } from "../../util/cap-lines"
import {
  computeActivityGroups,
  computeActivitySubGroups,
  countActivityTargets,
  typedActivityHeader,
  resolveActivityExpanded,
  summarizeActivity,
  toggleActivityOverride,
  toolPartOutcome,
  type ActivityGroupPart,
  type ActivityGroups,
} from "../../util/activity"
import { collapseDiff } from "../../util/collapse-diff"
import { usePluginRuntime } from "../../plugin/runtime"
import { DialogRetryAction } from "../../component/dialog-retry-action"
import { getRevertDiffFiles } from "../../util/revert-diff"
import { parseBackgroundResult, type BackgroundResult } from "../../util/background-task"
import { OPENCODE_BASE_MODE, useBindings, useCommandShortcut, useOpencodeKeymap } from "../../keymap"
import { usePathFormatter } from "../../context/path-format"
import { LocationProvider } from "../../context/location"

addDefaultParsers(parsers.parsers)

const GO_UPSELL_FREE_TIER_LAST_SEEN_AT = "go_upsell_last_seen_at"
const GO_UPSELL_FREE_TIER_DONT_SHOW = "go_upsell_dont_show"
const GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT = "go_upsell_account_rate_limit_last_seen_at"
const GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW = "go_upsell_account_rate_limit_dont_show"
const GO_UPSELL_WINDOW = 86_400_000 // 24 hrs
const GO_UPSELL_PROVIDERS = new Set(["opencode", "opencode-go"])

export const alwaysSeparate = new WeakSet<BoxRenderable>()

type RetryAction = Extract<SessionStatus, { type: "retry" }>["action"]

function goUpsellKeys(action: RetryAction) {
  if (!action) return
  if (!GO_UPSELL_PROVIDERS.has(action.provider)) return
  if (action.reason === "free_tier_limit") {
    return {
      lastSeenAt: GO_UPSELL_FREE_TIER_LAST_SEEN_AT,
      dontShow: GO_UPSELL_FREE_TIER_DONT_SHOW,
    }
  }
  if (action.reason === "account_rate_limit") {
    return {
      lastSeenAt: GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT,
      dontShow: GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW,
    }
  }
}

const sessionBindingCommands = [
  "session.share",
  "session.rename",
  "session.timeline",
  "session.fork",
  "session.compact",
  "session.unshare",
  "session.undo",
  "session.redo",
  "session.sidebar.toggle",
  "session.toggle.conceal",
  "session.toggle.timestamps",
  "session.toggle.thinking",
  "session.toggle.actions",
  "session.toggle.scrollbar",
  "session.toggle.generic_tool_output",
  "session.toggle.activity",
  "session.first",
  "session.last",
  "session.messages_last_user",
  "session.message.next",
  "session.message.previous",
  "messages.copy",
  "session.copy",
  "session.export",
  "session.child.first",
  "session.parent",
  "session.child.next",
  "session.child.previous",
] as const

const sessionGlobalBindingCommands = [
  "session.page.up",
  "session.page.down",
  "session.line.up",
  "session.line.down",
  "session.half.page.up",
  "session.half.page.down",
] as const

const sessionGlobalUnfocusedBindingCommands = ["session.first", "session.last"] as const

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  thinkingMode: () => ThinkingMode
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showGenericToolOutput: () => boolean
  diffWrapMode: () => "word" | "none"
  providers: () => ReadonlyMap<string, Provider>
  sync: ReturnType<typeof useSync>
  tui: ReturnType<typeof useTuiConfig>
  activity: () => ActivityGroups
  activityAllExpanded: () => boolean
  activityExpanded: (groupID: string) => boolean
  toggleActivity: (groupID: string) => void
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

// Exported so tests can mount the transcript components (AssistantMessageRow,
// ActivityGroup, tool renderers) outside the full Session route.
export const SessionContext = context

export function Session() {
  const setEpilogue = useEpilogue()
  const clipboard = useClipboard()
  const writeExport = async (file: string, content: string) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  const pluginRuntime = usePluginRuntime()
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const event = useEvent()
  const project = useProject()
  const paths = useTuiPaths()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const location = createMemo(() => {
    const current = session()
    return current ? { directory: current.directory, workspaceID: current.workspaceID } : undefined
  })

  createEffect(() => {
    const title = Locale.truncate(session()?.title ?? "", 50)
    setEpilogue(sessionEpilogue({ title, sessionID: session()?.id }))
  })
  onCleanup(() => setEpilogue())
  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const messagesBeforeRevert = () => {
    const messageID = session()?.revert?.messageID
    if (!messageID) return messages()
    const index = messages().findIndex((message) => message.id === messageID)
    return index === -1 ? messages() : messages().slice(0, index)
  }
  const activity = createMemo<ActivityGroups>(() =>
    computeActivityGroups(
      messagesBeforeRevert().map((message) => ({
        message,
        parts: sync.data.part[message.id] ?? [],
      })),
    ),
  )
  const activityExpanded = (groupID: string) =>
    resolveActivityExpanded(activityOverrides[groupID], activityAllExpanded())
  const toggleActivity = (groupID: string) => {
    setActivityOverrides(groupID, toggleActivityOverride(activityOverrides[groupID], activityAllExpanded()))
  }
  const clearActivityOverrides = () => {
    // setStore merges, so clearing requires removing every key explicitly.
    for (const key of Object.keys(activityOverrides)) setActivityOverrides(key, undefined)
  }
  const foregroundTasks = createMemo(() =>
    sync.data.capabilities.backgroundSubagents
      ? messages().flatMap((message) =>
          (sync.data.part[message.id] ?? []).filter(
            (part): part is ToolPart =>
              part.type === "tool" &&
              part.tool === "task" &&
              part.state.status === "running" &&
              part.state.metadata?.background !== true,
          ),
        )
      : [],
  )
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const questions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.question[x.id] ?? [])
  })
  const visible = createMemo(() => !session()?.parentID && permissions().length === 0 && questions().length === 0)
  const disabled = createMemo(() => permissions().length > 0 || questions().length > 0)

  const pending = createMemo(() => {
    const completed = messages().findLastIndex((message) => message.role === "assistant" && message.time.completed)
    const pending = messages().findLastIndex(
      (message, index) => index > completed && message.role === "assistant" && !message.time.completed,
    )
    return pending === -1 ? undefined : pending
  })

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })

  const dimensions = useTerminalDimensions()
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "auto")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [conceal, setConceal] = createSignal(true)
  const thinking = useThinkingMode()
  const thinkingMode = thinking.mode
  const showThinking = createMemo(() => true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, _setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [_animationsEnabled, _setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)
  const [activityAllExpanded, setActivityAllExpanded] = kv.signal("activity_groups_expanded", false)
  // Per-group overrides; only groups differing from the global default are
  // stored, `undefined` follows the global default (solid store merges).
  const [activityOverrides, setActivityOverrides] = createStore<Record<string, boolean | undefined>>({})

  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    if (session()?.parentID) return false
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() ? 42 : 0) - 4)
  const providers = createMemo(() => Model.index(sync.data.provider))

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const toast = useToast()
  const sdk = useSDK()
  const editor = useEditorContext()

  createEffect(() => {
    const sessionID = route.sessionID
    void (async () => {
      const previousWorkspace = untrack(() => project.workspace.current())
      const result = await sdk.client.session.get({ sessionID }, { throwOnError: true })
      if (!result.data) {
        toast.show({
          message: `Session not found: ${sessionID}`,
          variant: "error",
          duration: 5000,
        })
        navigate({ type: "home" })
        return
      }

      if (result.data.workspaceID !== previousWorkspace) {
        project.workspace.set(result.data.workspaceID)

        // Sync all the data for this workspace. Note that this
        // workspace may not exist anymore which is why this is not
        // fatal. If it doesn't we still want to show the session
        // (which will be non-interactive)
        try {
          await sync.bootstrap({ fatal: false })
        } catch {}
      }
      editor.reconnect(result.data.directory)
      await sync.session.sync(sessionID)
      if (route.sessionID === sessionID && scroll) scroll.scrollBy(100_000)
    })().catch((error) => {
      if (route.sessionID !== sessionID) return
      toast.show({
        message: errorMessage(error),
        variant: "error",
        duration: 5000,
      })
      navigate({ type: "home" })
    })
  })

  let lastSwitch: string | undefined = undefined
  // Session mounts on every sessionID switch; without the unsubscribe the
  // handlers pile up on the global emitter (#416).
  const offPartUpdated = event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.type !== "tool") return
    if (part.sessionID !== route.sessionID) return
    if (part.state.status !== "completed") return
    if (part.id === lastSwitch) return

    if (part.tool === "plan_exit") {
      local.agent.set("work")
      lastSwitch = part.id
    } else if (part.tool === "plan_enter") {
      local.agent.set("think")
      lastSwitch = part.id
    }
  })
  onCleanup(offPartUpdated)

  let seeded = false
  let scroll: ScrollBoxRenderable
  // "Jump to latest" (#241): true while the transcript is scrolled away from
  // its end. Derived from the scrollbar's own change event, so it follows
  // every scroll source (wheel, keys, sticky re-engage, session switch) and
  // stays put while new output lands under a reader who scrolled up.
  const [scrolledAway, setScrolledAway] = createSignal(false)
  const lastShortcut = useCommandShortcut("session.last")
  function watchScroll(r: ScrollBoxRenderable) {
    scroll = r
    const update = () =>
      queueMicrotask(() => {
        if (r.isDestroyed) return
        const max = Math.max(0, r.scrollHeight - r.viewport.height)
        // Same threshold the scrollbox uses to re-engage sticky scrolling.
        setScrolledAway(max > 1 && r.scrollTop < max - 1)
      })
    r.verticalScrollBar.on("change", update)
    onCleanup(() => r.verticalScrollBar.off("change", update))
  }
  let prompt: PromptRef | undefined
  const bind = (r: PromptRef | undefined) => {
    prompt = r
    promptRef.set(r)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }
  const keymap = useOpencodeKeymap()
  const dialog = useDialog()
  const renderer = useRenderer()

  const offSessionStatus = event.on("session.status", (evt) => {
    if (evt.properties.sessionID !== route.sessionID) return
    if (evt.properties.status.type !== "retry") return
    if (!evt.properties.status.action) return
    if (dialog.stack.length > 0) return

    const keys = goUpsellKeys(evt.properties.status.action)
    if (!keys) return

    const seen = kv.get(keys.lastSeenAt)
    if (typeof seen === "number" && Date.now() - seen < GO_UPSELL_WINDOW) return

    if (kv.get(keys.dontShow)) return

    void DialogRetryAction.show(dialog, evt.properties.status.action).then((dontShowAgain) => {
      if (dontShowAgain) kv.set(keys.dontShow, true)
      kv.set(keys.lastSeenAt, Date.now())
    })
  })
  onCleanup(offSessionStatus)

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messagesList = messages()
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id) return false
        const message = messagesList.find((m) => m.id === c.id)
        if (!message) return false

        // Check if message has valid non-synthetic, non-ignored text parts
        const parts = sync.data.part[message.id]
        if (!parts || !Array.isArray(parts)) return false

        return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  function toBottom() {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  const local = useLocal()

  function enterChild(sessionID: string) {
    navigate({
      type: "session",
      sessionID,
    })
    const status = sync.data.session_status[sessionID]
    if (status?.type === "retry") void DialogAlert.show(dialog, "Retry Error", status.message)
  }

  function moveFirstChild() {
    if (children().length === 1) return
    const next = children().find((x) => !!x.parentID)
    if (next) enterChild(next.id)
  }

  function moveChild(direction: number) {
    if (children().length === 1) return

    const sessions = children().filter((x) => !!x.parentID)
    let next = sessions.findIndex((x) => x.id === session()?.id) - direction

    if (next >= sessions.length) next = 0
    if (next < 0) next = sessions.length - 1
    if (sessions[next]) enterChild(sessions[next].id)
  }

  function childSessionHandler(func: () => void) {
    return () => {
      if (!session()?.parentID || dialog.stack.length > 0) return
      func()
    }
  }

  const sessionCommandList = createMemo(() => [
    {
      title: session()?.share?.url ? "Copy share link" : "Share session",
      value: "session.share",
      suggested: route.type === "session",
      category: "Session",
      enabled: sync.data.config.share !== "disabled",
      slash: {
        name: "share",
      },
      run: async () => {
        const copy = (url: string) =>
          clipboard
            .write?.(url)
            .then(() => toast.show({ message: "Share URL copied to clipboard!", variant: "success" }))
            .catch(() => toast.show({ message: "Failed to copy URL to clipboard", variant: "error" }))
        const url = session()?.share?.url
        if (url) {
          await copy(url)
          dialog.clear()
          return
        }
        if (!kv.get("share_consent", false)) {
          const ok = await DialogConfirm.show(dialog, "Share Session", "Are you sure you want to share it?")
          if (ok !== true) return
          kv.set("share_consent", true)
        }
        await sdk.client.session
          .share({
            sessionID: route.sessionID,
          })
          .then((res) => copy(res.data!.share!.url))
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to share session",
              variant: "error",
            })
          })
        dialog.clear()
      },
    },
    {
      title: "Rename session",
      value: "session.rename",
      category: "Session",
      slash: {
        name: "rename",
      },
      run: () => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      category: "Session",
      slash: {
        name: "timeline",
      },
      run: () => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
            setPrompt={(promptInfo) => prompt?.set(promptInfo)}
          />
        ))
      },
    },
    {
      title: "Fork session",
      value: "session.fork",
      category: "Session",
      slash: {
        name: "fork",
      },
      run: () => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              if (!messageID) return
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
          />
        ))
      },
    },
    {
      title: "Compact session",
      value: "session.compact",
      category: "Session",
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      run: () => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }
        void sdk.client.session.summarize({
          sessionID: route.sessionID,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
        })
        dialog.clear()
      },
    },
    {
      title: "Unshare session",
      value: "session.unshare",
      category: "Session",
      enabled: !!session()?.share?.url,
      slash: {
        name: "unshare",
      },
      run: async () => {
        await sdk.client.session
          .unshare({
            sessionID: route.sessionID,
          })
          .then(() => toast.show({ message: "Session unshared successfully", variant: "success" }))
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to unshare session",
              variant: "error",
            })
          })
        dialog.clear()
      },
    },
    {
      title: "Undo previous message",
      value: "session.undo",
      category: "Session",
      slash: {
        name: "undo",
      },
      run: async () => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const message = messagesBeforeRevert().findLast((item) => item.role === "user")
        if (!message) return
        void sdk.client.session
          .revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          .then(() => {
            toBottom()
          })
        const parts = sync.data.part[message.id]
        prompt?.set(
          parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          ),
        )
        dialog.clear()
      },
    },
    {
      title: "Redo",
      value: "session.redo",
      category: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      run: () => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        const message = messages().find((x) => x.role === "user" && x.id > messageID)
        if (!message) {
          void sdk.client.session.unrevert({
            sessionID: route.sessionID,
          })
          prompt?.set({ input: "", parts: [] })
          return
        }
        void sdk.client.session.revert({
          sessionID: route.sessionID,
          messageID: message.id,
        })
      },
    },
    {
      title: sidebarVisible() ? "Hide sidebar" : "Show sidebar",
      value: "session.sidebar.toggle",
      category: "Session",
      run: () => {
        batch(() => {
          const isVisible = sidebarVisible()
          setSidebar(() => (isVisible ? "hide" : "auto"))
          setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: conceal() ? "Disable code concealment" : "Enable code concealment",
      value: "session.toggle.conceal",
      category: "Session",
      run: () => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      run: () => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: (() => {
        const next = nextThinkingMode(thinkingMode())
        if (next === "hide") return "Collapse thinking"
        return "Expand thinking"
      })(),
      value: "session.toggle.thinking",
      category: "Session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      run: () => {
        thinking.set(nextThinkingMode(thinkingMode()))
        dialog.clear()
      },
    },
    {
      title: showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      category: "Session",
      slash: {
        name: "details",
      },
      run: () => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      category: "Session",
      run: () => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showGenericToolOutput() ? "Hide generic tool output" : "Show generic tool output",
      value: "session.toggle.generic_tool_output",
      category: "Session",
      run: () => {
        setShowGenericToolOutput((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: activityAllExpanded() ? "Collapse working blocks" : "Expand working blocks",
      value: "session.toggle.activity",
      category: "Session",
      slash: {
        name: "working",
        aliases: ["activity"],
      },
      run: () => {
        setActivityAllExpanded((prev) => !prev)
        clearActivityOverrides()
        dialog.clear()
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Page down",
      value: "session.page.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Line up",
      value: "session.line.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-1)
        dialog.clear()
      },
    },
    {
      title: "Line down",
      value: "session.line.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "Half page down",
      value: "session.half.page.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "First message",
      value: "session.first",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollTo(0)
        dialog.clear()
      },
    },
    {
      title: "Last message",
      value: "session.last",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      category: "Session",
      hidden: true,
      run: () => {
        const messages = sync.data.message[route.sessionID]
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
            break
          }
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("prev", dialog),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      category: "Session",
      run: () => {
        const lastAssistantMessage = messagesBeforeRevert().findLast((message) => message.role === "assistant")
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        clipboard
          .write?.(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: {
        name: "copy",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: showThinking(),
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
              providers: sync.data.provider,
            },
          )
          await clipboard.write?.(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      category: "Session",
      slash: {
        name: "export",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            showThinking(),
            showDetails(),
            showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
              providers: sync.data.provider,
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await openEditor({
              renderer,
              value: transcript,
              cwd:
                (project.instance.path().worktree === "/" ? undefined : project.instance.path().worktree) ||
                project.instance.directory() ||
                paths.cwd,
            })
          } else {
            const exportDir = paths.cwd
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await writeExport(filepath, transcript)

            // Open with EDITOR if available
            const result = await openEditor({
              renderer,
              value: transcript,
              cwd:
                (project.instance.path().worktree === "/" ? undefined : project.instance.path().worktree) ||
                project.instance.directory() ||
                paths.cwd,
            })
            if (result !== undefined) {
              await writeExport(filepath, result)
            }

            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Background subagents",
      value: "session.background",
      category: "Session",
      hidden: true,
      enabled: foregroundTasks().length > 0,
      run: () => {
        void sdk.client.experimental.session.background({
          sessionID: route.sessionID,
          workspace: project.workspace.current(),
        })
        dialog.clear()
      },
    },
    {
      title: "Go to child session",
      value: "session.child.first",
      category: "Session",
      hidden: true,
      run: () => {
        dialog.clear()
        moveFirstChild()
      },
    },
    {
      title: "Go to parent session",
      value: "session.parent",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      }),
    },
    {
      title: "Next child session",
      value: "session.child.next",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        dialog.clear()
        moveChild(1)
      }),
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        dialog.clear()
        moveChild(-1)
      }),
    },
  ])

  const sessionCommands = createMemo(() =>
    sessionCommandList().map((command) => ({
      namespace: "palette",
      name: command.value,
      desc: "description" in command ? command.description : undefined,
      slashName: "slash" in command ? command.slash?.name : undefined,
      slashAliases: "slash" in command ? command.slash?.aliases : undefined,
      ...command,
    })),
  )

  useBindings(() => ({
    commands: sessionCommands(),
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("session.global", sessionGlobalBindingCommands),
  }))

  useBindings(() => ({
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: tuiConfig.keybinds.gather("session.global.unfocused", sessionGlobalUnfocusedBindingCommands),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("session", sessionBindingCommands),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: foregroundTasks().length > 0,
    priority: 1,
    bindings: tuiConfig.keybinds.get("session.background"),
  }))

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)
  const revertMessageIndex = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return -1
    return messages().findIndex((message) => message.id === messageID)
  })

  const revertDiffFiles = createMemo(() => getRevertDiffFiles(revertInfo()?.diff ?? ""))

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    const index = revertMessageIndex()
    if (index === -1) return []
    return messages()
      .slice(index)
      .filter((message) => message.role === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

  return (
    <LocationProvider location={location()}>
      <context.Provider
        value={{
          get width() {
            return contentWidth()
          },
          sessionID: route.sessionID,
          conceal,
          thinkingMode,
          showThinking,
          showTimestamps,
          showDetails,
          showGenericToolOutput,
          diffWrapMode,
          providers,
          sync,
          tui: tuiConfig,
          activity,
          activityAllExpanded,
          activityExpanded,
          toggleActivity,
        }}
      >
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          {/* SilverCode docks the sidebar on the left; it must stay the first child of the row. */}
          <Show when={sidebarVisible()}>
            <Switch>
              <Match when={wide()}>
                <Sidebar sessionID={route.sessionID} />
              </Match>
              <Match when={!wide()}>
                <box
                  position="absolute"
                  top={0}
                  left={0}
                  right={0}
                  bottom={0}
                  alignItems="flex-start"
                  backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
                >
                  <Sidebar sessionID={route.sessionID} />
                </box>
              </Match>
            </Switch>
          </Show>
          <box flexGrow={1} minHeight={0} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1}>
            <Show when={session()}>
              <scrollbox
                ref={watchScroll}
                viewportOptions={{
                  paddingRight: showScrollbar() ? 1 : 0,
                }}
                verticalScrollbarOptions={{
                  paddingLeft: 1,
                  visible: showScrollbar(),
                  trackOptions: {
                    backgroundColor: theme.backgroundElement,
                    foregroundColor: theme.border,
                  },
                }}
                stickyScroll={true}
                stickyStart="bottom"
                flexGrow={1}
                scrollAcceleration={scrollAcceleration()}
              >
                <box height={1} />
                <For each={messages()}>
                  {(message, index) => (
                    <Switch>
                      <Match when={message.id === revert()?.messageID}>
                        {(function () {
                          const redoShortcut = useCommandShortcut("session.redo")
                          const [hover, setHover] = createSignal(false)
                          const dialog = useDialog()

                          const handleUnrevert = async () => {
                            const confirmed = await DialogConfirm.show(
                              dialog,
                              "Confirm Redo",
                              "Are you sure you want to restore the reverted messages?",
                            )
                            if (confirmed) {
                              keymap.dispatchCommand("session.redo")
                            }
                          }

                          return (
                            <box
                              onMouseOver={() => setHover(true)}
                              onMouseOut={() => setHover(false)}
                              onMouseUp={handleUnrevert}
                              marginTop={1}
                              flexShrink={0}
                              border={["left"]}
                              customBorderChars={SplitBorder.customBorderChars}
                              borderColor={theme.backgroundPanel}
                            >
                              <box
                                paddingTop={1}
                                paddingBottom={1}
                                paddingLeft={2}
                                backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
                              >
                                <text fg={theme.textMuted}>{revert()!.reverted.length} message reverted</text>
                                <text fg={theme.textMuted}>
                                  <span style={{ fg: theme.text }}>{redoShortcut()}</span> or /redo to restore
                                </text>
                                <Show when={revert()!.diffFiles?.length}>
                                  <box marginTop={1}>
                                    <For each={revert()!.diffFiles}>
                                      {(file) => (
                                        <text fg={theme.text}>
                                          {file.filename}
                                          <Show when={file.additions > 0}>
                                            <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                                          </Show>
                                          <Show when={file.deletions > 0}>
                                            <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                                          </Show>
                                        </text>
                                      )}
                                    </For>
                                  </box>
                                </Show>
                              </box>
                            </box>
                          )
                        })()}
                      </Match>
                      <Match
                        when={revert()?.messageID && revertMessageIndex() !== -1 && index() >= revertMessageIndex()}
                      >
                        <></>
                      </Match>
                      <Match when={message.role === "user"}>
                        <UserMessage
                          index={index()}
                          onMouseUp={() => {
                            if (renderer.getSelection()?.getSelectedText()) return
                            dialog.replace(() => (
                              <DialogMessage
                                messageID={message.id}
                                sessionID={route.sessionID}
                                setPrompt={(promptInfo) => prompt?.set(promptInfo)}
                              />
                            ))
                          }}
                          message={message as UserMessage}
                          parts={sync.data.part[message.id] ?? []}
                          pending={pending()}
                        />
                      </Match>
                      <Match when={message.role === "assistant"}>
                        <AssistantMessageRow
                          last={lastAssistant()?.id === message.id}
                          message={message as AssistantMessage}
                          parts={sync.data.part[message.id] ?? []}
                        />
                      </Match>
                    </Switch>
                  )}
                </For>
              </scrollbox>
              <box flexShrink={0}>
                {/* Sits in the gap row between transcript and prompt, so it
                    covers no output and shifts nothing when it appears. */}
                <Show when={scrolledAway()}>
                  <box
                    position="absolute"
                    top={-1}
                    right={showScrollbar() ? 2 : 0}
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={theme.backgroundElement}
                    onMouseUp={() => scroll.scrollTo(scroll.scrollHeight)}
                  >
                    <text fg={theme.text} wrapMode="none">
                      ↓ Jump to latest
                      <Show when={lastShortcut()}>
                        <span style={{ fg: theme.textMuted }}>{" · " + lastShortcut()}</span>
                      </Show>
                    </text>
                  </box>
                </Show>
                <Show when={permissions().length > 0}>
                  <PermissionPrompt
                    request={permissions()[0]}
                    directory={sync.session.get(permissions()[0].sessionID)?.directory}
                  />
                </Show>
                <Show when={permissions().length === 0 && questions().length > 0}>
                  <QuestionPrompt
                    request={questions()[0]}
                    directory={sync.session.get(questions()[0].sessionID)?.directory}
                  />
                </Show>
                <Show when={session()?.parentID}>
                  <SubagentFooter />
                </Show>
                <Show when={visible()}>
                  <pluginRuntime.Slot
                    name="session_prompt"
                    mode="replace"
                    session_id={route.sessionID}
                    visible={visible()}
                    disabled={disabled()}
                    on_submit={toBottom}
                    ref={bind}
                  >
                    <Prompt
                      visible={visible()}
                      ref={bind}
                      disabled={disabled()}
                      onSubmit={() => {
                        toBottom()
                      }}
                      sessionID={route.sessionID}
                      right={<pluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />}
                      hint={
                        // Session identity lives in the sidebar; when that is
                        // hidden (narrow terminal or toggled off) the status
                        // line names the session instead of the directory the
                        // sidebar footer would otherwise repeat (#241).
                        sidebarVisible() ? undefined : (
                          <box marginLeft={1} flexShrink={1} minWidth={0}>
                            <text fg={theme.text} wrapMode="none">
                              {session()?.title}
                            </text>
                          </box>
                        )
                      }
                    />
                  </pluginRuntime.Slot>
                </Show>
              </box>
            </Show>
            <Toast />
          </box>
        </box>
      </context.Provider>
    </LocationProvider>
  )
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: number
}) {
  const ctx = use()
  const local = useLocal()
  const text = createMemo(() => {
    const texts = props.parts
      .map((x) => {
        if (x.type === "text" && !x.synthetic) {
          return x.text
        }
        return null
      })
      .filter(Boolean)
    return texts.join("\n\n")
  })
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  // Background subagent results arrive as synthetic text parts carrying the
  // task delivery markup. The user text above hides synthetic parts, so each
  // delivered result gets its own history indicator instead of rendering
  // nothing and letting the main agent resume from an unexplained gap.
  const backgroundResults = createMemo(() =>
    props.parts
      .filter((part): part is TextPart => part.type === "text" && part.synthetic === true)
      .map((part) => parseBackgroundResult(part.text))
      .filter((result): result is BackgroundResult => result !== undefined),
  )
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.pending !== undefined && props.index > props.pending)
  const color = createMemo(() => local.agent.color(props.message.agent))
  const queuedFg = createMemo(() => selectedForeground(theme, color()))
  const metadataVisible = createMemo(() => queued() || ctx.showTimestamps())

  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))

  return (
    <>
      <Show when={text()}>
        <box
          id={props.message.id}
          ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
          border={["left"]}
          borderColor={color()}
          customBorderChars={SplitBorder.customBorderChars}
          marginTop={props.index === 0 ? 0 : 1}
        >
          <box
            onMouseOver={() => {
              setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
            onMouseUp={props.onMouseUp}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <text fg={theme.text}>{text()}</text>
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const directory = file.mime === "application/x-directory"
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: theme.secondary, fg: theme.background }}>
                          {directory ? " Directory " : " File "}
                        </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show
              when={queued()}
              fallback={
                <Show when={ctx.showTimestamps()}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.textMuted }}>
                      {Locale.todayTimeOrDateTime(props.message.time.created)}
                    </span>
                  </text>
                </Show>
              }
            >
              <text fg={theme.textMuted}>
                <span style={{ bg: color(), fg: queuedFg(), bold: true }}> QUEUED </span>
              </text>
            </Show>
          </box>
        </box>
      </Show>
      <For each={backgroundResults()}>
        {(result) => {
          const completed = () => result.state === "completed"
          const cancelled = () => result.state === "cancelled"
          return (
            <>
              <box
                marginTop={1}
                border={["top"]}
                title={
                  completed()
                    ? " Background subagent completed "
                    : cancelled()
                      ? " Background subagent cancelled "
                      : " Background subagent failed "
                }
                titleAlignment="center"
                borderColor={theme.borderActive}
              />
              <text fg={theme.textMuted}>
                <span style={{ fg: completed() ? theme.success : cancelled() ? theme.textMuted : theme.error }}>
                  {completed() ? "✓" : cancelled() ? "○" : "✗"}
                </span>{" "}
                {result.summary} — {cancelled() ? "cancellation" : "result"} delivered to the main agent
              </text>
            </>
          )
        }}
      </For>
      <Show when={compaction()}>
        <box
          marginTop={1}
          border={["top"]}
          title=" Compaction "
          titleAlignment="center"
          borderColor={theme.borderActive}
        />
      </Show>
    </>
  )
}

// Exported so tests can render the assistant transcript row directly.
export function AssistantMessageRow(props: { message: AssistantMessage; parts: Part[]; last: boolean }) {
  const ctx = use()
  const local = useLocal()
  const { theme } = useTheme()
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[props.message.sessionID] ?? [])
  const model = createMemo(() => Model.name(ctx.providers(), props.message.providerID, props.message.modelID))

  const final = createMemo(() => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  })

  // A finish-only turn is an assistant message that contains only tool parts
  // (no text or reasoning). It exists solely to invoke the finish tool and
  // must not render its own standalone model footer — the preceding
  // substantive turn already owns the footer.
  const isFinishOnly = createMemo(() => {
    return props.parts.length > 0 && !props.parts.some((p) => p.type === "text" || p.type === "reasoning")
  })

  const duration = createMemo(() => {
    if (!final()) return 0
    if (!props.message.time.completed) return 0
    const user = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
    if (!user || !user.time) return 0
    return props.message.time.completed - user.time.created
  })

  // The last turn counts up while it runs, and stays highlighted until it ends.
  const running = createMemo(
    () => props.last && !final() && !props.message.time.completed && !props.message.error && !isFinishOnly(),
  )
  const clock = useClock(running)
  const liveDuration = createMemo(() => {
    if (!running()) return undefined
    const user = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
    if (!user || !user.time) return undefined
    return elapsed(clock() - user.time.created)
  })
  const footerMuted = createMemo(() => (running() ? theme.text : theme.textMuted))

  const metrics = createMemo(() => formatGenerationMetrics(props.message))

  // A mid-task model/thinking-effort switch becomes visible on the first
  // assistant turn that actually ran with the new selection.
  const switchMarker = createMemo(() => {
    const turns = messages().filter((x): x is AssistantMessage => x.role === "assistant")
    const index = turns.findIndex((x) => x.id === props.message.id)
    const change = Model.modelSwitch(index > 0 ? turns.slice(0, index) : undefined, props.message)
    if (!change) return undefined
    return { model: model(), variant: change.variant }
  })

  const childShortcut = useCommandShortcut("session.child.first")
  const backgroundShortcut = useCommandShortcut("session.background")

  return (
    <>
      <Show when={switchMarker()}>
        {(marker) => (
          <box
            marginTop={1}
            border={["top"]}
            title={` ↻ ${marker().model}${marker().variant ? ` · thinking effort: ${marker().variant}` : ""} `}
            titleAlignment="center"
            borderColor={theme.border}
          />
        )}
      </Show>
      <For each={props.parts}>
        {(part, index) => {
          // Tool and reasoning parts belong to an activity group when their
          // run contains two or more tool calls. Only the first visible part
          // of the run (the owner) renders the group; the rest are rendered
          // inside it when expanded.
          const group = createMemo(() => {
            if (part.type !== "tool" && part.type !== "reasoning") return undefined
            const activity = ctx.activity()
            const groupID = activity.groupOf.get(part.id)
            if (!groupID) return undefined
            const info = activity.byID.get(groupID)
            if (!info || info.items.length < 2) return undefined
            return { groupID, owner: info.parts[0]?.part.id === part.id }
          })
          const component = createMemo(() => PART_MAPPING[part.type as keyof typeof PART_MAPPING])
          const pause = createMemo(() => (group() && !group()!.owner ? undefined : pauseMarker(props.parts, index())))
          return (
            <>
            <Show when={pause()}>
              {(text) => (
                <box
                  marginTop={1}
                  border={["top"]}
                  title={` ↻ ${text()} `}
                  titleAlignment="center"
                  borderColor={theme.border}
                />
              )}
            </Show>
            <Switch>
              <Match when={group()?.owner === true}>
                <ActivityGroup groupID={group()!.groupID} />
              </Match>
              <Match when={group()?.owner === false}>
                <></>
              </Match>
              <Match when={true}>
                <Show when={component()}>
                  <Dynamic
                    last={index() === props.parts.length - 1}
                    component={component()}
                    part={part as any}
                    message={props.message}
                  />
                </Show>
              </Match>
            </Switch>
            </>
          )
        }}
      </For>
      <Show when={props.parts.some((x) => x.type === "tool" && x.tool === "task")}>
        <box paddingTop={1} paddingLeft={3}>
          <text fg={theme.text}>
            {childShortcut()}
            <span style={{ fg: theme.textMuted }}> view subagents</span>
            <Show
              when={
                sync.data.capabilities.backgroundSubagents &&
                props.parts.some(
                  (x) =>
                    x.type === "tool" &&
                    x.tool === "task" &&
                    x.state.status === "running" &&
                    x.state.metadata?.background !== true,
                )
              }
            >
              <span style={{ fg: theme.textMuted }}> · </span>
              {backgroundShortcut()}
              <span style={{ fg: theme.textMuted }}> background</span>
            </Show>
          </text>
        </box>
      </Show>
      <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
        <AssistantMessageError error={props.message.error} />
      </Show>
      <Switch>
        <Match
          when={((props.last || final()) && !isFinishOnly()) || props.message.error?.name === "MessageAbortedError"}
        >
          <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3}>
            <text marginTop={1}>
              <span
                style={{
                  fg:
                    props.message.error?.name === "MessageAbortedError"
                      ? theme.textMuted
                      : local.agent.color(props.message.agent),
                }}
              >
                ▣{" "}
              </span>{" "}
              <span style={{ fg: theme.text }}>{Locale.titlecase(props.message.mode)}</span>
              <span style={{ fg: footerMuted() }}> · {model()}</span>
              <Show when={liveDuration()}>
                <span style={{ fg: footerMuted() }}> · {liveDuration()}</span>
              </Show>
              <Show when={duration()}>
                <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
              </Show>
              <Show when={metrics()}>
                <span style={{ fg: theme.textMuted }}> · {metrics()}</span>
              </Show>
              <Show when={props.message.error?.name === "MessageAbortedError"}>
                <span style={{ fg: theme.textMuted }}> · interrupted</span>
              </Show>
            </text>
          </box>
        </Match>
      </Switch>
    </>
  )
}

export function AssistantMessageError(props: { error: unknown }) {
  const ctx = use()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const message = createMemo(() => errorMessage(props.error))
  const maxLines = COLLAPSED_TOOL_PREVIEW_LINES
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => collapseToolOutput(message(), maxLines, maxChars()))
  const visible = createMemo(() => (expanded() || !collapsed().overflow ? message() : collapsed().output))

  return (
    <box
      ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      backgroundColor={hover() && collapsed().overflow ? theme.backgroundMenu : theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.error}
      onMouseOver={() => collapsed().overflow && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        if (collapsed().overflow) setExpanded((prev) => !prev)
      }}
    >
      <text fg={theme.textMuted}>{visible()}</text>
      <Show when={collapsed().overflow}>
        <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
      </Show>
    </box>
  )
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
}

const INLINE_TOOL_ICON_WIDTH = 2

// Default content lines shown in a collapsed bash/write/edit block before "Click to expand".
const COLLAPSED_TOOL_PREVIEW_LINES = 3

function ReasoningPart(props: { last: boolean; part: ReasoningPart; message: AssistantMessage }) {
  const { theme } = useTheme()
  const ctx = use()
  // Collapsed by default in hide mode: a single line throughout, so the
  // layout never shifts. Click to open the full markdown block, click to close.
  const [expanded, setExpanded] = createSignal(false)

  const content = createMemo(() => {
    // OpenRouter encrypts some reasoning blocks; drop the placeholder.
    return props.part.text.replace("[REDACTED]", "").trim()
  })
  const opaque = createMemo(() => !content() && Boolean(props.part.metadata))
  // Reasoning is finalized when the server sets `time.end` (see processor.ts).
  // Flips independently of the parent message completing.
  const isDone = createMemo(() => props.part.time.end !== undefined)
  const inMinimal = createMemo(() => ctx.thinkingMode() === "hide")
  const duration = createMemo(() => {
    const end = props.part.time.end
    return end === undefined ? 0 : Math.max(0, end - props.part.time.start)
  })
  const summary = createMemo(() => reasoningSummary(content()))
  const syntax = createSyntaxStyleMemo((owner) => generateSubtleSyntax(theme, owner))
  // The block stays open while the reasoning stream is active so the streamed
  // content is readable (regardless of the display mode). It only transitions
  // to its completed/collapsed state when the reasoning stream actually ends
  // (`isDone`), then falls back to the mode default.
  const open = createMemo(() => reasoningOpen({ done: isDone(), mode: ctx.thinkingMode(), expanded: expanded() }))

  const toggle = () => {
    if (!inMinimal() || opaque()) return
    setExpanded((prev) => !prev)
  }

  return (
    <Show when={content() || opaque()}>
      <box
        ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
        paddingLeft={3}
        marginTop={1}
        flexDirection="column"
        flexShrink={0}
      >
        <box onMouseUp={toggle}>
          <ReasoningHeader
            toggleable={inMinimal() && !opaque()}
            open={open()}
            done={isDone()}
            title={summary().title}
            duration={isDone() ? Locale.duration(duration()) : undefined}
            encrypted={opaque()}
          />
        </box>
        <Show when={!opaque() && open() && summary().body}>
          <box paddingLeft={inMinimal() ? 2 : 0} marginTop={1}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={syntax()}
              content={summary().body}
              conceal={ctx.conceal()}
              fg={theme.textMuted}
            />
          </box>
        </Show>
      </box>
    </Show>
  )
}

function ReasoningHeader(props: {
  toggleable: boolean
  open: boolean
  done: boolean
  title: string | null
  duration?: string
  encrypted?: boolean
}) {
  const { theme } = useTheme()
  // The streaming "Thinking" and completed "Thought" labels take their colour
  // and style from the theme file (#241). `thinkingOpacity` keeps its meaning:
  // the label dims while the reasoning body is shown underneath it.
  const color = () => (props.done ? theme.thinkingCompleted : theme.thinkingStreaming)
  const fg = () => {
    const base = color()
    return props.open ? RGBA.fromValues(base.r, base.g, base.b, theme.thinkingOpacity) : base
  }
  const attributes = () => textAttributes(props.done ? theme.thinkingCompletedStyle : theme.thinkingStreamingStyle)
  const completed = () => {
    if (props.encrypted) return `Thought${props.duration ? ` · ${props.duration}` : ""}`
    const detail = [props.title, props.duration].filter(Boolean).join(" · ")
    return `${props.toggleable ? (props.open ? "- " : "+ ") : ""}Thought${detail ? `: ${detail}` : ""}`
  }

  return (
    <Switch>
      <Match when={!props.done}>
        <box flexDirection="row">
          <Spinner color={fg()} attributes={attributes()}>
            {props.title ? "Thinking: " + props.title : "Thinking"}
          </Spinner>
        </box>
      </Match>
      <Match when={true}>
        <text fg={fg()} attributes={attributes()} wrapMode="none">
          {completed()}
        </text>
      </Match>
    </Switch>
  )
}

function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  return (
    <Show when={props.part.text.trim()}>
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3} marginTop={1} flexShrink={0}>
        <markdown
          syntaxStyle={syntax()}
          streaming={true}
          internalBlockMode="top-level"
          content={props.part.text.trim()}
          tableOptions={{ style: "grid" }}
          conceal={ctx.conceal()}
          fg={theme.markdownText}
          bg={theme.background}
        />
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

// Exported so tests can mount the activity block outside the full Session route.
export function ActivityGroup(props: { groupID: string }) {
  const ctx = use()
  const group = createMemo(() => ctx.activity().byID.get(props.groupID))
  // Keyed by block id (strings) so streamed updates never remount a block:
  // remounting would reset local row state (hover, nested reasoning toggles).
  const subIDs = createMemo(() => {
    const g = group()
    return g ? computeActivitySubGroups(g).map((sub) => sub.id) : []
  })
  return (
    <box
      ref={(el: BoxRenderable) => {
        alwaysSeparate.add(el)
        setPreLayoutSiblingMargin(el, (previous) => {
          return previous instanceof BoxRenderable && (previous.height > 1 || alwaysSeparate.has(previous)) ? 1 : 0
        })
      }}
      paddingLeft={3}
      flexShrink={0}
    >
      <For each={subIDs()}>{(id) => <ActivitySubGroupBlock groupID={props.groupID} subID={id} />}</For>
    </box>
  )
}

// One typed working block ("Explored N files", "Ran N commands", "Edited N
// files", or the unchanged misc "Working..." block) inside an activity group.
// The header is clickable: collapsed shows the summary, expanded renders each
// call with its native full row.
function ActivitySubGroupBlock(props: { groupID: string; subID: string }) {
  const ctx = use()
  const renderer = useRenderer()
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)

  const sub = createMemo(() => {
    const g = ctx.activity().byID.get(props.groupID)
    if (!g) return undefined
    return computeActivitySubGroups(g).find((s) => s.id === props.subID)
  })
  const kind = createMemo(() => sub()?.kind ?? "misc")
  const items = createMemo(() => sub()?.items ?? [])
  const parts = createMemo(() => sub()?.parts ?? [])
  const summary = createMemo(() => summarizeActivity(items().map((item) => item.part)))
  const targets = createMemo(() => countActivityTargets(items()))
  const expanded = createMemo(() => ctx.activityExpanded(props.subID))
  // A running block counts up once a second, from its first started tool call.
  const startedAt = createMemo(() => {
    let start: number | undefined
    for (const item of items()) {
      const state = item.part.state
      if (state.status === "pending") continue
      start = start === undefined ? state.time.start : Math.min(start, state.time.start)
    }
    return start
  })
  const clock = useClock(() => summary().working && startedAt() !== undefined)
  const header = createMemo(() =>
    typedActivityHeader(kind(), summary(), targets(), {
      expanded: expanded(),
      duration: summary().working
        ? startedAt() === undefined
          ? undefined
          : elapsed(clock() - startedAt()!)
        : summary().durationMs === undefined
          ? undefined
          : Locale.duration(summary().durationMs!),
    }),
  )
  const baseFg = createMemo(() => {
    if (hover()) return theme.text
    if (summary().working) return theme.text
    return theme.textMuted
  })

  const toggle = () => {
    if (renderer.getSelection()?.getSelectedText()) return
    ctx.toggleActivity(props.subID)
  }

  return (
    <box>
      <box onMouseOver={() => setHover(true)} onMouseOut={() => setHover(false)} onMouseUp={toggle}>
        <Switch>
          <Match when={summary().working}>
            <box flexDirection="row" gap={1}>
              <text fg={baseFg()} wrapMode="none">
                <span style={{ fg: baseFg() }}>{header().marker}</span>
              </text>
              <Spinner color={baseFg()}>
                {header().main}
                <Show when={header().failed}>
                  <span style={{ fg: theme.error }}> · {header().failed}</span>
                </Show>
              </Spinner>
            </box>
          </Match>
          <Match when={true}>
            <text fg={baseFg()} wrapMode="none">
              <span style={{ fg: baseFg() }}>{header().marker} </span>
              {header().main}
              <Show when={header().failed}>
                <span style={{ fg: theme.error }}> · {header().failed}</span>
              </Show>
              <Show when={header().note}>
                <span style={{ fg: theme.textMuted }}> · {header().note}</span>
              </Show>
            </text>
          </Match>
        </Switch>
      </box>
      <Show when={expanded()}>
        <For each={parts()}>{(item) => <ActivityGroupPartRow item={item} />}</For>
      </Show>
    </box>
  )
}

function ActivityGroupPartRow(props: { item: ActivityGroupPart }) {
  if (props.item.part.type === "reasoning") {
    return <ReasoningPart last={false} part={props.item.part} message={props.item.message} />
  }
  return <ToolPart last={false} part={props.item.part} message={props.item.message} />
}

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const renderer = createMemo(() => toolRenderer(props.part.tool))

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => shouldHideTool(props.part.tool, props.part.state.status, ctx.showDetails()))

  const toolprops = {
    get metadata() {
      return props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get tool() {
      return props.part.tool
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <Dynamic component={renderer()} {...toolprops} />
    </Show>
  )
}

type ToolProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: ToolPart
}
function GenericTool(props: ToolProps) {
  const { theme } = useTheme()
  const ctx = use()
  const output = createMemo(() => stripAnsi(props.output?.trim() ?? ""))
  const args = createMemo(() => Locale.truncate(input(props.input), Math.max(20, ctx.width - 12)))
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = 3
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return collapsed().output
  })

  return (
    <Show
      when={props.output && ctx.showGenericToolOutput()}
      fallback={
        <InlineTool icon="⚙" pending={`Preparing ${props.tool}...`} complete={true} part={props.part}>
          {props.tool} {args()}
        </InlineTool>
      }
    >
      <BlockTool
        title={`# ${props.tool} ${args()}`}
        part={props.part}
        onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
      >
        <box gap={1}>
          <text fg={theme.text}>{limited()}</text>
          <Show when={collapsed().overflow}>
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
          </Show>
        </box>
      </BlockTool>
    </Show>
  )
}

function Attachment(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  const [expanded, setExpanded] = createSignal(false)
  const action = createMemo(() => stringValue(props.input.action) ?? stringValue(props.metadata.action))
  const attachments = createMemo(() => parseAttachmentItems(props.metadata.attachments))
  const overflow = createMemo(() => attachments().length > COLLAPSED_TOOL_PREVIEW_LINES)
  const visible = createMemo(() =>
    expanded() || !overflow() ? attachments() : attachments().slice(0, COLLAPSED_TOOL_PREVIEW_LINES),
  )
  const target = createMemo(() => stringValue(props.metadata.resource) ?? stringValue(props.input.path))
  const title = createMemo(() => {
    if (action() === "save") {
      const path = target()
      if (props.part.state.status === "completed")
        return path ? `Saved attachment to ${pathFormatter.format(path)}` : "Saved attachment"
      return path ? `Save attachment to ${pathFormatter.format(path)}` : "Save attachment"
    }
    if (props.part.state.status !== "completed") return "List attachments"
    if (attachments().length === 0) return "No attachments"
    return `Listed ${attachments().length} attachment${attachments().length === 1 ? "" : "s"}`
  })
  const content = createMemo(() => {
    const rows = visible().map((item) => {
      const name = stripAnsi(item.name ?? item.mime)
      const type = item.name ? ` · ${item.mime}` : ""
      return `↳ ${name}${type}${item.unavailable ? " · unavailable" : ""}`
    })
    if (overflow())
      rows.push(
        `  ${expanded() ? "Click to collapse" : `Click to expand ${attachments().length - visible().length} more`}`,
      )
    return [title(), ...rows].join("\n")
  })
  const pending = createMemo(() => (action() === "save" ? "Saving attachment..." : "Listing attachments..."))

  return (
    <InlineTool
      icon="@"
      pending={pending()}
      failure="Attachment tool failed"
      complete={action() ?? props.part.state.status === "completed"}
      part={props.part}
      onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
    >
      {content()}
    </InlineTool>
  )
}

function Invalid(props: ToolProps) {
  const ctx = use()
  const { theme } = useTheme()
  const [expanded, setExpanded] = createSignal(false)
  const name = createMemo(() => stripAnsi(stringValue(props.input.tool)?.trim() ?? ""))
  const detail = createMemo(() => stripAnsi(stringValue(props.input.error)?.trim() || props.output?.trim() || ""))
  const collapsed = createMemo(() =>
    collapseToolOutput(
      detail(),
      COLLAPSED_TOOL_PREVIEW_LINES,
      COLLAPSED_TOOL_PREVIEW_LINES * Math.max(20, ctx.width - 6),
    ),
  )
  const visible = createMemo(() => (expanded() || !collapsed().overflow ? detail() : collapsed().output))
  const content = createMemo(() => {
    const title = name() ? `Invalid tool call: ${name()}` : "Invalid tool call"
    if (!visible()) return title
    return `${title}\n↳ ${visible()}${collapsed().overflow ? `\n  ${expanded() ? "Click to collapse" : "Click to expand"}` : ""}`
  })

  return (
    <InlineTool
      icon="✗"
      color={theme.error}
      pending="Validating tool call..."
      failure="Invalid tool call"
      complete={name() || props.part.state.status === "completed"}
      part={props.part}
      onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
    >
      {content()}
    </InlineTool>
  )
}

function Finish(props: ToolProps) {
  const ctx = use()
  const { theme } = useTheme()
  const result = createMemo(() => finishResult(props.input, props.output))
  // A completed review subagent delivers its report through a tagged
  // `<silvercode-review>` envelope in the finish result. Render that
  // structurally instead of dumping the raw JSON; only a completed part
  // qualifies, since a running finish can still be declined by the review
  // gate and must not pre-announce its verdict.
  const review = createMemo(() => (props.part.state.status === "completed" ? parseReviewReport(result()) : undefined))
  const [expanded, setExpanded] = createSignal(false)
  const [errorExpanded, setErrorExpanded] = createSignal(false)
  // The block shows the agent's own summary; the tool output also carries
  // runtime bookkeeping lines that are not part of what the agent said.
  const shown = createMemo(() => stringValue(props.input.result)?.trim() || result())
  const collapsed = createMemo(() =>
    collapseToolOutput(
      shown() ?? "",
      COLLAPSED_TOOL_PREVIEW_LINES,
      COLLAPSED_TOOL_PREVIEW_LINES * Math.max(20, ctx.width - 6),
    ),
  )
  const visible = createMemo(() => (expanded() || !collapsed().overflow ? shown() : collapsed().output))
  const view = createMemo(() => finishToolViewForPart(props.part, visible()))
  const block = createMemo(() => finishBlockView(props.part, props.input, visible()))
  const toggle = () => setExpanded((prev) => !prev)
  const toneColor = (tone: "success" | "waiting" | "failure") =>
    tone === "success" ? theme.success : tone === "waiting" ? theme.warning : theme.error

  return (
    <Show
      when={review()}
      fallback={
        <Switch>
          <Match when={block()?.tone === "quiet"}>
            <InlineToolRow
              icon="✕"
              color={theme.textMuted}
              errorColor={theme.textMuted}
              failed={true}
              complete={true}
              pending=""
              separate={false}
              error={props.part.state.status === "error" ? props.part.state.error : undefined}
              errorExpanded={errorExpanded()}
              onMouseUp={() => setErrorExpanded((prev) => !prev)}
            >
              Finish call failed
            </InlineToolRow>
          </Match>
          <Match when={block()}>
            {(item) => (
              <FinishBlock
                color={toneColor(item().tone as "success" | "waiting" | "failure")}
                title={item().title}
                detail={item().detail}
                hint={collapsed().overflow ? (expanded() ? "Click to collapse" : "Click to expand") : undefined}
                onClick={collapsed().overflow ? toggle : undefined}
              />
            )}
          </Match>
          <Match when={true}>
            <InlineTool
              icon={view().icon}
              pending={view().pending}
              complete={view().complete}
              spinner={view().spinner}
              failure={view().failure}
              separate={true}
              part={props.part}
            >
              {view().children}
            </InlineTool>
          </Match>
        </Switch>
      }
    >
      {(item) => <ReviewFinish review={item()} part={props.part} />}
    </Show>
  )
}

/** Blend `color` over `base` so a block gets a dark tint of its own hue. */
export function tintColor(color: RGBA, base: RGBA, amount: number) {
  return RGBA.fromValues(
    base.r + (color.r - base.r) * amount,
    base.g + (color.g - base.g) * amount,
    base.b + (color.b - base.b) * amount,
    base.a,
  )
}

function FinishBlock(props: { color: RGBA; title: string; detail?: string; hint?: string; onClick?: () => void }) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  return (
    <box
      ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      marginTop={1}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={props.color}
      backgroundColor={tintColor(props.color, theme.backgroundPanel, 0.14)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <text fg={props.color} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
      <Show when={props.detail}>
        <text fg={props.color}>{`↳ ${props.detail}`}</text>
      </Show>
      <Show when={props.hint}>
        <text fg={props.color}>{props.hint}</text>
      </Show>
    </box>
  )
}

/**
 * How a finished finish call is shown. A failed tool call is a quiet one-line
 * row; the colored blocks follow the reason the agent declared. Pending and
 * running calls keep the spinner row (no block).
 */
export function finishBlockView(part: ToolPart, input: Record<string, unknown>, result?: string) {
  if (part.state.status === "error") return { tone: "quiet" as const, title: "Finish call failed", detail: undefined }
  if (part.state.status !== "completed") return undefined
  const reason = stringValue(input.reason)
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  const waiting =
    metadata?.waiting === true || reason === "waiting_for_subagent" || reason === "subagent_wait"
  if (waiting) return { tone: "waiting" as const, title: `${WAITING_ICON} ${WAITING_LABEL}`, detail: result }
  if (reason === "failure") return { tone: "failure" as const, title: "✗ Task failed", detail: result }
  if (reason !== undefined && reason !== "success")
    return { tone: "waiting" as const, title: `◌ Finish: ${reason}`, detail: result }
  return { tone: "success" as const, title: "✓ Task completed", detail: result }
}

type FinishToolStatus = ToolPart["state"]["status"]

const WAITING_LABEL = "Waiting for subagent execution..."
const WAITING_ICON = "◌"

export function finishResult(input: Record<string, unknown>, output?: string) {
  return (output?.trim() || stringValue(input.result)?.trim() || undefined) ?? undefined
}

/**
 * The part-to-view mapping, kept separate from the component so the wiring is
 * testable without mounting the route. The wait flag and the effort status come
 * from the completed part's metadata, so they are only stamped on a settled call.
 */
export function finishToolViewForPart(part: ToolPart, result?: string) {
  return finishToolView(
    part.state.status,
    result,
    part.state.status === "completed" && "metadata" in part.state ? part.state.metadata : undefined,
  )
}

export function finishToolView(
  status: FinishToolStatus,
  result?: string,
  // A boolean is the #233 `waiting` flag; an object is the completed part's metadata.
  metadataOrWaiting?: Record<string, unknown> | boolean,
) {
  const metadata = typeof metadataOrWaiting === "boolean" ? { waiting: metadataOrWaiting } : metadataOrWaiting
  // A wait is not a completion: the agent yielded the turn while the background
  // subagents it launched still run, so the block must not read as done. The
  // waiting state is a paused icon, not the check the completed finish uses.
  const waiting = metadata?.waiting === true
  const completed = waiting ? WAITING_LABEL : "Task completed"
  if (status === "pending") {
    return {
      icon: "✓",
      pending: "Completing task...",
      complete: false,
      spinner: false,
      failure: "Finish failed",
      children: "Task completion",
    }
  }
  if (status === "running") {
    return {
      icon: "✓",
      pending: "Completing task...",
      complete: false,
      spinner: true,
      failure: "Finish failed",
      children: "Completing task...",
    }
  }
  const summary = result ? `${completed}\n↳ ${result}` : completed
  return {
    icon: waiting ? WAITING_ICON : "✓",
    pending: "Completing task...",
    complete: status === "completed",
    spinner: false,
    failure: "Finish failed",
    children: summary,
  }
}

/**
 * Parse a finish result into the review report it carries, when it does.
 * Detection reuses the runtime's canonical extractor (`ReviewReport.extract`)
 * instead of re-parsing the envelope ad hoc, so the display cannot drift from
 * the delivery protocol: only a complete, version-1 `<silvercode-review>`
 * envelope resolves to a report, and the surrounding text is returned as the
 * human-readable analysis. Anything else — a plain finish, a truncated or
 * malformed envelope — stays a plain finish result.
 */
export function parseReviewReport(result: string | undefined) {
  if (!result) return undefined
  const delivery = ReviewReport.extract([result])
  return delivery.ok ? { report: delivery.report, analysis: delivery.analysis } : undefined
}

const REVIEW_SEVERITY_ORDER: Record<ReviewReport.Finding["severity"], number> = {
  critical: 0,
  important: 1,
  minor: 2,
}

/** Review findings ordered by severity (critical, important, minor), stably. */
export function sortReviewFindings(findings: readonly ReviewReport.Finding[]) {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        REVIEW_SEVERITY_ORDER[a.finding.severity] - REVIEW_SEVERITY_ORDER[b.finding.severity] || a.index - b.index,
    )
    .map((entry) => entry.finding)
}

/**
 * The `file:line` locator for a finding, when the report names a file.
 * A line without a file would render as a bare `:42`, so it is dropped.
 */
export function reviewFindingLocation(finding: ReviewReport.Finding): string | undefined {
  const file = finding.file?.trim()
  if (!file) return undefined
  const line =
    finding.line !== undefined && Number.isInteger(finding.line) && finding.line > 0 ? `:${finding.line}` : ""
  return file + line
}

function ReviewFinish(props: { review: { report: ReviewReport.Info; analysis: string }; part: ToolPart }) {
  const { theme } = useTheme()
  const ctx = use()
  const [expanded, setExpanded] = createSignal(false)
  const [rawOpen, setRawOpen] = createSignal(false)

  // Read props.review through memos: the finish result (and therefore the
  // extracted report) can change while the component stays mounted, e.g.
  // when the part is updated in place. Plain consts would capture the first
  // report and keep rendering stale data under the unkeyed <Show> in Finish.
  const report = createMemo(() => props.review.report)
  const approved = createMemo(() => report().assessment === "approved")
  const findings = createMemo(() => sortReviewFindings(report().findings))
  const analysis = createMemo(() => props.review.analysis.trim())
  const analysisCollapsed = createMemo(() =>
    collapseToolOutput(
      analysis(),
      COLLAPSED_TOOL_PREVIEW_LINES,
      COLLAPSED_TOOL_PREVIEW_LINES * Math.max(20, ctx.width - 6),
    ),
  )
  const expandable = createMemo(() =>
    analysisCollapsed().overflow || findings().some((finding) => (finding.detail ?? "").trim() !== ""),
  )
  // The envelope is stripped from the default view; the exact canonical
  // JSON stays reachable on demand, re-serialized the same way the runtime
  // delivers it to the parent agent.
  const rawReport = createMemo(() => capOutputLines(ReviewReport.envelope(report())))
  const revision = createMemo(() => (report().revision ? Locale.truncateMiddle(report().revision, 24) : undefined))

  const severityColor = (severity: ReviewReport.Finding["severity"]) =>
    severity === "critical" ? theme.error : severity === "important" ? theme.warning : theme.textMuted

  return (
    <>
      <BlockTool
        title={"# Review" + (revision() ? ` · ${revision()}` : "")}
        part={props.part}
        onClick={expandable() ? () => setExpanded((prev) => !prev) : undefined}
      >
        <box gap={1}>
          <text fg={theme.text}>
            <span style={{ fg: approved() ? theme.success : theme.error, bold: true }}>
              {approved() ? "✓ Approved" : "✗ Needs fixes"}
            </span>
            <Show when={findings().length > 0}>
              <span style={{ fg: theme.textMuted }}>
                {" · "}{findings().length} finding{findings().length === 1 ? "" : "s"}
              </span>
            </Show>
          </text>
          <text fg={theme.text}>{report().summary}</text>
          <Show when={analysis()}>
            <text fg={theme.text}>
              {expanded() || !analysisCollapsed().overflow ? analysis() : analysisCollapsed().output}
            </text>
          </Show>
          <Show when={findings().length > 0}>
            <box>
              <For each={findings()}>
                {(finding) => {
                  const loc = reviewFindingLocation(finding)
                  return (
                    <>
                      <text fg={theme.text}>
                        {"↳ "}
                        <span style={{ fg: severityColor(finding.severity), bold: true }}>{finding.severity}</span>
                        {" · "}{finding.title}
                        {loc ? ` (${loc})` : ""}
                      </text>
                      <Show when={expanded() && (finding.detail ?? "").trim() !== ""}>
                        <text fg={theme.text}>
                          {"   ↳ "}{finding.detail}
                        </text>
                      </Show>
                    </>
                  )
                }}
              </For>
            </box>
          </Show>
          <Show when={expandable()}>
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
          </Show>
        </box>
      </BlockTool>
      <InlineTool
        icon="⚙"
        pending="Preparing review report..."
        complete={true}
        part={props.part}
        onClick={() => setRawOpen((prev) => !prev)}
      >
        {rawOpen() ? "Click to hide the raw report" : "Raw review report"}
      </InlineTool>
      <Show when={rawOpen()}>
        <box paddingLeft={5}>
          <text fg={theme.textMuted}>{rawReport()}</text>
        </box>
      </Show>
    </>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  separate?: boolean
  children: JSX.Element
  part: ToolPart
  onClick?: () => void
}) {
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const [errorExpanded, setErrorExpanded] = createSignal(false)

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))
  const outcome = createMemo(() => toolPartOutcome(props.part))
  const denied = createMemo(() => outcome() === "denied")
  const interrupted = createMemo(() => outcome() === "interrupted")
  const failed = createMemo(() => outcome() === "error")
  const clickable = createMemo(() => Boolean(props.onClick || failed()))
  const state = createMemo(() => inlineToolState(props.part.state.status, props.complete, props.spinner))
  const fg = createMemo(() => {
    if (props.color) return props.color
    if (permission()) return theme.warning
    if (failed()) return theme.error
    if (hover() && props.onClick) return theme.text
    if (state().complete || interrupted()) return theme.textMuted
    return theme.text
  })

  return (
    <InlineToolRow
      icon={props.icon}
      iconColor={props.iconColor}
      color={fg()}
      errorColor={theme.error}
      failed={failed()}
      denied={Boolean(denied())}
      interrupted={Boolean(interrupted())}
      error={error()}
      errorExpanded={errorExpanded()}
      complete={state().complete}
      pending={props.pending}
      failure={props.failure}
      spinner={state().spinner}
      separate={props.separate}
      onMouseOver={() => clickable() && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        if (failed()) {
          setErrorExpanded((value) => !value)
          return
        }
        props.onClick?.()
      }}
    >
      {props.children}
    </InlineToolRow>
  )
}

export function inlineToolState(status: ToolPart["state"]["status"], complete: unknown, spinner?: boolean) {
  return {
    complete: status === "completed" ? true : false,
    spinner: spinner ?? status === "running",
  }
}

export function InlineToolRow(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  errorColor?: RGBA
  failed?: boolean
  denied?: boolean
  interrupted?: boolean
  error?: string
  errorExpanded?: boolean
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  separate?: boolean
  children: JSX.Element
  onMouseOver?: () => void
  onMouseOut?: () => void
  onMouseUp?: () => void
}) {
  return (
    <box
      paddingLeft={3}
      onMouseOver={props.onMouseOver}
      onMouseOut={props.onMouseOut}
      onMouseUp={props.onMouseUp}
      ref={(el: BoxRenderable) => {
        if (props.separate) alwaysSeparate.add(el)
        setPreLayoutSiblingMargin(el, (previous) => {
          return props.separate ||
            (previous instanceof BoxRenderable && (previous.height > 1 || alwaysSeparate.has(previous)))
            ? 1
            : 0
        })
      }}
    >
      <Switch>
        <Match when={props.spinner}>
          <Spinner color={props.color} children={props.children} />
        </Match>
        <Match when={true}>
          <Show
            fallback={
              <text
                paddingLeft={3}
                fg={props.color}
                attributes={props.denied || props.interrupted ? TextAttributes.STRIKETHROUGH : undefined}
              >
                ~ {props.pending}
              </text>
            }
            when={props.complete || props.failed || props.denied || props.interrupted}
          >
            <box flexDirection="row">
              <text
                width={INLINE_TOOL_ICON_WIDTH}
                fg={props.failed ? props.errorColor : (props.iconColor ?? props.color)}
                attributes={props.denied || props.interrupted ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.icon}
              </text>
              <text
                flexGrow={1}
                fg={props.failed ? props.errorColor : props.color}
                attributes={props.denied || props.interrupted ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.failed && !props.complete ? (props.failure ?? props.children) : props.children}
                <Show when={props.interrupted}> (interrupted)</Show>
              </text>
            </box>
          </Show>
        </Match>
      </Switch>
      <Show when={props.failed && props.errorExpanded}>
        <box paddingLeft={INLINE_TOOL_ICON_WIDTH}>
          <text fg={props.errorColor}>{props.error}</text>
        </box>
      </Show>
    </box>
  )
}

function BlockTool(props: {
  title?: string
  children: JSX.Element
  onClick?: () => void
  part?: ToolPart
  spinner?: boolean
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  return (
    <box
      ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.background}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show when={props.title}>
        {(title) => (
          <Show
            when={props.spinner}
            fallback={
              <text paddingLeft={3} fg={theme.textMuted}>
                {title()}
              </text>
            }
          >
            <Spinner color={theme.textMuted}>{title().replace(/^# /, "")}</Spinner>
          </Show>
        )}
      </Show>
      {props.children}
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

function Shell(props: ToolProps) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const ctx = use()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const output = createMemo(() => stripAnsi(stringValue(props.metadata.output)?.trim() ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = COLLAPSED_TOOL_PREVIEW_LINES
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  // Cap pathological individual lines (minified JSON, base64 blobs, one-line
  // stack traces): the collapsed-preview char budget only bounds the collapsed
  // view, and the <text> render wraps long lines instead of clipping them like
  // the write renderer does — so expanded output with an uncapped long line
  // floods/jitters the viewport. Capping applies in both states.
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return capOutputLines(output())
    return capOutputLines(collapsed().output)
  })

  const workdirDisplay = createMemo(() => {
    const workdir = stringValue(props.input.workdir)
    if (!workdir || workdir === ".") return undefined
    const formatted = pathFormatter.format(workdir)
    if (formatted === ".") return undefined
    return formatted
  })

  const title = createMemo(() => {
    const wd = workdirDisplay()
    if (!wd) return
    return `# Running in ${wd}`
  })

  return (
    <Switch>
      <Match when={stringValue(props.metadata.output) !== undefined}>
        <BlockTool
          title={title()}
          part={props.part}
          onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box gap={1}>
            <Show when={isRunning()} fallback={<text fg={theme.text}>$ {stringValue(props.input.command)}</text>}>
              <Spinner color={theme.text}>{stringValue(props.input.command)}</Spinner>
            </Show>
            <Show when={output()}>
              <text fg={theme.text}>{limited()}</text>
            </Show>
            <Show when={collapsed().overflow}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command..." complete={stringValue(props.input.command)} part={props.part}>
          {stringValue(props.input.command)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Write(props: ToolProps) {
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  const code = createMemo(() => {
    return stringValue(props.input.content) ?? ""
  })
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => code().split("\n"))
  const overflow = createMemo(() => lines().length > COLLAPSED_TOOL_PREVIEW_LINES)
  const visible = createMemo(() =>
    expanded() || !overflow() ? code() : lines().slice(0, COLLAPSED_TOOL_PREVIEW_LINES).join("\n"),
  )

  return (
    <Switch>
      <Match when={props.metadata.diagnostics !== undefined}>
        <BlockTool
          title={"# Wrote " + pathFormatter.format(stringValue(props.input.filePath))}
          part={props.part}
          onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
        >
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(stringValue(props.input.filePath))}
              syntaxStyle={syntax()}
              content={visible()}
            />
          </line_number>
          <Show when={overflow()}>
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
          </Show>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={stringValue(props.input.filePath) ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="←"
          pending="Preparing write..."
          complete={stringValue(props.input.filePath)}
          part={props.part}
        >
          Write {pathFormatter.format(stringValue(props.input.filePath))}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Finding files..." complete={stringValue(props.input.pattern)} part={props.part}>
      Glob "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.count)}>
        ({numberValue(props.metadata.count)} {numberValue(props.metadata.count) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function Read(props: ToolProps) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    if (props.part.state.time.compacted) return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool
        icon="→"
        pending="Reading file..."
        complete={stringValue(props.input.filePath)}
        spinner={isRunning()}
        part={props.part}
      >
        Read {pathFormatter.format(stringValue(props.input.filePath))} {input(props.input, ["filePath"])}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Loaded {pathFormatter.format(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Searching content..." complete={stringValue(props.input.pattern)} part={props.part}>
      Grep "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.matches)}>
        ({numberValue(props.metadata.matches)} {numberValue(props.metadata.matches) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps) {
  return (
    <InlineTool icon="%" pending="Fetching from the web..." complete={stringValue(props.input.url)} part={props.part}>
      WebFetch {stringValue(props.input.url)}
    </InlineTool>
  )
}

function WebSearch(props: ToolProps) {
  return (
    <InlineTool icon="◈" pending="Searching web..." complete={stringValue(props.input.query)} part={props.part}>
      {webSearchProviderLabel(props.metadata.provider)} "{stringValue(props.input.query)}"{" "}
      <Show when={numberValue(props.metadata.numResults)}>({numberValue(props.metadata.numResults)} results)</Show>
    </InlineTool>
  )
}

function McpResource(props: ToolProps) {
  const ctx = use()
  const server = createMemo(() => stringValue(props.input.server) ?? stringValue(props.metadata.server))
  const uri = createMemo(() => stringValue(props.input.uri) ?? stringValue(props.metadata.uri))
  const count = createMemo(() => numberValue(props.metadata.count))
  const read = props.tool === "read_mcp_resource"
  const templates = props.tool === "list_mcp_resource_templates"
  const content = createMemo(() => {
    if (read) {
      const location = [uri(), server() ? `from ${server()}` : undefined].filter(Boolean).join(" ")
      const contents = numberValue(props.metadata.contents)
      const attachments = numberValue(props.metadata.attachments)
      const detail = [
        contents !== undefined ? `${contents} content${contents === 1 ? "" : "s"}` : undefined,
        attachments ? `${attachments} attachment${attachments === 1 ? "" : "s"}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ")
      return `${location ? `Read MCP resource ${location}` : "Read MCP resource"}${detail ? ` (${detail})` : ""}`
    }
    const label = templates ? "MCP resource templates" : "MCP resources"
    const location = server() ? ` from ${server()}` : ""
    const total = count()
    return `${label}${location}${total === undefined ? "" : ` (${total} found)`}`
  })
  const label = createMemo(() => Locale.truncate(content(), Math.max(20, ctx.width - 8)))

  return (
    <InlineTool
      icon={read ? "→" : "✱"}
      pending={
        read ? "Reading MCP resource..." : templates ? "Listing MCP resource templates..." : "Listing MCP resources..."
      }
      complete={read ? uri() : true}
      part={props.part}
    >
      {label()}
    </InlineTool>
  )
}

function Task(props: ToolProps) {
  const { theme } = useTheme()
  const { navigate } = useRoute()
  const sync = useSync()
  const dialog = useDialog()

  onMount(() => {
    const sessionID = stringValue(props.metadata.sessionId)
    if (sessionID && !sync.data.message[sessionID]?.length) void sync.session.sync(sessionID)
  })

  const sessionID = createMemo(() => stringValue(props.metadata.sessionId))
  const messages = createMemo(() => sync.data.message[sessionID() ?? ""] ?? [])

  const tools = createMemo(() => {
    return messages().flatMap((msg) =>
      (sync.data.part[msg.id] ?? [])
        .filter((part): part is ToolPart => part.type === "tool")
        .map((part) => ({ tool: part.tool, state: part.state })),
    )
  })

  const current = createMemo(() =>
    tools().findLast((x) => (x.state.status === "running" || x.state.status === "completed") && x.state.title),
  )

  const status = createMemo(() => sync.data.session_status[sessionID() ?? ""])
  const isRunning = createMemo(() => {
    const value = status()
    return (
      props.part.state.status === "running" ||
      (props.metadata.background === true && value !== undefined && value.type !== "idle")
    )
  })
  const retry = createMemo(() => {
    const value = status()
    if (value?.type !== "retry") return
    return value
  })

  const duration = createMemo(() => {
    const first = messages().find((x) => x.role === "user")?.time.created
    const assistant = messages().findLast((x) => x.role === "assistant")?.time.completed
    if (!first || !assistant) return 0
    return assistant - first
  })

  const content = createMemo(() => {
    const description = stringValue(props.input.description)
    if (!description) return ""
    let content = [
      formatSubagentTitle(
        Locale.titlecase(stringValue(props.input.subagent_type) ?? "General"),
        description,
        props.metadata.background === true,
      ),
    ]

    const retrying = retry()
    if (isRunning() && retrying) {
      content.push(`↳ ${formatSubagentRetry(retrying.attempt, Locale.truncate(retrying.message, 80))}`)
    } else if (isRunning() && tools().length > 0) {
      if (current()) {
        const state = current()!.state
        const title = state.status === "running" || state.status === "completed" ? state.title : undefined
        content.push(`↳ ${Locale.titlecase(current()!.tool)} ${title}`)
      } else content.push(`↳ ${formatSubagentToolcalls(tools().length)}`)
    }

    if (!isRunning() && props.part.state.status === "completed") {
      content.push(`↳ ${formatCompletedSubagentDetail(tools().length, Locale.duration(duration()))}`)
    }

    return content.join("\n")
  })

  return (
    <InlineTool
      icon={props.part.state.status === "completed" ? "✓" : "│"}
      separate={true}
      color={retry() ? theme.error : undefined}
      spinner={isRunning()}
      complete={stringValue(props.input.description)}
      pending="Delegating..."
      part={props.part}
      onClick={() => {
        if (sessionID()) {
          navigate({ type: "session", sessionID: sessionID()! })
        }
        const status = retry()
        if (status) void DialogAlert.show(dialog, "Retry Error", status.message)
      }}
    >
      {content()}
    </InlineTool>
  )
}

export function formatSubagentToolcalls(count: number) {
  return `${count} toolcall${count === 1 ? "" : "s"}`
}

export function formatSubagentTitle(agent: string, description: string, background: boolean) {
  return `${agent} Task${background ? " (background)" : ""} — ${description}`
}

export function formatSubagentRetry(attempt: number, message: string) {
  return `Retrying (attempt ${attempt}) · ${message}`
}

export function formatCompletedSubagentDetail(toolcalls: number, duration: string) {
  if (toolcalls === 0) return duration
  return `${formatSubagentToolcalls(toolcalls)} · ${duration}`
}

type ExecuteCall = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

function executeCalls(value: unknown): ExecuteCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((call) => {
    const item = recordValue(call)
    const tool = stringValue(item?.tool)
    const status = stringValue(item?.status)
    if (!tool || !status || !["running", "completed", "error"].includes(status)) return []
    return [{ tool, status: status as ExecuteCall["status"], input: recordValue(item?.input) }]
  })
}

// The `execute` tool streams child tool calls through metadata, not a child session like Task.
function Execute(props: ToolProps) {
  const ctx = use()
  const { theme } = useTheme()
  const isLoading = createMemo(() => props.part.state.status === "pending" || props.part.state.status === "running")
  const calls = createMemo(() => executeCalls(props.metadata.toolCalls))
  const output = createMemo(() => stripAnsi(props.output?.trim() ?? ""))
  const hasRuntimeError = createMemo(() => props.metadata.error === true)
  const outputPreview = createMemo(() => collapseToolOutput(output(), 4, 4 * Math.max(20, ctx.width - 6)).output)
  const showOutput = createMemo(() => output() && hasRuntimeError())
  const content = createMemo(() => {
    const lines = ["execute"]
    for (const call of calls()) {
      const args = Locale.truncate(input(call.input ?? {}), Math.max(20, ctx.width - 12))
      lines.push(`↳ ${call.tool}${args ? ` ${args}` : ""}${call.status === "error" ? " (failed)" : ""}`)
    }
    return lines.join("\n")
  })

  return (
    <>
      <InlineTool
        icon={hasRuntimeError() ? "✗" : props.part.state.status === "completed" ? "✓" : "│"}
        color={hasRuntimeError() ? theme.error : undefined}
        spinner={isLoading()}
        pending="execute"
        complete={true}
        part={props.part}
      >
        {content()}
      </InlineTool>
      <Show when={showOutput()}>
        <box paddingLeft={3}>
          <For each={outputPreview().split("\n")}>
            {(line, index) => (
              <text paddingLeft={3} fg={theme.error}>
                {index() === 0 ? "↳ " : "  "}
                {line}
              </text>
            )}
          </For>
        </box>
      </Show>
    </>
  )
}

function ToolSearch(props: ToolProps) {
  const regex = props.tool === "tool_search_regex"
  const [expanded, setExpanded] = createSignal(false)
  const query = createMemo(() => stringValue(regex ? props.input.pattern : props.input.query))
  const count = createMemo(() => numberValue(props.metadata.count))
  const tools = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    const value = props.metadata.tools
    if (!Array.isArray(value)) return []
    return value.filter((tool): tool is string => typeof tool === "string")
  })
  const overflow = createMemo(() => tools().length > COLLAPSED_TOOL_PREVIEW_LINES)
  const visible = createMemo(() =>
    expanded() || !overflow() ? tools() : tools().slice(0, COLLAPSED_TOOL_PREVIEW_LINES),
  )
  const content = createMemo(() => {
    const result =
      props.part.state.status === "completed" ? formatToolSearchResult(count(), props.part.state.title) : undefined
    const title = `Tool search ${regex ? `/${query()}` : `"${query()}"`}${result ? ` (${result})` : ""}`
    const rows = visible().map((tool) => `↳ Loaded ${tool}`)
    if (overflow())
      rows.push(`  ${expanded() ? "Click to collapse" : `Click to expand ${tools().length - visible().length} more`}`)
    return [title, ...rows].join("\n")
  })

  return (
    <InlineTool
      icon="?"
      pending="Searching tools..."
      complete={query()}
      part={props.part}
      onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
    >
      {content()}
    </InlineTool>
  )
}

export function formatToolSearchResult(count: number | undefined, title: string) {
  if (title === "Invalid regex") return "invalid regex"
  if (title === "No tools found") return "no tools found"
  if (title === "Already available") return "already available"
  return count === undefined ? undefined : `${count} ${count === 1 ? "tool found" : "tools found"}`
}

const lspOperationLabels: Record<string, string> = {
  goToDefinition: "Go to definition",
  findReferences: "Find references",
  hover: "Hover",
  documentSymbol: "Document symbols",
  workspaceSymbol: "Workspace symbols",
  goToImplementation: "Go to implementation",
  prepareCallHierarchy: "Prepare call hierarchy",
  incomingCalls: "Incoming calls",
  outgoingCalls: "Outgoing calls",
}

function Lsp(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  const operation = createMemo(() => {
    const value = stringValue(props.input.operation)
    if (!value) return undefined
    return lspOperationLabels[value] ?? value
  })
  const location = createMemo(() => {
    const filePath = stringValue(props.input.filePath)
    if (!filePath) return ""
    const line = numberValue(props.input.line)
    const character = numberValue(props.input.character)
    const position = line !== undefined ? `:${line}${character !== undefined ? `:${character}` : ""}` : ""
    return `${pathFormatter.format(filePath)}${position}`
  })

  return (
    <InlineTool
      icon="◎"
      pending="Running LSP operation..."
      complete={stringValue(props.input.operation)}
      part={props.part}
    >
      LSP {operation() ?? "operation"}
      <Show when={location()}> {location()}</Show>
    </InlineTool>
  )
}

function PlanExit(props: ToolProps) {
  const declined = createMemo(() => props.part.state.status === "error")
  return (
    <InlineTool icon="✓" pending="Requesting plan approval..." complete={true} part={props.part}>
      {declined() ? "Plan approval declined — staying with the Think agent" : "Plan complete — switching to Work agent"}
    </InlineTool>
  )
}

function Edit(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  const [expanded, setExpanded] = createSignal(false)

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(stringValue(props.input.filePath)))

  const diffContent = createMemo(() => stringValue(props.metadata.diff) ?? "")
  const collapsed = createMemo(() => collapseDiff(diffContent(), COLLAPSED_TOOL_PREVIEW_LINES))
  const visible = createMemo(() => (expanded() || !collapsed().overflow ? diffContent() : collapsed().diff))

  return (
    <Switch>
      <Match when={stringValue(props.metadata.diff) !== undefined}>
        <BlockTool
          title={"← Edit " + pathFormatter.format(stringValue(props.input.filePath))}
          part={props.part}
          onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box paddingLeft={1}>
            <diff
              diff={visible()}
              view={view()}
              filetype={ft()}
              syntaxStyle={syntax()}
              showLineNumbers={true}
              width="100%"
              wrapMode={ctx.diffWrapMode()}
              fg={theme.text}
              addedBg={theme.diffAddedBg}
              removedBg={theme.diffRemovedBg}
              contextBg={theme.diffContextBg}
              addedSignColor={theme.diffHighlightAdded}
              removedSignColor={theme.diffHighlightRemoved}
              lineNumberFg={theme.diffLineNumber}
              lineNumberBg={theme.diffContextBg}
              addedLineNumberBg={theme.diffAddedLineNumberBg}
              removedLineNumberBg={theme.diffRemovedLineNumberBg}
            />
          </box>
          <Show when={collapsed().overflow}>
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
          </Show>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={stringValue(props.input.filePath) ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing edit..." complete={stringValue(props.input.filePath)} part={props.part}>
          Edit {pathFormatter.format(stringValue(props.input.filePath))} {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()

  const files = createMemo(() => parseApplyPatchFiles(props.metadata.files))

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

  function Diff(p: { diff: string; filePath: string }) {
    return (
      <box paddingLeft={1}>
        <diff
          diff={p.diff}
          view={view()}
          filetype={filetype(p.filePath)}
          syntaxStyle={syntax()}
          showLineNumbers={true}
          width="100%"
          wrapMode={ctx.diffWrapMode()}
          fg={theme.text}
          addedBg={theme.diffAddedBg}
          removedBg={theme.diffRemovedBg}
          contextBg={theme.diffContextBg}
          addedSignColor={theme.diffHighlightAdded}
          removedSignColor={theme.diffHighlightRemoved}
          lineNumberFg={theme.diffLineNumber}
          lineNumberBg={theme.diffContextBg}
          addedLineNumberBg={theme.diffAddedLineNumberBg}
          removedLineNumberBg={theme.diffRemovedLineNumberBg}
        />
      </box>
    )
  }

  function title(file: ApplyPatchFile) {
    if (file.type === "delete") return "# Deleted " + file.relativePath
    if (file.type === "add") return "# Created " + file.relativePath
    if (file.type === "move") return "# Moved " + pathFormatter.format(file.filePath) + " → " + file.relativePath
    return "← Patched " + file.relativePath
  }

  function FilePatch(p: { file: ApplyPatchFile }) {
    const [expanded, setExpanded] = createSignal(false)
    const collapsed = createMemo(() => collapseDiff(p.file.patch, COLLAPSED_TOOL_PREVIEW_LINES))
    const visible = createMemo(() => (expanded() || !collapsed().overflow ? p.file.patch : collapsed().diff))

    return (
      <BlockTool
        title={title(p.file)}
        part={props.part}
        onClick={p.file.type !== "delete" && collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
      >
        <Show
          when={p.file.type !== "delete"}
          fallback={
            <text fg={theme.diffRemoved}>
              -{p.file.deletions} line{p.file.deletions !== 1 ? "s" : ""}
            </text>
          }
        >
          <Diff diff={visible()} filePath={p.file.filePath} />
          <Show when={collapsed().overflow}>
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
          </Show>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={p.file.movePath ?? p.file.filePath} />
        </Show>
      </BlockTool>
    )
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>{(file) => <FilePatch file={file} />}</For>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Preparing patch..." failure="Patch failed" complete={false} part={props.part}>
          Patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

type ApplyPatchFile = ReturnType<typeof parseApplyPatchFiles>[number]

function TodoWrite(props: ToolProps) {
  const { theme } = useTheme()
  const todos = createMemo(() => parseTodos(props.input.todos))
  return (
    <Switch>
      <Match when={props.metadata.todos !== undefined}>
        <BlockTool title="# Todos" part={props.part}>
          <Show when={todos().length > 0} fallback={<text fg={theme.textMuted}>No todos</text>}>
            <box>
              <For each={todos()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
            </box>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="⚙"
          pending="Updating todos..."
          failure="Todo update failed"
          complete={false}
          part={props.part}
        >
          Updating todos...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps) {
  const { theme } = useTheme()
  const questions = createMemo(() => parseQuestions(props.input.questions))
  const answers = createMemo(() => parseQuestionAnswers(props.metadata.answers))
  const count = createMemo(() => questions().length)

  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={answers()}>
        <BlockTool title="# Questions" part={props.part}>
          <Show when={questions().length > 0} fallback={<text fg={theme.textMuted}>No questions</text>}>
            <box gap={1}>
              <For each={questions()}>
                {(q, i) => (
                  <box flexDirection="column">
                    <text fg={theme.textMuted}>{q.question}</text>
                    <text fg={theme.text}>{format(answers()?.[i()])}</text>
                  </box>
                )}
              </For>
            </box>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps) {
  return (
    <InlineTool icon="→" pending="Loading skill..." complete={stringValue(props.input.name)} part={props.part}>
      Skill "{stringValue(props.input.name)}"
    </InlineTool>
  )
}

function Diagnostics(props: { diagnostics: unknown; filePath: string }) {
  const { theme } = useTheme()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const errors = createMemo(() => {
    const normalized = normalizePath(
      typeof props.filePath === "string" ? props.filePath : "",
      terminalEnvironment.platform,
    )
    return parseDiagnostics(props.diagnostics, normalized)
  })

  return (
    <Show when={errors().length}>
      <box>
        <For each={errors()}>
          {(diagnostic) => (
            <text fg={theme.error}>
              Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function input(input: Record<string, unknown>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

type NativeToolRenderer = (props: ToolProps) => JSX.Element

export function shouldHideTool(tool: string, status: ToolPart["state"]["status"], showDetails: boolean) {
  if (showDetails) return false
  if (status !== "completed") return false
  return tool !== "finish"
}

const nativeToolRenderers = {
  invalid: Invalid,
  attachment: Attachment,
  list_mcp_resources: McpResource,
  list_mcp_resource_templates: McpResource,
  read_mcp_resource: McpResource,
  bash: Shell,
  glob: Glob,
  read: Read,
  grep: Grep,
  webfetch: WebFetch,
  websearch: WebSearch,
  write: Write,
  edit: Edit,
  task: Task,
  apply_patch: ApplyPatch,
  todowrite: TodoWrite,
  question: Question,
  skill: Skill,
  execute: Execute,
  tool_search: ToolSearch,
  tool_search_regex: ToolSearch,
  lsp: Lsp,
  plan_exit: PlanExit,
  finish: Finish,
} satisfies Record<string, NativeToolRenderer>

export function toolRenderer(tool: string): NativeToolRenderer {
  return nativeToolRenderers[tool as keyof typeof nativeToolRenderers] ?? GenericTool
}

export function toolDisplay(tool: string) {
  return tool in nativeToolRenderers ? tool : "generic"
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

export function parseAttachmentItems(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const attachment = recordValue(item)
    const mime = stringValue(attachment?.mime)
    if (!mime) return []
    return [
      {
        name: stringValue(attachment?.name),
        mime,
        unavailable: attachment?.unavailable === true,
      },
    ]
  })
}

export function parseApplyPatchFiles(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const file = recordValue(item)
    if (!file) return []
    const type = stringValue(file.type)
    const relativePath = stringValue(file.relativePath)
    const filePath = stringValue(file.filePath)
    const patch = stringValue(file.patch)
    const deletions = numberValue(file.deletions)
    if (!type || !relativePath || !filePath || patch === undefined || deletions === undefined) return []
    return [{ type, relativePath, filePath, patch, deletions, movePath: stringValue(file.movePath) }]
  })
}

export function parseTodos(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const todo = recordValue(item)
    const status = stringValue(todo?.status)
    const content = stringValue(todo?.content)
    return status && content ? [{ status, content }] : []
  })
}

export function parseQuestions(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const question = stringValue(recordValue(item)?.question)
    return question ? [{ question }] : []
  })
}

export function parseQuestionAnswers(value: unknown) {
  if (!Array.isArray(value)) return
  return value.map((answer) =>
    Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : [],
  )
}

export function parseDiagnostics(value: unknown, filePath: string) {
  const diagnostics = recordValue(value)?.[filePath]
  if (!Array.isArray(diagnostics)) return []
  return diagnostics
    .flatMap((item) => {
      const diagnostic = recordValue(item)
      const start = recordValue(recordValue(diagnostic?.range)?.start)
      const line = numberValue(start?.line)
      const character = numberValue(start?.character)
      const message = stringValue(diagnostic?.message)
      if (diagnostic?.severity !== 1 || line === undefined || character === undefined || !message) return []
      return [{ range: { start: { line, character } }, message }]
    })
    .slice(0, 3)
}
