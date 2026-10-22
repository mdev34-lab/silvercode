/** @jsxImportSource @opentui/solid */
import { createMemo, For, Show } from "solid-js"
import { useTerminalDimensions } from "../util/terminal-dimensions"
import { useTheme } from "../context/theme"
import { useSync } from "../context/sync"
import { useRoute } from "../context/route"
import { useSessionTabs } from "../context/session-tabs"
import { SessionTabs } from "../session-tabs"
import { isDefaultTitle } from "../util/session"

/**
 * One row above the session view: a tab per open session. The active tab is
 * highlighted, bold and carries a close button, a running session shows a dot,
 * and a background session that needs the user shows a diamond. Clicking a tab
 * selects it; the "+" starts a new session. Keyboard shortcuts live in app.tsx.
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
                  <span style={{ bold: active() }}>
                    {`${tab.index} ${SessionTabs.truncate(title(tab.id), layout().titleWidth)}`}
                  </span>
                </text>
                <Show when={active()}>
                  <box onMouseDown={() => tabs.close(tab.id)} paddingLeft={2}>
                    <text fg={theme.textMuted}>×</text>
                  </box>
                </Show>
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
        <box
          onMouseDown={() => route.navigate({ type: "home" })}
          paddingLeft={1}
          paddingRight={1}
          marginLeft={1}
          backgroundColor={theme.backgroundElement}
        >
          <text fg={theme.text}>
            <span style={{ bold: true }}>+</span>
          </text>
        </box>
        <box flexGrow={1} />
      </box>
    </Show>
  )
}
