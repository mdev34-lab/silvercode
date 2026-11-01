import { Schema } from "effect"
import DESCRIPTION from "./shell.txt"
import { PositiveInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { ShellID } from "./id"

const PS = new Set(["powershell", "pwsh"])
const CMD = new Set(["cmd"])

export type Limits = {
  maxLines: number
  maxBytes: number
}

export function parameterSchema() {
  return Schema.Struct({
    command: Schema.String.annotate({ description: "The command to execute" }),
    timeout: Schema.optional(PositiveInt).annotate({ description: "Optional timeout in milliseconds" }),
    workdir: Schema.optional(Schema.String).annotate({
      description: `The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.`,
    }),
  })
}

export const Parameters = parameterSchema()
export type Parameters = Schema.Schema.Type<typeof Parameters>

function renderPrompt(template: string, values: Record<string, string>) {
  return template.replace(/\$\{(\w+)\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`Missing shell prompt value: ${key}`)
    return value
  })
}

function shellDisplayName(name: string) {
  if (name === "pwsh") return "PowerShell (7+)"
  if (name === "powershell") return "Windows PowerShell (5.1)"
  if (name === "cmd") return "cmd.exe"
  return name
}

function powershellNotes(name: string) {
  if (name === "pwsh") {
    return `# PowerShell (7+) shell notes
- This cross-platform shell supports pipeline chain operators (\`&&\` and \`||\`).
- Use double quotes for interpolated strings (\`"Hello $name"\`), single quotes for verbatim strings.
- Prefer full cmdlet names like \`Get-ChildItem\`, \`Set-Content\`, \`Remove-Item\`, and \`New-Item\` over aliases.
- Use \`$(...)\` for subexpressions. Use \`@(...)\` for array expressions.
- To call a native executable whose path contains spaces, use the call operator: \`& "path/to/exe" args\`.
- Escape special characters with the PowerShell backtick character.`
  }
  if (name === "powershell") {
    return `# Windows PowerShell (5.1) shell notes
- Use \`cmd1; if ($?) { cmd2 }\` to chain dependent commands.
- Use double quotes for interpolated strings (\`"Hello $name"\`), single quotes for verbatim strings.
- Prefer full cmdlet names like \`Get-ChildItem\`, \`Set-Content\`, \`Remove-Item\`, and \`New-Item\` over aliases.
- Use \`$(...)\` for subexpressions. Use \`@(...)\` for array expressions.
- To call a native executable whose path contains spaces, use the call operator: \`& "path/to/exe" args\`.
- Escape special characters with the PowerShell backtick character.`
  }
  return ""
}

function chainGuidance(name: string) {
  if (name === "powershell") {
    return "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell (5.1) does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success."
  }
  if (PS.has(name)) {
    return "Chain dependent commands in a single bash tool call with '&&'."
  }
  if (CMD.has(name)) {
    return "Chain dependent commands in a single bash tool call with `&&`."
  }
  return "Chain dependent commands in a single Bash call with '&&' (e.g., `mkdir out && cp a out/`)."
}

function bashCommandSection(chain: string, limits: Limits, defaultTimeoutMs: number) {
  return `Usage notes:
  - Quote file paths containing spaces with double quotes. Verify a parent directory exists (\`ls\`) before creating files in it.
  - Optional timeout in milliseconds; commands will time out after ${defaultTimeoutMs}ms if not specified.
  - Output beyond ${limits.maxLines} lines or ${limits.maxBytes} bytes is truncated and saved to a file; read it with Read offset/limit or Grep. Do NOT pipe through \`head\`, \`tail\` or similar to limit output.
  - Independent commands: make multiple bash tool calls in one message. ${chain} Use ';' when later commands should run even if earlier ones fail. Do not separate commands with newlines.`
}

function powershellCommandSection(
  name: string,
  chain: string,
  pathSep: string,
  limits: Limits,
  defaultTimeoutMs: number,
) {
  return `${powershellNotes(name)}

Usage notes:
  - Quote file paths containing spaces with double quotes. Verify a parent directory exists (\`Test-Path -LiteralPath <parent>\`) before creating files in it.
  - Optional timeout in milliseconds; commands will time out after ${defaultTimeoutMs}ms if not specified.
  - Output beyond ${limits.maxLines} lines or ${limits.maxBytes} bytes is truncated and saved to a file; read it with Read offset/limit or Grep. Do NOT use \`Select-Object -First/-Last\` or similar to limit output.
  - Independent commands: make multiple bash tool calls in one message. ${chain} Use \`;\` when later commands should run even if earlier ones fail. Do not separate commands with newlines.`
}

function cmdCommandSection(chain: string, limits: Limits, defaultTimeoutMs: number) {
  return `# cmd.exe shell notes
- Use double quotes for paths with spaces.
- Use %VAR% for environment variables.
- Use \`if exist\` for existence checks.
- Use \`call\` when invoking batch files from another batch-style command.

Usage notes:
  - Quote file paths containing spaces with double quotes. Verify a parent directory exists (\`if exist\`) before creating files in it.
  - Optional timeout in milliseconds; commands will time out after ${defaultTimeoutMs}ms if not specified.
  - Output beyond ${limits.maxLines} lines or ${limits.maxBytes} bytes is truncated and saved to a file; read it with Read offset/limit or Grep. Do NOT use \`more\` or similar to limit output.
  - Independent commands: make multiple bash tool calls in one message. ${chain} Use \`&\` when later commands should run even if earlier ones fail. Do not separate commands with newlines.`
}

const NO_RETRY_RULE = `- On the first shell parse error (\`ParserError\`, "is not recognized", "not a valid regular expression", etc.), STOP retrying the same construct. Either (a) translate the command to this shell's native syntax, or (b) for anything multi-line or loop-shaped, write a script file with the Write tool (\`.py\`, \`.ps1\`, or \`.sh\` as appropriate) and execute it. Never attempt the same failing syntax pattern more than once.`

function shellAdaptationSection(name: string) {
  const header = "# Shell identity and failure adaptation"
  if (PS.has(name)) {
    return `${header}
- This host runs ${shellDisplayName(name)}, not a POSIX shell. POSIX-shaped commands are parse errors here: heredocs (\`<<\`), \`for f in ...; do ... done\` one-liners, and POSIX flag forms such as \`rm -f\` (PowerShell reads \`-f\` as an ambiguous parameter name).
${NO_RETRY_RULE}
- PowerShell regex and quoting rules differ from POSIX: use single-quoted verbatim strings for patterns so backslashes are not mangled, and prefer a script file over inline regex when unsure.`
  }
  if (CMD.has(name)) {
    return `${header}
- This host runs ${shellDisplayName(name)}, not a POSIX shell and not PowerShell. POSIX constructs (heredocs \`<<\`, \`for f in ...; do ... done\` one-liners, POSIX flag forms such as \`rm -f\`) and PowerShell cmdlets such as \`Remove-Item\` are both parse errors here.
${NO_RETRY_RULE}
- cmd.exe quoting and escaping rules differ from POSIX: use double quotes, escape \`%\` as \`%%\`, and prefer a script file over an elaborate inline one-liner.`
  }
  return `${header}
- This host runs ${name} (POSIX). PowerShell and cmd.exe idioms such as \`Remove-Item\`, \`Get-ChildItem\`, or \`if exist\` are not valid here; use POSIX equivalents.
${NO_RETRY_RULE}
- If a POSIX-shaped command ever produces a parse error, treat it as a shell-family mismatch rather than a typo and switch strategy instead of re-sending the same construct.`
}

function profile(name: string, platform: NodeJS.Platform, limits: Limits, defaultTimeoutMs: number) {
  const isPowerShell = PS.has(name)
  const chain = chainGuidance(name)
  if (CMD.has(name)) {
    return {
      intro: `Executes a given ${shellDisplayName(name)} command with optional timeout, ensuring proper handling and security measures.`,
      workdirSection:
        "Commands run in the working directory by default; use `workdir` to run elsewhere.",
      commandSection: cmdCommandSection(chain, limits, defaultTimeoutMs),
      gitCommands: "git commands",
      gitCommandRestriction: "git commands",
      createPrInstruction: "Create PR using a temporary body file so cmd.exe quoting stays simple.",
      createPrExample: `(\n  echo ## Summary\n  echo - ^<1-3 bullet points^>\n) > pr-body.txt\ngh pr create --title "the pr title" --body-file pr-body.txt`,
    }
  }
  if (isPowerShell) {
    return {
      intro: `Executes a given ${shellDisplayName(name)} command with optional timeout, ensuring proper handling and security measures.`,
      workdirSection:
        "Commands run in the working directory by default; use `workdir` to run elsewhere.",
      commandSection: powershellCommandSection(
        name,
        chain,
        platform === "win32" ? "\\" : "/",
        limits,
        defaultTimeoutMs,
      ),
      gitCommands: "git commands",
      gitCommandRestriction: "git commands",
      createPrInstruction: "Create PR using gh pr create with a PowerShell here-string to pass the body correctly.",
      createPrExample: `gh pr create --title "the pr title" --body @'
## Summary
- <1-3 bullet points>
'@`,
    }
  }
  return {
    intro:
      "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.",
    workdirSection:
      "Commands run in the working directory by default; use `workdir` to run elsewhere.",
    commandSection: bashCommandSection(chain, limits, defaultTimeoutMs),
    gitCommands: "bash commands",
    gitCommandRestriction: "git bash commands",
    createPrInstruction:
      "Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting.",
    createPrExample: `gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>`,
  }
}

export function render(name: string, platform: NodeJS.Platform, limits: Limits, defaultTimeoutMs: number) {
  const selected = profile(name, platform, limits, defaultTimeoutMs)
  return {
    description: renderPrompt(DESCRIPTION, {
      intro: selected.intro,
      os: platform,
      shell: name,
      tmp: Global.Path.tmp,
      shellAdaptation: shellAdaptationSection(name),
      workdirSection: selected.workdirSection,
      commandSection: selected.commandSection,
      gitCommands: selected.gitCommands,
      toolName: ShellID.ToolID,
      gitCommandRestriction: selected.gitCommandRestriction,
      createPrInstruction: selected.createPrInstruction,
      createPrExample: selected.createPrExample,
    }),
    parameters: parameterSchema(),
  }
}

export * as ShellPrompt from "./prompt"
