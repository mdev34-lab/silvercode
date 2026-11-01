/** @jsxImportSource @opentui/solid */
// #424: a provider's event subscriptions must die with the provider's owner.
// Mounts the REAL ProjectProvider inside a disposable nested root under a
// live SDKProvider, disposes it, and asserts a later event is not handled.
// A live control subscription proves every emitted event actually landed, so
// the test cannot pass vacuously.
import { createRoot } from "solid-js"
import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { createEventSource, createFetch, directory } from "../fixture/tui-sdk"
import { SDKProvider } from "../../src/context/sdk"
import { ProjectProvider, useProject } from "../../src/context/project"
import { useEvent } from "../../src/context/event"

function workspaceStatus(workspaceID: string) {
  return {
    directory,
    payload: { type: "workspace.status", properties: { workspaceID, status: "connected" } },
  } as never
}

test("disposed provider no longer handles events; live owner still does", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const events = createEventSource()
  const calls = createFetch(undefined, events)

  let event!: ReturnType<typeof useEvent>
  let project!: ReturnType<typeof useProject>
  let disposeInner!: () => void

  const disposeOuter = createRoot((dispose) => {
    // Build the provider tree inside the root (components execute eagerly),
    // then hand back the dispose handle.
    ;<SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
      {(() => {
        event = useEvent()
        disposeInner = createRoot((disposeInnerRoot) => {
          ;<ProjectProvider>
            {(() => {
              project = useProject()
              return <></>
            })()}
          </ProjectProvider>
          return disposeInnerRoot
        })
        return <></>
      })()}
    </SDKProvider>
    return dispose
  })

  try {
    // Control: a live subscription sees every emitted event, proving the
    // emits below actually land.
    const seen: string[] = []
    event.subscribe((evt) => {
      if (evt.type === "workspace.status") seen.push(evt.properties.workspaceID)
    })

    await Bun.sleep(50)

    events.emit(workspaceStatus("w1"))
    await Bun.sleep(20)
    expect(seen).toEqual(["w1"])
    expect(project.data.workspace.status["w1"]).toBe("connected")

    disposeInner()

    events.emit(workspaceStatus("w2"))
    await Bun.sleep(20)
    expect(seen).toEqual(["w1", "w2"])
    // The disposed provider's handler must not run anymore.
    expect(project.data.workspace.status["w2"]).toBeUndefined()
  } finally {
    disposeOuter()
  }
})
