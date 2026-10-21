import path from "path"
import { appendFile, mkdir, rename, rm } from "fs/promises"

export function readText(filePath: string) {
  return Bun.file(filePath).text()
}

export function readJson<T>(filePath: string) {
  return Bun.file(filePath).json() as Promise<T>
}

export async function writeText(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await Bun.write(filePath, content)
}

export async function appendText(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await appendFile(filePath, content)
}

const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"])

/**
 * Rename `source` over `dest`, retrying transient refusals. Windows cannot
 * replace a destination while a reader, the search indexer or a virus scanner
 * still holds it open, and those handles are released within a few hundred
 * milliseconds, so a short backoff turns a spurious EPERM into a successful
 * atomic replace. `renameFn` is injectable for tests.
 */
export async function renameReplace(
  source: string,
  dest: string,
  renameFn: (source: string, dest: string) => Promise<void> = rename,
) {
  let delay = 25
  for (let attempt = 0; ; attempt++) {
    try {
      await renameFn(source, dest)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (!code || !TRANSIENT_RENAME_CODES.has(code) || attempt >= 11) throw error
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, 400)
    }
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary, JSON.stringify(value)).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
  await renameReplace(temporary, filePath).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
}
