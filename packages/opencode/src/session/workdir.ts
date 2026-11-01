import os from "os"
import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

/**
 * The working folder a session resolves its paths from.
 *
 * A folder is a resolution base, never a permission boundary. The instance the
 * session runs in stays the anchor every `external_directory` decision is
 * measured against, so choosing a folder outside the project - which a user may
 * legitimately do to reach a home directory or a sibling project - grants no
 * access to it: reaching those paths still asks the permissions that already
 * gate them. Inherited rulesets are untouched as well, so a nested child cannot
 * escape its ancestor's denies by choosing a folder of its own.
 *
 * Both the inherited and the requested folder end up canonical here: a selection
 * that reaches its target through a symlink or junction is stored as the real
 * directory, so an external tree can never be read as if it were internal.
 */

// Stored on the session row instead of in a new column: the selection is part of
// the same per-session record as the effort level, so it survives a restart and
// a resume without a migration.
const Key = "workdir"

export function read(metadata: Record<string, unknown> | undefined) {
  const value = metadata?.[Key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function select(metadata: Record<string, unknown> | undefined, directory: string) {
  return { ...metadata, [Key]: directory }
}

/** The folder this session works in: its own selection, else the folder it was created in. */
export function of(session: { metadata?: Record<string, unknown>; directory: string }) {
  return read(session.metadata) ?? session.directory
}

/** Windows compares paths case-insensitively; every other platform compares them exactly. */
export function same(a: string, b: string) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

// The user's home shorthand, and only that: `$HOME` and deeper shell expansion
// stay in the shell, where quoting decides what the caller meant.
const Home = /^~(?=$|[\\/])/

export function expand(directory: string) {
  return Home.test(directory) ? os.homedir() + directory.slice(1) : directory
}

/**
 * Resolve a requested working folder against the folder its caller already works
 * in, and canonicalize it. Existence and directory-ness are checked here so a
 * child can never be pointed at a folder it would fail to open on every call.
 */
export const resolve = Effect.fn("Workdir.resolve")(function* (input: {
  fs: FSUtil.Interface
  requested: string
  base: string
}) {
  const requested = expand(input.requested)
  if (requested.length === 0) {
    return yield* Effect.fail(new Error("The working folder cannot be empty."))
  }
  // `C:folder` is relative to that drive's own current directory, which is not a
  // folder the caller named: resolving it against the session's folder would land
  // somewhere nobody asked for.
  if (process.platform === "win32" && /^[A-Za-z]:(?![\\/])/.test(requested)) {
    return yield* Effect.fail(new Error(`The working folder must be an absolute path: ${requested}`))
  }
  const target = path.isAbsolute(requested) ? requested : path.resolve(input.base, requested)
  const directory = yield* Effect.try({
    try: () => FSUtil.resolve(target),
    catch: (error) =>
      new Error(
        `Cannot resolve the working folder ${requested}: ${error instanceof Error ? error.message : String(error)}`,
      ),
  })
  if (!(yield* input.fs.existsSafe(directory))) {
    return yield* Effect.fail(new Error(`The working folder does not exist: ${directory}`))
  }
  if (!(yield* input.fs.isDir(directory))) {
    return yield* Effect.fail(new Error(`The working folder is not a directory: ${directory}`))
  }
  return directory
})

export * as Workdir from "./workdir"
