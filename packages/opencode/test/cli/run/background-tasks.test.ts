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
