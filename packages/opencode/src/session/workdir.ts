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

/** The platform whose path rules decide what a request means. */
export type Platform = NodeJS.Platform

/**
 * Windows compares paths case-insensitively, so the same folder respelled with
 * different case is still the same folder and a resume may keep it. Every other
 * platform compares them exactly, where a case difference names a different
 * folder (or no folder at all) and the resume is refused.
 */
export function same(a: string, b: string, platform: Platform = process.platform) {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

// The user's home shorthand, and only that: `$HOME` and deeper shell expansion
// stay in the shell, where quoting decides what the caller meant.
const Home = /^~(?=$|[\\/])/

export function expand(directory: string, home: string = os.homedir()) {
  return Home.test(directory) ? home + directory.slice(1) : directory
}

/**
 * What a request names, in the terms the platform decides with.
 *
 * `absolute` names its own target, including a Windows UNC path
 * (`\\server\share\folder`), which is why those can be used as they are.
 * `relative` is resolved from the session's folder. `process-relative` names a
 * location that depends on state nobody asked about - `C:folder` follows that
 * drive's current directory and `\folder` follows the process's current drive -
 * so it is refused rather than silently resolved from somewhere else.
 *
 * The platform is a parameter so both rule sets can be exercised on either
 * runner: the Linux leg proves the Windows spellings without a Windows machine,
 * and the Windows leg still proves the real thing.
 */
export type Spelling = "absolute" | "relative" | "process-relative"

export function classify(requested: string, platform: Platform = process.platform): Spelling {
  if (platform !== "win32") return path.posix.isAbsolute(requested) ? "absolute" : "relative"
  if (/^[A-Za-z]:(?![\\/])/.test(requested)) return "process-relative"
  if (/^[\\/](?![\\/])/.test(requested)) return "process-relative"
  return path.win32.isAbsolute(requested) ? "absolute" : "relative"
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
  // `C:folder` is relative to that drive's own current directory and `\folder`
  // is rooted on the process's current drive; neither names a folder the caller
  // asked for, so resolving either against the session's folder would land
  // somewhere nobody asked for.
  const spelling = classify(requested)
  if (spelling === "process-relative") {
    return yield* Effect.fail(new Error(`The working folder must be an absolute path: ${requested}`))
  }
  const target = spelling === "absolute" ? requested : path.resolve(input.base, requested)
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
