import { SyntaxStyle, TextAttributes, type ColorInput, type NativeResourceOwner } from "@opentui/core"
import { type RunEntryTheme, type RunTheme } from "./theme"
import type { StreamCommit } from "./types"

function syntax(style: SyntaxStyle | undefined, owner: NativeResourceOwner): SyntaxStyle {
  return style ?? SyntaxStyle.fromTheme([], owner)
}

export function entrySyntax(commit: StreamCommit, theme: RunTheme, owner: NativeResourceOwner): SyntaxStyle {
  if (commit.kind === "reasoning") {
    return syntax(theme.block.subtleSyntax ?? theme.block.syntax, owner)
  }

  return syntax(theme.block.syntax, owner)
}

export function entryCancelled(commit: StreamCommit): boolean {
  if (commit.kind !== "tool" || commit.part?.state.status !== "error") return false
  const error = commit.part.state.error
  return (
    commit.part.state.metadata?.interrupted === true ||
    error.includes("Tool execution aborted") ||
    error.includes("QuestionRejectedError") ||
    error.includes("rejected permission") ||
    error.includes("specified a rule") ||
    error.includes("user dismissed")
  )
}

export function entryFailed(commit: StreamCommit): boolean {
  if (commit.kind !== "tool" || entryCancelled(commit)) return false
  if (commit.tool === "invalid") return true
  if (commit.part?.state.status === "completed" && commit.part.state.metadata?.error === true) return true
  return commit.toolState === "error" || commit.part?.state.status === "error"
}

export function entryLook(commit: StreamCommit, theme: RunEntryTheme): { fg: ColorInput; attrs?: number } {
  if (commit.kind === "user") {
    return {
      fg: theme.user.body,
      //attrs: TextAttributes.BOLD,
    }
  }

  if (entryFailed(commit)) {
    return {
      fg: theme.error.body,
      attrs: TextAttributes.BOLD,
    }
  }

  if (entryCancelled(commit)) {
    return {
      fg: theme.system.body,
      attrs: TextAttributes.DIM | TextAttributes.STRIKETHROUGH,
    }
  }

  if (commit.phase === "final") {
    return {
      fg: theme.system.body,
      attrs: TextAttributes.DIM,
    }
  }

  if (commit.kind === "tool" && commit.phase === "start") {
    return {
      fg: theme.tool.start ?? theme.tool.body,
    }
  }

  if (commit.kind === "assistant") {
    return { fg: theme.assistant.body }
  }

  if (commit.kind === "reasoning") {
    return {
      fg: theme.reasoning.body,
      attrs: TextAttributes.DIM,
    }
  }

  if (commit.kind === "error") {
    return {
      fg: theme.error.body,
      attrs: TextAttributes.BOLD,
    }
  }

  if (commit.kind === "tool") {
    return { fg: theme.tool.body }
  }

  return { fg: theme.system.body }
}

export function entryColor(commit: StreamCommit, theme: RunTheme): ColorInput {
  if (commit.kind === "assistant") {
    return theme.entry.assistant.body
  }

  if (commit.kind === "reasoning") {
    return theme.entry.reasoning.body
  }

  if (entryFailed(commit)) {
    return theme.entry.error.body
  }

  if (commit.kind === "tool") {
    return theme.block.text
  }

  return entryLook(commit, theme.entry).fg
}
