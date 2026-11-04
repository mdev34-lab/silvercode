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

// Commands run as arguments instead of typed input: node-pty defers writes until the terminal reports
// first output, and a write that lands on a closed console pipe throws on Windows.
const dirArgs = ["/d", "/c", "dir /b"]
// `type *.txt` avoids typing a non-ASCII name into the console input codepage.
const typeArgs = ["/d", "/c", "type *.txt"]

const escapes = (text: string) => text.match(/\u001b\[[0-9;?]*[A-Za-z]/g) ?? []

type Session = {
  onData: (listener: (data: string) => unknown) => unknown
  onExit: (listener: (event: { exitCode: number }) => unknown) => unknown
  kill: () => void
}

const runSession = (session: Session) =>
  new Promise<{ chunks: string[]; output: string }>((resolve, reject) => {
    const chunks: string[] = []
    let output = ""
    const timer = setTimeout(() => {
      session.kill()
      reject(new Error(`timed out waiting for the PTY session; output so far: ${JSON.stringify(output)}`))
    }, 30_000)
    session.onData((data) => {
      chunks.push(data)
      output += data
    })
    session.onExit(() => {
      clearTimeout(timer)
      // Exit follows the socket close, so let any last chunk queued behind it run first.
      setTimeout(() => resolve({ chunks, output }), 100)
    })
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

const options = (directory: string) => ({ name: "xterm-256color", cols: 200, rows: 50, cwd: directory })

describe("cmd.exe under ConPTY (#710)", () => {
  windows("passes UTF-8 file content and file names through the node backend", () =>
    withFixture(async (directory) => {
      // `dir /b` reports names from the wide-character path and keeps them intact either way.
      const listing = await runSession(spawn(shell, dirArgs, options(directory)))
      expect(listing.output).toContain(fileName)

      const content = await runSession(spawn(shell, typeArgs, options(directory)))
      expect(content.output).toContain(fileText)
    }),
  )

  test.skipIf(process.platform !== "win32" || !consoleCodePage || consoleCodePage === 65001)(
    "raw output is the console codepage expansion that the decoder reverses",
    () =>
      withFixture(async (directory) => {
        const listing = await runSession(nodePty.spawn(shell, dirArgs, options(directory)))
        expect(listing.output).toContain(fileName)

        // Before the fix this is what reached the UI: the UTF-8 bytes of the file read as console characters.
        const expanded = iconv.decode(Buffer.from(fileText, "utf8"), String(consoleCodePage))
        const content = await runSession(nodePty.spawn(shell, typeArgs, options(directory)))
        expect(content.output).toContain(expanded)
        expect(content.output).not.toContain(fileText)

        const decoder = conptyTextDecoder({ codepage: consoleCodePage })
        const decoded = content.chunks.map((chunk) => decoder.decode(chunk)).join("") + decoder.end()
        expect(decoded).toContain(fileText)
        expect(escapes(decoded)).toEqual(escapes(content.output))
      }),
  )
})
