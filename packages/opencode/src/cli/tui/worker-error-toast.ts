import { EventV2 } from "@opencode-ai/core/event"
import type { WorkerErrorReport } from "./worker"

// Build the GlobalEvent the TUI main thread synthesizes from a worker.error
// report (#396). The shape must satisfy the SDK's GlobalEvent contract: a
// required top-level `directory` ("global" matches the server-side
// convention for non-workspace events) and a payload carrying its own `id`,
// or the TUI's typed event stream cannot decode it.
export function workerErrorToastEvent(report: WorkerErrorReport) {
  return {
    directory: "global",
    payload: {
      id: EventV2.ID.create(),
      type: "tui.toast.show" as const,
      properties: {
        title: report.fatal ? "Backend worker crashed" : "Backend worker error",
        message: report.message,
        variant: "error" as const,
        duration: 8000,
      },
    },
  }
}
