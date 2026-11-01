const kinds = ["bash", "pwsh", "powershell", "cmd"] as const
export type Kind = (typeof kinds)[number]

const shellKinds = new Set<string>(kinds)

function isKind(value: string): value is Kind {
  return shellKinds.has(value)
}

export function toKind(value: string): Kind {
  return isKind(value) ? value : "bash"
}

// The exposed tool ID and permission key are "shell": the tool runs the host
// shell (zsh/sh/PowerShell/cmd/...), not necessarily bash (#780). Legacy
// "bash" permission rules, saved grants, and config keep matching through the
// alias-aware Wildcard.matchAction used by both permission engines.
export const ToolID = "shell"
export type ToolID = typeof ToolID

export * as ShellID from "./id"
