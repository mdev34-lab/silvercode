import { createEffect, createSignal, onCleanup } from "solid-js"

// One shared 1 Hz clock for every live timer on screen. The interval only runs
// while at least one timer is active, and each subscriber releases it on
// unmount or when its timer stops, so nothing ticks for finished blocks.
const [now, setNow] = createSignal(Date.now())
let users = 0
let timer: ReturnType<typeof setInterval> | undefined

function acquire() {
  if (users++ === 0) {
    setNow(Date.now())
    timer = setInterval(() => setNow(Date.now()), 1000)
  }
}

function release() {
  if (--users > 0) return
  users = 0
  if (timer) clearInterval(timer)
  timer = undefined
}

export function useClock(active: () => boolean): () => number {
  createEffect(() => {
    if (!active()) return
    acquire()
    onCleanup(release)
  })
  return now
}

// Whole-second elapsed time that does not jitter in width: 8s, 8m 22s, 1h 5m.
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`
}

export function clockUsers() {
  return users
}
