/** The text readers consume UTF-8, but Windows PowerShell inherits a legacy console encoding. */
export function windowsPowerShellCommand(shell: string, command: string, platform = process.platform): string {
  if (platform !== "win32" || !/(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(shell)) return command
  // Both the host's stdout/stderr and text piped to native commands must agree.
  // Keep the original command on its own line, including leading comments.
  return "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n" + command
}

/**
 * For the Node `shell: cmd` spawn route only: start a new cmd after changing the codepage.
 * The original cmd can keep writing its startup OEM codepage even after chcp succeeds.
 * Use an absolute helper, never a project-resolved `chcp`; unsafe system roots are left alone.
 */
export function windowsCmdCommand(
  shell: string,
  command: string,
  platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  if (platform !== "win32" || !/(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell)) return command
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir
  if (!root || !/^[A-Za-z]:\\[^\s"%&^|<>!()]*$/.test(root) || /[\r\n]/.test(command)) return command
  // `&` (not `&&`) so a failing chcp never blocks the user's command.
  return `${root.replace(/\\+$/, "")}\\System32\\chcp.com 65001>nul & %COMSPEC% /d /s /c ${cmdLine(command)}`
}

/** Pass an intact /s /c command through the outer cmd, not through Windows argv quoting. */
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
