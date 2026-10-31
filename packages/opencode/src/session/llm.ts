import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LLMEvent } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import { GenerationLimit } from "./llm/generation-limit"
import { ReasoningWatchdog } from "./llm/reasoning-watchdog"
import { RepetitionGuard } from "./llm/repetition-guard"
import { SystemPrompt } from "./system"
import { ToolCatalog } from "@/tool/catalog"

// A truncated `write` call is recoverable in a narrow, honest sense: the file path
// is usually emitted before the (large) content body, so a prefix of the arguments
// can name the target even though the payload never parsed. Only the path is
// salvaged - never a partial body - and nothing here reconstructs the call.
export type TruncatedWriteRecovery = {
  tool: "write"
  filePath: string
}

function isJsonParseFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : ""
  return /json parse|unterminated|unexpected end of json|unexpected end of input|syntaxerror/i.test(
    `${message} ${cause}`,
  )
}

// Index of the `"` that closes the string literal starting at `from`, or undefined
// when the fragment ends first (the value was cut off, so it does not exist).
function endOfStringLiteral(raw: string, from: number): number | undefined {
  for (let index = from; index < raw.length; index++) {
    const char = raw[index]
    if (char === "\\") {
      index += 1
      continue
    }
    if (char === '"') return index
  }
  return undefined
}

/**
 * Tolerant prefix parse of one top-level string argument out of a possibly truncated
 * JSON object. Scans the fragment character by character (so a `"filePath":` that only
 * appears inside some other string value is never mistaken for the key), and decodes a
 * value only when its closing quote actually arrived. Anything that never completed -
 * an unterminated value, a bad escape, a key whose value never started - yields
 * `undefined` instead of a guess.
 */
export function salvageStringArgument(raw: string, key: string): string | undefined {
  let depth = 0
  let index = 0

  while (index < raw.length) {
    const char = raw[index]

    if (char === '"') {
      const end = endOfStringLiteral(raw, index + 1)
      // The fragment ended inside a string literal: whatever follows is unknowable.
      if (end === undefined) return undefined

      if (depth === 1) {
        let cursor = end + 1
        while (cursor < raw.length && /\s/.test(raw[cursor])) cursor++
        if (raw[cursor] === ":") {
          let name: unknown
          try {
            name = JSON.parse(raw.slice(index, end + 1))
          } catch {
            name = undefined
          }
          if (name === key) {
            cursor += 1
            while (cursor < raw.length && /\s/.test(raw[cursor])) cursor++
            if (raw[cursor] !== '"') return undefined
            const valueEnd = endOfStringLiteral(raw, cursor + 1)
            if (valueEnd === undefined) return undefined
            try {
              const value = JSON.parse(raw.slice(cursor, valueEnd + 1))
              if (typeof value === "string" && value.length > 0) return value
            } catch {
              // Undecodable literal: report nothing rather than a mangled path.
            }
            return undefined
          }
        }
      }

      index = end + 1
      continue
    }

    if (char === "{" || char === "[") depth++
    else if (char === "}" || char === "]") depth--
    index++
  }

  return undefined
}

/**
 * What can be honestly said about a failed `write` call: the target path, when the
 * prefix carried a complete `filePath` value. Only the `write` tool is handled - its
 * two arguments are independent, so a path alone is meaningful - and only when the
 * raw arguments genuinely failed to parse (a schema rejection of well-formed JSON is
 * a different failure with a different message).
 */
export function truncatedWriteRecovery(toolName: string, rawArguments: unknown): TruncatedWriteRecovery | undefined {
  if (toolName.toLowerCase() !== "write") return undefined
  if (typeof rawArguments !== "string" || rawArguments.length === 0) return undefined
  try {
    JSON.parse(rawArguments)
    return undefined
  } catch {
    // Expected: the fragment did not parse, which is why the repair hook is running.
  }
  const filePath = salvageStringArgument(rawArguments, "filePath")
  if (!filePath) return undefined
  return { tool: "write", filePath }
}

// A tool call whose arguments never parsed as JSON is almost always a response
// cut off at the output-token limit mid-payload (or genuinely malformed JSON).
// Name the likely cause and the recovery instead of relaying the bare parser
// error, so the model retries with smaller arguments instead of improvising
// chunking schemes. A nudge only: the model remains free to retry the same call.
// With a recovery, the nudge becomes a guided continuation for that one path.
export function repairToolCallMessage(error: unknown, recovery?: TruncatedWriteRecovery): string {
  const message = error instanceof Error ? error.message : String(error)
  if (!isJsonParseFailure(error)) return message
  const head = [
    `The tool-call arguments were not valid JSON (${message}).`,
    "This usually means the response was cut off at the output-token limit while the arguments were being generated.",
  ]
  if (!recovery) {
    return [
      ...head,
      "Retry with smaller arguments. When writing a large file, split the content across several smaller tool calls or append it in chunks instead of sending one large payload, and keep each individual tool call well within the output budget.",
    ].join(" ")
  }
  return [
    ...head,
    `Recovered from the partial arguments: the write call that failed to parse targeted "${recovery.filePath}". No file content arrived before the cut, so no content was recovered and none is assumed.`,
    `That call did not execute, so this specific write wrote no file and changed nothing on disk. This is a statement about this one call only: earlier tool calls in this session may already have run and had effects, which this repair cannot see.`,
    `Re-issue the write for "${recovery.filePath}" in smaller chunks instead: first send a write call whose content is only the first chunk of the file, then send follow-up calls that append the remaining chunks to the same file, keeping every single call well within the output budget.`,
  ].join(" ")
}

export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | EventV2Bridge.Service
  | LLMClientService
  | RuntimeFlags.Service
  | ToolCatalog.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service
    const catalog = yield* ToolCatalog.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
        steLite: SystemPrompt.chat({
          config: cfg.ste_lite,
          hidden: input.agent.hidden,
          small: input.small,
          format: input.user.format?.type,
        }),
      })
      const summarizedReasoning = ReasoningWatchdog.hasSummary(prepared.params.options, input.model)
      // Hard application-level cap for a single generation stream. The
      // provider request already carries maxOutputTokens, but a pathological
      // model can ignore it and stream unbounded deltas until the host goes
      // down (issue #89). This client-side bound turns that into a clean
      // abort; the env override takes precedence over the derived default.
      const maxGenerationChars = GenerationLimit.resolveMaxChars({
        maxOutputTokens: prepared.params.maxOutputTokens,
        override: flags.generationCharMax,
      })
      // Loop detector for a model that regenerates the same text verbatim
      // without ever reaching a tool call (issue #94). Fires far below the
      // character cap above so a repetitive loop aborts before the token
      // budget is anywhere near exhausted.
      const repetitionThresholds = RepetitionGuard.resolveThresholds({
        lineRepeats: flags.repetitionLineRepeats,
        unitRepeats: flags.repetitionUnitRepeats,
      })

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      const bridge = yield* EffectBridge.make()
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionV1.ID.ascending()
          let unsub: EventV2.Unsubscribe | undefined
          try {
            unsub = await bridge.promise(
              events.listen((event) => {
                if (event.type !== Permission.Event.Replied.type) return Effect.void
                const data = event.data as EventV2.Data<typeof Permission.Event.Replied>
                if (data.requestID !== id) return Effect.void
                void data.reply
                return Effect.void
              }),
            )
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            if (unsub) await bridge.promise(unsub)
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is an opt-in adapter over @opencode-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      if (flags.experimentalNativeLlm) {
        const native = LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected", {
            "llm.runtime": "native",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          })
          return {
            type: "native" as const,
            stream: native.stream,
            executableTools: new Set(
              Object.entries(prepared.tools)
                .filter(([, tool]) => tool.execute)
                .map(([name]) => name),
            ),
            summarizedReasoning,
            maxGenerationChars,
            repetitionThresholds,
          }
        }
        yield* Effect.logInfo("llm runtime selected", {
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
          "llm.native_unsupported_reason": native.reason,
        })
        yield* Effect.logInfo("native runtime unavailable; falling back to ai-sdk", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          "session.id": input.sessionID,
          small: (input.small ?? false).toString(),
          agent: input.agent.name,
          mode: input.agent.mode,
          reason: native.reason,
        })
      }

      yield* Effect.logInfo("llm runtime selected", {
        "llm.runtime": "ai-sdk",
        "llm.provider": input.model.providerID,
        "llm.model": input.model.id,
      })
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      return {
        type: "ai-sdk" as const,
        executableTools: new Set(
          Object.entries(prepared.tools)
            .filter(([, tool]) => tool.execute)
            .map(([name]) => name),
        ),
        summarizedReasoning,
        maxGenerationChars,
        repetitionThresholds,
        result: streamText({
          onError(error) {
            bridge.fork(
              Effect.logError("stream error", {
                providerID: input.model.providerID,
                modelID: input.model.id,
                "session.id": input.sessionID,
                small: (input.small ?? false).toString(),
                agent: input.agent.name,
                mode: input.agent.mode,
                error,
              }),
            )
          },
          // Copilot returns the authoritative billed amount only in provider-specific response fields.
          includeRawChunks: input.model.providerID.includes("github-copilot"),
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            // A deferred tool called by its exact name: the tool exists but was never loaded,
            // so the model has no way to know it is available. Discover it for this session
            // and tell the model to retry — it is in the very next request. Any catalog
            // failure falls through to the generic repair, so this can never make a call
            // worse than it was.
            if (!prepared.tools[failed.toolCall.toolName]) {
              const entry = await bridge.promise(catalog.get(failed.toolCall.toolName)).catch(() => undefined)
              if (entry?.deferred) {
                await bridge.promise(catalog.discover(input.sessionID, [entry.id])).catch(() => undefined)
                return {
                  ...failed.toolCall,
                  input: JSON.stringify({
                    tool: failed.toolCall.toolName,
                    error: `${entry.id} exists and has been loaded — call it again`,
                  }),
                  toolName: "invalid",
                }
              }
            }
            // Known to this request, a truncated write call can name its target from
            // the raw fragment. The call itself still never executed: it is routed to
            // `invalid` exactly as before, now with a guided continuation.
            const recovery = Object.hasOwn(prepared.tools, failed.toolCall.toolName)
              ? truncatedWriteRecovery(failed.toolCall.toolName, failed.toolCall.input)
              : undefined
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: repairToolCallMessage(failed.error, recovery),
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: ProviderTransform.withQwenWebThreadScope(
            ProviderTransform.providerOptions(input.model, prepared.params.options),
            input.agent.name,
            input.small,
            input.sessionID,
          ),
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          messages: prepared.messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    // @ts-expect-error
                    args.params.prompt = ProviderTransform.message(
                      args.params.prompt,
                      input.model,
                      prepared.messageTransformOptions,
                    )
                  }
                  return args.params
                },
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here. Both are
            // wrapped in the inactivity watchdog, the repetition guard, and the
            // generation-length cap so a pathological stream aborts cleanly
            // instead of taking the host process down (issues #89 and #94).
            // Single choke point: both runtimes funnel through the one guarded
            // stream below, so no runtime can bypass the guards.
            const state = LLMAISDK.adapterState()
            const inner =
              result.type === "native"
                ? result.stream
                : Stream.fromAsyncIterable(result.result.fullStream, (e) =>
                    e instanceof Error ? e : new Error(String(e)),
                  ).pipe(
                    Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
                    Stream.flatMap((events) => Stream.fromIterable(events)),
                  )
            return GenerationLimit.guard(
              RepetitionGuard.guard(
                ReasoningWatchdog.guard(inner, {
                  summarized: result.summarizedReasoning,
                  executableTools: result.executableTools,
                }),
                { thresholds: result.repetitionThresholds },
              ),
              { maxChars: result.maxGenerationChars },
            )
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export const node = LayerNode.make({
  service: Service,
  layer: live,
  deps: [
    Auth.node,
    Config.node,
    Provider.node,
    Plugin.node,
    Permission.node,
    EventV2Bridge.node,
    llmClient,
    RuntimeFlags.node,
    ToolCatalog.node,
  ],
})

export * as LLM from "./llm"
