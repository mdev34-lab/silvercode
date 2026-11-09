import { describe, expect, test } from "bun:test"
import { ShellPrompt } from "@/tool/shell/prompt"
import EDIT from "@/tool/edit.txt"
import GLOB from "@/tool/glob.txt"
import GREP from "@/tool/grep.txt"
import READ from "@/tool/read.txt"
import WRITE from "@/tool/write.txt"

const limits = { maxLines: 100, maxBytes: 10_000 }
const posix: Array<[string, NodeJS.Platform]> = [
  ["bash", "linux"],
  ["zsh", "darwin"],
]
const powershell: Array<[string, NodeJS.Platform]> = [
  ["pwsh", "win32"],
  ["powershell", "win32"],
]
const cmd: Array<[string, NodeJS.Platform]> = [["cmd", "win32"]]
const all = [...posix, ...powershell, ...cmd]

/** Collapse template wrapping so assertions do not depend on line breaks. */
const flat = (name: string, platform: NodeJS.Platform) =>
  ShellPrompt.render(name, platform, limits, 120_000).description.replace(/\s+/g, " ")

describe("tool.shell prompt shell identity", () => {
  for (const [name, platform] of all) {
    test(`${name} description carries the no-retry rule`, () => {
      const description = flat(name, platform)

      expect(description).toContain("# Shell identity and failure adaptation")
      expect(description).toContain("STOP retrying the same construct")
      expect(description).toContain("Never attempt the same failing syntax pattern more than once.")
      // Recovery paths: translate, or write and run a script file.
      expect(description).toContain("translate the command to this shell's native syntax")
      expect(description).toContain("write a script file with the Write tool")
      expect(description).toContain("`ParserError`")
      expect(description).toContain("not a valid regular expression")
    })
  }

  for (const [name, platform] of [...powershell, ...cmd]) {
    test(`${name} description names the three POSIX failure modes`, () => {
      const description = flat(name, platform)

      expect(description).toContain("heredocs")
      expect(description).toContain("`<<`")
      expect(description).toContain("`for f in ...; do ... done` one-liners")
      expect(description).toContain("`rm -f`")
      expect(description).toContain("not a POSIX shell")
    })
  }

  for (const [name, platform] of powershell) {
    test(`${name} description keeps the PowerShell quoting guidance`, () => {
      const description = flat(name, platform)

      expect(description).toContain("single-quoted verbatim strings for patterns")
      expect(description).toContain("ambiguous parameter name")
    })
  }

  test("cmd.exe guidance does not claim the shell is bash or PowerShell", () => {
    const description = flat("cmd", "win32")

    expect(description).toContain("This host runs cmd.exe")
    expect(description).toContain("not a POSIX shell and not PowerShell")
    expect(description).not.toContain("Your shell may be bash (POSIX) or PowerShell")
  })

  for (const [name, platform] of posix) {
    test(`${name} guidance is POSIX-framed and not PowerShell-framed`, () => {
      const description = flat(name, platform)

      expect(description).toContain(`This host runs ${name} (POSIX)`)
      expect(description).toContain("If a POSIX-shaped command ever produces a parse error")
      expect(description).not.toContain("heredocs")
    })
  }

  // #780: the tool is published as "shell", so no profile may instruct the
  // model to make "bash tool calls", and the POSIX intro must not claim a
  // persistent bash session on hosts running zsh/sh/etc. (each call spawns a
  // fresh process).
  for (const [name, platform] of all) {
    test(`${name} description names the tool "shell", never "bash"`, () => {
      const description = flat(name, platform)

      expect(description).toContain("shell tool call")
      expect(description).not.toContain("bash tool call")
      expect(description).not.toContain("a single Bash call")
      expect(description).not.toContain("given bash command")
      expect(description).not.toContain("persistent shell session")
    })
  }

  test("POSIX intro says each call runs in a fresh shell process", () => {
    for (const [name, platform] of posix) {
      expect(flat(name, platform)).toContain("in a fresh shell process")
    }
  })

  test("rendered descriptions contain no leftover template placeholders", () => {
    for (const [name, platform] of all) {
      expect(ShellPrompt.render(name, platform, limits, 120_000).description).not.toContain("${")
    }
  })
})

describe("tool.shell prompt scoping", () => {
  test("the section stays out of other tools' descriptions", () => {
    for (const other of [WRITE, EDIT, GREP, GLOB, READ]) {
      expect(other).not.toContain("Shell identity and failure adaptation")
      expect(other).not.toContain("Never attempt the same failing syntax pattern")
    }
  })
})
