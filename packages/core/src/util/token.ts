export * as Token from "./token"

const CHARS_PER_TOKEN = 4

export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))

/** Tokens a serialized payload of `characters` characters is estimated to occupy. */
export const fromLength = (characters: number) => Math.max(0, Math.round(characters / CHARS_PER_TOKEN))
