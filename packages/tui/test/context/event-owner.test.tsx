/** @jsxImportSource @opentui/solid */
// #424: subscriptions made inside a disposed owner must not fire after the
// owner is gone; a remount must not stack duplicates. Guards the pattern
// ProjectProvider/LocalProvider now follow (capture unsub, tie to onCleanup).
import { createRoot } from "solid-js"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import { TestTuiContexts } from "../fixture/tui-environment"
import { SDKProvider } from "../../src/context/sdk"
import { useEvent } from "../../src/context/event"
import { onCleanup } from "solid-js"

test("subscriptions tied to onCleanup die with their owner", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/agent") {
      return json({
        location: { directory, project: { id: "proj_test", directory } },
        data: [{ id: "build", name: "build", description: "Build agent", permissions: [] }],
      })
    }
    return undefined
  }, events)

  let event!: ReturnType<typeof useEvent>
  const app = await testRender(() => (
    <TestTuiContexts paths={{ state: tmp.path }}>
      <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
        {(() => {
          event = useEvent()
          return <></>
        })()}
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    let fired = 0
    const dispose = createRoot((dispose) => {
      const off = event.on("session.deleted", () => {
        fired++
      })
      onCleanup(off)
      return dispose
    })
    dispose()

    await Bun.sleep(50)
    events.emit({
      directory,
      payload: { type: "session.deleted", properties: { info: { id: "ses_gone" } } },
    } as never)
    await Bun.sleep(50)
    expect(fired).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})
