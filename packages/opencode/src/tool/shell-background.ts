import { Effect, Schema } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import * as Tool from "./tool"
import DESCRIPTION from "./shell-background.txt"
import { BackgroundJob } from "@/background/job"
import { ShellBackground } from "./shell/background"
import { Truncate } from "./truncate"
import type { SessionID } from "@/session/schema"

const Actions = ["list", "status", "output", "cancel"] as const

// A status check is a glance, not a dump: it stays short enough to read on every
// poll, and `output` is the action that returns the whole captured tail.
const STATUS_OUTPUT_CHARS = 4_000

export const Parameters = Schema.Struct({
  action: Schema.Literals(Actions).annotate({
    description:
      'list: background shell commands of this session; status: current status plus partial output (never waits); output: output captured so far (never waits); cancel: kill the command\'s process tree',
  }),
  job_id: Schema.optional(Schema.String).annotate({
    description: "Background job id from the shell envelope. Required for status, output and cancel.",
  }),
})

type Metadata = {
  jobId?: string
  status?: string
  truncated?: boolean
  outputPath?: string
}

function elapsed(job: BackgroundJob.Info) {
  const end = job.completed_at ?? Date.now()
  return Math.max(0, end - job.started_at)
}

function attributes(job: BackgroundJob.Info, snapshot?: ShellBackground.Snapshot, truncated?: boolean) {
  const pid = job.metadata?.pid
  const exit = snapshot?.exit ?? job.metadata?.exit
  return [
    typeof pid === "number" ? ` pid="${pid}"` : "",
    typeof exit === "number" ? ` exit="${exit}"` : "",
    truncated ? ` truncated="true"` : "",
  ].join("")
}

function command(job: BackgroundJob.Info) {
  return typeof job.metadata?.command === "string" ? job.metadata.command : (job.title ?? "(unknown command)")
}

/**
 * The live half of a running command is the tool's own bounded buffers; the
 * terminal half is the registry entry. Reading either never waits on the
 * command, which is what lets an agent inspect a command mid-flight.
 */
function read(background: BackgroundJob.Interface, job: BackgroundJob.Info, fallback?: ShellBackground.Snapshot) {
  const snapshot = ShellBackground.get(background, job.id)?.snapshot() ?? fallback
  const truncated = Boolean(snapshot?.truncated) || job.metadata?.truncated === true
  const outputPath =
    snapshot?.outputPath ?? (typeof job.metadata?.outputPath === "string" ? job.metadata.outputPath : undefined)
  if (job.status === "running") return { text: snapshot?.output ?? "", snapshot, truncated, outputPath }
  return { text: job.output ?? snapshot?.output ?? job.error ?? "", snapshot, truncated, outputPath }
}

export const ShellBackgroundTool = Tool.define<
  typeof Parameters,
  Metadata,
  BackgroundJob.Service | Truncate.Service
>(
  ShellBackground.ToolID,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const trunc = yield* Truncate.Service

    const owned = Effect.fn("ShellBackgroundTool.list")(function* (sessionID: SessionID) {
      return (yield* background.list())
        .filter((job) => job.type === ShellBackground.TYPE && BackgroundJob.runsSession(job, sessionID))
        .toSorted((a, b) => b.started_at - a.started_at)
    })

    /** Keeps a chatty command's capture inside the tool output budget. */
    const bounded = Effect.fnUntraced(function* (text: string) {
      const out = yield* trunc.output(text)
      return out.truncated
        ? { text: out.content, truncated: true, outputPath: out.outputPath }
        : { text: out.content, truncated: false, outputPath: undefined }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          if (params.action === "list") {
            const jobs = yield* owned(ctx.sessionID)
            const body =
              jobs.length === 0
                ? "No background shell commands in this session."
                : jobs
                    .map(
                      (job) =>
                        `<job id="${job.id}" state="${job.status}"${attributes(job)} elapsed_ms="${elapsed(job)}">${command(job)}</job>`,
                    )
                    .join("\n")
            return {
              title: `${jobs.length} background command${jobs.length === 1 ? "" : "s"}`,
              metadata: { truncated: false },
              output: [`<shell_backgrounds count="${jobs.length}">`, body, "</shell_backgrounds>"].join("\n"),
            }
          }

          if (!params.job_id) {
            return yield* Effect.fail(
              new ToolFailure({ message: `action "${params.action}" requires a job_id from the shell envelope.` }),
            )
          }
          const job = yield* background.get(params.job_id)
          if (!job || job.type !== ShellBackground.TYPE || !BackgroundJob.runsSession(job, ctx.sessionID)) {
            return yield* Effect.fail(
              new ToolFailure({ message: `No background shell command with job_id ${params.job_id} in this session.` }),
            )
          }

          if (params.action === "cancel") {
            // Claim the cancellation before killing: the kill lets the child
            // exit, and the job would otherwise settle as completed first. The
            // handle is read before the registry closes the job, because that
            // teardown also drops it from the live map.
            const handle = ShellBackground.get(background, job.id)
            const snapshot = handle?.snapshot()
            const cancelled = yield* background.cancel(job.id)
            // Then kill the real process tree. The handle runs the same
            // SIGTERM-then-SIGKILL escalation the inline timeout path uses, so a
            // cancel is never just bookkeeping on the registry entry.
            if (handle) yield* handle.kill()
            const info = cancelled ?? job
            const state = info.status === "running" ? "cancelled" : info.status
            const captured = read(background, info, snapshot)
            const out = yield* bounded(captured.text)
            const truncated = captured.truncated || out.truncated
            const outputPath = captured.outputPath ?? out.outputPath
            return {
              title: `${state === "cancelled" ? "Cancelled" : state} ${command(info)}`,
              metadata: {
                jobId: info.id,
                status: state,
                truncated,
                ...(outputPath ? { outputPath } : {}),
              },
              output: ShellBackground.renderResult({
                id: info.id,
                command: command(info),
                state,
                text: out.text || (state === "cancelled" ? ShellBackground.CANCELLED_TEXT : ""),
                ...(captured.snapshot?.exit !== undefined ? { exit: captured.snapshot.exit } : {}),
                truncated,
                ...(outputPath ? { outputPath } : {}),
              }),
            }
          }

          const captured = read(background, job)
          const running = job.status === "running"
          const sliced = params.action === "status" && captured.text.length > STATUS_OUTPUT_CHARS
          const out = yield* bounded(sliced ? captured.text.slice(-STATUS_OUTPUT_CHARS) : captured.text)
          const truncated = captured.truncated || sliced || out.truncated
          const outputPath = captured.outputPath ?? out.outputPath
          const head = [
            `<shell_background job_id="${job.id}" state="${job.status}"${attributes(job, captured.snapshot, truncated)} elapsed_ms="${elapsed(job)}">`,
            `<command>${command(job)}</command>`,
          ]
          const tail = [
            `<output>`,
            out.text || "(no output yet)",
            `</output>`,
            ...(truncated && outputPath ? [`<output_path>${outputPath}</output_path>`] : []),
            running
              ? `<note>The command is still running and this is the output captured so far. You will be notified when it finishes; action="cancel" job_id="${job.id}" kills it.</note>`
              : `<note>The command is no longer running.</note>`,
            "</shell_background>",
          ]
          return {
            title: `${job.status} ${command(job)}`,
            metadata: {
              jobId: job.id,
              status: job.status,
              truncated,
              ...(outputPath ? { outputPath } : {}),
            },
            output: [...head, ...tail].join("\n"),
          }
        }),
    }
  }),
)
