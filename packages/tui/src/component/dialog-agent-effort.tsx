import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { useTheme } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { effortBadge, type Level } from "../util/agent-effort"

const ENTRIES: {
  value: Level
  title: string
  description: string
  details: string[]
}[] = [
  {
    value: "fast",
    title: "Fast",
    description: "no review ritual",
    details: ["Inline self-check and syntax/smoke validation, delivered with an honest unreviewed label"],
  },
  {
    value: "medium",
    title: "Medium",
    // No "· default" here: on home the persisted selection decides the
    // default now, so a static claim on one row would contradict it. The
    // cursor and the footer carry that meaning instead.
    description: "up to 2 review passes",
    details: ["Independent review for code changes; only blocking findings force another pass, then an honest status"],
  },
  {
    value: "thorough",
    title: "Thorough",
    description: "review until clean",
    details: ["Structured review contract with severity-driven convergence and full validation gates, no pass cap"],
  },
]

export function DialogAgentEffort() {
  const local = useLocal()
  const dialog = useDialog()
  const { theme } = useTheme()

  const options = createMemo(() =>
    ENTRIES.map((entry) => {
      // Level names always stay visible; the hue only reinforces them (fast
      // green, medium orange, thorough red). It is painted as a filled chip so
      // it keeps its contrast on both the panel and a highlighted row.
      const badge = effortBadge(entry.value, theme)
      return {
        value: entry.value,
        title: entry.title,
        titleView: (
          <>
            <span style={{ fg: badge.fg, bg: badge.bg, bold: true }}>{` ${entry.title} `}</span>
          </>
        ),
        description: entry.description,
        details: entry.details,
        onSelect: () => {
          dialog.clear()
          local.effort.set(entry.value)
        },
      }
    }),
  )

  return (
    <DialogSelect<Level>
      options={options()}
      title="Agent effort"
      current={local.effort.current()}
      flat={true}
      footer={
        <text fg={theme.textMuted}>
          {local.effort.scoped() ? "Stored on this session" : "Default for new sessions"}
        </text>
      }
    />
  )
}
