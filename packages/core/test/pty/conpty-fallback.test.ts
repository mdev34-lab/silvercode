// #443: ConPTY fallback policy. Runs on any platform: the win32 branch is
// exercised by injecting a fake backend spawner.
import { describe, expect, mock, test } from "bun:test"
import { isConptyDllLoadError, spawnWithConptyFallback } from "../../src/pty/pty.node"

const dllError = () => new Error("The specified module could not be found. \\\\?\\C:\\app\\conpty.dll (winerror 126)")
const spawnError = () => new Error("spawn nosuchfile ENOENT")

describe("isConptyDllLoadError", () => {
  test("matches DLL-load failures only", () => {
    expect(isConptyDllLoadError(dllError())).toBe(true)
    expect(isConptyDllLoadError(new Error("ConPTY initialization failed"))).toBe(true)
    expect(isConptyDllLoadError(spawnError())).toBe(false)
    expect(isConptyDllLoadError(new Error("Access is denied."))).toBe(false)
  })
})

describe("spawnWithConptyFallback", () => {
  test("uses the bundled DLL first and does not retry on success", () => {
    const backends: boolean[] = []
    const proc = spawnWithConptyFallback((backend) => {
      backends.push(backend.useConptyDll)
      return { pid: 1 }
    })
    expect(proc).toEqual({ pid: 1 })
    expect(backends).toEqual([true])
  })

  test("falls back to the system ConPTY only on DLL-load failure", () => {
    const backends: boolean[] = []
    const proc = spawnWithConptyFallback((backend) => {
      backends.push(backend.useConptyDll)
      if (backend.useConptyDll) throw dllError()
      return { pid: 2 }
    })
    expect(proc).toEqual({ pid: 2 })
    expect(backends).toEqual([true, false])
  })

  test("does not retry when the spawn request itself is invalid", () => {
    const spawnBackend = mock(() => {
      throw spawnError()
    })
    expect(() => spawnWithConptyFallback(spawnBackend)).toThrow("ENOENT")
    expect(spawnBackend).toHaveBeenCalledTimes(1)
  })

  test("when both backends fail the thrown error carries both as cause", () => {
    const first = dllError()
    const second = new Error("CreatePseudoConsole failed")
    const spawnBackend = mock((backend: { useConptyDll: boolean }) => {
      throw backend.useConptyDll ? first : second
    })
    try {
      spawnWithConptyFallback(spawnBackend)
      expect.unreachable("should have thrown")
    } catch (error) {
      const cause = (error as { cause?: { first?: unknown; second?: unknown } }).cause
      expect(cause?.first).toBe(first)
      expect(cause?.second).toBe(second)
    }
    expect(spawnBackend).toHaveBeenCalledTimes(2)
  })
})
