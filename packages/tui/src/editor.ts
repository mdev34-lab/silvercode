import type { CliRenderer } from "@opentui/core"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import type { Stream } from "node:stream"
import { resolveZedDbPath, resolveZedSelection } from "./editor-zed"
import { win32DisableProcessedInput } from "./terminal-win32"

type EditorStdio = "inherit" | "pipe" | "ignore" | number | Stream

export function normalizePromptContent(content: string) {
  if (content.endsWith("\r\n")) {
    const body = content.slice(0, -2)
    return !body.includes("\n") && !body.includes("\r") ? body : content
  }

  if (content.endsWith("\n")) {
    const body = content.slice(0, -1)
    return !body.includes("\n") && !body.includes("\r") ? body : content
  }

  return content
}

export async function openEditor(input: { value: string; renderer: CliRenderer; cwd?: string; stdin?: EditorStdio }) {
  const editor = process.env.VISUAL || process.env.EDITOR
  if (!editor) return
  const file = path.join(os.tmpdir(), `${Date.now()}.md`)
  await writeFile(file, input.value)
  try {
    await input.renderer.suspend()
    // suspend() restores the console mode it found, which re-enables processed
    // input. On Windows that turns Ctrl+C into a console event for every process
    // attached to the console (the editor, this process, and any npm launcher)
    // instead of input the editor can handle. The Ctrl+C guard re-asserts this
    // after raw-mode toggles, but it only wraps the stream it was installed on,
    // so re-assert at the handoff as well (#441).
    const stdin = input.stdin
    win32DisableProcessedInput(
      typeof stdin === "object" && stdin !== null && "isTTY" in stdin ? (stdin as NodeJS.ReadStream) : process.stdin,
    )
    await new Promise<void>((resolve, reject) => {
      const parts = editor.split(" ")
      const child = spawn(parts[0]!, [...parts.slice(1), file], {
        cwd: input.cwd && existsSync(input.cwd) ? input.cwd : process.cwd(),
        stdio: [input.stdin ?? "inherit", "inherit", "inherit"],
        shell: process.platform === "win32",
      })
      child.on("error", reject)
      child.on("exit", (code, signal) => {
        if (code === 0) return resolve()
        reject(new Error(`Editor exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
      })
    })
    return (await readFile(file, "utf8")) || undefined
  } finally {
    await rm(file, { force: true }).catch(() => {})
    // The renderer can be destroyed while the external editor owns the
    // terminal (SIGHUP/SIGTERM teardown between suspend and resume, #377).
    // Resuming a destroyed renderer throws on the native guard; skip it and
    // let the teardown path own the terminal instead.
    if (!input.renderer.isDestroyed) {
      try {
        await input.renderer.resume()
        // resume() is async: teardown can land while it is in flight, so
        // recheck before touching the native scene again.
        if (!input.renderer.isDestroyed) input.renderer.requestRender()
      } catch (error) {
        // Suppress only the teardown race; a resume() failure on a live
        // renderer is a real defect and must propagate.
        if (!input.renderer.isDestroyed) throw error
      }
    }
  }
}

export function discoverEditorConnection(directory: string) {
  const root = path.join(os.homedir(), ".claude", "ide")
  const contains = (parent: string) => {
    const resolved = path.resolve(parent)
    const relative = path.relative(resolved, path.resolve(directory))
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? resolved.length : 0
  }
  try {
    return readdirSync(root)
      .filter((entry) => entry.endsWith(".lock"))
      .flatMap((entry) => {
        const file = path.join(root, entry)
        const port = Number.parseInt(path.basename(file, ".lock"), 10)
        if (!Number.isInteger(port) || port <= 0 || port > 65535) return []
        try {
          const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
          if (value.transport !== undefined && value.transport !== "ws") return []
          const folders = Array.isArray(value.workspaceFolders)
            ? value.workspaceFolders.filter((item): item is string => typeof item === "string")
            : []
          const score = Math.max(0, ...folders.map(contains))
          if (!score) return []
          return [
            {
              url: `ws://127.0.0.1:${port}`,
              authToken: typeof value.authToken === "string" ? value.authToken : undefined,
              source: `lock:${port}`,
              score,
              mtime: statSync(file).mtimeMs,
            },
          ]
        } catch {
          return []
        }
      })
      .sort((left, right) => right.score - left.score || right.mtime - left.mtime)
      .map(({ url, authToken, source }) => ({ url, authToken, source }))[0]
  } catch {
    return undefined
  }
}

export const editorIntegration = {
  connection: discoverEditorConnection,
  selection: (directory: string) => resolveZedSelection(resolveZedDbPath() ?? "", directory),
}
