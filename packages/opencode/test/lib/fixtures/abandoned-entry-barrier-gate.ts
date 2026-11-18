import { phase } from "./abandoned-entry-barrier-phase"

let resolveGate: ((value: string) => void) | undefined

export const gate = new Promise<string>((resolve) => {
  resolveGate = resolve
})

export const releaseGate = () => {
  phase("gate:release")
  resolveGate?.("release\n")
}
