// Opt-in, per-command diagnostic used by the core process test. No commands,
// output, environment, paths, PIDs or error text are retained.
export type ProcessPhase =
  | "test-start"
  | "run-before-spawn"
  | "spawn-before-launch"
  | "launch-return"
  | "spawn-event"
  | "stdout-eof"
  | "stderr-eof"
  | "stdout-close"
  | "stderr-close"
  | "exit-event"
  | "close-event"
  | "spawn-return"
  | "collector-start"
  | "collector-eof"
  | "collector-exit-observed"
  | "race-eof"
  | "race-quiet"
  | "finalizer-start"
  | "finalizer-end"
  | "test-return"
  | "assertions-passed"

type Event = { phase: ProcessPhase; wallMs: number; monoMs: number }
const registrations = new WeakMap<object, ProcessPhaseTrace>()

export class ProcessPhaseTrace {
  private readonly wallStart = Date.now()
  private readonly monoStart = performance.now()
  private readonly events: Event[] = []
  private command?: object
  private active = true

  bind(command: object) {
    this.command = command
    registrations.set(command, this)
  }

  mark(phase: ProcessPhase) {
    if (!this.active) return
    this.events.push({ phase, wallMs: Date.now() - this.wallStart, monoMs: performance.now() - this.monoStart })
  }

  report() {
    return `[process-phase] ${JSON.stringify({ events: this.events })}`
  }

  close() {
    this.active = false
    if (this.command) registrations.delete(this.command)
    this.command = undefined
  }
}

export const processPhaseTrace = (command: object) => registrations.get(command)
