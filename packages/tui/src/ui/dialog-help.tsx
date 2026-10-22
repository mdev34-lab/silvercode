import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "../util/terminal-dimensions"
import { For } from "solid-js"
import { BRAND_NAME } from "../brand"
import { useTheme } from "../context/theme"
import { useDialog } from "./dialog"
import { useBindings, useCommandShortcut } from "../keymap"
import { HELP_SECTIONS, pad } from "./help-content"

export function DialogHelp() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const commandShortcut = useCommandShortcut("command.palette.show")

  dialog.setSize("large")

  // Give the command table roughly half the terminal height (matching the
  // dialog-select row budget) but never a negative/zero scroll region, so the
  // dialog renders sensibly even in a very short terminal.
  const maxHeight = () => Math.max(4, Math.floor(dimensions().height / 2) - 6)

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close help", group: "Dialog", cmd: () => dialog.clear() },
      { key: "escape", desc: "Close help", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {BRAND_NAME} — Help
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc/enter
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted} wrapMode="word">
          An AI coding agent that runs in your terminal. Here are the most useful commands. Press{" "}
          {commandShortcut()} to see every command available in the current context.
        </text>
      </box>
      <scrollbox
        maxHeight={maxHeight()}
        scrollbarOptions={{ visible: false }}
        paddingLeft={1}
        paddingRight={1}
      >
        <For each={HELP_SECTIONS}>
          {(section) => (
            <box paddingBottom={1}>
              <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                {section.title}
              </text>
              <For each={section.commands}>
                {(command) => (
                  <box flexDirection="row" paddingLeft={2}>
                    <text fg={theme.primary} flexShrink={0} wrapMode="none">
                      {pad(command.command)}
                    </text>
                    <text fg={theme.text} flexGrow={1} minWidth={0} wrapMode="word">
                      {command.desc}
                    </text>
                  </box>
                )}
              </For>
            </box>
          )}
        </For>
      </scrollbox>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}
