import { spawnSync } from "node:child_process"

/** The text readers consume UTF-8, but Windows PowerShell inherits a legacy console encoding. */
export function windowsPowerShellCommand(shell: string, command: string, platform = process.platform): string {
  if (platform !== "win32" || !/(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(shell)) return command
  // Both the host's stdout/stderr and text piped to native commands must agree.
  // Keep the original command on its own line, including leading comments.
  return "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n" + command
}

/** Probe a fresh cmd through the same shell option used to run commands, so it reports its inherited startup codepage. */
export function windowsCmdCodePage(shell: string) {
  if (process.platform !== "win32") return undefined
  const result = spawnSync("chcp", { shell, encoding: "utf8", windowsHide: true })
  if (result.error || result.status !== 0) return undefined
  const match = result.stdout.match(/(\d+)\s*$/)
  return match ? Number(match[1]) : undefined
}

type OutputDecoder = {
  decode: (bytes: Uint8Array) => string
  end: () => string
  warning?: string
}

/** PowerShell is initialized as UTF-8 above; cmd builtins use the codepage inherited when their process starts. */
export function shellOutputDecoder(
  shell: string,
  options: { platform?: NodeJS.Platform; codepage?: number | null; ignoreBOM?: boolean } = {},
): OutputDecoder {
  const platform = options.platform ?? process.platform
  let warning: string | undefined
  if (platform === "win32" && /(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell)) {
    // This startup snapshot stays fixed for the decoder's lifetime. A command
    // that later runs `chcp`, or a native program emitting another encoding,
    // is not tracked; its bytes are still decoded with this initial codepage.
    const codepage = options.codepage === undefined ? windowsCmdCodePage(shell) : options.codepage
    if (codepage === null || codepage === undefined) {
      warning = "Unable to determine the inherited cmd.exe output codepage; decoding output as UTF-8."
    } else if (codepage !== 65001) {
      const encoding = String(codepage)
      const iconv: typeof import("iconv-lite") = require("iconv-lite")
      if (iconv.encodingExists(encoding)) {
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
