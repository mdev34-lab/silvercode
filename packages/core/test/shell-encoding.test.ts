import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { shellOutputDecoder, windowsPowerShellCommand } from "../src/shell-encoding"

const text = "Área de Trabalho - ação 日本語 😀"
const command = `[Console]::Write('${text}'); [Console]::Error.Write('${text}'); exit 7`
const pwsh = Bun.which("pwsh") || Bun.which("powershell")

const decode = (shell: string, chunks: ReadonlyArray<Uint8Array>, platform: NodeJS.Platform, codepage?: number) => {
  const decoder = shellOutputDecoder(shell, { platform, codepage })
  return chunks.map((chunk) => decoder.decode(chunk)).join("") + decoder.end()
}

describe("shell output decoding (#543)", () => {
  test("decodes synthetic Windows ANSI and OEM bytes with the console codepage", () => {
    const area = [0x72, 0x65, 0x61, 0x20, 0x64, 0x65, 0x20, 0x54, 0x72, 0x61, 0x62, 0x61, 0x6c, 0x68, 0x6f]
    expect(decode("cmd.exe", [Uint8Array.from([0xc1, ...area])], "win32", 1252)).toBe("Área de Trabalho")
    expect(
      decode(
        "C:\\Windows\\System32\\cmd.exe",
        [Uint8Array.from([0x86, ...area, 0x0a, 0x61, 0x87, 0x84, 0x6f])],
        "win32",
        860,
      ),
    ).toBe("Área de Trabalho\nação")
  })

  test("keeps UTF-8 and POSIX decoding unchanged", () => {
    const bytes = new TextEncoder().encode(text)
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte))
    for (const [shell, platform, codepage] of [
      ["/bin/sh", "linux", undefined],
      ["pwsh", "win32", 1252],
      ["cmd.exe", "win32", 65001],
    ] as const)
      expect(decode(shell, chunks, platform, codepage)).toBe(text)

    expect(decode("/bin/sh", [Uint8Array.from([0xc1, 0x72, 0x65, 0x61])], "linux", 1252)).toBe("�rea")

    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, 0x41])
    const buffered = shellOutputDecoder("/bin/sh", { platform: "linux", ignoreBOM: true })
    expect(buffered.decode(bom) + buffered.end()).toBe("\uFEFFA")
    const streamed = shellOutputDecoder("/bin/sh", { platform: "linux" })
    expect(streamed.decode(bom) + streamed.end()).toBe("A")
  })
  ;(process.platform === "win32" ? test : test.skip)("decodes real cmd builtin output and preserves its exit", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "shell-encoding-"))
    try {
      const file = "área-ç.txt"
      writeFileSync(path.join(directory, file), "")
      const shell = process.env.COMSPEC || "cmd.exe"
      const child = spawnSync("dir /b *.txt & exit /b 7", { cwd: directory, shell, windowsHide: true })
      expect(child.error).toBeUndefined()
      expect(child.status).toBe(7)
      const decoder = shellOutputDecoder(shell)
      expect(decoder.decode(child.stdout) + decoder.end()).toBe(`${file}\r\n`)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("PowerShell UTF-8 output (#543)", () => {
  test("initializes Windows PowerShell output without rewriting the command", () => {
    const wrapped = windowsPowerShellCommand("C:\\tools\\PowerShell.EXE", command, "win32")
    expect(wrapped).toContain("[Console]::OutputEncoding")
    expect(wrapped).toContain("$OutputEncoding")
    expect(wrapped.endsWith(command)).toBe(true)
    expect(windowsPowerShellCommand("pwsh", command, "win32")).toBe(wrapped)
  })

  test("leaves POSIX shells and non-Windows PowerShell unchanged", () => {
    for (const shell of ["cmd.exe", "C:\\Git\\bin\\bash.exe", "/bin/sh"])
      expect(windowsPowerShellCommand(shell, command, "win32")).toBe(command)
    expect(windowsPowerShellCommand("pwsh", command, "linux")).toBe(command)
  })
  ;(pwsh ? test : test.skip)(
    "real PowerShell restores UTF-8 stdout/stderr after a legacy codepage and preserves exit",
    () => {
      const setup = "[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(1252);\n"
      const invoke = (script: string) =>
        spawnSync(pwsh!, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script])
      const before = invoke(setup + command)
      expect(before.status).toBe(7)
      expect(before.stdout.toString("utf8")).not.toBe(text)
      const after = invoke(setup + windowsPowerShellCommand(pwsh!, command, "win32"))
      expect(after.status).toBe(7)
      expect(after.stdout.toString("utf8")).toBe(text)
      expect(after.stderr.toString("utf8")).toBe(text)
      expect(after.stdout.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false)
    },
  )
})
