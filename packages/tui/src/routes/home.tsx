import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Logo } from "../component/logo"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { usePluginRuntime } from "../plugin/runtime"
import { useEditorContext } from "../context/editor"
import { useTerminalDimensions } from "../util/terminal-dimensions"
import { useTuiConfig } from "../config"
import { HomeSessionDestinationProvider } from "./home/session-destination"
import { HomeTipPlaceholderProvider, useHomeTipPlaceholder } from "./home/tip-placeholder"

let once = false
const TIP_ROTATE_MS = 10_000
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

function HomeScreen() {
  const pluginRuntime = usePluginRuntime()
  const sync = useSync()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const promptMaxWidth = createMemo(() => {
    const configured = tuiConfig.prompt?.max_width
    if (configured === "auto") return Math.max(75, Math.floor(dimensions().width * 0.7))
    return configured ?? 75
  })
  const tipPlaceholder = useHomeTipPlaceholder()
  const tipOffset = Math.random()
  const [tipStep, setTipStep] = createSignal(0)
  // Placeholders must stay on one line; a wrapped tip would resize the prompt on every rotation.
  const tipWidth = createMemo(() => Math.min(promptMaxWidth(), dimensions().width - 4) - 6)
  const tip = createMemo(() => {
    const list = tipPlaceholder?.tips()
    if (!list?.length) return
    const width = tipWidth()
    const fitting = list.filter((item) => item.length <= width)
    const pool = fitting.length ? fitting : list
    const value = pool[Math.floor(tipOffset * pool.length + tipStep()) % pool.length]
    return value.length > width ? value.slice(0, Math.max(0, width - 1)) + "…" : value
  })
  let sent = false

  onMount(() => {
    editor.clearSelection()
    const timer = setInterval(() => setTipStep((step) => step + 1), TIP_ROTATE_MS)
    onCleanup(() => clearInterval(timer))
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <HomeSessionDestinationProvider>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <box flexShrink={0}>
          <pluginRuntime.Slot name="home_logo" mode="replace">
            <Logo />
          </pluginRuntime.Slot>
        </box>
        <box width="100%" maxWidth={promptMaxWidth()} zIndex={1000} paddingTop={1} flexShrink={0}>
          <pluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt
              ref={bind}
              right={<pluginRuntime.Slot name="home_prompt_right" />}
              placeholder={tip()}
              placeholders={placeholder}
              centerShortcuts
            />
          </pluginRuntime.Slot>
        </box>
        <pluginRuntime.Slot name="home_bottom" />
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <pluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </HomeSessionDestinationProvider>
  )
}

export function Home() {
  return (
    <HomeTipPlaceholderProvider>
      <HomeScreen />
    </HomeTipPlaceholderProvider>
  )
}
