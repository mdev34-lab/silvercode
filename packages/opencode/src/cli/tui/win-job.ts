/**
 * Windows Job Object adoption for the subprocess TUI worker (#442).
 *
 * The dev (uncompiled Bun) TUI runs its backend as a child process. On POSIX
 * the child is spawned detached so terminal job-control signals (Ctrl+Z,
 * Ctrl+C, SIGHUP) cannot reach it, which also means the child no longer dies
 * with its owner; the worker watches the owner itself for that case
 * (owner-watch.ts). Windows has no process groups, and neither the IPC
 * `disconnect` event nor a signal-0 probe of the owner PID fires there after
 * a hard-killed owner (#480), so the worker needs an owner-side guarantee
 * instead: the OS one.
 *
 * The owner assigns each spawned worker to a Job Object configured with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so Windows terminates every process in
 * the job when the last handle to it closes. The owner holds that handle for
 * its whole lifetime and never closes it, so a hard kill - TerminateProcess,
 * the OOM killer, a crash - closes the handle with the process and takes the
 * worker (and everything the worker spawned) down with it.
 *
 * Everything here is best-effort: nested jobs are unavailable on some Windows
 * configurations (pre-Windows 8, or a parent job that forbids it), so a
 * failure is logged once and the worker falls back to its owner watchdog.
 * `bun:ffi` is only loaded on win32, and only on the first spawn.
 *
 * Assignment happens immediately after `Bun.spawn` returns (there is no
 * suspended start to assign a PID that does not exist yet), so an owner killed
 * inside that window can still leave an orphan; every later kill is covered.
 */

/** JOBOBJECTINFOCLASS value for JOBOBJECT_EXTENDED_LIMIT_INFORMATION. */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9

/** Terminate every process in the job when its last handle closes. */
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000

/**
 * Access rights `AssignProcessToJobObject` needs on the target process:
 * PROCESS_SET_QUOTA | PROCESS_TERMINATE.
 */
export const JOB_ASSIGN_ACCESS = 0x0100 | 0x0001

/**
 * Size of JOBOBJECT_EXTENDED_LIMIT_INFORMATION: the leading
 * JOBOBJECT_BASIC_LIMIT_INFORMATION (64 bytes with 8-byte pointers, 48 with
 * 4-byte ones - 8-byte alignment rounds the 32-bit struct up), then
 * JOBOBJECT_IO_COUNTERS (six 8-byte counters) and four SIZE_T memory fields.
 */
export function jobInfoSize(pointerBytes: number) {
  return (pointerBytes === 4 ? 48 : 64) + 48 + pointerBytes * 4
}

/**
 * JOBOBJECT_EXTENDED_LIMIT_INFORMATION with only LimitFlags set: every other
 * field is a resource limit, and a zero limit means "none".
 */
export function killOnCloseInfo(pointerBytes: number) {
  const info = new Uint8Array(jobInfoSize(pointerBytes))
  // LimitFlags follows the two LARGE_INTEGER time limits, at byte 16.
  new DataView(info.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true)
  return info
}

/**
 * The kernel32 calls this module needs, with handles kept opaque so tests can
 * stand in objects for the real HANDLE pointers.
 */
export type WindowsJobApi = {
  /** Bytes per pointer: the job info struct differs between 32- and 64-bit. */
  pointerBytes: number
  /** `CreateJobObjectW(NULL, NULL)`; a null handle means failure. */
  createJobObject(): unknown
  /** `SetInformationJobObject(job, JobObjectExtendedLimitInformation, ...)`. */
  setInformationJobObject(job: unknown, info: Uint8Array): boolean
  /** `OpenProcess(desiredAccess, FALSE, pid)`; a null handle means failure. */
  openProcess(desiredAccess: number, pid: number): unknown
  /** `AssignProcessToJobObject(job, process)`. */
  assignProcessToJobObject(job: unknown, process: unknown): boolean
  closeHandle(handle: unknown): void
  /** `GetLastError`, read immediately after a failed call. */
  lastError(): number
}

type Failure = { ok: false; reason: string }

export type OwnerJob = { ok: true; job: unknown } | Failure
export type JobAssignment = { ok: true } | Failure

function isNullHandle(handle: unknown) {
  return handle === null || handle === undefined || handle === 0 || handle === 0n
}

/**
 * Create and configure the owner's kill-on-close job. The caller keeps the
 * returned handle open: closing it is what kills the workers assigned to it.
 */
export function createOwnerJob(api: WindowsJobApi): OwnerJob {
  const job = api.createJobObject()
  if (isNullHandle(job)) return { ok: false, reason: `CreateJobObjectW failed (error ${api.lastError()})` }
  if (!api.setInformationJobObject(job, killOnCloseInfo(api.pointerBytes))) {
    const reason = `SetInformationJobObject failed (error ${api.lastError()})`
    api.closeHandle(job)
    return { ok: false, reason }
  }
  return { ok: true, job }
}

/**
 * Put one worker process under the job. The process handle is only needed for
 * the assignment call; the job keeps the process alive-and-killable after it
 * closes, so only that handle is released here.
 */
export function addProcessToJob(api: WindowsJobApi, job: unknown, pid: number): JobAssignment {
  const process = api.openProcess(JOB_ASSIGN_ACCESS, pid)
  if (isNullHandle(process)) return { ok: false, reason: `OpenProcess(${pid}) failed (error ${api.lastError()})` }
  const assigned = api.assignProcessToJobObject(job, process)
  const reason = `AssignProcessToJobObject(${pid}) failed (error ${api.lastError()})`
  api.closeHandle(process)
  return assigned ? { ok: true } : { ok: false, reason }
}

/** The slice of `bun:ffi` this module binds, kept structural for tests. */
export type FfiModule = {
  dlopen(
    library: string,
    definitions: Record<string, { args: string[]; returns: string }>,
  ): {
    symbols: Record<string, (...args: never[]) => unknown>
  }
  ptr(value: Uint8Array | ArrayBufferLike): unknown
}

/**
 * Bind kernel32 to the {@link WindowsJobApi} contract. Split from the lazy
 * loader so the binding itself is testable without Windows.
 */
export function windowsJobApi(ffi: FfiModule, arch: string): WindowsJobApi {
  const kernel32 = ffi.dlopen("kernel32.dll", {
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
    SetInformationJobObject: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
    AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  })
  // Handles are opaque here (and null stands in for a failed call), so bind
  // the raw signatures once instead of threading Bun's Pointer type through.
  const symbols = kernel32.symbols as unknown as {
    CreateJobObjectW(attributes: null, name: null): unknown
    SetInformationJobObject(job: unknown, infoClass: number, info: unknown, length: number): number
    OpenProcess(desiredAccess: number, inherit: number, pid: number): unknown
    AssignProcessToJobObject(job: unknown, process: unknown): number
    CloseHandle(handle: unknown): number
    GetLastError(): number
  }
  return {
    // Bun ships 64-bit builds; ia32 is the only 32-bit pointer width left.
    pointerBytes: arch === "ia32" ? 4 : 8,
    createJobObject: () => symbols.CreateJobObjectW(null, null),
    setInformationJobObject: (job, info) =>
      symbols.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ffi.ptr(info), info.length) !== 0,
    openProcess: (desiredAccess, pid) => symbols.OpenProcess(desiredAccess, 0, pid),
    assignProcessToJobObject: (job, process) => symbols.AssignProcessToJobObject(job, process) !== 0,
    closeHandle: (handle) => {
      symbols.CloseHandle(handle)
    },
    lastError: () => symbols.GetLastError(),
  }
}

function loadWindowsJobApi(): WindowsJobApi {
  // Lazy require: this module is imported on every platform, but bun:ffi and
  // kernel32.dll must only be loaded on win32.
  // `require` is untyped here on purpose: the binding function does the
  // signature checking against FfiModule.
  return windowsJobApi(require("bun:ffi"), process.arch)
}

/**
 * Owner-side adopter: creates the job once per owner process and assigns every
 * spawned worker to it, including crash-restart replacements.
 *
 * Once job creation has failed there is nothing left to try on later spawns,
 * so the failure is remembered and logged a single time instead of on every
 * restart. A failed *assignment* keeps the job: the next restart can succeed.
 */
export function createOwnerJobAdopter(input: { platform?: NodeJS.Platform; loadApi?: () => WindowsJobApi } = {}) {
  const platform = input.platform ?? process.platform
  const loadApi = input.loadApi ?? loadWindowsJobApi
  let api: WindowsJobApi | undefined
  let job: unknown
  let failure: string | undefined

  return function adopt(pid: number | undefined, log: (message: string) => void) {
    if (platform !== "win32" || pid === undefined || !Number.isInteger(pid) || pid <= 0) return
    if (failure !== undefined) return
    try {
      api ??= loadApi()
      if (job === undefined) {
        const created = createOwnerJob(api)
        if (!created.ok) {
          failure = created.reason
          log(`[silvercode] ${created.reason}; the worker may outlive a hard-killed owner (#442)`)
          return
        }
        job = created.job
      }
      const assigned = addProcessToJob(api, job, pid)
      if (!assigned.ok) log(`[silvercode] ${assigned.reason}; the worker may outlive a hard-killed owner (#442)`)
    } catch (error) {
      // A broken FFI load or a missing kernel32 symbol must never take the TUI
      // down: remember it, say so once, and leave the watchdog as the fallback.
      failure = error instanceof Error ? error.message : String(error)
      log(`[silvercode] Windows job object setup failed: ${failure} (#442)`)
    }
  }
}

let adopter: ReturnType<typeof createOwnerJobAdopter> | undefined

/**
 * Parent-side owner-death guard for a freshly spawned worker (see
 * worker-process.ts). No-op off Windows, where the worker's own watchdog
 * covers this and `bun:ffi` must never be touched.
 */
export function adoptWorkerProcess(pid: number | undefined, log: (message: string) => void) {
  if (process.platform !== "win32") return
  adopter ??= createOwnerJobAdopter()
  adopter(pid, log)
}
