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
          ? `INCOMPLETE error=${out.error.message}`
          : out.signal
            ? `INCOMPLETE signal=${out.signal}`
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

// Second question: with the default @lydell/node-pty ConPTY backend (not the repo's DLL fallback path), spawned
// directly with the same Shell.args shape, what text does cmd's own `dir /b` deliver for the non-ASCII file name?
// `type` of a UTF-8 file is a second cmd builtin, NOT an external-executable or mixed-output control. The data
// listener yields JS strings; the hex printed is those strings re-encoded as UTF-8, not the raw wire bytes. The
// result concerns this transport only. Prints only. Exit, timeout and spawn failure are reported explicitly; a
// child that does not exit after SIGKILL stops the probe and leaves its directory in place.
winOnly(
  "probe: cmd.exe output through ConPTY",
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cmd-pty-probe-"))
    let childLive = false
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
        const chunks: string[] = []
        const subs: { dispose(): void }[] = []
        let timer: ReturnType<typeof setTimeout> | undefined
        let proc: ReturnType<typeof nodePty.spawn>
        try {
          proc = nodePty.spawn(cmd, Shell.args(cmd, line, dir), {
            cwd: dir,
            cols: 200,
            rows: 30,
            name: "xterm-256color",
            env: process.env as Record<string, string>,
          })
        } catch (error) {
          console.log(
            `pty-probe [${name}] INCOMPLETE: spawn failed ${error instanceof Error ? error.message : String(error)}`,
          )
          continue
        }
        childLive = true
        const exited = new Promise<number>((resolve) => {
          subs.push(proc.onExit((e) => resolve(e.exitCode)))
        })
        subs.push(proc.onData((data) => chunks.push(data)))
        const first = await Promise.race([
          exited,
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), CHILD_TIMEOUT_MS)
          }),
        ])
        clearTimeout(timer)
        let state: string
        if (first === "timeout") {
          try {
            proc.kill()
          } catch {}
          const after = await Promise.race([
            exited,
            new Promise<"none">((resolve) => setTimeout(() => resolve("none"), 5000)),
          ])
          state =
            after === "none" ? "INCOMPLETE timeout, no exit after kill" : `INCOMPLETE timeout, killed, exit=${after}`
          if (after === "none") {
            console.log(`pty-probe [${name}] ${state}; stopping, directory left in place`)
            return
          }
        } else {
          state = `exit=${first}`
        }
        childLive = false
        for (const sub of subs) sub.dispose()
        const text = chunks.join("")
        console.log(
          `pty-probe [${name}] modeled=Shell.args /c via node-pty default backend ${state} hasFile=${text.includes(file)} hasU8=${text.includes("ação")} reencodedUtf8Hex=${Buffer.from(text, "utf8").toString("hex")}`,
        )
      }
      expect(true).toBe(true)
    } finally {
      if (!childLive) rmSync(dir, { recursive: true, force: true })
    }
  },
  60000,
)
