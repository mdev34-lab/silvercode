import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const codepages = new Map<string, number | undefined>()

/** The text readers consume UTF-8, but Windows PowerShell inherits a legacy console encoding. */
export function windowsPowerShellCommand(shell: string, command: string, platform = process.platform): string {
  if (platform !== "win32" || !/(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(shell)) return command
  // Both the host's stdout/stderr and text piped to native commands must agree.
  // Keep the original command on its own line, including leading comments.
  return "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n" + command
}

type CmdProbe = (
  shell: string,
  timeout: number,
) => {
  error?: Error
  status: number | null
  stdout: string
}

export function parseWindowsCmdCodePage(stdout: string) {
  const match = /(\d{3,6})/.exec(stdout)
  return match ? Number(match[1]) : undefined
}

/**
 * Probe a fresh cmd through the same shell option used to run commands, so it reports its inherited startup codepage.
 * Integration coverage is limited to this exact hidden/piped spawn shape in the headless Windows runner. Tests do not
 * create a fresh console or inherit an existing one; those scenarios and other no-console launch mechanisms are
 * unverified, so no effective-codepage guarantee is claimed for them.
 */
export function windowsCmdCodePage(shell: string, options: { platform?: NodeJS.Platform; probe?: CmdProbe } = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== "win32") return undefined
  if (codepages.has(shell)) return codepages.get(shell)

  let codepage: number | undefined
  try {
    const probe =
      options.probe ??
      ((shell: string, timeout: number) => spawnSync("chcp", { shell, encoding: "utf8", windowsHide: true, timeout }))
    const result = probe(shell, 2_000)
    if (!result.error && result.status === 0) codepage = parseWindowsCmdCodePage(result.stdout)
  } catch {}
  // Cache failures too, so a failed or timed-out probe cannot block every command.
  codepages.set(shell, codepage)
  return codepage
}

type OutputDecoder = {
  decode: (bytes: Uint8Array) => string
  end: () => string
  warning?: string
}

const executable = (shell: string) => {
  const value = shell.trim()
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1)
    if (end > 0) return value.slice(1, end)
  }
  return value.split(/\s+/, 1)[0] ?? value
}

const isCmd = (shell: string) => /(?:^|[\\/])cmd(?:\.exe)?$/i.test(executable(shell))
const isCmdWrapper = (shell: string) => /\.(?:bat|cmd)$/i.test(executable(shell))

/** PowerShell is initialized as UTF-8 above; cmd builtins use the codepage inherited when their process starts. */
export function shellOutputDecoder(
  shell: string,
  options: {
    platform?: NodeJS.Platform
    codepage?: number | null
    ignoreBOM?: boolean
    loadIconv?: () => typeof import("iconv-lite")
  } = {},
): OutputDecoder {
  const platform = options.platform ?? process.platform
  let warning: string | undefined
  const cmd = platform === "win32" && isCmd(shell)
  if (platform === "win32" && !cmd && isCmdWrapper(shell)) {
    warning = `Unable to determine the inherited cmd.exe output codepage for cmd-like shell ${JSON.stringify(shell)}; decoding output as UTF-8.`
  }
  if (cmd) {
    // This startup snapshot stays fixed for the decoder's lifetime. A command
    // that later runs `chcp`, or a native program emitting another encoding,
    // is not tracked; its bytes are still decoded with this initial codepage.
    const codepage = options.codepage === undefined ? windowsCmdCodePage(shell) : options.codepage
    if (codepage === null || codepage === undefined) {
      warning = "Unable to determine the inherited cmd.exe output codepage; decoding output as UTF-8."
    } else if (codepage !== 65001) {
      const encoding = String(codepage)
      let iconv: typeof import("iconv-lite") | undefined
      try {
        iconv = (options.loadIconv ?? (() => require("iconv-lite")))()
      } catch {}
      if (iconv?.encodingExists(encoding)) {
        const decoder = iconv.getDecoder(encoding)
        return {
          decode: (bytes: Uint8Array) => decoder.write(Buffer.from(bytes)),
          end: () => decoder.end() ?? "",
        }
      }
      warning = `cmd.exe output codepage ${codepage} is unsupported; decoding output as UTF-8.`
    }
  }

  const decoder = new TextDecoder("utf-8", { ignoreBOM: options.ignoreBOM })
  return {
    decode: (bytes: Uint8Array) => decoder.decode(bytes, { stream: true }),
    end: () => decoder.decode(),
    warning,
  }
}
