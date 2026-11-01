import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Deferred, Effect, Exit, Layer, Context, Option, Ref, Scope, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { ProviderError } from "@/provider/error"
import { GenerationLimit } from "./llm/generation-limit"
import { RepetitionGuard } from "./llm/repetition-guard"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { HeadlessRunRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { Usage, type LLMEvent } from "@opencode-ai/llm"
import { createGenerationClock } from "./generation-metrics"

const DOOM_LOOP_THRESHOLD = 3
export type Result = "compact" | "stop" | "continue"

export interface Handle {
  readonly message: SessionV1.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: SessionV1.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly waitForOtherTools: (toolCallID: string) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  tool: string
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: SessionV1.TextPart | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
  // Time of the last reasoning delta per part, so a thought ends when the model stopped thinking, not when the next chunk arrived.
  reasoningLast: Record<string, number>
}

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        reasoningMap: {},
        reasoningLast: {},
      }
      let aborted = false
      // Set from every step-finish event. A stream that ends with no
      // step-finish died instead of completing - without this check the turn
      // ends silently with no error and no retry. An "unknown" reason is NOT
      // death: it means the provider transmitted no finish reason (per the
      // provider-spec contract), which a completed response may legitimately
      // do, and retrying a completed response replays its tool calls. Genuine
      // interruptions must be detected at the provider's transport layer
      // (e.g. the Zen adapter's [DONE]-framing guard), which surfaces them as
      // stream errors this pipeline already retries.
      let stepFinishReason: string | undefined = undefined
      // Set when this attempt's stream carried any tool activity. A retry
      // re-issues THIS step's request; results from already-completed steps
      // ride that request's history, but a result produced mid-step never
      // lands in it, so the provider would issue the call again and repeat
      // its side effects. An attempt that touched tools is therefore never
      // retried; a text-only attempt is always safe to.
      let sawToolActivity = false
      const clock = createGenerationClock()

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const waitForOtherTools = Effect.fn("SessionProcessor.waitForOtherTools")(function* (toolCallID: string) {
        // Let sibling tool invocations register before taking the first snapshot. Recheck after
        // each batch because a provider can emit another tool call while an earlier one settles.
        yield* Effect.yieldNow
        while (true) {
          const pending = Object.entries(ctx.toolcalls)
            .filter(([id, call]) => id !== toolCallID && call.tool !== "finish")
            .map(([, call]) => Deferred.await(call.done))
          if (pending.length === 0) return
          yield* Effect.all(pending, { concurrency: "unbounded" })
          yield* Effect.yieldNow
        }
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          yield* Deferred.succeed(call.done, undefined).pipe(Effect.ignore)
          return undefined
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: SessionV1.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        // The commit is a read-modify-write, and a child's write projection can
        // land on this part from another fiber while the tool is running. Merge
        // against what is actually stored, under the part's lock, so the commit
        // cannot erase evidence that was written after the read above.
        //
        // Background output can predate a child's write projection. Keep
        // persisted evidence and never let a stale false erase a known write.
        const committed = yield* session.modifyPart(
          {
            sessionID: match.call.sessionID,
            messageID: match.call.messageID,
            partID: match.call.partID,
          },
          (part): SessionV1.ToolPart | undefined => {
            if (!part || part.type !== "tool" || part.state.status !== "running") return undefined
            const metadata = { ...part.state.metadata, ...output.metadata }
            const previousReview = part.state.metadata?.reviewLoop
            const returnedReview = output.metadata.reviewLoop
            if (isRecord(previousReview) || isRecord(returnedReview)) {
              metadata.reviewLoop = {
                ...(isRecord(previousReview) ? previousReview : {}),
                ...(isRecord(returnedReview) ? returnedReview : {}),
                ...((isRecord(previousReview) && previousReview.writesFiles === true) ||
                (isRecord(returnedReview) && returnedReview.writesFiles === true)
                  ? { writesFiles: true }
                  : {}),
              }
            }
            return {
              ...part,
              state: {
                status: "completed",
                input: part.state.input,
                output: output.output,
                metadata,
                title: output.title,
                time: { start: part.state.time.start, end: Date.now() },
                attachments: output.attachments,
              },
            }
          },
        )
        if (!committed) return
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            // Keep metadata streamed while running so failures retain progress detail (e.g. execute's child calls).
            metadata: match.part.state.metadata,
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        // `PermissionV1.TimedOutError` is deliberately absent: an unanswered prompt
        // fails only this tool call so the model can pick another approach, while a
        // rejection ends the turn unless `experimental.continue_loop_on_deny` is set.
        if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        if (!(reasoningID in ctx.reasoningMap)) return
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = {
          ...ctx.reasoningMap[reasoningID].time,
          end: ctx.reasoningLast[reasoningID] ?? Date.now(),
        }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        delete ctx.reasoningMap[reasoningID]
        delete ctx.reasoningLast[reasoningID]
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        const existing = yield* readToolCall(input.id)
        if (existing) {
          if (!input.providerExecuted || existing.part.metadata?.providerExecuted) return existing
          const part = yield* session.updatePart({
            ...existing.part,
            metadata: { ...existing.part.metadata, providerExecuted: true },
          })
          ctx.toolcalls[input.id] = {
            ...existing.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return { call: ctx.toolcalls[input.id], part }
        }
        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: input.name,
          callID: input.id,
          state: { status: "pending", input: {}, raw: "" },
          metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
        } satisfies SessionV1.ToolPart)
        ctx.toolcalls[input.id] = {
          tool: input.name,
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return { call: ctx.toolcalls[input.id], part }
      })

      const isFilePart = (value: unknown): value is SessionV1.FilePart => Schema.is(SessionV1.FilePart)(value)

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: SessionV1.FilePart[] } => {
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
                switch (value.type) {
          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            ctx.reasoningLast[value.id] = Date.now()
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            ctx.reasoningLast[value.id] = Date.now()
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (value.providerMetadata && value.id in ctx.reasoningMap) {
              ctx.reasoningMap[value.id].metadata = value.providerMetadata
            }
            yield* finishReasoning(value.id)
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            yield* ensureToolCall(value)
            return

          case "tool-input-end": {
            yield* ensureToolCall(value)
            return
          }

          case "tool-call": {
            sawToolActivity = true
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            const input = isRecord(value.input) ? value.input : { value: value.input }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            // Unlike a tool permission this ask runs inside the event stream, not inside a
            // tool, so a failure here halts the turn instead of failing one tool call. That
            // is intentional for the countdown too: nobody answering "keep going after three
            // identical failures?" is treated like a "no", which is the bounded outcome for
            // an agent that is already stuck. See issue #186.
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.name],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.name, input },
              always: [value.name],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            sawToolActivity = true
            const toolCall = yield* readToolCall(value.id)
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed<SessionV1.FilePart>(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            yield* completeToolCall(value.id, output)
            return
          }

          case "tool-error": {
            sawToolActivity = true
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            return
          }

          case "provider-error":
            // Preserve the provider's structured classification: a generic
            // Error would degrade to Unknown in fromError, dropping
            // context-overflow from the compaction path and explicit
            // retryability from the retry policy (#409).
            if (value.classification === "context-overflow")
              throw new SessionV1.ContextOverflowError({ message: value.message })
            throw new SessionV1.APIError({ message: value.message, isRetryable: value.retryable ?? false })

          case "step-start":
            // A new step resets the finish witness: without this, a prior
            // step's finish reason survives into a step whose stream dies
            // before its own step-finish, and the no-finish backstop below
            // mistakes the dead step for a completed one.
            stepFinishReason = undefined
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "step-finish": {
            stepFinishReason = value.reason
            const completedSnapshot = yield* snapshot.track()
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            ctx.assistantMessage.finish = value.reason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return

          case "finish":
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        const metrics = clock.finish(Date.now())
        if (metrics.ttft !== undefined) ctx.assistantMessage.ttft = metrics.ttft
        if (metrics.tokensPerSecond !== undefined) ctx.assistantMessage.tokensPerSecond = metrics.tokensPerSecond

        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const [id, part] of Object.entries(ctx.reasoningMap)) {
          const end = ctx.reasoningLast[id] ?? Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}
        ctx.reasoningLast = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        yield* Effect.logError("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
          error: errorMessage(e),
          stack: e instanceof Error ? e.stack : undefined,
        })
        const error = parse(e)
        if (SessionV1.ContextOverflowError.isInstance(error)) {
          if ((yield* config.get()).compaction?.auto === false && !ctx.assistantMessage.summary) {
            ctx.assistantMessage.error = error
            ctx.assistantMessage.finish = "error"
            yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            yield* status.set(ctx.sessionID, { type: "idle" })
            return
          }
          ctx.needsCompaction = true
          yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = error
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true
        // Tracks whether the retry loop was terminated because the user
        // switched to a different model/provider mid-backoff. When true,
        // the processor returns "continue" (not "stop") so the outer
        // runLoop can pick up the new selection on the next iteration.
        const retryInvalidated = yield* Ref.make(false)
        // Counts scheduled retries so a terminal error can say the turn did
        // not die on the first failure.
        const retryAttempts = yield* Ref.make(0)
        const headless = yield* HeadlessRunRef
        const maxDelay = headless
          ? (headless.maxDelayMs ?? flags.retryMaxDelayMs ?? SessionRetry.RETRY_HEADLESS_MAX_DELAY)
          : undefined

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            // Argument-only calls from a failed attempt never executed. A safe
            // retry must discard these drafts and settle their rendezvous before
            // the next finish call waits for siblings. Executed calls are never
            // retried and must keep their persisted evidence.
            for (const toolCallID of Object.keys(ctx.toolcalls)) {
              const match = yield* readToolCall(toolCallID)
              if (!match || match.part.state.status !== "pending") continue
              yield* session.removePart({
                sessionID: match.call.sessionID,
                messageID: match.call.messageID,
                partID: match.call.partID,
              })
              yield* settleToolCall(toolCallID)
            }
            ctx.currentText = undefined
            stepFinishReason = undefined
            sawToolActivity = false
            // A retry after a stalled or failed stream must not leave the previous attempt's thought open.
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            ctx.reasoningMap = {}
            ctx.reasoningLast = {}
            yield* status.set(ctx.sessionID, { type: "busy" })
            const stream = llm.stream(streamInput)
            clock.startRequest(Date.now())

            yield* stream.pipe(
              Stream.tap((event) => {
                clock.observe(event, Date.now())
                return handleEvent(event)
              }),
              Stream.takeUntil(() => ctx.needsCompaction),
              Stream.runDrain,
            )
            // A stream that ended without any step-finish died
            // mid-generation. Route it into the retry pipeline as a stream
            // error; aborts and compaction takeUntil are legitimate early
            // ends and stay untouched, and an "unknown" finish reason is a
            // completed response whose provider omitted metadata, not a death.
            if (!aborted && !ctx.needsCompaction && stepFinishReason === undefined) {
              return yield* Effect.fail(
                new ProviderError.ResponseStreamError("response stream ended without a finish reason"),
              )
            }
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => {
                const squashed = Cause.squash(cause)
                // A stream that dies mid-step after tool activity must
                // surface as a terminal interruption, not a retry: the retry
                // re-issues this step's request without the results those
                // calls produced, so the provider would issue them again and
                // repeat their side effects. Text-only attempts stay on the
                // normal retry path - replaying them regenerates words, never
                // actions. Classifications the rest of the pipeline depends
                // on (context overflow drives compaction; the generation cap
                // and repetition guard must keep their own messages; aborts
                // are the caller's own) are never re-labeled.
                const message = squashed instanceof Error ? squashed.message : String(squashed)
                if (
                  sawToolActivity &&
                  !(squashed instanceof DOMException && squashed.name === "AbortError") &&
                  !SessionV1.ContextOverflowError.isInstance(squashed) &&
                  !message.includes(GenerationLimit.GENERATION_LIMIT_MESSAGE) &&
                  !message.includes(RepetitionGuard.REPETITION_MESSAGE)
                ) {
                  return Effect.fail(
                    new ProviderError.StreamInterruptedAfterToolCallError(
                      "Response stream interrupted after tool calls were issued; the turn was not retried so tool side effects are not repeated. Continue the conversation to resume.",
                      { cause: squashed },
                    ),
                  )
                }
                return Effect.fail(squashed)
              },
            ),
            Effect.retry(
              SessionRetry.policy({
                provider: input.model.providerID,
                parse,
                maxDelay,
                set: (info) => {
                  return Effect.flatMap(Ref.update(retryAttempts, (n) => n + 1), () =>
                    status.set(ctx.sessionID, {
                      type: "retry",
                      attempt: info.attempt,
                      message: info.message,
                      action: info.action,
                      next: info.next,
                    }),
                  )
                },
                // Cancel stale retries when the user has switched to a
                // different model/provider since this turn started. The
                // outer runLoop will pick up the new selection on the next
                // iteration via turnSelection().
                invalidate: () =>
                  Effect.gen(function* () {
                    const current = yield* session.get(ctx.sessionID).pipe(Effect.option)
                    if (Option.isNone(current)) return false
                    const currentModel = current.value.model
                    if (!currentModel) return false
                    return currentModel.providerID !== input.model.providerID || currentModel.id !== input.model.id
                  }),
              }),
            ),
            Effect.catchIf(
              (error) => SessionRetry.isRetryInvalidated(error),
              () =>
                Effect.gen(function* () {
                  yield* Ref.set(retryInvalidated, true)
                  yield* Effect.logInfo("retry invalidated: model changed mid-backoff", {
                    "session.id": ctx.sessionID,
                    "old.model": input.model.id,
                    "old.provider": input.model.providerID,
                  })
                }),
            ),
            Effect.catch((e) =>
              Effect.gen(function* () {
                // After real retries, say so in the terminal error: a bare
                // "stream timed out" reads as if the turn died on the first
                // failure with no retry marker left behind.
                const attempts = yield* Ref.get(retryAttempts)
                if (attempts > 0 && e instanceof ProviderError.ResponseStreamError) {
                  return yield* halt(
                    new ProviderError.ResponseStreamError(`${e.message} (gave up after ${attempts} retries)`),
                  )
                }
                return yield* halt(e)
              }),
            ),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsCompaction) return "compact"
          // If retries were invalidated by a model switch, continue the loop
          // so runLoop can pick up the new selection.
          const wasInvalidated = yield* Ref.get(retryInvalidated)
          if (wasInvalidated) return "continue"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        updateToolCall,
        completeToolCall,
        waitForOtherTools,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Session.node,
    Config.node,
    Snapshot.node,
    Agent.node,
    LLM.node,
    Permission.node,
    Plugin.node,
    SessionSummary.node,
    SessionStatus.node,
    Image.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Database.node,
  ],
})

export * as SessionProcessor from "./processor"
