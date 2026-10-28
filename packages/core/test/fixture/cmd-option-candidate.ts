/**
 * EXPERIMENTAL TEST FIXTURE ONLY: the guarded #682 candidate, not used by either tool.
 * The unguarded form below allows diagnostic controls to measure otherwise skipped cases.
 */
export function windowsCmdCommand(
  shell: string,
  command: string,
  platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  if (platform !== "win32" || !/(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell)) return command
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir
  // Preserve the old candidate's guards for comparison, not as a claim that the remaining domain is safe.
  if (!root || !/^[A-Za-z]:\\[^\s"%&^|<>!()]*$/.test(root) || /[!\r\n]/.test(command)) return command
  // The inner command expands COMSPEC in the child's environment, not necessarily process.env.
  const comspec = Object.entries(env).filter(([key]) => key.toLowerCase() === "comspec")
  if (comspec.length !== 1 || !comspec[0]?.[1]) return command
  if (!/^[A-Za-z]:\\[^\s"%&^|<>!()]*$/.test(comspec[0][1]) || !/(?:^|\\)cmd(?:\.exe)?$/i.test(comspec[0][1]))
    return command
  return unguardedCmdCommand(command, root)
}

/** Reproduce the unguarded e560ab6b candidate; do not use this in production. */
export function unguardedCmdCommand(command: string, root: string) {
  return `${root.replace(/\\+$/, "")}\\System32\\chcp.com 65001>nul & %COMSPEC% /d /s /c ${cmdLine(command)}`
}

/**
 * Experimental outer-cmd caret encoding; parity is NOT established. Microsoft documents that /s strips
 * the first and last quotes, leaving the remainder unchanged:
 * https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd
 * That contract alone does not prove this two-parser encoding or environment/ERRORLEVEL behavior.
 */
function cmdLine(command: string) {
  const escape = (char: string) => (/[&|<>()^"]/.test(char) ? `^${char}` : char)
  let quoted = false
  let line = ""
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quoted) {
      line += char
      if (char === '"') quoted = false
      continue
    }
    if (char === '"') {
      quoted = true
      line += char
      continue
    }
    if (char === "^" && i + 1 < command.length) {
      // The next character was already escaped in the user's line; retain both for the inner cmd.
      line += `^^${escape(command[++i]!)}`
      continue
    }
    line += escape(char)
  }
  // ^" sends a literal boundary quote through the outer cmd without changing its quote state.
  // If the user left a quote open, it already protects the final boundary quote from metacharacters.
  return `^"${line}${quoted ? '"' : '^"'}`
}
