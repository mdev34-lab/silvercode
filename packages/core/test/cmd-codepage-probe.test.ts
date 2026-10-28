import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"

// Diagnostic only (#543, #665). It records how cmd.exe output is encoded under the spawn shape the shell
// tools use (piped stdio, hidden window) and which prefix, if any, changes it. It asserts nothing about
// encoding, so it cannot fail on the answer; it only prints. Not meant to merge.
;(process.platform === "win32" ? test : test.skip)("probe: cmd.exe output code page under piped spawn", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cmd-cp-probe-"))
  try {
    const file = "ação-日本.txt"
    writeFileSync(path.join(dir, file), "")
    const cmd = process.env.COMSPEC || "cmd.exe"
    const root = process.env.SystemRoot ?? process.env.windir
    const chcp = `${root}\\System32\\chcp.com`
    const variants: Record<string, string> = {
      "A plain dir": `dir /b *.txt`,
      "B chcp then dir (the #665 shape)": `${chcp} 65001>nul & dir /b *.txt`,
      "C chcp reports then dir": `${chcp} 65001 & ${chcp} & dir /b *.txt`,
      "D chcp then nested cmd dir": `${chcp} 65001>nul & "${cmd}" /d /c dir /b *.txt`,
      "E nested cmd /u dir (utf16le)": `"${cmd}" /d /u /c dir /b *.txt`,
      "F chcp then nested cmd /u dir": `${chcp} 65001>nul & "${cmd}" /d /u /c dir /b *.txt`,
    }
    for (const [name, line] of Object.entries(variants)) {
      const out = spawnSync(cmd, ["/d", "/s", "/c", `"${line}"`], {
        cwd: dir,
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
      const b = out.stdout ?? Buffer.alloc(0)
      console.log(
        `cp-probe ${name}: status=${out.status} err=${out.error?.message ?? ""} utf8=${b.toString("utf8").includes(file)} utf16le=${b.toString("utf16le").includes(file)} hex=${b.toString("hex")} stderr=${out.stderr?.toString("utf8").trim()}`,
      )
    }
    expect(true).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
