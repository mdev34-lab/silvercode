import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Shell } from "../src/shell"
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
  const env = { SystemRoot: "C:\\Windows" }
  test("switches the console codepage with the absolute System32 helper and keeps the command intact", () => {
    const wrapped = windowsCmdCommand("C:\\Windows\\System32\\cmd.exe", "dir", "win32", env)
    expect(wrapped).toBe("C:\\Windows\\System32\\chcp.com 65001>nul & dir")
    expect(windowsCmdCommand("cmd", "dir", "win32", env)).toBe(wrapped)
  })

  test("never uses a bare chcp: unsafe or missing system root leaves the command unchanged", () => {
    for (const SystemRoot of [undefined, "", "relative", 'C:\\W"in', "C:\\%PATH%", "C:\\a&b", "C:\\Program Files\\Win"])
      expect(windowsCmdCommand("cmd.exe", "dir", "win32", { SystemRoot })).toBe("dir")
  })

  test("leaves other shells and non-Windows hosts unchanged", () => {
    for (const shell of ["pwsh", "C:\\Git\\bin\\bash.exe", "/bin/sh"]) expect(windowsCmdCommand(shell, "dir", "win32", env)).toBe("dir")
    expect(windowsCmdCommand("cmd.exe", "dir", "linux", env)).toBe("dir")
  })
  ;(process.platform === "win32" ? test : test.skip)("real cmd.exe emits UTF-8 through the actual spawn shapes, preserves the exit code and ignores a project chcp", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cmd-chcp-"))
    try {
      writeFileSync(path.join(dir, "chcp.cmd"), "@echo HIJACKED\r\n")
      writeFileSync(path.join(dir, "chcp.bat"), "@echo HIJACKED\r\n")
      const cmd = process.env.COMSPEC || "cmd.exe"
      const echo = `echo ${text.split(" ")[0]} & exit /b 7`
      const wrapped = windowsCmdCommand(cmd, echo)
      expect(wrapped).not.toBe(echo)
      const shapes = {
        // Shell.args applies the wrapper itself: argv form, piped stdio, hidden window.
        args: spawnSync(cmd, Shell.args(cmd, echo, dir), { cwd: dir, windowsHide: true }),
        // Spawn with the shell option: the host builds /d /s /c "<command>".
        shell: spawnSync(wrapped, { cwd: dir, shell: cmd, windowsHide: true }),
      }
      const base = spawnSync(echo, { cwd: dir, shell: cmd, windowsHide: true })
      console.log("cmd baseline utf8 =", base.stdout.toString("utf8").includes("Área"))
      for (const [name, out] of Object.entries(shapes)) {
        expect({ name, status: out.status }).toEqual({ name, status: 7 })
        expect({ name, out: out.stdout.toString("utf8").includes("Área") }).toEqual({ name, out: true })
        expect(out.stdout.toString("utf8")).not.toContain("HIJACKED")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
