import { describe, expect, test } from "bun:test"
import {
  adoptWorkerProcess,
  createOwnerJob,
  createOwnerJobAdopter,
  addProcessToJob,
  JOB_ASSIGN_ACCESS,
  jobInfoSize,
  killOnCloseInfo,
  windowsJobApi,
  type FfiModule,
  type WindowsJobApi,
} from "../../../src/cli/tui/win-job"

const KILL_ON_JOB_CLOSE = 0x00002000

/** Behavior overrides; every call is still recorded in `calls`. */
type FakeBehavior = {
  create?: () => unknown
  set?: () => boolean
  open?: () => unknown
  assign?: () => boolean
}

function fakeApi(behavior: FakeBehavior = {}) {
  const calls: string[] = []
  const jobHandle = { job: true }
  const processHandle = { process: true }
  const infos: Uint8Array[] = []
  const api: WindowsJobApi = {
    pointerBytes: 8,
    createJobObject() {
      calls.push("CreateJobObjectW")
      return behavior.create ? behavior.create() : jobHandle
    },
    setInformationJobObject(job, info) {
      calls.push("SetInformationJobObject")
      expect(job).toBe(jobHandle)
      infos.push(info)
      return behavior.set ? behavior.set() : true
    },
    openProcess(desiredAccess, pid) {
      calls.push(`OpenProcess(${desiredAccess},${pid})`)
      return behavior.open ? behavior.open() : processHandle
    },
    assignProcessToJobObject(job, process) {
      calls.push("AssignProcessToJobObject")
      expect(job).toBe(jobHandle)
      expect(process).toBe(processHandle)
      return behavior.assign ? behavior.assign() : true
    },
    closeHandle(handle) {
      calls.push(handle === jobHandle ? "CloseHandle(job)" : "CloseHandle(process)")
    },
    lastError: () => 5,
  }
  return { api, calls, infos, jobHandle, processHandle }
}

describe("windows job object", () => {
  test("sizes JOBOBJECT_EXTENDED_LIMIT_INFORMATION for both pointer widths", () => {
    expect(jobInfoSize(8)).toBe(144)
    expect(jobInfoSize(4)).toBe(112)
    // The struct starts with two 8-byte LARGE_INTEGERs, so LimitFlags sits at
    // byte 16 on both widths.
    const wide = killOnCloseInfo(8)
    const narrow = killOnCloseInfo(4)
    expect(wide.length).toBe(144)
    expect(narrow.length).toBe(112)
    expect(new DataView(wide.buffer).getUint32(16, true)).toBe(KILL_ON_JOB_CLOSE)
    expect(new DataView(narrow.buffer).getUint32(16, true)).toBe(KILL_ON_JOB_CLOSE)
  })

  test("leaves every other job limit unset", () => {
    const info = killOnCloseInfo(8)
    // Only the four LimitFlags bytes may be non-zero: every other field is a
    // limit, and a limit of zero means "no limit".
    expect([...info].filter((byte, index) => byte !== 0 && (index < 16 || index > 19))).toEqual([])
  })

  test("creates the job and configures kill-on-close", () => {
    const fake = fakeApi()
    const created = createOwnerJob(fake.api)

    expect(created.ok).toBe(true)
    expect(fake.calls).toEqual(["CreateJobObjectW", "SetInformationJobObject"])
    expect(new DataView(fake.infos[0].buffer).getUint32(16, true)).toBe(KILL_ON_JOB_CLOSE)
  })

  test("reports a null job handle without configuring or closing anything", () => {
    const fake = fakeApi({ create: () => null })
    const created = createOwnerJob(fake.api)

    expect(created).toEqual({ ok: false, reason: "CreateJobObjectW failed (error 5)" })
    // Nothing to configure and nothing to close: the handle never existed.
    expect(fake.calls).toEqual(["CreateJobObjectW"])
  })

  test("closes the job handle when it cannot be configured", () => {
    const fake = fakeApi({ set: () => false })
    const created = createOwnerJob(fake.api)

    expect(created).toEqual({ ok: false, reason: "SetInformationJobObject failed (error 5)" })
    expect(fake.calls).toEqual(["CreateJobObjectW", "SetInformationJobObject", "CloseHandle(job)"])
  })

  test("assigns a process with quota and terminate rights, releasing only its handle", () => {
    const fake = fakeApi()
    const assigned = addProcessToJob(fake.api, fake.jobHandle, 4242)

    expect(assigned).toEqual({ ok: true })
    // Process handles are only needed for the assignment call itself; the job
    // keeps the process for as long as the owner holds it, so the job handle
    // must stay open (#442).
    expect(fake.calls).toEqual([
      `OpenProcess(${JOB_ASSIGN_ACCESS},4242)`,
      "AssignProcessToJobObject",
      "CloseHandle(process)",
    ])
    expect(JOB_ASSIGN_ACCESS).toBe(0x0101)
  })

  test("reports an unopenable process without assigning", () => {
    const fake = fakeApi({ open: () => 0 })
    const assigned = addProcessToJob(fake.api, fake.jobHandle, 7)

    expect(assigned).toEqual({ ok: false, reason: "OpenProcess(7) failed (error 5)" })
    expect(fake.calls).toEqual([`OpenProcess(${JOB_ASSIGN_ACCESS},7)`])
  })

  test("reports a refused assignment and still releases the process handle", () => {
    const fake = fakeApi({ assign: () => false })
    const assigned = addProcessToJob(fake.api, fake.jobHandle, 7)

    expect(assigned).toEqual({ ok: false, reason: "AssignProcessToJobObject(7) failed (error 5)" })
    expect(fake.calls).toEqual([
      `OpenProcess(${JOB_ASSIGN_ACCESS},7)`,
      "AssignProcessToJobObject",
      "CloseHandle(process)",
    ])
  })

  test("the win32 adopter reuses one job for every spawn, restarts included", () => {
    const fake = fakeApi()
    const adopt = createOwnerJobAdopter({ platform: "win32", loadApi: () => fake.api })
    const messages: string[] = []

    adopt(101, (message) => messages.push(message))
    adopt(202, (message) => messages.push(message))

    expect(messages).toEqual([])
    expect(fake.calls.filter((call) => call === "CreateJobObjectW")).toHaveLength(1)
    expect(fake.calls.filter((call) => call === "SetInformationJobObject")).toHaveLength(1)
    expect(fake.calls).toContain(`OpenProcess(${JOB_ASSIGN_ACCESS},101)`)
    expect(fake.calls).toContain(`OpenProcess(${JOB_ASSIGN_ACCESS},202)`)
    expect(fake.calls).not.toContain("CloseHandle(job)")
  })

  test("degrades to a single warning when the job cannot be created", () => {
    let loads = 0
    const fake = fakeApi({ create: () => null })
    const adopt = createOwnerJobAdopter({
      platform: "win32",
      loadApi: () => {
        loads++
        return fake.api
      },
    })
    const messages: string[] = []

    adopt(101, (message) => messages.push(message))
    adopt(202, (message) => messages.push(message))

    // One warning, no retry loop: there is nothing left to try once the job
    // does not exist, and the worker watchdog is the documented fallback.
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("CreateJobObjectW failed")
    expect(messages[0]).toContain("#442")
    expect(loads).toBe(1)
    expect(fake.calls.filter((call) => call.startsWith("OpenProcess"))).toEqual([])
  })

  test("keeps the job and retries the assignment after a refused one", () => {
    let refuse = true
    const fake = fakeApi({
      assign: () => {
        const value = !refuse
        refuse = false
        return value
      },
    })
    const adopt = createOwnerJobAdopter({ platform: "win32", loadApi: () => fake.api })
    const messages: string[] = []

    adopt(101, (message) => messages.push(message))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("AssignProcessToJobObject(101) failed")

    adopt(202, (message) => messages.push(message))
    expect(messages).toHaveLength(1)
    expect(fake.calls.filter((call) => call === "CreateJobObjectW")).toHaveLength(1)
    expect(fake.calls).toContain(`OpenProcess(${JOB_ASSIGN_ACCESS},202)`)
  })

  test("warns once while assignment keeps failing, and keeps retrying every spawn", () => {
    const fake = fakeApi({ assign: () => false })
    const adopt = createOwnerJobAdopter({ platform: "win32", loadApi: () => fake.api })
    const messages: string[] = []

    adopt(101, (message) => messages.push(message))
    adopt(202, (message) => messages.push(message))
    adopt(303, (message) => messages.push(message))

    // The single-warning fallback contract: persistent assignment failure is
    // one warning, not one per adoption - but every later spawn is still
    // attempted against the same retained job.
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("AssignProcessToJobObject(101) failed")
    expect(messages[0]).toContain("#442")
    expect(fake.calls.filter((call) => call === "CreateJobObjectW")).toHaveLength(1)
    expect(fake.calls.filter((call) => call.startsWith("OpenProcess"))).toEqual([
      `OpenProcess(${JOB_ASSIGN_ACCESS},101)`,
      `OpenProcess(${JOB_ASSIGN_ACCESS},202)`,
      `OpenProcess(${JOB_ASSIGN_ACCESS},303)`,
    ])
    expect(fake.calls).not.toContain("CloseHandle(job)")
  })

  test("warns once while the worker process cannot be opened", () => {
    const fake = fakeApi({ open: () => null })
    const adopt = createOwnerJobAdopter({ platform: "win32", loadApi: () => fake.api })
    const messages: string[] = []

    adopt(101, (message) => messages.push(message))
    adopt(202, (message) => messages.push(message))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("OpenProcess(101) failed")
    expect(fake.calls.filter((call) => call.startsWith("OpenProcess"))).toEqual([
      `OpenProcess(${JOB_ASSIGN_ACCESS},101)`,
      `OpenProcess(${JOB_ASSIGN_ACCESS},202)`,
    ])
  })

  test("a successful assignment rearms the warning for a later failure episode", () => {
    const results = [false, true, false]
    const fake = fakeApi({ assign: () => results.shift() ?? true })
    const adopt = createOwnerJobAdopter({ platform: "win32", loadApi: () => fake.api })
    const messages: string[] = []

    adopt(101, (message) => messages.push(message))
    adopt(202, (message) => messages.push(message))
    adopt(303, (message) => messages.push(message))

    // Failure, success, failure: the warning fired for the first episode,
    // stayed quiet through the success, and fires again for the new episode.
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain("AssignProcessToJobObject(101) failed")
    expect(messages[1]).toContain("AssignProcessToJobObject(303) failed")
  })

  test("survives a broken FFI load and warns once", () => {
    let loads = 0
    const adopt = createOwnerJobAdopter({
      platform: "win32",
      loadApi: () => {
        loads++
        throw new Error("cannot open kernel32.dll")
      },
    })
    const messages: string[] = []

    expect(() => adopt(101, (message) => messages.push(message))).not.toThrow()
    adopt(202, (message) => messages.push(message))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("cannot open kernel32.dll")
    expect(loads).toBe(1)
  })

  test("does nothing off Windows", () => {
    let loads = 0
    const adopt = createOwnerJobAdopter({
      platform: "linux",
      loadApi: () => {
        loads++
        return fakeApi().api
      },
    })

    adopt(101, () => {})
    adopt(undefined, () => {})

    expect(loads).toBe(0)
  })

  test("never loads bun:ffi on a non-win32 host", () => {
    if (process.platform === "win32") return
    // A real guard: dlopen("kernel32.dll") throws here, so a no-op proves the
    // production entry point short-circuits before touching bun:ffi.
    expect(() => adoptWorkerProcess(process.pid, () => {})).not.toThrow()
    expect(() => adoptWorkerProcess(undefined, () => {})).not.toThrow()
  })
})

/**
 * A `bun:ffi` stand-in: kernel32.dll cannot load off Windows, and the binding
 * is exactly the part a typo would break silently on the only platform where
 * it runs.
 */
function fakeFfi(results: { set?: number; assign?: number; close?: number } = {}) {
  const calls: Array<{ symbol: string; args: unknown[] }> = []
  let bound: { library: string; definitions: Record<string, { args: string[]; returns: string }> } | undefined
  const symbol = (name: string, result: unknown) =>
    function (...args: never[]) {
      calls.push({ symbol: name, args })
      return result
    }
  const ffi: FfiModule = {
    dlopen(library, definitions) {
      bound = { library, definitions }
      return {
        symbols: {
          CreateJobObjectW: symbol("CreateJobObjectW", { job: true }),
          SetInformationJobObject: symbol("SetInformationJobObject", results.set ?? 1),
          OpenProcess: symbol("OpenProcess", { process: true }),
          AssignProcessToJobObject: symbol("AssignProcessToJobObject", results.assign ?? 1),
          CloseHandle: symbol("CloseHandle", results.close ?? 1),
          GetLastError: symbol("GetLastError", 87),
        },
      }
    },
    ptr: (value) => ({ info: value }),
  }
  return { ffi, calls, bound: () => bound! }
}

describe("kernel32 binding", () => {
  test("binds the job-object calls kernel32 exports", () => {
    const fake = fakeFfi()
    windowsJobApi(fake.ffi, "x64")

    expect(fake.bound().library).toBe("kernel32.dll")
    expect(fake.bound().definitions).toEqual({
      CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
      SetInformationJobObject: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
      OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
      AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
      CloseHandle: { args: ["ptr"], returns: "i32" },
      GetLastError: { args: [], returns: "u32" },
    })
  })

  test("derives the pointer width from the architecture", () => {
    expect(windowsJobApi(fakeFfi().ffi, "x64").pointerBytes).toBe(8)
    expect(windowsJobApi(fakeFfi().ffi, "arm64").pointerBytes).toBe(8)
    expect(windowsJobApi(fakeFfi().ffi, "ia32").pointerBytes).toBe(4)
  })

  test("translates each call into its kernel32 signature", () => {
    const fake = fakeFfi()
    const api = windowsJobApi(fake.ffi, "x64")
    const info = killOnCloseInfo(api.pointerBytes)

    api.createJobObject()
    expect(api.setInformationJobObject("job", info)).toBe(true)
    api.openProcess(JOB_ASSIGN_ACCESS, 1234)
    expect(api.assignProcessToJobObject("job", "process")).toBe(true)
    api.closeHandle("job")
    expect(api.lastError()).toBe(87)

    expect(fake.calls).toEqual([
      { symbol: "CreateJobObjectW", args: [null, null] },
      // JobObjectExtendedLimitInformation (9), the info bytes, and its size.
      { symbol: "SetInformationJobObject", args: ["job", 9, { info }, info.length] },
      { symbol: "OpenProcess", args: [JOB_ASSIGN_ACCESS, 0, 1234] },
      { symbol: "AssignProcessToJobObject", args: ["job", "process"] },
      { symbol: "CloseHandle", args: ["job"] },
      { symbol: "GetLastError", args: [] },
    ])
  })

  test("reads a zero kernel32 return as failure", () => {
    const api = windowsJobApi(fakeFfi({ set: 0, assign: 0 }).ffi, "x64")
    expect(api.setInformationJobObject("job", killOnCloseInfo(8))).toBe(false)
    expect(api.assignProcessToJobObject("job", "process")).toBe(false)
  })
})
