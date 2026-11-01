// Curated editorial overview of the most useful slash commands shown in the
// /help dialog.
//
// This is intentionally NOT a complete command reference: the command palette
// (and the per-context command registrations it reads) is the authoritative,
// complete list. Keep this concise and stable rather than trying to mirror
// every registered command. Keeping this data import-free lets it be unit
// tested without pulling in the Solid/OpenTUI renderer stack.

export type HelpCommand = { command: string; desc: string }
export type HelpSection = { title: string; commands: HelpCommand[] }

export const HELP_SECTIONS: HelpSection[] = [
  {
    title: "Start",
    commands: [
      { command: "/help", desc: "Open this help dialog" },
      { command: "/connect", desc: "Connect an AI provider to start coding" },
      { command: "/models", desc: "Switch the active AI model" },
      { command: "/agents", desc: "Switch agent (Work, Think, or subagents)" },
      { command: "/skills", desc: "Browse and load an available skill" },
    ],
  },
  {
    title: "Session",
    commands: [
      { command: "/new", desc: "Start a fresh conversation session" },
      { command: "/sessions", desc: "List, pin, and switch sessions" },
      { command: "/rename", desc: "Rename the current session" },
      { command: "/timeline", desc: "Jump to a specific message" },
      { command: "/fork", desc: "Fork a new session from a message" },
      { command: "/compact", desc: "Summarize a long session near the context limit" },
      { command: "/export", desc: "Save the conversation as Markdown" },
      { command: "/undo", desc: "Revert the last message and its file changes" },
      { command: "/redo", desc: "Restore a reverted message" },
      { command: "/share", desc: "Share the session and copy a link" },
      { command: "/unshare", desc: "Remove the session from public access" },
      { command: "/move", desc: "Move the session to another project directory" },
    ],
  },
  {
    title: "Review",
    commands: [
      { command: "/diff", desc: "Open the diff viewer for uncommitted changes" },
      { command: "/init", desc: "Generate project rules (AGENTS.md) from your codebase" },
      { command: "/review", desc: "Review uncommitted changes, branches, or PRs" },
    ],
  },
  {
    title: "System",
    commands: [
      { command: "/variants", desc: "Switch model variants, when supported" },
      { command: "/effort", desc: "Agent effort: review rigor (fast, medium, thorough)" },
      { command: "/mcps", desc: "Toggle MCP servers" },
      { command: "/themes", desc: "Switch the terminal theme" },
      { command: "/status", desc: "View system status info" },
      { command: "/debug", desc: "View debug information" },
      { command: "/editor", desc: "Compose the prompt in your external editor" },
      { command: "/exit", desc: "Quit SilverCode" },
    ],
  },
]

// Pad the command column so the description column lines up in a table.
export function pad(command: string) {
  const width = 12
  return command.length >= width ? command : command + " ".repeat(width - command.length)
}
