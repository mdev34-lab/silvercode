// The headless exit rule's bookkeeping (#222, acceptance 3): which sessions a
// run launched are still in flight. The rule is what keeps `opencode run` alive
// while work it started is still running - and what lets it exit at all.
import { describe, expect, test } from "bun:test"
import { BackgroundTasks } from "@/cli/cmd/run/background-tasks"

const root = "ses_root"
const child = "ses_child"
const grandchild = "ses_grandchild"

const launch = (parent: string, session: string) => ({
  sessionID: session,
  parentSessionID: parent,
})

describe("headless background task tracking", () => {
  test("a launched session holds the run open until it settles", () => {
    const tasks = BackgroundTasks.make(root)
    expect(tasks.launch(launch(root, child))).toBe(true)
    expect(tasks.settled()).toBe(false)
    expect(tasks.pending()).toEqual([child])
    // A terminal envelope is the one signal that settles a session on its own.
    tasks.resolve(child)
    expect(tasks.settled()).toBe(true)
  })

  test("a session that goes idle with nothing of its own still holds until it reports", () => {
    const tasks = BackgroundTasks.make(root)
    tasks.launch(launch(root, child))
    expect(tasks.settled()).toBe(false)
    expect(tasks.pending()).toEqual([child])
    expect(tasks.settled()).toBe(false)
  })

  test("a session that yields for its own subagent is not finished when it goes idle", () => {
    const tasks = BackgroundTasks.make(root)
    expect(tasks.launch(launch(root, child))).toBe(true)
    expect(tasks.launch(launch(child, grandchild))).toBe(true)
    // The child ends its turn at the yield: idle, but its work has not ended.
    expect(tasks.settled()).toBe(false)
    // Both jobs remain pending until their terminal deliveries arrive.
    expect(tasks.pending()).toEqual([child, grandchild])
    expect(tasks.settled()).toBe(false)
    // The child resumes for the report.
    expect(tasks.pending()).toEqual([child, grandchild])
    // The grandchild reports, and the child's run then ends at its own result.
    tasks.resolve(grandchild)
    expect(tasks.pending()).toEqual([child])
    expect(tasks.settled()).toBe(false)
    tasks.resolve(child)
    expect(tasks.settled()).toBe(true)
  })

  test("a terminal result settles its own session, not the subagents it launched", () => {
    const tasks = BackgroundTasks.make(root)
    tasks.launch(launch(root, child))
    tasks.launch(launch(child, grandchild))
    // The child delivered its final result while its own subagent still runs:
    // the run must keep waiting for that subagent.
    tasks.resolve(child)
    expect(tasks.pending()).toEqual([grandchild])
    tasks.resolve(grandchild)
    expect(tasks.settled()).toBe(true)
  })

  test("a launch from a session this run does not own is ignored", () => {
    const tasks = BackgroundTasks.make(root)
    tasks.launch(launch("ses_other", child))
    expect(tasks.launch(launch("ses_other", grandchild))).toBe(false)
    expect(tasks.pending()).toEqual([])
    expect(tasks.settled()).toBe(true)
  })

  test("two runs of one session are both pending until each reports", () => {
    const tasks = BackgroundTasks.make(root)
    expect(tasks.launch({ ...launch(root, child), run: `${child}@1` })).toBe(true)
    expect(tasks.launch({ ...launch(root, child), run: `${child}@2` })).toBe(true)
    // Keyed by session alone, the second launch deduped into the first and the
    // run exited while a child still ran (#400).
    expect(tasks.pending()).toEqual([child, child])
    tasks.resolve(`${child}@1`)
    expect(tasks.settled()).toBe(false)
    tasks.resolve(`${child}@2`)
    expect(tasks.settled()).toBe(true)
  })

  test("a terminal envelope for an earlier run does not settle a resumed run", () => {
    const tasks = BackgroundTasks.make(root)
    tasks.launch({ ...launch(root, child), run: `${child}@1` })
    tasks.resolve(`${child}@1`)
    // task_id resume: same session, new run, tracked on its own key.
    expect(tasks.launch({ ...launch(root, child), run: `${child}@2` })).toBe(true)
    expect(tasks.settled()).toBe(false)
    // A late duplicate of the first run's envelope must not settle the second.
    tasks.resolve(`${child}@1`)
    expect(tasks.settled()).toBe(false)
    tasks.resolve(`${child}@2`)
    expect(tasks.settled()).toBe(true)
  })

  test("a re-emitted launch part for the same run still dedupes", () => {
    const tasks = BackgroundTasks.make(root)
    expect(tasks.launch({ ...launch(root, child), run: `${child}@1` })).toBe(true)
    expect(tasks.launch({ ...launch(root, child), run: `${child}@1` })).toBe(false)
    expect(tasks.pending()).toEqual([child])
  })

  test("a session that reported before its task part arrived stays settled", () => {
    const tasks = BackgroundTasks.make(root)
    tasks.resolve(child)
    expect(tasks.launch(launch(root, child))).toBe(false)
    expect(tasks.settled()).toBe(true)
  })
})

test("descendant launches observed before the parent are adopted", () => {
  const tasks = BackgroundTasks.make(root)
  tasks.launch(launch(child, grandchild))
  expect(tasks.settled()).toBe(true)
  tasks.launch(launch(root, child))
  tasks.resolve(child)
  expect(tasks.pending()).toEqual([grandchild])
  tasks.resolve(grandchild)
  expect(tasks.settled()).toBe(true)
})

test("a resolved session resumed through task_id is pending again until its new run reports", () => {
  const tasks = BackgroundTasks.make(root)
  expect(tasks.launch(launch(root, child))).toBe(true)
  tasks.resolve(child)
  expect(tasks.settled()).toBe(true)
  expect(tasks.launch(launch(root, child))).toBe(true)
  expect(tasks.pending()).toEqual([child])
  expect(tasks.settled()).toBe(false)
  tasks.resolve(child)
  expect(tasks.settled()).toBe(true)
})

test("a completed explicit run launch replay stays settled while a new run remains pending", () => {
  const tasks = BackgroundTasks.make(root)
  tasks.launch({ ...launch(root, child), run: `${child}@1` })
  tasks.resolve(`${child}@1`)
  expect(tasks.settled()).toBe(true)
  expect(tasks.launch({ ...launch(root, child), run: `${child}@1` })).toBe(false)
  expect(tasks.settled()).toBe(true)
  tasks.launch({ ...launch(root, child), run: `${child}@2` })
  expect(tasks.launch({ ...launch(root, child), run: `${child}@1` })).toBe(false)
  expect(tasks.pending()).toEqual([child])
  tasks.resolve(`${child}@2`)
  expect(tasks.settled()).toBe(true)
})

test("legacy launch part replay cannot resurrect a delivered run, but a distinct task part can resume", () => {
  const tasks = BackgroundTasks.make(root)
  const first = { ...launch(root, child), launchID: "prt_first" }
  expect(tasks.launch(first)).toBe(true)
  tasks.resolve(child)
  expect(tasks.launch(first)).toBe(false)
  expect(tasks.settled()).toBe(true)
  expect(tasks.launch({ ...launch(root, child), launchID: "prt_resume" })).toBe(true)
  expect(tasks.launch(first)).toBe(false)
  expect(tasks.pending()).toEqual([child])
  tasks.resolve(child)
  expect(tasks.settled()).toBe(true)
})

test("legacy launch part dedupes while pending and a delivery before its first observation stays settled", () => {
  const tasks = BackgroundTasks.make(root)
  const first = { ...launch(root, child), launchID: "prt_first" }
  expect(tasks.launch(first)).toBe(true)
  expect(tasks.launch(first)).toBe(false)
  expect(tasks.pending()).toEqual([child])
  tasks.resolve(child)
  expect(tasks.launch(first)).toBe(false)
  const early = BackgroundTasks.make(root)
  early.resolve(child)
  expect(early.launch(first)).toBe(false)
  expect(early.settled()).toBe(true)
  expect(early.launch(first)).toBe(false)
})
