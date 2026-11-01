import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { useRouteData } from "../../context/route"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { useSDK } from "../../context/sdk"
import { useDialog } from "../../ui/dialog"
import { SplitBorder } from "../../ui/border"
import { Spinner } from "../../component/spinner"
import { Locale } from "../../util/locale"
import { contextUsage } from "../../util/context-usage"
import { useTerminalDimensions } from "../../util/terminal-dimensions"
import { OPENCODE_BASE_MODE, useBindings, useCommandShortcut, useOpencodeKeymap } from "../../keymap"
import { useTuiConfig } from "../../config"
import { DOUBLE_PRESS_WINDOW_MS } from "../../util/double-press"

export function SubagentFooter() {
  const route = useRouteData("session")
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const session = createMemo(() => sync.session.get(route.sessionID))
  const sdk = useSDK()
  const dialog = useDialog()
  const tuiConfig = useTuiConfig()

  const subagentInfo = createMemo(() => {
    const s = session()
    if (!s) return { label: "Subagent", index: 0, total: 0 }
    const agentMatch = s.title.match(/@(\w+) subagent/)
    const label = agentMatch ? Locale.titlecase(agentMatch[1]) : "Subagent"

    if (!s.parentID) return { label, index: 0, total: 0 }

    const siblings = sync.data.session
      .filter((x) => x.parentID === s.parentID)
      .toSorted((a, b) => a.time.created - b.time.created)
    const index = siblings.findIndex((x) => x.id === s.id)

    return { label, index: index + 1, total: siblings.length }
  })

  // Same measurement as the sidebar context bar (#241); unknown usage shows
  // no count rather than a figure the bar would contradict.
  const usage = createMemo(() => {
    const measured = contextUsage({
      report: sync.data.session_context[route.sessionID],
      messages: messages(),
      contextLimit: (providerID, modelID) =>
        sync.data.provider.find((item) => item.id === providerID)?.models[modelID]?.limit.context,
    })
    if (!measured) return

    const pct = measured.percent === undefined ? undefined : `${measured.percent}%`
    const cost = session()?.cost ?? 0

    const money = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    })

    // #241 owner correction: unknown usage shows no count at all.
    const context = pct ? `${Locale.number(measured.tokens)} (${pct})` : undefined
    if (!context && cost <= 0) return
    return {
      context,
      cost: cost > 0 ? money.format(cost) : undefined,
    }
  })

  // Only a running subagent has an execution handle to stop. Session status
  // covers a child that is mid-turn; an assistant message that never completed
  // covers the gap before the status event lands.
  const running = createMemo(() => {
    const status = sync.data.session_status[route.sessionID]?.type
    if (status === "busy" || status === "retry") return true
    const last = messages().findLast((message) => message.role === "assistant")
    return last !== undefined && !last.time.completed
  })

  // An interrupted child's assistant message carries the abort, which is the
  // persisted proof the child was cancelled. Reading the transcript keeps the
  // label correct after navigating away and back, not just during the press.
  const cancelled = createMemo(() => {
    const last = messages().findLast((message) => message.role === "assistant")
    return last?.error?.name === "MessageAbortedError"
  })

  // Both the armed press and the in-flight request belong to one trace: moving
  // to another subagent must re-arm for that child and must not show its
  // status as cancelling because of a request aimed at a sibling.
  const [armedFor, setArmedFor] = createSignal<string>()
  const [requestedFor, setRequestedFor] = createSignal<string>()
  let disarm: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(disarm))

  const armed = createMemo(() => armedFor() === route.sessionID)
  const requested = createMemo(() => requestedFor() === route.sessionID)

  createEffect(
    on(
      () => route.sessionID,
      () => {
        clearTimeout(disarm)
        setArmedFor(undefined)
      },
    ),
  )

  // A request only describes a stop that is still in flight. Once the child is
  // no longer running, the transcript is the only evidence of how it ended: an
  // abort the server accepted but the child outlived must not label a later
  // completion as cancelled, and must not resurface on the child's next run.
  createEffect(
    on(running, (alive) => {
      if (!alive) setRequestedFor(undefined)
    }),
  )

  const stopPhase = createMemo<"cancelling" | "cancelled" | undefined>(() => {
    if (running()) return requested() ? "cancelling" : undefined
    return cancelled() ? "cancelled" : undefined
  })

  // Deeper navigation opens dialogs over the trace; Esc belongs to the dialog
  // while one is open, exactly as the child session navigation keys assume.
  const stop = () => {
    if (dialog.stack.length > 0) return
    if (!running()) return
    const target = route.sessionID
    if (!armed()) {
      clearTimeout(disarm)
      setArmedFor(target)
      disarm = setTimeout(
        () => setArmedFor((current) => (current === target ? undefined : current)),
        DOUBLE_PRESS_WINDOW_MS,
      )
      return
    }
    clearTimeout(disarm)
    setArmedFor(undefined)
    setRequestedFor(target)
    // A request that never reached the server must not read as progress: the
    // child is still running and nothing was cancelled.
    sdk.client.session.abort({ sessionID: target }, { throwOnError: true }).catch(() => {
      if (requestedFor() === target) setRequestedFor(undefined)
    })
  }

  useBindings(() => ({
    commands: [
      {
        name: "session.subagent.stop",
        title: "Stop subagent",
        desc: "Stop the selected subagent",
        hidden: true,
        enabled: running(),
        run: stop,
      },
    ],
  }))

  // Registered by the footer, which only renders while a subagent trace is
  // open: Esc outside that view keeps whatever the parent session had bound.
  // Base mode keeps it out of dialogs, and the lowest priority makes it a
  // fallback so inline prompts - a permission prompt's reject, for instance -
  // keep the Esc they bind while one is open over the trace.
  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    priority: -1,
    enabled: running(),
    bindings: tuiConfig.keybinds.get("session.subagent.stop"),
  }))

  const { theme } = useTheme()
  const keymap = useOpencodeKeymap()
  const parentShortcut = useCommandShortcut("session.parent")
  const previousShortcut = useCommandShortcut("session.child.previous")
  const nextShortcut = useCommandShortcut("session.child.next")
  const stopShortcut = useCommandShortcut("session.subagent.stop")
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | "stop" | null>(null)
  useTerminalDimensions()

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        {/* Identity on the left, controls on the right. Both groups refuse to
            shrink and the row wraps instead (#241), so a narrow terminal
            stacks the controls under the label rather than word-wrapping
            "Stop subagent" and "(1 of 2)" into each other. */}
        <box flexDirection="row" flexWrap="wrap" justifyContent="space-between" gap={1}>
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text fg={theme.text} wrapMode="none">
              <b>{subagentInfo().label}</b>
            </text>
            <Show when={subagentInfo().total > 0}>
              <text style={{ fg: theme.textMuted }} wrapMode="none">
                ({subagentInfo().index} of {subagentInfo().total})
              </text>
            </Show>
            <Show when={usage()}>
              {(item) => (
                <text fg={theme.textMuted} wrapMode="none">
                  {[item().context, item().cost].filter(Boolean).join(" · ")}
                </text>
              )}
            </Show>
            <Show when={stopPhase()}>
              {(phase) => (
                <Show when={phase() === "cancelling"} fallback={<text fg={theme.textMuted}>Cancelled</text>}>
                  <Spinner color={theme.warning}>Cancelling…</Spinner>
                </Show>
              )}
            </Show>
          </box>
          <box flexDirection="row" flexWrap="wrap" gap={2} flexShrink={0}>
            <Show when={running()}>
              <box flexDirection="row" gap={1} flexShrink={0}>
                {/* The click target names the action; the shortcut beside it is
                    what advertises the double press. */}
                <box
                  onMouseOver={() => setHover("stop")}
                  onMouseOut={() => setHover(null)}
                  onMouseUp={() => keymap.dispatchCommand("session.subagent.stop")}
                  backgroundColor={hover() === "stop" ? theme.backgroundElement : theme.backgroundPanel}
                >
                  <text fg={armed() ? theme.primary : theme.text} wrapMode="none">
                    Stop subagent
                  </text>
                </box>
                <text style={{ fg: armed() ? theme.primary : theme.textMuted }} wrapMode="none">
                  {armed() ? `${stopShortcut()} again to stop` : `${stopShortcut()} ${stopShortcut()}`}
                </text>
              </box>
            </Show>
            <box
              onMouseOver={() => setHover("parent")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatchCommand("session.parent")}
              backgroundColor={hover() === "parent" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text} wrapMode="none">
                Parent <span style={{ fg: theme.textMuted }}>{parentShortcut()}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("prev")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatchCommand("session.child.previous")}
              backgroundColor={hover() === "prev" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text} wrapMode="none">
                Prev <span style={{ fg: theme.textMuted }}>{previousShortcut()}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("next")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatchCommand("session.child.next")}
              backgroundColor={hover() === "next" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text} wrapMode="none">
                Next <span style={{ fg: theme.textMuted }}>{nextShortcut()}</span>
              </text>
            </box>
          </box>
        </box>
      </box>
    </box>
  )
}
