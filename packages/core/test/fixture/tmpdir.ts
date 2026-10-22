import fs from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "path"

export const tmpdir = async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(osTmpdir(), "opencode-core-test-")))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await remove(dir)
    },
  }
}

// Windows tmpdir cleanup loses a file-lock race against AV/indexers and
// still-open handles as EBUSY, EPERM or EFAULT; all three are transient here
// and worth the retry. EACCES stays fatal: a real permission problem should
// not be retried into a hang.
const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "EFAULT"])

async function remove(dir: string, retries = 30): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch (error) {
    if (
      retries === 0 ||
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      typeof error.code !== "string" ||
      !RETRYABLE_REMOVE_CODES.has(error.code)
    )
      throw error
    Bun.gc(true)
    await Bun.sleep(100)
    return remove(dir, retries - 1)
  }
}
