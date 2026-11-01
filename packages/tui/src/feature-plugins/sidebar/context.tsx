import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"
import { contextUsage } from "../../util/context-usage"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

// Primary presentation for #241: a single filling bar is the context
// indicator; the numeric token count/percent stay as an optional,
// accessibility-friendly detail underneath instead of the sole readout.
//
// Owner correction (post-review): there is no "confidently empty" status.
// When no measured usage exists — either no report and no assistant message
// yet, or usage exists but the model's context limit is not resolvable — the
// true state is UNKNOWN; reporting "0 tokens / 0% used" would assert a fact
// we don't have. It renders as a plain empty bar (no fill, no hatch/texture
// glyph) paired with the "usage unknown" text. A prior hatch-glyph ("▨")
// rendering for unknown was removed because that glyph's cell height renders
// differently from the fill/empty glyphs in terminal fonts, visually breaking
// the single-bar presentation the issue calls for.
//
// Measurement itself is not derived here: the runtime publishes one report per
// provider request (see `util/context-usage`), and this view renders it. Only a
// session that has not reached its first provider request falls back to the
// provider's token accounting for its last assistant turn, which is where the
// UNKNOWN cases above come from.
export const CONTEXT_BAR_WIDTH = 20

export type ContextUsage = { status: "known"; tokens: number; percent: number } | { status: "unknown"; tokens: number }

export function contextBarGlyphs(usage: ContextUsage): string {
  if (usage.status === "unknown") return "░".repeat(CONTEXT_BAR_WIDTH)
  const clamped = Math.max(0, Math.min(100, usage.percent))
  const filled = Math.round((clamped / 100) * CONTEXT_BAR_WIDTH)
  return "█".repeat(filled) + "░".repeat(CONTEXT_BAR_WIDTH - filled)
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)
  const report = createMemo(() => props.api.state.session.context(props.session_id))

  const usage = createMemo(() =>
    contextUsage({
      report: report(),
      messages: msg(),
      contextLimit: (providerID, modelID) =>
        props.api.state.provider.find((item) => item.id === providerID)?.models[modelID]?.limit.context,
    }),
  )

  const state = createMemo((): ContextUsage => {
    const measured = usage()
    if (!measured) return { status: "unknown", tokens: 0 }
    if (measured.percent === undefined) return { status: "unknown", tokens: measured.tokens }
    return { status: "known", tokens: measured.tokens, percent: measured.percent }
  })

  const detail = createMemo(() => {
    const measured = usage()
    if (!measured) return "usage unknown"
    if (measured.exhausted) return `${measured.tokens.toLocaleString()} tokens · context exhausted`
    if (measured.urgent)
      return `${measured.tokens.toLocaleString()} tokens · ${measured.reclaimed.toLocaleString()} reclaimed`
    if (state().status === "unknown") return "usage unknown"
    return `${measured.tokens.toLocaleString()} tokens · ${measured.percent}% used`
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{contextBarGlyphs(state())}</text>
      <text fg={theme().textMuted}>{detail()}</text>
      <text fg={theme().textMuted}>{money.format(cost())} spent</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
