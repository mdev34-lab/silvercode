import { describe, expect, test } from "bun:test"
import { BackgroundTasks } from "../../../src/cli/cmd/run/background-tasks"
import { RetryNotice } from "../../../src/cli/cmd/run/retry-notice"

// #555: a child's retry wait can arrive before the launch that ties the child to the run.
const setup = (json = false) => {
  const lines: string[] = []
  const background = BackgroundTasks.make("root")
  const notice = RetryNotice.make({
    rootSessionID: "root",
    owns: background.owns,
    print: (line) => lines.push(line),
    threshold: 10_000,
    json,
    now: () => 1_000,
  })
  const retry = (attempt: number, ms = 12_000) => ({
    type: "retry",
    attempt,
    next: 1_000 + ms,
    action: { reason: "free_tier_limit" },
  })
  return { lines, background, notice, retry }
}

describe("retry wait notice ordering (#555)", () => {
  test("a child wait seen before its launch is announced once the launch is observed", () => {
    const { lines, background, notice, retry } = setup()
    notice.status("child", retry(1))
    expect(lines).toEqual([])
    background.launch({ sessionID: "child", parentSessionID: "root", run: "r1", launchID: "p1" })
    notice.launched()
    expect(lines).toEqual(["subagent waiting about 12s before retrying (attempt 1): free usage limit reached"])
    notice.launched()
    expect(lines.length).toBe(1)
  })

  test("a held wait that ended before the launch is not announced", () => {
    const { lines, background, notice, retry } = setup()
    notice.status("child", retry(1))
    notice.status("child", { type: "busy" })
    background.launch({ sessionID: "child", parentSessionID: "root", run: "r1", launchID: "p1" })
    notice.launched()
    expect(lines).toEqual([])
  })

  test("only the latest held attempt is announced, and unrelated sessions never are", () => {
    const { lines, background, notice, retry } = setup()
    notice.status("child", retry(1))
    notice.status("child", retry(2))
    notice.status("stranger", retry(1))
    background.launch({ sessionID: "child", parentSessionID: "root", run: "r1", launchID: "p1" })
    notice.launched()
    expect(lines).toEqual(["subagent waiting about 12s before retrying (attempt 2): free usage limit reached"])
  })

  test("short waits, JSON output and the root keep their existing behavior", () => {
    const short = setup()
    short.notice.status("root", short.retry(1, 5_000))
    expect(short.lines).toEqual([])
    const json = setup(true)
    json.notice.status("root", json.retry(1))
    expect(json.lines).toEqual([])
    const root = setup()
    root.notice.status("root", root.retry(1))
    root.notice.status("root", root.retry(1))
    expect(root.lines).toEqual(["waiting about 12s before retrying (attempt 1): free usage limit reached"])
  })

  test("the held map is capped, JSON mode holds nothing, and ended waits are pruned", () => {
    const { lines, background, notice, retry } = setup()
    for (let i = 0; i < 100; i++) notice.status(`s${i}`, retry(1))
    // The oldest entries were dropped; the newest still replays after its launch.
    background.launch({ sessionID: "s0", parentSessionID: "root", run: "r0", launchID: "p0" })
    background.launch({ sessionID: "s99", parentSessionID: "root", run: "r99", launchID: "p99" })
    notice.launched()
    expect(lines).toEqual(["subagent waiting about 12s before retrying (attempt 1): free usage limit reached"])
    const json = setup(true)
    json.notice.status("child", json.retry(1))
    json.background.launch({ sessionID: "child", parentSessionID: "root", run: "r1", launchID: "p1" })
    json.notice.launched()
    expect(json.lines).toEqual([])
    const ended = setup()
    ended.notice.status("child", ended.retry(1, -1))
    ended.background.launch({ sessionID: "child", parentSessionID: "root", run: "r1", launchID: "p1" })
    ended.notice.launched()
    expect(ended.lines).toEqual([])
  })
})
