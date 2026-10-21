/** @jsxImportSource @opentui/solid */
// #425: a pending toast timeout must be cleared when the provider's owner is
// disposed, so no timer fires into a dead tree.
import { createRoot } from "solid-js"
import { expect, test } from "bun:test"
import { ToastProvider, useToast } from "../../src/ui/toast"

test("pending toast timeout is cleared on dispose", async () => {
  let toast!: ReturnType<typeof useToast>
  const dispose = createRoot((dispose) => {
    ;<ToastProvider>
      {(() => {
        toast = useToast()
        return <></>
      })()}
    </ToastProvider>
    return dispose
  })

  toast.show({ variant: "info", message: "hi", duration: 30 })
  dispose()
  await Bun.sleep(90)
  // If the timer had survived the dispose, it would have cleared the toast.
  expect(toast.currentToast).not.toBe(null)
  expect(toast.currentToast?.message).toBe("hi")
})
