import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import iconv from "iconv-lite"
import { shellOutputDecoder, windowsCmdCodePage, windowsPowerShellCommand } from "../src/shell-encoding"

const text = "Área de Trabalho - ação 日本語 😀"
const command = `[Console]::Write('${text}'); [Console]::Error.Write('${text}'); exit 7`
const pwsh = Bun.which("pwsh") || Bun.which("powershell")

const decode = (shell: string, chunks: ReadonlyArray<Uint8Array>, platform: NodeJS.Platform, codepage?: number) => {
  const decoder = shellOutputDecoder(shell, { platform, codepage })
  return chunks.map((chunk) => decoder.decode(chunk)).join("") + decoder.end()
}

const encode = (value: string, codepage: number) =>
  codepage === 65001 ? Buffer.from(value, "utf8") : iconv.encode(value, String(codepage))
const roundtrip = (value: string, codepage: number) => {
  const bytes = encode(value, codepage)
  return codepage === 65001 ? bytes.toString("utf8") : iconv.decode(bytes, String(codepage))
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

  test("flushes trailing incomplete UTF-8 and legacy multibyte sequences", () => {
    for (const [shell, platform, codepage, lead] of [
      ["/bin/sh", "linux", undefined, 0xc3],
      ["pwsh", "win32", 65001, 0xc3],
      ["cmd.exe", "win32", 932, 0x82],
    ] as const) {
      const decoder = shellOutputDecoder(shell, { platform, codepage })
      expect(decoder.decode(Uint8Array.of(0x61, lead))).toBe("a")
      expect(decoder.end()).toBe("�")
    }
  })

  test("warns when a cmd codepage is unsupported and falls back to UTF-8", () => {
    const decoder = shellOutputDecoder("cmd.exe", { platform: "win32", codepage: 1_000_000 })
    expect(decoder.warning).toContain("1000000")
    const bytes = new TextEncoder().encode("ação")
    expect(decoder.decode(bytes) + decoder.end()).toBe("ação")
  })

  test("warns when the inherited cmd codepage cannot be determined", () => {
    const decoder = shellOutputDecoder("cmd.exe", { platform: "win32", codepage: null })
    expect(decoder.warning).toContain("Unable to determine")
    expect(decoder.decode(new TextEncoder().encode("ação")) + decoder.end()).toBe("ação")
  })
  ;(process.platform === "win32" ? test : test.skip)(
    "emits real non-ASCII cmd bytes and decodes them with the inherited process codepage",
    () => {
      const directory = mkdtempSync(path.join(tmpdir(), "shell-encoding-"))
      try {
        const shell = process.env.COMSPEC || "cmd.exe"
        const codepage = windowsCmdCodePage(shell)
        if (!codepage) throw new Error("Windows cmd process codepage is unavailable")
        if (codepage !== 65001 && !iconv.encodingExists(String(codepage)))
          throw new Error(`Unsupported Windows cmd codepage: ${codepage}`)
        const file = ["Área de Trabalho.txt", "área de trabalho.txt"].find((candidate) => {
          const bytes = encode(candidate, codepage)
          return roundtrip(candidate, codepage) === candidate && bytes.some((byte) => byte >= 0x80)
        })
        if (!file) throw new Error(`The accented fixtures are not representable in cmd codepage ${codepage}`)

        writeFileSync(path.join(directory, file), "")
        const child = spawnSync("dir /b *.txt & exit /b 7", { cwd: directory, shell, windowsHide: true })
        console.log(
          `cmd.exe codepage=${codepage}; file=${JSON.stringify(file)}; stdout=${child.stdout.toString("hex")}`,
        )
        expect(child.error).toBeUndefined()
        expect(child.status).toBe(7)
        expect(child.stdout.toString("hex")).toBe(encode(`${file}\r\n`, codepage).toString("hex"))
        expect(child.stdout.some((byte) => byte >= 0x80)).toBe(true)
        const decoder = shellOutputDecoder(shell)
        expect(decoder.warning).toBeUndefined()
        expect(decoder.decode(child.stdout) + decoder.end()).toBe(`${file}\r\n`)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
  ;(process.platform === "win32" ? test : test.skip)(
    "decodes real cmd output inherited from a non-default UTF-8 console",
    () => {
      const directory = mkdtempSync(path.join(tmpdir(), "shell-encoding-utf8-"))
      try {
        const file = "Área de Trabalho.txt"
        const module = pathToFileURL(path.join(__dirname, "../src/shell-encoding.ts")).href
        const probe = path.join(directory, "probe.ts")
        const runner = path.join(directory, "probe.cmd")
        writeFileSync(
          probe,
          `import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { shellOutputDecoder, windowsCmdCodePage } from ${JSON.stringify(module)}
const file = ${JSON.stringify(file)}
writeFileSync(path.join(import.meta.dir, file), "")
const shell = process.env.COMSPEC || "cmd.exe"
const codepage = windowsCmdCodePage(shell)
const child = spawnSync("dir /b *.txt & exit /b 7", { cwd: import.meta.dir, shell, windowsHide: true })
const decoder = shellOutputDecoder(shell)
process.stdout.write(JSON.stringify({
  codepage,
  status: child.status,
  error: child.error?.message,
  stdout: child.stdout.toString("hex"),
  output: decoder.decode(child.stdout) + decoder.end(),
  warning: decoder.warning,
}))
`,
        )
        writeFileSync(
          runner,
          ["@echo off", "chcp.com 65001 >nul", `"${process.execPath}" "${probe}"`, "exit /b %ERRORLEVEL%", ""].join(
            "\r\n",
          ),
        )
        const shell = process.env.COMSPEC || "cmd.exe"
        const child = spawnSync(runner, { cwd: directory, shell, encoding: "utf8", windowsHide: true })
        console.log(`cmd.exe UTF-8 console: status=${child.status}; stdout=${child.stdout.trim()}`)
        expect(child.error).toBeUndefined()
        expect(child.status).toBe(0)
        expect(child.stderr).toBe("")
        const result: {
          codepage?: number
          status: number | null
          error?: string
          stdout: string
          output: string
          warning?: string
        } = JSON.parse(child.stdout)
        expect(result.error).toBeUndefined()
        expect(result.codepage).toBe(65001)
        expect(result.warning).toBeUndefined()
        expect(result.status).toBe(7)
        expect(result.stdout).toBe(Buffer.from(`${file}\r\n`, "utf8").toString("hex"))
        expect(result.output).toBe(`${file}\r\n`)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
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
