/** @jsxImportSource @opentui/solid */
import { createMemo, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { useSync } from "../context/sync"
import { useRoute } from "../context/route"
import { useSessionTabs } from "../context/session-tabs"
import { SessionTabs } from "../session-tabs"
import { isDefaultTitle } from "../util/session"

/**
 * One row above the session view: a tab per open session. The active tab is
 * marked with a leading triangle and highlighted, a running session shows a dot,
 * and a background session that needs the user shows a diamond. The marker keeps
 * the active tab identifiable in plain text, not only by colour. Clicking a tab selects it; the "+" starts a
 * new session. Keyboard shortcuts live in app.tsx.
 */
export function SessionTabsBar() {
  const tabs = useSessionTabs()
  const sync = useSync()
  const route = useRoute()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const layout = createMemo(() =>
    SessionTabs.layout({
      count: tabs.open.length,
      active: tabs.open.indexOf(tabs.active ?? ""),
      width: dimensions().width,
    }),
  )
  const visible = createMemo(() =>
    tabs.open.slice(layout().start, layout().end).map((id, offset) => ({ id, index: layout().start + offset + 1 })),
  )

  function title(id: string) {
    const value = sync.session.get(id)?.title
    if (!value || isDefaultTitle(value)) return "New session"
    return value
  }

  return (
    <Show when={tabs.open.length > 0}>
      <box flexDirection="row" height={1} flexShrink={0} backgroundColor={theme.backgroundPanel}>
        <Show when={layout().start > 0}>
          <text fg={theme.textMuted}>{`‹${layout().start} `}</text>
        </Show>
        <For each={visible()}>
          {(tab) => {
            const active = () => tab.id === tabs.active
            return (
              <box
                flexShrink={0}
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active() ? theme.backgroundElement : undefined}
                onMouseDown={() => tabs.select(tab.id)}
              >
                <text fg={active() ? theme.text : theme.textMuted}>
                  {`${active() ? "▸" : " "}${tab.index} ${SessionTabs.truncate(title(tab.id), layout().titleWidth)}`}
                </text>
                <Show when={tabs.isRunning(tab.id)}>
                  <text fg={theme.success}>{" ●"}</text>
                </Show>
                <Show when={tabs.isAttention(tab.id)}>
                  <text fg={theme.warning}>{" ◆"}</text>
                </Show>
              </box>
            )
          }}
        </For>
        <Show when={layout().end < tabs.open.length}>
          <text fg={theme.textMuted}>{` ›${tabs.open.length - layout().end}`}</text>
        </Show>
        <box flexGrow={1} />
        <box onMouseDown={() => route.navigate({ type: "home" })} paddingLeft={1} paddingRight={1}>
          <text fg={theme.textMuted}>+</text>
        </box>
      </box>
    </Show>
  )
}
