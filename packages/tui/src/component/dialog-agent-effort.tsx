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
}[] = [
  {
    value: "fast",
    title: "Fast",
    description: "Reliable workhorse for everyday tasks",
  },
  {
    value: "medium",
    title: "Medium",
    // No "· default" here: on home the persisted selection decides the
    // default now, so a static claim on one row would contradict it. The
    // cursor and the footer carry that meaning instead.
    description: "Smarter agent for more demanding work",
  },
  {
    value: "thorough",
    title: "Thorough",
    description: "Deep, meticulous work on complex tasks from start to finish",
  },
]

// The widest level chip (` Thorough `) is 10 columns; a fixed title cell keeps
// every description starting in the same column, which is what lets a wrapped
// description hold its alignment instead of running back under the chip.
const TITLE_COLUMN = 10

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
        titleColumn: TITLE_COLUMN,
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
      // Breathing room between the three levels, and a description column that
      // wraps under itself in narrow terminals (#791).
      optionSpacing={1}
      footer={
        <text fg={theme.textMuted}>
          {local.effort.scoped() ? "Stored on this session" : "Default for new sessions"}
        </text>
      }
    />
  )
}
