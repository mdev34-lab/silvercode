import { AsyncLocalStorage } from "node:async_hooks"
import http from "node:http"

type OwnerEvent = { owner: string; target: "loopback" | "redacted"; path: "plugin-package" | "other" }
let installed: (() => { restored: boolean; conflict: boolean }) | undefined

/** Private diagnostic: observes node:http.request only, never headers or raw URLs. */
export function observeRequestOwner(input: {
  enabled: boolean
  owner: () => string | undefined
  report: (event: OwnerEvent) => void
}) {
  if (!input.enabled) return { dispose: () => ({ restored: false, conflict: false }) }
  if (installed) throw new Error("request owner observer already installed")
  const original = http.request
  let disposed = false
  const wrapper = function (this: unknown, ...args: Parameters<typeof http.request>) {
    // Invoke exactly once, with the original receiver and arguments. Original
    // exceptions propagate unchanged; observational failures must not escape.
    const request = Reflect.apply(original, this, args)
    if (disposed) return request
    try {
      // The returned request reflects overload resolution, including overrides.
      // Never serialize its host/path values. Unknown targets stay redacted.
      const host = request.host
      input.report({
        owner: input.owner() ?? "unattributed",
        target: typeof host === "string" && /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) ? "loopback" : "redacted",
        path: typeof request.path === "string" && request.path.includes("opencode-ai") ? "plugin-package" : "other",
      })
    } catch {}
    return request
  } as typeof http.request
  const dispose = () => {
    if (disposed) return { restored: false, conflict: false }
    disposed = true
    const owned = http.request === wrapper
    if (owned) http.request = original
    installed = undefined
    return { restored: owned, conflict: !owned }
  }
  http.request = wrapper
  installed = dispose
  return { dispose }
}

const requestOwner = new AsyncLocalStorage<string>()
export function withRequestOwner<A>(owner: string, admission: string | undefined, run: () => Promise<A>): Promise<A> {
  // Only generated opaque IDs may enter the observer. No path/config data.
  const safeOwner = /^\d+-\d+$/.test(owner) ? owner : "unattributed"
  const safeAdmission = admission && /^\d+-admission-\d+$/.test(admission) ? admission : "unattributed"
  return requestOwner.run(`${safeOwner}/${safeAdmission}`, run)
}
export function installRequestOwnerDiagnostic() {
  return observeRequestOwner({
    enabled: process.env.OPENCODE_TEST_INSTALL_OWNER_DIAGNOSTICS === "1",
    owner: () => requestOwner.getStore(),
    report: (event) => console.log("INSTALL_OWNER", JSON.stringify({ phase: "http-request-owner", at: Date.now(), ...event })),
  })
}
