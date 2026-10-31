export * as AgentEffort from "./agent-effort"

import { Schema } from "effect"

/** Ordered agent-effort levels: least to most process. */
export const levels = ["fast", "medium", "thorough", "ultra"] as const

export type Level = (typeof levels)[number]

/** Closed schema for a persisted or configured agent-effort level. */
export const Level = Schema.Literals(levels).annotate({ identifier: "AgentEffort.Level" })

/**
 * Safely resolves an untrusted value to an effort level.
 *
 * Invalid or missing values fall back to `fallback`, and an invalid (or
 * absent) fallback falls back to `medium` — the ultimate default — so callers
 * always receive a usable level without throwing on untrusted input.
 */
export function resolve(value: unknown, fallback?: Level): Level {
  return levels.includes(value as Level) ? (value as Level) : (fallback ?? "medium")
}
