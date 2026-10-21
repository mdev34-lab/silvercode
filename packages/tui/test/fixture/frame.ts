import type { testRender } from "@opentui/solid"

type Setup = Awaited<ReturnType<typeof testRender>>

// While a frame is being flushed the native session holds the only lease on its output
// buffer, and a capture taken inside that window throws instead of waiting. Tests that pump
// frames can land in the window whenever the runner is busy, so every capture goes through
// this retry: a busy buffer is "not painted yet", which a frame pump already knows how to
// handle.
function isBusyOutput(error: unknown) {
  return error instanceof Error && error.message.includes("OutputBusy")
}

/** The current frame, retried while the output buffer is still being flushed. */
export async function captureFrame(app: Pick<Setup, "captureCharFrame">) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return app.captureCharFrame()
    } catch (error) {
      if (!isBusyOutput(error)) throw error
      await Bun.sleep(5)
    }
  }
  return app.captureCharFrame()
}

/**
 * Pumps frames until `probe` yields a value, so assertions read a settled layout. The render
 * comes first because probes read live layout, which is meaningless before it has run. Probes
 * capture frames themselves (that is how these tests read the UI), so a busy output buffer is
 * swallowed here and retried on the next pass instead of failing the test.
 */
export async function waitFor<T>(
  app: Pick<Setup, "captureCharFrame" | "renderOnce">,
  probe: () => T | undefined,
  passes = 400,
  label = "condition never settled",
): Promise<T> {
  for (let pass = 0; pass <= passes; pass++) {
    await app.renderOnce()
    try {
      const value = probe()
      if (value !== undefined) return value
    } catch (error) {
      if (!isBusyOutput(error)) throw error
    }
    await Bun.sleep(5)
  }
  throw new Error(`${label}:\n${await captureFrame(app)}`)
}
