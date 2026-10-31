import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@opencode-ai/core/shell"
import { shellOutputDecoder, windowsPowerShellCommand } from "@opencode-ai/core/shell-encoding"
import { ShellID } from "./shell/id"
import { ToolFailure } from "@opencode-ai/llm"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { BackgroundJob } from "@/background/job"
import { ShellBackground } from "./shell/background"
import { Identifier } from "@/id/id"
import { EffectBridge } from "@/effect/bridge"
import type { TaskPromptOps } from "./task"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const POST_EXIT_OUTPUT_IDLE_TIMEOUT = "500 millis"
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan, input: { command: string }) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(
      shell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsPowerShellCommand(shell, command)],
      {
        cwd,
        env,
        stdin: "ignore",
        detached: false,
        // Bound scope-teardown kills: without this, a child that ignores SIGTERM
        // hangs the finalizer forever and the session never leaves "running".
        forceKillAfter: "3 seconds",
      },
    )
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
    forceKillAfter: "3 seconds",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

/**
 * The tool result shape for both endings: a command that finished inline and a
 * command that was promoted to the background. Declaring it keeps the two
 * branches assignable to one result type.
 */
type Metadata = {
  output: string
  exit?: number | null
  truncated: boolean
  outputPath?: string
  background?: boolean
  jobId?: string
}

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const background = yield* BackgroundJob.Service
    // The inline window for a command the caller did not bound. The older
    // bashDefaultTimeoutMs knob was "how long to let a command run inline", so
    // it is honored as the threshold when the new flag is unset; an explicit
    // threshold wins, and the default window is 5 minutes (#726).
    const backgroundThresholdMs = flags.bashBackgroundThresholdMs ?? flags.bashDefaultTimeoutMs ?? 5 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        /** Hard deadline in milliseconds. */
        timeout: number
        /**
         * False when the deadline is the tool's own window rather than a value
         * the caller passed. Only that case is eligible for promotion: an
         * explicit timeout is a caller-set deadline and keeps kill semantics.
         */
        explicitTimeout: boolean
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let processed = 0
      let processing = false
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let spillError: Error | undefined
      let cut = false
      let expired = false
      let aborted = false
      let signaled: string | undefined
      let exitCode: number | null | undefined
      // Set at the threshold. From then on the tool call is over and this run
      // belongs to the background job, so it must stop publishing to the call.
      let promoted = false
      const meta: string[] = []
      // Live control of the child, filled in at spawn. The background handle and
      // the management tool read the latest value, so a cancel is always aimed
      // at the process that is actually running.
      const control: { kill: Effect.Effect<void>; pid: number | undefined } = {
        kill: Effect.void,
        pid: undefined,
      }
      // Producer-owned metadata for the background job, created at promotion.
      // The registry retains this object, so late evidence stays visible to the
      // job list without a second channel.
      let live: Record<string, unknown> | undefined
      const promotion = yield* Deferred.make<void>()
      // The child runs in a scope of its own rather than the tool call's: on
      // promotion its fiber is handed to the background job instead of being
      // interrupted when this call returns. Every other ending closes the scope
      // explicitly, so nothing outlives the call by accident.
      const childScope = yield* Scope.make()
      let handedOff = false
      // After promotion the tool part is finished; progress goes to the job
      // record instead of a completed call's metadata.
      const publish = (text: string) => (promoted ? Effect.void : ctx.metadata({ metadata: { output: text } }))

      /** What the command has emitted so far, bounded by the same limits the inline result uses. */
      const snapshot = (): ShellBackground.Snapshot => {
        const end = tail(list.map((item) => item.text).join(""), limits.maxLines, limits.maxBytes)
        return {
          output: end.text,
          truncated: cut || end.cut,
          ...(file ? { outputPath: file } : {}),
          ...(exitCode !== undefined ? { exit: exitCode } : {}),
          ...(signaled ? { signal: signaled } : {}),
        }
      }

      const markOutputProcessed = Effect.sync(() => {
        processing = false
        processed++
      })

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
        },
      })

      const execute = Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const decoder = shellOutputDecoder(input.shell)
          if (decoder.warning) {
            meta.push(decoder.warning)
            yield* Effect.logWarning(decoder.warning)
          }
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))
          control.pid = handle.pid
          // The same escalation the inline path uses for timeout and abort:
          // SIGTERM to the process group, SIGKILL after three seconds.
          control.kill = handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore)
          // A heavy command (build, headless browser, busy loop) at normal
          // priority can starve the TUI of CPU time until the screen stops
          // rendering. Run tool commands below normal priority; children
          // inherit it, and on an idle machine it costs nothing. Best effort.
          try {
            os.setPriority(handle.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
          } catch {}

          const append = (chunk: string) => {
            processing = true
            const size = Buffer.byteLength(chunk, "utf-8")
            list.push({ text: chunk, size })
            used += size
            while (used > keep && list.length > 1) {
              const item = list.shift()
              if (!item) break
              used -= item.size
              cut = true
            }

            last = preview(last + chunk)

            if (file) {
              sink?.write(chunk)
            } else {
              full += chunk
              if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                return trunc.write(full).pipe(
                  Effect.andThen((next) =>
                    Effect.sync(() => {
                      file = next
                      cut = true
                      sink = createWriteStream(next, { flags: "a" })
                      // Listen right away: a mid-command failure (ENOSPC, EACCES,
                      // EMFILE) with no listener is an uncaughtException that kills
                      // a bare server process. On failure, stop spilling and keep the
                      // truncated in-memory output instead of taking down the runtime.
                      const stream = sink
                      stream.on("error", (error) => {
                        spillError = error instanceof Error ? error : new Error(String(error))
                        if (sink === stream) sink = undefined
                        stream.destroy()
                      })
                      full = ""
                    }),
                  ),
                  Effect.andThen(publish(last)),
                  Effect.ensuring(markOutputProcessed),
                )
              }
            }

            // The job record keeps a live, bounded preview so listing jobs does
            // not have to reach into a finished tool call's metadata.
            if (promoted && live) live.output = last
            return publish(last).pipe(Effect.ensuring(markOutputProcessed))
          }
          const output = yield* Stream.runForEach(Stream.map(handle.all, decoder.decode), append).pipe(
            // Abort, timeout, and idle cutoff can close the scope before the input
            // reaches EOF, so flush the decoder when this fiber ends for any reason.
            Effect.ensuring(Effect.suspend(() => append(decoder.end()))),
            Effect.forkScoped,
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          // An explicit timeout is a caller-set deadline and keeps kill
          // semantics. Without one the command is never killed for running
          // long: it is promoted to a background job at the threshold instead,
          // so the legacy default window cannot cut a long command short.
          const deadline = !input.explicitTimeout
            ? Effect.never
            : Effect.sleep(`${input.timeout + 100} millis`).pipe(
                Effect.map(() => ({ kind: "timeout" as const, code: null, signal: undefined })),
              )

          // Promotion keeps the same child alive: the signal is a receipt for
          // the tool call, and this fiber goes on waiting for the real exit.
          const threshold = input.explicitTimeout
            ? Effect.never
            : Effect.sleep(`${backgroundThresholdMs} millis`).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    promoted = true
                  }),
                ),
                Effect.andThen(Deferred.succeed(promotion, void 0)),
                Effect.andThen(Effect.never),
              )

          // A child killed by an external signal fails `exitCode` by design
          // ("Process interrupted due to receipt of signal"). That is a normal
          // way for a command to end, so recover it here: the run completes
          // with the output collected so far and a note about the signal
          // instead of dying as a defect.
          const exited = handle.exitCode.pipe(
            Effect.map((code) => ({ kind: "exit" as const, code: code as number | null, signal: undefined })),
            Effect.catch((error) => {
              const message = error instanceof Error ? error.message : String(error)
              const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : ""
              return Effect.succeed({
                kind: "exit" as const,
                code: null,
                signal: /signal: '([^']+)'/.exec(message)?.[1] ?? /signal: '([^']+)'/.exec(cause)?.[1],
              })
            }),
          )
          const exit = yield* Effect.raceAll([
            exited,
            abort.pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  promoted
                    ? Effect.never
                    : Effect.succeed({ kind: "abort" as const, code: null, signal: undefined }),
                ),
              ),
            ),
            deadline,
            threshold,
          ])

          // The kill can lose the race against the child exiting on its own
          // (ESRCH on POSIX, "not found" from taskkill on Windows): the wanted
          // end state already holds, so tolerate the failure.
          const kill = control.kill
          if (exit.kind === "abort") {
            aborted = true
            yield* kill
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* kill
          }
          if (exit.kind === "exit" && exit.signal) {
            signaled = exit.signal
          }

          if (exit.kind === "exit") {
            // Ordinary commands reach EOF immediately; outliving children can keep stdio open.
            // After exit, stop waiting once processed output stays quiet across a 500ms check.
            const settle = Effect.gen(function* () {
              let seen = processed
              while (true) {
                yield* Effect.sleep(POST_EXIT_OUTPUT_IDLE_TIMEOUT)
                const current = processed
                if (!processing && current === seen) return
                seen = current
              }
            })
            yield* Effect.raceAll([Fiber.join(output).pipe(Effect.ignore), settle])
          }

          exitCode = exit.kind === "exit" ? exit.code : null
          return exitCode
        }),
      ).pipe(
        Effect.mapError(
          (error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
        ),
      )

      /**
       * The result for a finished command. The inline path and the background
       * job both render through it, so exit code, truncation and the spill file
       * are reported identically however the command ended up running.
       */
      const format = Effect.fnUntraced(function* (code: number | null) {
        if (expired) {
          meta.push(
            `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
          )
        }
        if (aborted) meta.push("User aborted the command")
        if (spillError) {
          meta.push(
            `Could not save the full output to a file (${spillError.message}). The output below may be incomplete.`,
          )
          file = ""
        }
        if (signaled) meta.push(`Command was terminated by signal ${signaled}`)
        const raw = list.map((item) => item.text).join("")
        const end = tail(raw, limits.maxLines, limits.maxBytes)
        if (end.cut) cut = true
        if (!file && end.cut && !spillError) {
          file = yield* trunc.write(raw)
        }

        let output = end.text
        if (!output) output = "(no output)"

        if (cut && file) {
          output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
        }

        // Capture the user-visible preview before appending protocol metadata.
        // metadata.output is rendered verbatim in the TUI, so <shell_metadata>
        // must never appear there. The model-facing `output` field retains the
        // full block so recovery/retry hints reach the model unchanged.
        const tuiPreview = last || preview(output)

        if (meta.length > 0) {
          output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
        }
        return {
          code,
          output,
          tuiPreview,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        }
      })

      /**
       * Delivers the terminal envelope for a backgrounded command through the
       * same background-result path the task tool uses: wait on the job, then
       * prompt the owning session with a synthetic part. A teardown cancel keeps
       * its receipt but suppresses the wake, so a session that is stopping is
       * not resurrected (#413).
       *
       * Delivery is forked on the host runtime rather than into this tool call's
       * scope: the receipt must arrive after the call - and possibly the turn -
       * that launched the command has ended.
       */
      const notify = Effect.fn("ShellTool.notifyBackgroundResult")(function* (jobID: string) {
        const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
        if (!ops) return
        const bridge = yield* EffectBridge.make()
        const deliver = Effect.gen(function* () {
          const result = yield* background.wait({ id: jobID })
          const info = result.info
          if (!info) return
          const state =
            info.status === "completed" ? "completed" : info.status === "cancelled" ? "cancelled" : "error"
          // A teardown cancel is delivered silently: the row resolves without a
          // turn, so the session being torn down is not woken by it.
          const silent = info.cancelledByTeardown === true
          const text =
            info.status === "completed"
              ? (info.output ?? "")
              : info.status === "cancelled"
                ? (info.output ?? ShellBackground.CANCELLED_TEXT)
                : (info.error ?? "")
          yield* ops.prompt({
            sessionID: ctx.sessionID,
            noReply: silent,
            agent: ctx.agent,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: ShellBackground.renderResult({ id: jobID, command: input.command, state, text }),
                ...(silent ? { metadata: { backgroundNoReply: true } } : {}),
              },
            ],
          })
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`shell background notification failed: ${String(cause)}`),
          ),
        )
        yield* Effect.sync(() => {
          bridge.fork(deliver)
        })
      })

      // The child is supervised in its own fiber and scope so that promotion can
      // hand it over without interrupting it. If this call is interrupted before
      // the handoff, the child must not outlive it unseen: closing this scope
      // runs the spawner escalation and kills the same process tree the inline
      // path would.
      const supervised = Effect.gen(function* () {
        const fiber = yield* execute.pipe(Effect.forkIn(childScope, { startImmediately: true }))
        const first = yield* Effect.raceFirst(
          Fiber.await(fiber).pipe(Effect.map((exit) => ({ kind: "done" as const, exit }))),
          Deferred.await(promotion).pipe(Effect.map(() => ({ kind: "promoted" as const }))),
        )

        if (first.kind === "done") {
          yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore)
          const code = Exit.isSuccess(first.exit) ? first.exit.value : yield* Effect.failCause(first.exit.cause)
          const result = yield* format(code)
          const settled: Tool.ExecuteResult<Metadata> = {
            title: input.command,
            metadata: {
              output: result.tuiPreview,
              exit: code,
              truncated: result.truncated,
              ...(result.outputPath ? { outputPath: result.outputPath } : {}),
            },
            output: result.output,
          }
          return settled
        }

        // Promotion. The job owns the child from here: the same process, the same
        // output fiber, no kill and no re-execution.
        handedOff = true
        const jobID = Identifier.ascending("job")
        const metadata: Record<string, unknown> = {
          sessionId: ctx.sessionID,
          command: input.command,
          cwd: input.cwd,
          ...(control.pid !== undefined ? { pid: control.pid } : {}),
          // This job only exists once promoted, so it starts as background work
          // rather than going through promote() from a foreground job.
          background: true,
        }
        live = metadata
        const unregister = ShellBackground.register(background, {
          id: jobID,
          command: input.command,
          sessionID: ctx.sessionID,
          startedAt: Date.now(),
          ...(control.pid !== undefined ? { pid: control.pid } : {}),
          snapshot,
          kill: () => control.kill,
        })
        const info = yield* background.start({
          id: jobID,
          type: ShellBackground.TYPE,
          title: input.command,
          metadata,
          run: Effect.gen(function* () {
            const exit = yield* Fiber.await(fiber)
            if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
            // The registry has no exit-code field, and the job list already
            // carries this metadata object: record the outcome where it can be
            // read without re-parsing the envelope.
            if (exit.value !== null) metadata.exit = exit.value
            return (yield* format(exit.value)).output
          }).pipe(
            // Cancellation and teardown close the job scope; closing the child's
            // scope with it interrupts the supervisor and runs the spawner's
            // escalation, so the process tree dies with the registry entry.
            Effect.ensuring(Scope.close(childScope, Exit.void).pipe(Effect.ignore)),
            Effect.ensuring(Effect.sync(unregister)),
          ),
        })

        yield* notify(info.id).pipe(Effect.ignore)

        const view = snapshot()
        const started: Tool.ExecuteResult<Metadata> = {
          title: input.command,
          metadata: {
            // Same rule as the inline result: the TUI preview never carries the
            // protocol envelope.
            output: last || preview(view.output),
            background: true,
            jobId: info.id,
            truncated: view.truncated,
            ...(view.outputPath ? { outputPath: view.outputPath } : {}),
          },
          output: ShellBackground.renderRunning({
            id: info.id,
            command: input.command,
            thresholdMs: backgroundThresholdMs,
            output: view.output,
          }),
        }
        return started
      })
      return yield* supervised.pipe(
        Effect.onInterrupt(() =>
          handedOff ? Effect.void : Scope.close(childScope, Exit.void).pipe(Effect.ignore),
        ),
      )
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, backgroundThresholdMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const explicitTimeout = params.timeout !== undefined
              const timeout = params.timeout ?? backgroundThresholdMs
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, params)
                }),
              )

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  explicitTimeout,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
