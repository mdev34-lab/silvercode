import { Locale } from "./locale"

function readFinite(input: object, key: string) {
  const value = Reflect.get(input, key)
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return value
}

export function formatGenerationMetrics(input: object) {
  const parts: string[] = []
  const tokensPerSecond = readFinite(input, "tokensPerSecond")
  const ttft = readFinite(input, "ttft")
  if (tokensPerSecond !== undefined && tokensPerSecond > 0) {
    parts.push(`${tokensPerSecond.toFixed(1)} tok/s`)
  }
  if (ttft !== undefined && ttft >= 0) {
    parts.push(`TTFT ${Locale.duration(Math.round(ttft))}`)
  }
  return parts.join(" · ")
}
