import { describe, expect, test } from "bun:test"
import iconv from "iconv-lite"
import { conptyTextDecoder, normalizeConptyOutput } from "../../src/pty/encoding"
import type { Proc } from "../../src/pty/pty"

const content = "ação-日本 😀 ok"

// What conhost sends for a program that writes these UTF-8 bytes to a console handle: each byte is read
// as one character of the console codepage, and ConPTY re-encodes the resulting text as UTF-8.
const expanded = (text: string, codepage: number) => iconv.decode(Buffer.from(text, "utf8"), String(codepage))

const decodeChunks = (chunks: ReadonlyArray<string>, codepage: number | null | undefined) => {
  const decoder = conptyTextDecoder({ codepage })
  return chunks.map((chunk) => decoder.decode(chunk)).join("") + decoder.end()
}

// Control sequences and printable text in the order ConPTY emitted them.
const escapes = (text: string) => text.match(/\u001b\[[0-9;?]*[A-Za-z]/g) ?? []

const fakeProc = () => {
  const data: Array<(chunk: string) => void> = []
  const exit: Array<(event: { exitCode: number }) => void> = []
  const written: string[] = []
  const resized: Array<[number, number]> = []
  const killed: Array<string | undefined> = []
  const proc: Proc = {
    pid: 7,
    onData(listener) {
      data.push(listener)
      return { dispose: () => void data.splice(data.indexOf(listener), 1) }
    },
    onExit(listener) {
      exit.push(listener)
      return { dispose: () => void exit.splice(exit.indexOf(listener), 1) }
    },
    write(value) {
      written.push(value)
    },
    resize(cols, rows) {
      resized.push([cols, rows])
    },
    kill(signal) {
      killed.push(signal)
    },
  }
  return {
    proc,
    written,
    resized,
    killed,
    emit: (chunk: string) => data.slice().forEach((listener) => listener(chunk)),
    stop: (exitCode = 0) => exit.slice().forEach((listener) => listener({ exitCode })),
  }
}

describe("ConPTY console codepage recovery (#710)", () => {
  test("reads file content printed by cmd.exe back as UTF-8", () => {
    expect(decodeChunks([expanded(content, 437)], 437)).toBe(content)
    expect(decodeChunks([expanded(content, 850)], 850)).toBe(content)
    expect(decodeChunks([expanded("ação 日本", 1252)], 1252)).toBe("ação 日本")
  })

  test("leaves output the console rendered as wide characters unchanged", () => {
    // `dir /b` reports names through the wide-character API, so they arrive as real UTF-8. Legacy files
    // written in the console codepage arrive the same way and must stay readable as well.
    for (const text of ["ação-日本.txt", "C:\\Users\\josé\\ação.txt", "├──┐", "resumé", "ação"])
      expect(decodeChunks([text], 437)).toBe(text)
  })

  test("keeps VT sequences and other control bytes out of the reversal", () => {
    const control = "\u001b[2J\u001b]0;C:\\Users\\josé\u0007\u001b[1;1H\u001b[31m"
    const wrapped = `${control}${expanded("ação", 437)}\u001b[0m\r\n`
    expect(decodeChunks([wrapped], 437)).toBe(`${control}ação\u001b[0m\r\n`)
    expect(escapes(decodeChunks([wrapped], 437))).toEqual(escapes(wrapped))
  })

  test("recovers content split across chunk boundaries", () => {
    const wire = expanded(content, 437)
    for (let split = 1; split < wire.length; split++)
      expect(decodeChunks([wire.slice(0, split), wire.slice(split)], 437)).toBe(content)
    expect(decodeChunks(Array.from(wire), 437)).toBe(content)
  })

  test("holds an unfinished sequence until the next chunk or the end of the stream", () => {
    const decoder = conptyTextDecoder({ codepage: 437 })
    // 0xc3 starts the two bytes of `ç`, so the first chunk alone proves nothing yet.
    expect(decoder.decode("├")).toBe("")
    expect(decoder.decode("º")).toBe("ç")

    const ended = conptyTextDecoder({ codepage: 437 })
    expect(ended.decode("├") + ended.end()).toBe("├")
  })

  test("passes output through when the codepage cannot prove a reversal", () => {
    const wire = expanded(content, 437)
    // A UTF-8 console renders raw bytes as UTF-8 already, and double-byte codepages do not expand one
    // character per byte. Unknown or unloadable codepages must not guess either.
    expect(decodeChunks([wire], 65001)).toBe(wire)
    expect(decodeChunks([wire], 932)).toBe(wire)
    expect(decodeChunks([wire], undefined)).toBe(wire)
    expect(decodeChunks([wire], null)).toBe(wire)
    expect(decodeChunks([wire], 1_000_000)).toBe(wire)
    const unavailable = conptyTextDecoder({
      codepage: 437,
      loadIconv: () => {
        throw new Error("MODULE_NOT_FOUND")
      },
    })
    expect(unavailable.decode(wire) + unavailable.end()).toBe(wire)
  })

  test("recovers only the runs that are valid UTF-8", () => {
    // A name from the wide-character path, a byte-oriented run, and lines the codepage cannot explain.
    const mixed = `ação-日本.txt\r\n${expanded("ação", 437)}\r\n°±▓\r\n`
    expect(decodeChunks([mixed], 437)).toBe(`ação-日本.txt\r\nação\r\n°±▓\r\n`)
  })
})

describe("ConPTY output normalization wiring", () => {
  test("delivers normalized chunks and forwards process controls", () => {
    const fake = fakeProc()
    const proc = normalizeConptyOutput(fake.proc, conptyTextDecoder({ codepage: 437 }))
    const received: string[] = []
    proc.onData((chunk) => received.push(chunk))

    fake.emit(expanded("ação", 437))
    expect(received.join("")).toBe("ação")

    proc.write("dir\r")
    proc.resize(120, 40)
    proc.kill("SIGTERM")
    expect(fake.written).toEqual(["dir\r"])
    expect(fake.resized).toEqual([[120, 40]])
    expect(fake.killed).toEqual(["SIGTERM"])
  })

  test("flushes a held sequence before the exit event", () => {
    const fake = fakeProc()
    const proc = normalizeConptyOutput(fake.proc, conptyTextDecoder({ codepage: 437 }))
    const events: string[] = []
    proc.onData((chunk) => events.push(`data:${chunk}`))
    proc.onExit((event) => events.push(`exit:${event.exitCode}`))

    fake.emit("├")
    expect(events).toEqual([])
    fake.stop(3)
    expect(events).toEqual(["data:├", "exit:3"])
  })

  test("stops delivery after a data listener is disposed", () => {
    const fake = fakeProc()
    const proc = normalizeConptyOutput(fake.proc, conptyTextDecoder({ codepage: 437 }))
    const received: string[] = []
    const listener = proc.onData((chunk) => received.push(chunk))

    fake.emit("ação\r\n")
    listener.dispose()
    fake.emit("日本\r\n")
    expect(received.join("")).toBe("ação\r\n")
  })
})
