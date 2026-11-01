import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createEffect, createMemo, onCleanup } from "solid-js"
import { createTipList } from "./tips-view"
import { useBindings } from "../../keymap"
import { useHomeTipPlaceholder } from "../../routes/home/tip-placeholder"

const id = "internal:home-tips"

// Tips no longer render as a row; the home prompt rotates them as its placeholder.
function View(props: { api: TuiPluginApi; hidden: boolean; show: boolean; connected: boolean }) {
  useBindings(() => ({
    commands: [
      {
        name: "tips.toggle",
        title: props.hidden ? "Show tips" : "Hide tips",
        category: "System",
        namespace: "palette",
        run() {
          props.api.kv.set("tips_hidden", !props.api.kv.get("tips_hidden", false))
          props.api.ui.dialog.clear()
        },
      },
    ],
    bindings: props.api.tuiConfig.keybinds.get("tips.toggle"),
  }))

  const placeholder = useHomeTipPlaceholder()
  const list = createTipList({ api: props.api, connected: () => props.connected })
  createEffect(() => {
    placeholder?.setTips(props.show ? list() : undefined)
  })
  onCleanup(() => placeholder?.setTips(undefined))
  return null
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_bottom() {
        const hidden = createMemo(() => api.kv.get("tips_hidden", false))
        const first = createMemo(() => api.state.session.count() === 0)
        const connected = createMemo(() =>
          api.state.provider.some(
            (item) => item.id !== "opencode" || Object.values(item.models).some((model) => model.cost?.input !== 0),
          ),
        )
        const show = createMemo(() => (!first() || !connected()) && !hidden())
        return <View api={api} hidden={hidden()} show={show()} connected={connected()} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
