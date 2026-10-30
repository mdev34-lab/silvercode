import { spawnSync } from "node:child_process"
import path from "node:path"
import iconv from "iconv-lite"

/** The text readers consume UTF-8, but Windows PowerShell inherits a legacy console encoding. */
export function windowsPowerShellCommand(shell: string, command: string, platform = process.platform): string {
  if (platform !== "win32" || !/(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(shell)) return command
  // Both the host's stdout/stderr and text piped to native commands must agree.
  // Keep the original command on its own line, including leading comments.
  return "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n" + command
}

function windowsConsoleCodePage() {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir
  if (!root) return undefined
  const result = spawnSync(path.win32.join(root, "System32", "chcp.com"), {
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.error || result.status !== 0) return undefined
  const match = result.stdout.match(/(\d+)\s*$/)
  return match ? Number(match[1]) : undefined
}

/** PowerShell is initialized as UTF-8 above; cmd builtins require the console's legacy codepage. */
export function shellOutputDecoder(
  shell: string,
  options: { platform?: NodeJS.Platform; codepage?: number; ignoreBOM?: boolean } = {},
) {
  const platform = options.platform ?? process.platform
  if (platform === "win32" && /(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell)) {
    const codepage = options.codepage ?? windowsConsoleCodePage()
    const encoding = String(codepage)
    if (codepage !== 65001 && iconv.encodingExists(encoding)) {
      const decoder = iconv.getDecoder(encoding)
      return {
        decode: (bytes: Uint8Array) => decoder.write(Buffer.from(bytes)),
        end: () => decoder.end() ?? "",
      }
    }
  }

  const decoder = new TextDecoder("utf-8", { ignoreBOM: options.ignoreBOM })
  return {
    decode: (bytes: Uint8Array) => decoder.decode(bytes, { stream: true }),
    end: () => decoder.decode(),
  }
}
