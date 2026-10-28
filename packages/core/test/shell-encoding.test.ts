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

describe("cmd.exe UTF-8 output (#543)", () => {
  const env = { SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe" }
  const prefix = "C:\\Windows\\System32\\chcp.com 65001>nul & %COMSPEC% /d /s /c "

  test("switches the codepage using the absolute helper and starts a new cmd", () => {
    const wrapped = windowsCmdCommand("C:\\Windows\\System32\\cmd.exe", "dir", "win32", env)
    expect(wrapped).toBe(`${prefix}^"dir^"`)
    expect(windowsCmdCommand("cmd", "dir", "win32", env)).toBe(wrapped)
  })

  test("preserves embedded quotes and escapes the outer cmd's metacharacters", () => {
    const line = 'echo "a & b" && echo ^"quoted^" | findstr txt'
    expect(windowsCmdCommand("cmd.exe", line, "win32", env)).toBe(
      `${prefix}^"echo "a & b" ^&^& echo ^^^"quoted^^^" ^| findstr txt^"`,
    )
    expect(windowsCmdCommand("cmd.exe", 'echo "open', "win32", env)).toBe(`${prefix}^"echo "open"`)
  })

  test("never uses a bare chcp: unsafe or missing system root leaves the command unchanged", () => {
    for (const SystemRoot of [undefined, "", "relative", 'C:\\W"in', "C:\\%PATH%", "C:\\a&b", "C:\\Program Files\\Win"])
      expect(windowsCmdCommand("cmd.exe", "dir", "win32", { ...env, SystemRoot })).toBe("dir")
  })

  test("leaves the command alone when COMSPEC cannot safely name the inner cmd", () => {
    for (const ComSpec of [
      undefined,
      "",
      "cmd.exe",
      "C:\\Program Files\\cmd.exe",
      "C:\\evil&cmd.exe",
      "C:\\Windows\\pwsh.exe",
    ])
      expect(windowsCmdCommand("cmd.exe", "dir", "win32", { ...env, ComSpec })).toBe("dir")
    expect(windowsCmdCommand("cmd.exe", "dir", "win32", { ...env, COMSPEC: env.ComSpec })).toBe("dir")
  })

  test("leaves other shells, non-Windows hosts, and multiline commands unchanged", () => {
    for (const shell of ["pwsh", "C:\\Git\\bin\\bash.exe", "/bin/sh"])
      expect(windowsCmdCommand(shell, "dir", "win32", env)).toBe("dir")
    expect(windowsCmdCommand("cmd.exe", "dir", "linux", env)).toBe("dir")
    expect(windowsCmdCommand("cmd.exe", "echo one\r\necho two", "win32", env)).toBe("echo one\r\necho two")
  })

  test("the argv route still passes cmd's command unchanged", () => {
    const line = 'echo "a b" && dir /b'
    expect(Shell.args("cmd", line, "C:\\tmp")).toEqual(["/c", line])
  })
  ;(process.platform === "win32" ? test : test.skip)(
    "real cmd.exe shell-option spawn emits UTF-8, preserves exit and ignores a project chcp",
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), "cmd-chcp-"))
      try {
        writeFileSync(path.join(dir, "chcp.cmd"), "@echo HIJACKED\r\n")
        writeFileSync(path.join(dir, "chcp.bat"), "@echo HIJACKED\r\n")
        const cmd = process.env.COMSPEC || "cmd.exe"
        const file = "ação-日本.txt"
        writeFileSync(path.join(dir, file), "")
        const line = "dir /b *.txt & exit /b 7"
        const wrapped = windowsCmdCommand(cmd, line)
        expect(wrapped).not.toBe(line)
        const options = {
          cwd: dir,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
          timeout: 5_000,
        }
        // This reports a separate child's codepage, not the parent's console state.
        const sysRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir
        const probe = () => {
          const out = spawnSync(`${sysRoot}\\System32\\chcp.com`, { ...options, cwd: tmpdir(), shell: cmd })
          expect(out.error).toBeUndefined()
          expect(out.status).toBe(0)
          return out.stdout.toString("utf8").trim()
        }
        const cpBefore = probe()
        const base = spawnSync(line, { ...options, shell: cmd })
        const args = spawnSync(cmd, Shell.args(cmd, line, dir), options)
        const shell = spawnSync(wrapped, { ...options, shell: cmd })
        const level = spawnSync(windowsCmdCommand(cmd, "if errorlevel 1 (echo LEVEL=BAD) else (echo LEVEL=OK)"), {
          ...options,
          shell: cmd,
        })
        for (const [name, out] of Object.entries({ base, args, shell, level })) {
          console.log(
            `cmd shape ${name}: status=${out.status} stdout=${out.stdout?.toString("hex")} stderr=${out.stderr?.toString("utf8").trim()}`,
          )
          expect(out.error).toBeUndefined()
        }
        expect(base.status).toBe(7)
        expect(args.status).toBe(7)
        expect(shell.status).toBe(7)
        expect(level.status).toBe(0)
        expect(level.stdout.toString("utf8")).toContain("LEVEL=OK")
        expect(probe()).toBe(cpBefore)
        // argv is intentionally not fixed: it must still behave like the unwrapped baseline.
        expect(args.stdout).toEqual(base.stdout)
        expect(args.stdout.toString("utf8")).not.toContain("HIJACKED")
        expect(shell.stdout.toString("utf8")).toContain(file)
        expect(shell.stdout.toString("utf8")).not.toContain("HIJACKED")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
  ;(process.platform === "win32" ? test : test.skip)(
    "real shell-option cmd preserves quoted arguments, quoted metacharacters and the probed pipeline",
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), "cmd-quotes-"))
      try {
        const cmd = process.env.COMSPEC || "cmd.exe"
        const file = "ação-日本.txt"
        writeFileSync(path.join(dir, file), "")
        const invoke = (line: string) =>
          spawnSync(windowsCmdCommand(cmd, line), {
            cwd: dir,
            shell: cmd,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 5_000,
          })
        for (const [line, expected] of [
          ['echo "a & b" && echo DONE', '"a & b"\r\nDONE'],
          ['echo ^"quoted^"', '"quoted"'],
          ['echo "ação 日本"', '"ação 日本"'],
          ['echo "a b" && dir /b *.txt | findstr txt', file],
        ]) {
          const out = invoke(line)
          expect(out.error).toBeUndefined()
          expect({ line, status: out.status }).toEqual({ line, status: 0 })
          expect({ line, text: out.stdout.toString("utf8") }).toEqual({
            line,
            text: expect.stringContaining(expected),
          })
        }
        // The nested process status is visible to the hosting cmd, not just to spawnSync.
        const mapped = spawnSync(`${windowsCmdCommand(cmd, "dir /b *.txt & exit /b 3")} || exit /b 9`, {
          cwd: dir,
          shell: cmd,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 5_000,
        })
        expect(mapped.error).toBeUndefined()
        expect(mapped.status).toBe(9)
        expect(mapped.stdout.toString("utf8")).toContain(file)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})
