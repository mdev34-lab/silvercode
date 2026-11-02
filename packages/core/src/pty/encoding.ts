import { Buffer } from "node:buffer"
import { createRequire } from "node:module"
import type { Proc } from "./pty"

const require = createRequire(import.meta.url)

// OEM codepages a console starts with, plus the ANSI codepages it can report after chcp. Double-byte
// codepages mix one- and two-byte sequences, so a character no longer maps back to one byte and the
// byte-level recovery below is not defined for them.
const oemCodePages = new Set([437, 720, 737, 775, 850, 852, 855, 857, 858, 860, 861, 862, 863, 864, 865, 866, 869, 874])
const isSingleByte = (codepage: number) => oemCodePages.has(codepage) || (codepage >= 1250 && codepage <= 1258)

export type ConptyTextDecoder = {
  /** Normalizes one chunk. Returns an empty string while a trailing partial byte sequence waits for more input. */
  decode: (chunk: string) => string
  /** Releases a sequence still held when the stream ends. */
  end: () => string
}

const identity: ConptyTextDecoder = { decode: (chunk) => chunk, end: () => "" }

// A UTF-8 sequence can need at most three more bytes, which is the longest prefix worth holding.
const MAX_HOLD = 3

const sequenceSize = (lead: number) =>
  lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0

// Length of the trailing bytes that are a valid but unfinished UTF-8 sequence, so a later chunk can complete them.
const incompleteTail = (bytes: Uint8Array) => {
  for (let length = Math.min(MAX_HOLD, bytes.length); length > 0; length--) {
    const start = bytes.length - length
    if (sequenceSize(bytes[start]) <= length) continue
    if (bytes.subarray(start + 1).every((byte) => byte >= 0x80 && byte <= 0xbf)) return length
  }
  return 0
}

// Strict UTF-8 decoding: a lossy round trip means the bytes were never a UTF-8 sequence.
const utf8 = (bytes: Uint8Array) => {
  const buffer = Buffer.from(bytes)
  const text = buffer.toString("utf8")
  return Buffer.from(text, "utf8").equals(buffer) ? text : undefined
}

/**
 * Reverses the console codepage expansion ConPTY applies to byte-oriented output (#710).
 *
 * ConPTY reports every session as UTF-8, and conhost has already decoded what a program wrote: wide characters
 * pass through unchanged, while raw bytes written to a console handle are read with the console output codepage.
 * A UTF-8 file printed by `type` therefore arrives as that codepage's reading of its own bytes, one character per
 * byte, so `ação` shows up as `├º├úo`. Re-encoding a run of those characters and decoding the bytes as UTF-8
 * restores the file text, and the same reversal applies to any byte-oriented program that prints UTF-8.
 *
 * Only provable reversals are applied. A run must map back to exactly one byte per character, those bytes must be
 * a complete and valid UTF-8 sequence, and the run must contain a non-ASCII byte. Anything else, including
 * correctly rendered text from the wide-character path, non-representable characters and invalid byte sequences,
 * passes through unchanged. Control characters never join a run, so VT sequences, line endings and the console
 * title stay byte-for-byte intact.
 */
export function conptyTextDecoder(
  options: { codepage?: number | null; loadIconv?: () => typeof import("iconv-lite") } = {},
): ConptyTextDecoder {
  const codepage = options.codepage
  if (codepage === null || codepage === undefined || codepage === 65001 || !isSingleByte(codepage)) return identity
  let iconv: typeof import("iconv-lite") | undefined
  try {
    iconv = (options.loadIconv ?? (() => require("iconv-lite")))()
  } catch {}
  if (!iconv) return identity
  const encoding = String(codepage)
  if (!iconv.encodingExists(encoding)) return identity

  // One byte per character is the premise of the whole reversal, so refuse any codepage that breaks it.
  const replacement = "\uFFFD"
  const bytes = new Map<string, number>()
  for (let byte = 0x80; byte <= 0xff; byte++) {
    const char = iconv.decode(Uint8Array.of(byte), encoding)
    // Bytes a codepage leaves undefined decode to nothing, to several characters, or to U+FFFD.
    if (char === replacement || char.length !== 1) continue
    // A char reachable from two bytes would make the reversal ambiguous.
    if (bytes.has(char)) return identity
    bytes.set(char, byte)
  }
  if (bytes.size === 0) return identity

  // Control characters break a run so VT sequences, line endings and the console title stay untouched.
  const byteOf = (char: string) => {
    const code = char.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) return undefined
    return code < 0x80 ? code : bytes.get(char)
  }

  // `hold` keeps a trailing partial sequence, which can only be completed by the next chunk.
  const recover = (run: string, hold: boolean) => {
    if (!run) return { text: "", held: "" }
    const encoded = new Uint8Array(run.length)
    let wide = false
    for (let index = 0; index < run.length; index++) {
      const byte = byteOf(run.charAt(index))!
      encoded[index] = byte
      if (byte >= 0x80) wide = true
    }
    // Plain ASCII encodes to itself, so there is nothing to reverse.
    if (!wide) return { text: run, held: "" }
    const split = hold ? incompleteTail(encoded) : 0
    const text = utf8(encoded.subarray(0, encoded.length - split))
    if (text === undefined) return { text: run, held: "" }
    return { text, held: split ? run.slice(run.length - split) : "" }
  }

  let pending = ""
  return {
    decode(chunk) {
      if (!chunk) return ""
      const text = pending + chunk
      pending = ""
      let out = ""
      let run = ""
      for (const char of text) {
        if (byteOf(char) !== undefined) {
          run += char
          continue
        }
        out += recover(run, false).text
        run = ""
        out += char
      }
      const tail = recover(run, true)
      out += tail.text
      pending = tail.held
      return out
    },
    end() {
      const text = pending
      pending = ""
      return text
    },
  }
}

/**
 * Wraps a ConPTY process so every data listener receives normalized text. A partial sequence still held when the
 * process exits is delivered before the exit listener, so no output is dropped when a run ends mid-sequence.
 */
export function normalizeConptyOutput(proc: Proc, decoder: ConptyTextDecoder): Proc {
  const listeners = new Set<(data: string) => void>()
  proc.onData((chunk) => {
    const data = decoder.decode(chunk)
    if (!data) return
    for (const listener of listeners) listener(data)
  })
  return {
    pid: proc.pid,
    onData(listener) {
      listeners.add(listener)
      return {
        dispose: () => {
          listeners.delete(listener)
        },
      }
    },
    onExit(listener) {
      return proc.onExit((event) => {
        const rest = decoder.end()
        if (rest) for (const listener of listeners) listener(rest)
        listeners.clear()
        listener(event)
      })
    },
    write(data) {
      proc.write(data)
    },
    resize(cols, rows) {
      proc.resize(cols, rows)
    },
    kill(signal) {
      proc.kill(signal)
    },
  }
}
