import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "path"
import { Config } from "@/config/config"
import { ShellTool } from "../../src/tool/shell"
import {
  ShellBackground,
  type Handle,
} from "../../src/tool/shell/background"
import { ShellBackgroundTool } from "../../src/tool/shell-background"
import { provideInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { EventV2Bridge } from "@/event-v2-bridge"

const layer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      SessionStatus.node,
      SessionRunState.node,
      RuntimeFlags.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(layer)

const initShell = Effect.fn("ShellBackgroundTest.initShell")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const initBackground = Effect.fn("ShellBackgroundTest.initBackground")(function* () {
  const info = yield* ShellBackgroundTool
  return yield* info.init()
})

const sessionID = SessionID.make("ses_shell_background")
const callID = "call_shell_background"

type Prompt = { text: string; silent: boolean }

/** Collects what the tool would deliver back into the owning session. */
function promptOps(notifications: Prompt[]) {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template: string) =>
      Effect.succeed([{ type: "text" as const, text: template }] as never),
    prompt: (input: { noReply?: boolean; parts: readonly { type: string; text?: string }[] }) =>
      Effect.sync(() => {
        notifications.push({ text: input.parts[0]?.text ?? "", silent: input.noReply === true })
        return { info: {}, parts: [] }
      }),
  }
}

function context(notifications: Prompt[] = [], id: string = callID): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make("msg_shell_background"),
    agent: "work",
    abort: AbortSignal.any([]),
    callID: id,
    messages: [],
    extra: { promptOps: promptOps(notifications) },
    metadata: () => Effect.void,
    ask: () => Effect.void,
  } as Tool.Context
}

const run = Effect.fn("ShellBackgroundTest.run")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  ctx: Tool.Context,
) {
  const shell = yield* initShell()
  return yield* shell.execute(args, ctx)
})

const manage = Effect.fn("ShellBackgroundTest.manage")(function* (
  args: { action: "list" | "status" | "output" | "cancel"; job_id?: string },
  ctx: Tool.Context,
) {
  const tool = yield* initBackground()
  return yield* tool.execute(args, ctx)
})

type RunResult = Effect.Success<ReturnType<typeof run>>
const jobID = (result: RunResult) => String((result.metadata as { jobId?: string }).jobId)

/** Liveness of the whole process group the shell tool spawned for a job. */
const groupAlive = (pid: number) => {
  try {
    // A negative pid addresses the group the detached child leads.
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

const deadGroup = Effect.fnUntraced(function* (pid: number) {
  yield* pollWithTimeout(
    Effect.sync(() => (groupAlive(pid) ? undefined : true)),
    `process group ${pid} was still alive`,
    "10 seconds",
  )
})

const unique = () => path.join(os.tmpdir(), `shell-background-${Math.random().toString(36).slice(2)}.log`)

describe("tool.shell automatic backgrounding", () => {
  // (a) No behavior change for commands that finish inside the window.
  it.live(
    "returns a command under the threshold inline and creates no job",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const result = yield* run({ command: "echo inline_ok" }, context())
        expect(result.output).toContain("inline_ok")
        expect((result.metadata as { exit?: number | null }).exit).toBe(0)
        expect((result.metadata as { jobId?: string }).jobId).toBeUndefined()
        expect(yield* jobs.list()).toHaveLength(0)
      }).pipe(
        Effect.provide(RuntimeFlags.layer({ bashBackgroundThresholdMs: 10_000 })),
        provideInstance(path.join(__dirname, "../..")),
      ),
    20_000,
  )

  // (b) Promotion keeps the same child alive and completion is delivered.
  it.live(
    "promotes a command past the threshold, keeps it running, and delivers its completion",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const notifications: Prompt[] = []
        const trace = unique()
        const result = yield* run(
          { command: `printf 'start\n' | tee -a ${trace}; sleep 2; printf 'finish\n' | tee -a ${trace}` },
          context(notifications),
        )

        expect(result.output).toContain('state="running"')
        expect(result.output).toContain("moved to the background")
        const id = jobID(result)
        expect((yield* jobs.get(id))?.status).toBe("running")

        const waited = yield* jobs.wait({ id, timeout: 15_000 })
        expect(waited.info?.status).toBe("completed")
        expect(waited.info?.output).toContain("finish")

        // The same process ran once: neither killed at the threshold nor restarted.
        expect((yield* Effect.promise(() => fs.readFile(trace, "utf8"))).trim().split("\n")).toEqual([
          "start",
          "finish",
        ])

        // Completion reaches the owning session through the background-result path.
        const delivered = yield* pollWithTimeout(
          Effect.sync(() => notifications[0]?.text),
          "the background command did not notify its session",
          "10 seconds",
        )
        expect(delivered).toContain(`job_id="${id}"`)
        expect(delivered).toContain('state="completed"')
        expect(delivered).toContain("finish")
      }).pipe(
        Effect.provide(RuntimeFlags.layer({ bashBackgroundThresholdMs: 300 })),
        provideInstance(path.join(__dirname, "../..")),
      ),
    30_000,
  )

  // (c) An explicit timeout is a caller-set deadline: it still kills.
  it.live(
    "terminates a command at its explicit timeout instead of promoting it",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const result = yield* run({ command: "sleep 60", timeout: 400 }, context())
        expect(result.output).toContain("exceeding timeout 400 ms")
        expect((result.metadata as { jobId?: string }).jobId).toBeUndefined()
        expect(yield* jobs.list()).toHaveLength(0)
      }).pipe(
        // A threshold below the explicit deadline proves promotion cannot win.
        Effect.provide(RuntimeFlags.layer({ bashBackgroundThresholdMs: 50 })),
        provideInstance(path.join(__dirname, "../..")),
      ),
    20_000,
  )

  // (d) Inspecting a running command never waits for it to finish.
  it.live(
    "status and list return immediately with partial output while the command runs",
    () =>
      Effect.gen(function* () {
        const result = yield* run({ command: "echo partial_marker; sleep 20" }, context())
        const id = jobID(result)

        const started = Date.now()
        const status = yield* manage({ action: "status", job_id: id }, context(undefined, "call_status"))
        const elapsed = Date.now() - started

        expect(elapsed).toBeLessThan(5_000)
        expect(status.output).toContain('state="running"')
        expect(status.output).toContain("partial_marker")
        expect(status.output).toContain('action="cancel"')

        const listed = yield* manage({ action: "list" }, context(undefined, "call_list"))
        expect(listed.output).toContain(id)

        const output = yield* manage({ action: "output", job_id: id }, context(undefined, "call_output"))
        expect(output.output).toContain("partial_marker")

        yield* manage({ action: "cancel", job_id: id }, context(undefined, "call_cleanup"))
      }).pipe(
        Effect.provide(RuntimeFlags.layer({ bashBackgroundThresholdMs: 100 })),
        provideInstance(path.join(__dirname, "../..")),
      ),
    40_000,
  )

  // (e) Cancel kills the process tree, not only the registry entry.
  it.live(
    "cancel kills the process tree of the backgrounded command",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const result = yield* run({ command: "sleep 300" }, context())
        const id = jobID(result)
        const info = yield* jobs.get(id)
        const pid = info?.metadata?.pid as number
        expect(pid).toBeGreaterThan(0)
        expect(groupAlive(pid)).toBe(true)

        const cancelled = yield* manage({ action: "cancel", job_id: id }, context(undefined, "call_cancel"))
        expect(cancelled.output).toContain('state="cancelled"')
        expect((yield* jobs.get(id))?.status).toBe("cancelled")

        yield* deadGroup(pid)
      }).pipe(
        Effect.provide(RuntimeFlags.layer({ bashBackgroundThresholdMs: 100 })),
        provideInstance(path.join(__dirname, "../..")),
      ),
    40_000,
  )

  // (f) Session teardown sweeps background commands, and the cancel settles.
  it.live(
    "session teardown sweeps a backgrounded command and kills its process tree",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const runState = yield* SessionRunState.Service
        const result = yield* run({ command: "sleep 300" }, context())
        const id = jobID(result)
        const pid = (yield* jobs.get(id))?.metadata?.pid as number

        yield* runState.cancel(sessionID)

        const swept = yield* jobs.wait({ id, timeout: 20_000 })
        expect(swept.info?.status).toBe("cancelled")
        yield* deadGroup(pid)
      }).pipe(
        Effect.provide(RuntimeFlags.layer({ bashBackgroundThresholdMs: 100 })),
        provideInstance(path.join(__dirname, "../..")),
      ),
    40_000,
  )

  // Totality: a teardown cancel still delivers a terminal envelope, but silently
  // so the session being stopped is not woken by it.
  it.live(
    "a teardown cancel delivers a silent terminal receipt",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const notifications: Prompt[] = []
        const result = yield* run({ command: "sleep 300" }, context(notifications))
        const id = jobID(result)

        yield* jobs.cancel(id, { teardown: true })

        const delivered = yield* pollWithTimeout(
          Effect.sync(() => notifications[0]),
          "the teardown cancel did not deliver a receipt",
          "10 seconds",
        )
        expect(delivered.silent).toBe(true)
        expect(delivered.text).toContain('state="cancelled"')
        expect(delivered.text).toContain(ShellBackground.CANCELLED_TEXT)
      }).pipe(
        Effect.provide(RuntimeFlags.layer({ bashBackgroundThresholdMs: 100 })),
        provideInstance(path.join(__dirname, "../..")),
      ),
    40_000,
  )
})

// The handle map is process-local and keyed by registry instance; this guards
// the lookup the management tool depends on without needing a live command.
describe("tool.shell background handles", () => {
  it.effect("keeps handles isolated per registry owner", () =>
    Effect.sync(() => {
      const owner = {}
      const other = {}
      const handle: Handle = {
        id: "job_x",
        command: "sleep 1",
        sessionID,
        startedAt: Date.now(),
        snapshot: () => ({ output: "", truncated: false }),
        kill: () => Effect.void,
      }
      const unregister = ShellBackground.register(owner, handle)
      expect(ShellBackground.get(owner, "job_x")).toBe(handle)
      expect(ShellBackground.get(other, "job_x")).toBeUndefined()
      expect(ShellBackground.list(owner)).toHaveLength(1)
      unregister()
      expect(ShellBackground.get(owner, "job_x")).toBeUndefined()
    }),
  )
})
