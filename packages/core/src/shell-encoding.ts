/** The text readers consume UTF-8, but Windows PowerShell inherits a legacy console encoding. */
export function windowsPowerShellCommand(shell: string, command: string, platform = process.platform): string {
  if (platform !== "win32" || !/(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(shell)) return command
  // Both the host's stdout/stderr and text piped to native commands must agree.
  // Keep the original command on its own line, including leading comments.
  return "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n" + command
}

/**
 * cmd.exe builtins write in the console's OEM codepage; switch it to UTF-8 so the text readers decode them.
 * cmd resolves a bare `chcp` from the working directory first, and that is the project, so the helper is
 * addressed by its absolute System32 path. Without a safe system root the command is left unchanged.
 */
export function windowsCmdCommand(
  shell: string,
  command: string,
  platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  if (platform !== "win32" || !/(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell)) return command
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir
  if (!root || !/^[A-Za-z]:\\[^"%&^|<>!\r\n]*$/.test(root)) return command
  // `&` (not `&&`) so a failing chcp never blocks the user's command.
  return `"${root.replace(/\\+$/, "")}\\System32\\chcp.com" 65001>nul & ${command}`
}
