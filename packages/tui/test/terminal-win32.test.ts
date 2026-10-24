import { expect, test } from "bun:test"
import vm from "node:vm"

const filename = new URL("../src/terminal-win32.ts", import.meta.url)
const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  (await Bun.file(filename).text())
    .replace('import { dlopen, ptr } from "bun:ffi"', "const { dlopen, ptr } = ffi")
    .replaceAll("export function ", "function "),
)

function fixture(
  input: {
    platform?: string
    tty?: boolean
    open?: number
    modeFails?: boolean
    intervalThrows?: boolean
    rawThrows?: boolean
  } = {},
) {
  let mode = 7
  const opened: unknown[][] = []
  const closed: number[] = []
  const reads: number[] = []
  const writes: number[][] = []
  const immediates: (() => void)[] = []
  const intervals = new Set<() => void>()
  let raw = 0
  const stdin = {
    isTTY: input.tty ?? false,
    setRawMode() {
      return stdin
    },
  }
  const conin = {
    isTTY: true,
    setRawMode() {
      raw++
      mode = 7
      return conin
    },
  }
  const original = conin.setRawMode
  if (input.rawThrows)
    Object.defineProperty(conin, "setRawMode", {
      get: () => original,
      set: () => {
        throw new Error("raw setter failed")
      },
    })
  const api = vm.runInNewContext(
    `(() => { ${source}; return { win32InstallCtrlCGuard, win32DisableProcessedInput } })()`,
    {
      process: { platform: input.platform ?? "win32", stdin },
      ffi: {
        ptr: (buf: unknown) => buf,
        dlopen: () => ({
          symbols: {
            GetStdHandle: () => 11,
            CreateFileW: (...args: unknown[]) => {
              opened.push(args)
              return input.open ?? 22
            },
            CloseHandle: (handle: number) => {
              closed.push(handle)
              return 1
            },
            GetConsoleMode: (handle: number, buf: Uint32Array) => {
              reads.push(handle)
              buf[0] = mode
              return input.modeFails ? 0 : 1
            },
            SetConsoleMode: (handle: number, next: number) => {
              writes.push([handle, next])
              mode = next
              return 1
            },
          },
        }),
      },
      setImmediate: (fn: () => void) => immediates.push(fn),
      setInterval: (fn: () => void) => {
        if (input.intervalThrows) throw new Error("timer setup failed")
        intervals.add(fn)
        return { unref() {} }
      },
      clearInterval: () => intervals.clear(),
    },
  )
  return {
    api,
    stdin,
    conin,
    original,
    opened,
    closed,
    reads,
    writes,
    intervals,
    immediates,
    get mode() {
      return mode
    },
    get raw() {
      return raw
    },
    reset() {
      mode = 7
    },
  }
}

test("guards the renderer CONIN$ stream when process stdin is redirected", () => {
  const f = fixture()
  const stop = f.api.win32InstallCtrlCGuard(f.conin)
  expect(typeof stop).toBe("function")
  const [name, access, share, , disposition] = f.opened[0]!
  expect(String.fromCharCode(...(name as Uint16Array))).toBe("CONIN$\0")
  expect([access, share, disposition]).toEqual([0xc0000000, 3, 3])
  expect(f.mode & 1).toBe(0)
  expect(f.reads.every((handle) => handle === 22)).toBe(true)
  f.conin.setRawMode()
  expect(f.raw).toBe(1)
  expect(f.mode & 1).toBe(0)
  f.reset()
  for (const poll of f.intervals) poll()
  expect(f.mode & 1).toBe(0)
  stop()
  stop()
  expect(f.conin.setRawMode).toBe(f.original)
  expect(f.mode).toBe(7)
  expect(f.closed).toEqual([22])
  expect(f.intervals.size).toBe(0)
  const reads = f.reads.length
  for (const immediate of f.immediates) immediate()
  expect(f.reads.length).toBe(reads)
})

test("editor handoff reasserts on CONIN$ and closes only its temporary handle", () => {
  const f = fixture()
  f.api.win32DisableProcessedInput(f.conin)
  expect(f.mode & 1).toBe(0)
  expect(f.writes).toEqual([[22, 6]])
  expect(f.closed).toEqual([22])
})

test("normal tty stdin retains the borrowed standard handle", () => {
  const f = fixture({ tty: true })
  const stop = f.api.win32InstallCtrlCGuard()
  expect(f.opened).toHaveLength(0)
  expect(f.reads.every((handle) => handle === 11)).toBe(true)
  stop()
  expect(f.closed).toEqual([])
})

test("failed CONIN$ open does not install a guard or close an invalid handle", () => {
  const f = fixture({ open: 0xffffffffffffffff })
  expect(f.api.win32InstallCtrlCGuard(f.conin)).toBeUndefined()
  expect(f.reads).toEqual([])
  expect(f.closed).toEqual([])
  expect(f.conin.setRawMode).toBe(f.original)
})

test("failed console mode lookup closes the owned handle", () => {
  const f = fixture({ modeFails: true })
  expect(f.api.win32InstallCtrlCGuard(f.conin)).toBeUndefined()
  expect(f.closed).toEqual([22])
  expect(f.conin.setRawMode).toBe(f.original)
})

test("POSIX does not open console handles", () => {
  const f = fixture({ platform: "linux" })
  expect(f.api.win32InstallCtrlCGuard(f.conin)).toBeUndefined()
  f.api.win32DisableProcessedInput(f.conin)
  expect(f.opened).toEqual([])
})

for (const failure of ["rawThrows", "intervalThrows"] as const) {
  test(`closes the owned console handle when ${failure} interrupts guard setup`, () => {
    const f = fixture({ [failure]: true })
    expect(() => f.api.win32InstallCtrlCGuard(f.conin)).toThrow()
    expect(f.closed).toEqual([22])
    expect(f.conin.setRawMode).toBe(f.original)
    const reads = f.reads.length
    for (const immediate of f.immediates) immediate()
    expect(f.reads.length).toBe(reads)
  })
}
