import { measureEditText } from "@opentui/core"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function promptOffsetWidth(value: string) {
  // Match the prompt Textarea's EditBuffer exactly (#372): cells under
  // widthMethod "unicode" with the default tab width, control notation, and
  // one position per line break. Hand-rolling this with Bun.stringWidth
  // undercounts tabs (default tab width) and control chars (caret notation).
  return measureEditText(value, { widthMethod: "unicode" })
}

// indexOf returns a UTF-16 index, but prompt/extmark offsets are display
// columns (Textarea measures with widthMethod "unicode"); convert so a token
// sitting after wide chars lands on the right extmark range (#372).
export function displayIndexOf(value: string, search: string) {
  const index = value.indexOf(search)
  if (index === -1) return -1
  return promptOffsetWidth(value.slice(0, index))
}

function displayOffsetIndex(value: string, offset: number) {
  if (offset <= 0) return 0

  let width = 0
  for (const part of graphemes.segment(value)) {
    const next = width + promptOffsetWidth(part.segment)
    if (next > offset) return part.index
    width = next
  }

  return value.length
}

export function displaySlice(value: string, start = 0, end = promptOffsetWidth(value)) {
  return value.slice(displayOffsetIndex(value, start), displayOffsetIndex(value, end))
}

export function displayCharAt(value: string, offset: number) {
  let width = 0
  for (const part of graphemes.segment(value)) {
    const next = width + promptOffsetWidth(part.segment)
    if (offset === width || offset < next) return part.segment
    width = next
  }
}

export function mentionTriggerIndex(value: string, offset = promptOffsetWidth(value)) {
  const text = displaySlice(value, 0, offset)
  const index = text.lastIndexOf("@")
  if (index === -1) return

  const before = index === 0 ? undefined : text[index - 1]
  const query = text.slice(index)
  if ((before === undefined || /\s/.test(before)) && !/\s/.test(query)) {
    return promptOffsetWidth(text.slice(0, index))
  }
}
