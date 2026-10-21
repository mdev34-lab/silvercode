// Arms a one-shot SIGCONT listener that resumes a suspended renderer.
// Re-arming drops a still-pending listener so two suspends before SIGCONT
// cannot stack listeners and resume twice, and a renderer destroyed while
// stopped is never resumed (#426).
export function createSigcontResume(renderer: { isDestroyed: boolean; resume(): Promise<void> }) {
  let pending: (() => void) | undefined

  function dispose() {
    if (pending) process.removeListener("SIGCONT", pending)
    pending = undefined
  }

  return {
    arm() {
      dispose()
      const onSigcont = () => {
        pending = undefined
        if (renderer.isDestroyed) return
        void renderer.resume().catch(() => {})
      }
      pending = onSigcont
      process.once("SIGCONT", onSigcont)
    },
    dispose,
  }
}
