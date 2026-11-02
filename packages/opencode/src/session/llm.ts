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
import { Wildcard as CoreWildcard } from "@opencode-ai/core/util/wildcard"
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

type StringRead = { ok: true; value: string; next: number } | { ok: false; reason: "truncated" | "invalid" }

// Reads one JSON string literal whose opening quote sits at `from`. A fragment that ends
// inside the literal is `truncated` (the value never finished arriving); a literal that
// closes but does not decode is `invalid`. Neither is a value we may report.
function readStringLiteral(raw: string, from: number): StringRead {
  for (let index = from + 1; index < raw.length; index++) {
    const char = raw[index]
    if (char === "\\") {
      index += 1
      continue
    }
    if (char !== '"') continue
    try {
      return { ok: true, value: JSON.parse(raw.slice(from, index + 1)), next: index + 1 }
    } catch {
      return { ok: false, reason: "invalid" }
    }
  }
  return { ok: false, reason: "truncated" }
}

type ValueSkip = { ok: true; next: number; truncated: boolean } | { ok: false; reason: "invalid" }

const JSON_TOKEN = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/

// Skips a non-string JSON value starting at `from`, tracking nesting and string literals
// so a `}` or `,` inside a nested string can never be mistaken for structure.
function skipValue(raw: string, from: number): ValueSkip {
  const char = raw[from]
  if (char === '"') {
    const literal = readStringLiteral(raw, from)
    if (!literal.ok) {
      return literal.reason === "truncated" ? { ok: true, next: raw.length, truncated: true } : { ok: false, reason: "invalid" }
    }
    return { ok: true, next: literal.next, truncated: false }
  }
  if (char === "{" || char === "[") {
    // Track the opening brackets so a closing one only balances a value when it
    // matches: `{]` and `[}` are not prefixes of well-formed JSON, and treating
    // them as balanced would let a malformed fragment look like a completed one.
    const open: string[] = [char]
    let index = from + 1
    while (index < raw.length) {
      const current = raw[index]
      if (current === '"') {
        const literal = readStringLiteral(raw, index)
        if (!literal.ok) {
          return literal.reason === "truncated"
            ? { ok: true, next: raw.length, truncated: true }
            : { ok: false, reason: "invalid" }
        }
        index = literal.next
        continue
      }
      if (current === "{" || current === "[") open.push(current)
      else if (current === "}" || current === "]") {
        if (open[open.length - 1] !== (current === "}" ? "{" : "[")) return { ok: false, reason: "invalid" }
        open.pop()
        if (open.length === 0) return { ok: true, next: index + 1, truncated: false }
      }
      index += 1
    }
    return { ok: true, next: raw.length, truncated: true }
  }
  let index = from
  while (index < raw.length && !/[\s,}\]]/.test(raw[index])) index += 1
  const token = raw.slice(from, index)
  if (index >= raw.length) {
    // A literal cut off at the end is unknown, not a token we can validate - and it is
    // not the value we are looking for either, so the scan simply stops here.
    return { ok: true, next: raw.length, truncated: true }
  }
  if (!JSON_TOKEN.test(token)) return { ok: false, reason: "invalid" }
  return { ok: true, next: index, truncated: false }
}

/**
 * Tolerant prefix parse of one top-level string member out of a possibly truncated JSON
 * object. The fragment must be a structural prefix of a single object: members are read
 * in order as `"key": value` with real separators, so key-shaped text inside a string, a
 * nested value, or a top-level array is never mistaken for the member. A duplicate of the
 * requested key makes the target ambiguous - a complete payload could resolve it to a
 * different value - so it yields nothing rather than a guess, and a value is returned
 * only when its closing quote actually arrived.
 */
export function salvageStringArgument(raw: string, key: string): string | undefined {
  let index = 0
  const skipWhitespace = () => {
    while (index < raw.length && /\s/.test(raw[index])) index += 1
  }

  skipWhitespace()
  // Anything but an object start cannot carry this member meaningfully; a leading `[`
  // can still contain the key shape textually, which is exactly the mistake to avoid.
  if (raw[index] !== "{") return undefined
  index += 1

  let found: string | undefined
  let seen = false

  while (true) {
    skipWhitespace()
    // A fragment ending at a member boundary is a valid prefix: keep what was completed.
    if (index >= raw.length) break
    if (raw[index] === "}") break
    if (raw[index] !== '"') return undefined

    const name = readStringLiteral(raw, index)
    if (!name.ok) return undefined
    index = name.next

    const target = name.value === key
    // A repeated target key makes the target ambiguous even when the fragment ends
    // before the second member's colon: a complete payload could still resolve the
    // duplicate to a different value, so refuse rather than report the first. The check
    // therefore happens as soon as the name is read, not after the colon.
    if (target) {
      if (seen) return undefined
      seen = true
    }

    skipWhitespace()
    // Truncated between a key and its colon: the member's value is simply unknown, and
    // nothing after it can exist, so the members read so far stay trustworthy.
    if (index >= raw.length) break
    if (raw[index] !== ":") return undefined
    index += 1
    skipWhitespace()

    // The fragment ended between a member's key and its value: unknown, but a member we
    // never needed, so the members already read stay valid.
    if (index >= raw.length) {
      if (target) return undefined
      break
    }

    if (raw[index] === '"' && target) {
      const value = readStringLiteral(raw, index)
      if (!value.ok) return undefined
      if (value.value.length === 0) return undefined
      found = value.value
      index = value.next
    } else {
      const value = skipValue(raw, index)
      if (!value.ok) return undefined
      index = value.next
      // The wanted member exists but its value is not a complete string, or it was cut
      // off: there is nothing recoverable and a later duplicate could still change it.
      if (target) return undefined
      if (value.truncated) break
    }

    skipWhitespace()
    if (index >= raw.length) break
    if (raw[index] === ",") {
      index += 1
      continue
    }
    if (raw[index] === "}") break
    // No separator between members: the fragment is not a prefix of well-formed JSON,
    // so its structure cannot be trusted.
    return undefined
  }

  return found
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
    `Recovered from the partial arguments: the write call that failed to parse targeted "${recovery.filePath}". The file content for that call is not recovered - whatever content did or did not arrive in the fragment is unknown - so no content is assumed and none is inferred.`,
    `That call did not execute, so this specific write call wrote nothing and changed nothing on disk. This is a statement about this one call only: earlier tool calls in this session may already have run and had effects, including on this same path, which this repair cannot see.`,
    `Continue by inspecting "${recovery.filePath}" first: check whether it exists and what it currently holds. If it does not exist, send one write call whose content is only the first chunk of the file. Then append the remaining chunks with edit calls whose oldString is a unique tail of the content already on disk and whose newString is that same tail followed by the next chunk. If the path already exists, do not start over with write - write replaces the entire file and would discard what is already there and anything earlier calls wrote - append the remaining chunks with those same edit calls instead, or write the complete content in one call if it fits. Keep every single call well within the output budget.`,
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
          const match = CoreWildcard.winningRule(
            ruleset,
            name,
            (rule) => rule.permission,
            () => true,
            (rule) => rule.action === "deny",
          )
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
