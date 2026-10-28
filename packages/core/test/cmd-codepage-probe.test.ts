import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import * as Shell from "../src/shell"

// Diagnostic only (#543, #665). Prints how cmd.exe output is encoded for the shape the shell tools use
// (Shell.args(cmd, command, cwd), piped stdio, hidden window) and for the same command line with a
// chcp prefix. It asserts nothing about encoding, so the answer cannot fail it. It reports signals,
// errors and timeouts explicitly. Not meant to merge, and it proposes no product change.
const winOnly = process.platform === "win32" ? test : test.skip
const CHILD_TIMEOUT_MS = 10000

winOnly(
  "probe: cmd.exe output code page under piped spawn (Shell.args shape)",
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cmd-cp-probe-"))
    try {
      const file = "ação-日本.txt"
      writeFileSync(path.join(dir, file), "")
      const cmd = process.env.COMSPEC || "cmd.exe"
      const root = process.env.SystemRoot ?? process.env.windir ?? ""
      const chcp = `${root}\\System32\\chcp.com`
      if (!/^[A-Za-z]:\\[^\s"%&^|<>!()]*$/.test(root) || !existsSync(chcp)) {
        console.log(`cp-probe INCOMPLETE: unusable SystemRoot or missing chcp.com (root=${root})`)
        return
      }
      // Each line ends with an explicit user exit code 7 so the exit path is observed too.
      const variants: Record<string, string> = {
        "A plain dir": `dir /b *.txt & exit /b 7`,
        "B chcp prefix then dir (#665 shape)": `${chcp} 65001>nul & dir /b *.txt & exit /b 7`,
        "C chcp output visible then dir": `${chcp} 65001 & ${chcp} & dir /b *.txt & exit /b 7`,
        "D chcp prefix then nested cmd dir": `${chcp} 65001>nul & "${cmd}" /d /c dir /b *.txt & exit /b 7`,
      }
      for (const [name, line] of Object.entries(variants)) {
        const out = spawnSync(cmd, Shell.args(cmd, line, dir), {
          cwd: dir,
          windowsHide: true,
          timeout: CHILD_TIMEOUT_MS,
          killSignal: "SIGKILL",
        })
        const b = out.stdout ?? Buffer.alloc(0)
        const state = out.error
          ? `error=${out.error.message}`
          : out.signal
            ? `signal=${out.signal}`
            : `status=${out.status}`
        console.log(
          `cp-probe [${name}] modeled=Shell.args /c ${state} utf8=${b.toString("utf8").includes(file)} hex=${b.toString("hex")} stderrHex=${(out.stderr ?? Buffer.alloc(0)).toString("hex")}`,
        )
      }
      expect(true).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  60000,
)

// Second question: does the existing ConPTY transport (@lydell/node-pty) deliver the non-ASCII file name from
// cmd's own `dir` as UTF-8, with no chcp prefix? Spawned directly, no product code. A UTF-8 file listed by
// `type` is the external-content control. Prints only; reports exit, timeout and spawn errors explicitly.
winOnly(
  "probe: cmd.exe output through ConPTY",
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cmd-pty-probe-"))
    try {
      const file = "ação-日本.txt"
      writeFileSync(path.join(dir, file), "")
      writeFileSync(path.join(dir, "u8.txt"), file)
      const cmd = process.env.COMSPEC || "cmd.exe"
      const lines: Record<string, string> = {
        "P1 pty dir + exit 7": `dir /b *.txt & exit /b 7`,
        "P2 pty type of a utf8 file + exit 7": `type u8.txt & exit /b 7`,
      }
      let nodePty: typeof import("@lydell/node-pty")
      try {
        nodePty = await import("@lydell/node-pty")
      } catch (error) {
        console.log(`pty-probe INCOMPLETE: import failed: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      for (const [name, line] of Object.entries(lines)) {
        let proc: ReturnType<typeof nodePty.spawn> | undefined
        try {
          const chunks: string[] = []
          proc = nodePty.spawn(cmd, Shell.args(cmd, line, dir), {
            cwd: dir,
            cols: 200,
            rows: 30,
            name: "xterm-256color",
            env: process.env as Record<string, string>,
          })
          proc.onData((data) => chunks.push(data))
          const exit = await Promise.race([
            new Promise<string>((resolve) => proc!.onExit((e) => resolve(`exit=${e.exitCode}`))),
            new Promise<string>((resolve) => setTimeout(() => resolve("TIMEOUT"), CHILD_TIMEOUT_MS)),
          ])
          const text = chunks.join("")
          console.log(
            `pty-probe [${name}] modeled=Shell.args /c via node-pty ${exit} hasFile=${text.includes(file)} hasU8=${text.includes("ação")} hex=${Buffer.from(text, "utf8").toString("hex")}`,
          )
        } catch (error) {
          console.log(
            `pty-probe [${name}] INCOMPLETE: spawn failed ${error instanceof Error ? error.message : String(error)}`,
          )
        } finally {
          try {
            proc?.kill()
          } catch {}
        }
      }
      expect(true).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  60000,
)
