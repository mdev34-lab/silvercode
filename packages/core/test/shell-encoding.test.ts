import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import iconv from "iconv-lite"
import {
  parseWindowsCmdCodePage,
  shellOutputDecoder,
  windowsCmdCodePage,
  windowsPowerShellCommand,
} from "../src/shell-encoding"

const text = "Área de Trabalho - ação 日本語 😀"
const command = `[Console]::Write('${text}'); [Console]::Error.Write('${text}'); exit 7`
const pwsh = Bun.which("pwsh") || Bun.which("powershell")
const defaultCmd = process.env.COMSPEC || "cmd.exe"
const startupCodepage = process.platform === "win32" ? windowsCmdCodePage(defaultCmd) : undefined

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
const readCodePage = (stdout: Buffer, offset = 0) => {
  const end = stdout.indexOf(0x0a, offset)
  if (end < 0) throw new Error(`Missing chcp report in stdout: ${stdout.toString("hex")}`)
  const line = stdout.subarray(offset, end).toString("ascii")
  const match = /(\d+)\r?$/.exec(line)
  if (!match) throw new Error(`Invalid chcp report ${JSON.stringify(line)}`)
  return { codepage: Number(match[1]), offset: end + 1 }
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

  test("parses localized chcp output with trailing punctuation", () => {
    expect(parseWindowsCmdCodePage("Aktive Codepage: 437.\r\n")).toBe(437)
    expect(parseWindowsCmdCodePage("Página de código ativa: 860.\r\n")).toBe(860)
    expect(parseWindowsCmdCodePage("codepage unavailable\r\n")).toBeUndefined()
  })

  test("memoizes bounded codepage probes per shell", () => {
    let calls = 0
    const options = {
      platform: "win32" as const,
      probe: (shell: string, timeout: number) => {
        calls++
        expect(timeout).toBe(2_000)
        return { status: 0, stdout: `Aktive Codepage: ${shell.includes("other") ? 860 : 437}.\r\n` }
      },
    }
    expect(windowsCmdCodePage("cmd-cache.exe", options)).toBe(437)
    expect(windowsCmdCodePage("cmd-cache.exe", options)).toBe(437)
    expect(windowsCmdCodePage("cmd-cache-other.exe", options)).toBe(860)
    expect(calls).toBe(2)

    let failures = 0
    const failed = {
      platform: "win32" as const,
      probe: () => {
        failures++
        return { status: 1, stdout: "" }
      },
    }
    expect(windowsCmdCodePage("cmd-cache-failure.exe", failed)).toBeUndefined()
    expect(windowsCmdCodePage("cmd-cache-failure.exe", failed)).toBeUndefined()
    expect(failures).toBe(1)
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

  test("documents that mid-stream encoding changes are not tracked", () => {
    const decoder = shellOutputDecoder("cmd.exe", { platform: "win32", codepage: 437 })
    const legacy = iconv.encode("á", "437")
    const utf8 = Buffer.from("á", "utf8")
    expect(decoder.decode(legacy)).toBe("á")
    expect(decoder.decode(utf8) + decoder.end()).toBe("├í")
  })

  test("warns and falls back when the legacy decoder cannot be loaded", () => {
    const decoder = shellOutputDecoder("cmd.exe", {
      platform: "win32",
      codepage: 437,
      loadIconv: () => {
        throw new Error("MODULE_NOT_FOUND")
      },
    })
    expect(decoder.warning).toBe("cmd.exe output codepage 437 is unsupported; decoding output as UTF-8.")
    expect(decoder.decode(new TextEncoder().encode("ação")) + decoder.end()).toBe("ação")
  })

  test("recognizes quoted cmd invocations and warns for cmd wrappers", () => {
    for (const shell of ['"cmd.exe"', "cmd.exe /d", '"C:\\Program Files\\Windows\\cmd.exe" /d /s']) {
      const decoder = shellOutputDecoder(shell, { platform: "win32", codepage: 437 })
      expect(decoder.warning).toBeUndefined()
      expect(decoder.decode(iconv.encode("á", "437")) + decoder.end()).toBe("á")
    }
    for (const shell of ["wrapper.cmd", "C:\\tools\\wrapper.bat /d"]) {
      const decoder = shellOutputDecoder(shell, { platform: "win32", codepage: 437 })
      expect(decoder.warning).toContain("cmd-like shell")
      expect(decoder.decode(new TextEncoder().encode("ação")) + decoder.end()).toBe("ação")
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
  // The Windows runner supplies the headless scenario. Fresh-console and
  // inherited-console launches intentionally remain unverified; this test only
  // covers the hidden/piped child and requires it to report its own codepage.
  ;(process.platform === "win32" ? test : test.skip)(
    "matches the probe to a hidden cmd child's own codepage and output bytes",
    () => {
      const directory = mkdtempSync(path.join(tmpdir(), "shell-encoding-"))
      try {
        const shell = defaultCmd
        const codepage = startupCodepage
        if (!codepage) throw new Error("Windows cmd process codepage is unavailable")
        if (codepage !== 65001 && !iconv.encodingExists(String(codepage)))
          throw new Error(`Unsupported Windows cmd codepage: ${codepage}`)
        const file = ["Área de Trabalho.txt", "área de trabalho.txt"].find((candidate) => {
          const bytes = encode(candidate, codepage)
          return roundtrip(candidate, codepage) === candidate && bytes.some((byte) => byte >= 0x80)
        })
        if (!file) throw new Error(`The accented fixtures are not representable in cmd codepage ${codepage}`)

        writeFileSync(path.join(directory, file), "")
        const child = spawnSync("chcp & dir /b *.txt & exit /b 7", {
          cwd: directory,
          shell,
          windowsHide: true,
        })
        expect(child.error).toBeUndefined()
        expect(child.status).toBe(7)
        const actual = readCodePage(child.stdout)
        const output = child.stdout.subarray(actual.offset)
        console.log(
          `headless cmd.exe probe=${codepage}; child=${actual.codepage}; file=${JSON.stringify(file)}; dir=${output.toString("hex")}`,
        )
        expect(actual.codepage).toBe(codepage)
        expect(output.toString("hex")).toBe(encode(`${file}\r\n`, actual.codepage).toString("hex"))
        expect(output.some((byte) => byte >= 0x80)).toBe(true)
        const decoder = shellOutputDecoder(shell)
        expect(decoder.warning).toBeUndefined()
        expect(decoder.decode(output) + decoder.end()).toBe(`${file}\r\n`)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
  test.skipIf(process.platform !== "win32" || startupCodepage === 65001)(
    "documents hidden cmd chcp bytes (requires a non-UTF-8 startup codepage)",
    () => {
      const shell = defaultCmd
      const codepage = startupCodepage
      if (!codepage) throw new Error("Windows cmd process codepage is unavailable")
      const directory = mkdtempSync(path.join(tmpdir(), "shell-encoding-chcp-"))
      try {
        if (codepage !== 65001 && !iconv.encodingExists(String(codepage)))
          throw new Error(`Unsupported Windows cmd codepage: ${codepage}`)
        const file = ["Área de Trabalho.txt", "área de trabalho.txt"].find((candidate) => {
          const bytes = encode(candidate, codepage)
          return roundtrip(candidate, codepage) === candidate && bytes.some((byte) => byte >= 0x80)
        })
        if (!file) throw new Error(`The accented fixtures are not representable in cmd codepage ${codepage}`)

        writeFileSync(path.join(directory, file), "")
        const child = spawnSync("chcp & chcp.com 65001 >nul & chcp & dir /b *.txt & exit /b 7", {
          cwd: directory,
          shell,
          windowsHide: true,
        })
        expect(child.error).toBeUndefined()
        expect(child.status).toBe(7)
        const before = readCodePage(child.stdout)
        const after = readCodePage(child.stdout, before.offset)
        const output = child.stdout.subarray(after.offset)
        console.log(
          `headless cmd.exe chcp: probe=${codepage}; before=${before.codepage}; after=${after.codepage}; file=${JSON.stringify(file)}; dir=${output.toString("hex")}`,
        )
        expect(before.codepage).toBe(codepage)
        expect(before.codepage).not.toBe(65001)
        expect(after.codepage).toBe(65001)
        // This proves the reported codepage changed while the builtin's bytes did
        // not. It is not coverage for tracking a real output-encoding transition.
        expect(output.toString("hex")).toBe(encode(`${file}\r\n`, before.codepage).toString("hex"))
        expect(output.some((byte) => byte >= 0x80)).toBe(true)
        const decoder = shellOutputDecoder(shell)
        expect(decoder.warning).toBeUndefined()
        expect(decoder.decode(output) + decoder.end()).toBe(`${file}\r\n`)
      } finally {
        try {
          const restored = spawnSync(`chcp.com ${codepage} >nul`, { shell, windowsHide: true })
          expect(restored.error).toBeUndefined()
          expect(restored.status).toBe(0)
        } finally {
          rmSync(directory, { recursive: true, force: true })
        }
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
