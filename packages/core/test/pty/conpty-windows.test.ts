import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as nodePty from "@lydell/node-pty"
import iconv from "iconv-lite"
import { conptyTextDecoder } from "../../src/pty/encoding"
import { spawn } from "../../src/pty/pty.node"
import { windowsConsoleCodePage } from "../../src/shell-encoding"

// #710 reproduces only under a real Windows ConPTY session, which the Linux runners cannot create.
const windows = process.platform === "win32" ? test : test.skip
const shell = process.env.COMSPEC || "cmd.exe"
const consoleCodePage = windowsConsoleCodePage()
const fileName = "ação-日本.txt"
const fileText = "ação-日本 ok"

// `type *.txt` avoids typing a non-ASCII name into the console input codepage.
const commands = ["dir /b", "type *.txt"]

const escapes = (text: string) => text.match(/\u001b\[[0-9;?]*[A-Za-z]/g) ?? []

type Session = {
  onData: (listener: (data: string) => unknown) => unknown
  onExit: (listener: (event: { exitCode: number }) => unknown) => unknown
  write: (data: string) => void
  kill: () => void
}

// Resolves once the shell printed what the caller waits for, so the assertion never races the prompt echo.
const runSession = (session: Session, ready: (output: string) => boolean) =>
  new Promise<{ chunks: string[]; output: string }>((resolve, reject) => {
    const chunks: string[] = []
    let output = ""
    const timer = setTimeout(() => {
      session.kill()
      reject(new Error(`timed out waiting for the PTY session; output so far: ${JSON.stringify(output)}`))
    }, 30_000)
    const done = () => {
      clearTimeout(timer)
      session.kill()
      resolve({ chunks, output })
    }
    session.onData((data) => {
      chunks.push(data)
      output += data
      if (ready(output)) done()
    })
    session.onExit(() => {
      clearTimeout(timer)
      resolve({ chunks, output })
    })
    for (const command of commands) session.write(`${command}\r`)
  })

const withFixture = async (run: (directory: string) => Promise<void>) => {
  const directory = mkdtempSync(path.join(tmpdir(), "conpty-encoding-"))
  try {
    writeFileSync(path.join(directory, fileName), `${fileText}\n`, "utf8")
    await run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("cmd.exe under ConPTY (#710)", () => {
  windows("passes UTF-8 file content and file names through the node backend", () =>
    withFixture(async (directory) => {
      const session = spawn(shell, [], { name: "xterm-256color", cols: 200, rows: 50, cwd: directory })
      const { output } = await runSession(session, (text) => text.includes(fileText))
      // `dir /b` reports names from the wide-character path and keeps them intact either way.
      expect(output).toContain(fileName)
      expect(output).toContain(fileText)
    }),
  )

  test.skipIf(process.platform !== "win32" || !consoleCodePage || consoleCodePage === 65001)(
    "raw output is the console codepage expansion that the decoder reverses",
    () =>
      withFixture(async (directory) => {
        // Before the fix this is what reached the UI: the UTF-8 bytes of the file read as console characters.
        const expanded = iconv.decode(Buffer.from(fileText, "utf8"), String(consoleCodePage))
        const session = nodePty.spawn(shell, [], { name: "xterm-256color", cols: 200, rows: 50, cwd: directory })
        const { chunks, output } = await runSession(session, (text) => text.includes(expanded))
        expect(output).toContain(fileName)
        expect(output).toContain(expanded)
        expect(output).not.toContain(fileText)

        const decoder = conptyTextDecoder({ codepage: consoleCodePage })
        const decoded = chunks.map((chunk) => decoder.decode(chunk)).join("") + decoder.end()
        expect(decoded).toContain(fileText)
        expect(decoded).toContain(fileName)
        expect(escapes(decoded)).toEqual(escapes(output))
      }),
  )
})
