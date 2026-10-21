import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

// Bounded replay log backing SSE resume: a subscriber reconnecting with
// Last-Event-ID replays what it missed instead of losing it silently. 2000
// events covers minutes of busy multi-session traffic; older events fall out
// and the cursor is then reported incomplete so the client resyncs.
const REPLAY_CAPACITY = 2000

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  private recent: GlobalEvent[] = []

  emitEvent(event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    this.recent.push(event)
    if (this.recent.length > REPLAY_CAPACITY) this.recent.splice(0, this.recent.length - REPLAY_CAPACITY)
    return super.emit("event", event)
  }

  /**
   * Events newer than `lastID`, oldest first. Ids are time-ordered
   * (`evt_<ms*0x1000+counter as 12 hex chars><random>`), so lexicographic
   * comparison is creation order within this process. `complete` is false
   * when the cursor predates the oldest retained event: some of what the
   * client missed may already be evicted, so it must resync rather than
   * trust the replay.
   */
  sinceEvents(lastID: string): { events: GlobalEvent[]; complete: boolean } {
    const oldest = this.recent[0]?.payload?.id
    if (typeof oldest !== "string" || oldest > lastID) return { events: [], complete: false }
    return {
      events: this.recent.filter((event) => typeof event.payload?.id === "string" && event.payload.id > lastID),
      complete: true,
    }
  }
}

export const GlobalBus = new GlobalBusEmitter()
