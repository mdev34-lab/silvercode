import { Effect } from "effect"

/**
 * Registry job type for a shell command that outlived the tool call. The
 * registry, session teardown and the server's job list all key on it.
 */
export const TYPE = "shell"

/** Agent-facing tool for list / status / output / cancel of those jobs. */
export const ToolID = "shell_background"

/**
 * Stand-in result for a backgrounded command the user stopped. A cancelled
 * command never reaches an exit, so its delivery has to say what became of it.
 */
export const CANCELLED_TEXT = "The command was cancelled before it finished."

/**
 * Bounded, live view of what a backgrounded command has emitted so far. It is
 * read from the tool's own buffers, so asking for it never blocks on the
 * command and never grows past the truncation limits.
 */
export type Snapshot = {
  output: string
  truncated: boolean
  outputPath?: string
  exit?: number | null
  signal?: string
}

/**
 * The live half of a backgrounded command. The registry entry records status
 * and the terminal output; this handle is what the owning process needs to
 * read partial output and to kill the real process tree.
 */
export type Handle = {
  readonly id: string
  readonly command: string
  readonly sessionID: string
  readonly pid?: number
  readonly startedAt: number
  readonly snapshot: () => Snapshot
  /** Kills the process tree with the same escalation the inline path uses. */
  readonly kill: () => Effect.Effect<void>
}

/**
 * Handles are keyed by the registry instance they belong to, so isolated
 * instances (tests, servers, workspaces) cannot see or kill each other's
 * commands, and a disposed registry does not keep its handles alive.
 */
const handles = new WeakMap<object, Map<string, Handle>>()

function registry(owner: object) {
  const existing = handles.get(owner)
  if (existing) return existing
  const created = new Map<string, Handle>()
  handles.set(owner, created)
  return created
}

/** Publishes a running command and returns the matching deregistration. */
export function register(owner: object, handle: Handle) {
  registry(owner).set(handle.id, handle)
  return () => {
    const map = handles.get(owner)
    if (map?.get(handle.id) !== handle) return
    map.delete(handle.id)
  }
}

export function get(owner: object, id: string) {
  return handles.get(owner)?.get(id)
}

export function list(owner: object) {
  return [...(handles.get(owner)?.values() ?? [])]
}

/**
 * The model-facing envelope for a command that moved to the background. The
 * command is still running: this is a receipt, not a result.
 */
export function renderRunning(input: { id: string; command: string; thresholdMs: number; output: string }) {
  return [
    `<shell_background job_id="${input.id}" state="running">`,
    `<summary>Command moved to the background after ${input.thresholdMs}ms: ${input.command}</summary>`,
    "The command was NOT killed and was NOT restarted: the same process keeps running and its output keeps streaming.",
    `Check it with the ${ToolID} tool: action="status" job_id="${input.id}" returns immediately with the current status and partial output; action="output" reads the output captured so far; action="cancel" stops it and kills the process tree.`,
    "You will be notified automatically when it finishes. Do not re-run the command or duplicate its work in the meantime.",
    input.output ? `<output>\n${input.output}\n</output>` : "",
    "</shell_background>",
  ]
    .filter(Boolean)
    .join("\n")
}

/**
 * The model-facing terminal envelope for a backgrounded command. Completion,
 * cancellation and teardown all end here, so every launched job has exactly
 * one terminal delivery.
 */
export function renderResult(input: {
  id: string
  command: string
  state: "completed" | "cancelled" | "error"
  text: string
  exit?: number | null
  signal?: string
  truncated?: boolean
  outputPath?: string
}) {
  const tag = input.state === "error" ? "shell_background_error" : "shell_background_result"
  const summary =
    input.state === "completed"
      ? `Background command completed: ${input.command}`
      : input.state === "cancelled"
        ? `Background command cancelled: ${input.command}`
        : `Background command failed: ${input.command}`
  return [
    `<shell_background job_id="${input.id}" state="${input.state}"${input.exit !== undefined && input.exit !== null ? ` exit="${input.exit}"` : ""}${input.signal ? ` signal="${input.signal}"` : ""}${input.truncated ? ` truncated="true"` : ""}>`,
    `<summary>${summary}</summary>`,
    `<${tag}>`,
    input.text || "(no output)",
    `</${tag}>`,
    ...(input.truncated && input.outputPath ? [`<output_path>${input.outputPath}</output_path>`] : []),
    "</shell_background>",
  ].join("\n")
}

export * as ShellBackground from "./background"
