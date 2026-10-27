import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { windowsCmdCommand, windowsPowerShellCommand } from "../src/shell-encoding"

const text = "Área de Trabalho - ação 日本語 😀"
const command = `[Console]::Write('${text}'); [Console]::Error.Write('${text}'); exit 7`
const pwsh = Bun.which("pwsh") || Bun.which("powershell")

describe("PowerShell UTF-8 output (#543)", () => {
  test("initializes Windows PowerShell output without rewriting the command", () => {
    const wrapped = windowsPowerShellCommand("C:\\tools\\PowerShell.EXE", command, "win32")
    expect(wrapped).toContain("[Console]::OutputEncoding")
    expect(wrapped).toContain("$OutputEncoding")
    expect(wrapped.endsWith(command)).toBe(true)
    expect(windowsPowerShellCommand("pwsh", command, "win32")).toBe(wrapped)
  })

  test("leaves POSIX shells and non-Windows PowerShell unchanged", () => {
    for (const shell of ["C:\\Git\\bin\\bash.exe", "/bin/sh"])
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

describe("cmd.exe UTF-8 output (#543)", () => {
  test("switches the console codepage first and keeps the command intact", () => {
    const wrapped = windowsCmdCommand("C:\\Windows\\System32\\cmd.exe", "dir", "win32")
    expect(wrapped).toBe("chcp 65001>nul & dir")
    expect(windowsCmdCommand("cmd", "dir", "win32")).toBe(wrapped)
  })

  test("leaves other shells and non-Windows hosts unchanged", () => {
    for (const shell of ["pwsh", "C:\\Git\\bin\\bash.exe", "/bin/sh"]) expect(windowsCmdCommand(shell, "dir", "win32")).toBe("dir")
    expect(windowsCmdCommand("cmd.exe", "dir", "linux")).toBe("dir")
  })
  ;(process.platform === "win32" ? test : test.skip)("real cmd.exe emits UTF-8 and preserves the exit code", () => {
    const echo = `echo ${text.split(" ")[0]} & exit /b 7`
    const run = (c: string) => spawnSync(process.env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", c])
    const after = run(windowsCmdCommand("cmd.exe", echo))
    expect(after.status).toBe(7)
    expect(after.stdout.toString("utf8")).toContain("Área")
  })
})
