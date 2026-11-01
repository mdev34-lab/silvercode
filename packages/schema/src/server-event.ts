export * as ServerEvent from "./server-event"

import { Schema } from "effect"

import { Event } from "./event"

export const Connected = Event.define({ type: "server.connected", schema: {} })
export const Disposed = Event.define({ type: "global.disposed", schema: {} })

// Emitted on /global/event when a Last-Event-ID resume cursor predates the
// retained replay log: the server cannot prove the replay is complete, so
// the client must resync rather than trust a partial replay.
export const Resync = Event.define({
  type: "server.resync",
  schema: { reason: Schema.Literal("resume-cursor-expired") },
})

export const Definitions = Event.inventory(Connected, Disposed, Resync)
