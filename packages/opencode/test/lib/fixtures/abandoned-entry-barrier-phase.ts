import fs from "node:fs"

export const PHASE_ENV = "OPENCODE_ABANDONED_ENTRY_PHASE_PATH"

const MAX_RECORDS = 24
const MAX_BYTES = 2048
const file = process.env[PHASE_ENV]
let records = 0
let bytes = 0

export function phase(name: string) {
  if (!file) return
  try {
    if (records >= MAX_RECORDS) return
    const line = `${name}\n`
    if (bytes + line.length > MAX_BYTES) return
    records += 1
    bytes += line.length
    fs.appendFileSync(file, line)
  } catch {}
}
