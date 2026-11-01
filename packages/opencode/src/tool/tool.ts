import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { REVIEW_LOOP_METADATA } from "@opencode-ai/core/review-loop"
import { Effect, Schema } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { MessageV2 } from "../session/message-v2"
import type { Permission } from "../permission"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { Agent } from "@/agent/agent"

interface Metadata {
  [key: string]: any
}

export type ToolMetadata = {
  /** The tool writes files and therefore starts a review cycle. */
  readonly writesFiles?: boolean
}

// TODO: remove this hack
export type DynamicDescription = (agent: Agent.Info) => Effect.Effect<string>

/** Formats parameter validation failures before they become model-facing tool errors. */
export class InvalidArgumentsError extends Schema.TaggedErrorClass<InvalidArgumentsError>()(
  "ToolInvalidArgumentsError",
  {
    tool: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `The ${this.tool} tool was called with invalid arguments: ${this.detail}.\nPlease rewrite the input so it satisfies the expected schema.`
  }
}

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  /**
   * The working folder this session resolves relative paths from and uses as
   * its default search root. A delegated child can work in a folder other than
   * the project it was dispatched from.
   *
   * This is a resolution base, never a permission boundary: `external_directory`
   * approval is still measured against the instance the session runs in, so a
   * folder chosen outside the project does not grant access to it. Callers that
   * omit it resolve from that instance directory, which is where every tool
   * resolved before this field existed.
   */
  cwd?: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  messages: SessionV1.WithParts[]
  waitForOtherTools?: Effect.Effect<void>
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  ask(input: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>
}

export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[]
}

export interface Def<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  description: string
  parameters: Parameters
  jsonSchema?: JSONSchema7
  metadata?: ToolMetadata
  execute(args: Schema.Schema.Type<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>, ToolFailure>
  formatValidationError?(error: unknown): string
}
export type DefWithoutID<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> = Omit<Def<Parameters, M>, "id">

export interface Info<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  metadata?: ToolMetadata
  init: () => Effect.Effect<DefWithoutID<Parameters, M>>
}

type Init<Parameters extends Schema.Decoder<unknown>, M extends Metadata> =
  | DefWithoutID<Parameters, M>
  | (() => Effect.Effect<DefWithoutID<Parameters, M>>)

export type InferParameters<T> =
  T extends Info<infer P, any>
    ? Schema.Schema.Type<P>
    : T extends Effect.Effect<Info<infer P, any>, any, any>
      ? Schema.Schema.Type<P>
      : never
export type InferMetadata<T> =
  T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

export type InferDef<T> =
  T extends Info<infer P, infer M>
    ? Def<P, M>
    : T extends Effect.Effect<Info<infer P, infer M>, any, any>
      ? Def<P, M>
      : never

function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadata>(
  id: string,
  init: Init<Parameters, Result>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
  definitionMetadata?: ToolMetadata,
) {
  return () =>
    Effect.gen(function* () {
      const toolInfo = typeof init === "function" ? { ...(yield* init()) } : { ...init }
      const reviewMetadata =
        definitionMetadata?.writesFiles === true ? { [REVIEW_LOOP_METADATA]: { writesFiles: true } } : undefined
      // Compile the parser closure once per tool init; `decodeUnknownEffect`
      // allocates a new closure per call, so hoisting avoids re-closing it for
      // every LLM tool invocation.
      const decode = Schema.decodeUnknownEffect(toolInfo.parameters)
      const execute = toolInfo.execute
      toolInfo.execute = (args, ctx) => {
        const attrs = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }
        return Effect.gen(function* () {
          const decoded = yield* decode(args).pipe(
            Effect.mapError((error) => {
              const invalid = new InvalidArgumentsError({
                tool: id,
                detail: toolInfo.formatValidationError ? toolInfo.formatValidationError(error) : String(error),
              })
              return new ToolFailure({ message: invalid.message, error: invalid })
            }),
          )
          const result = yield* execute(decoded as Schema.Schema.Type<Parameters>, ctx)
          const marked = reviewMetadata ? { ...result, metadata: { ...result.metadata, ...reviewMetadata } } : result
          if (marked.metadata.truncated !== undefined) return marked

          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(marked.output, {}, agent)
          return {
            ...marked,
            output: truncated.content,
            metadata: {
              ...marked.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }).pipe(Effect.withSpan("Tool.execute", { attributes: attrs }))
      }
      return {
        ...toolInfo,
        ...(definitionMetadata ? { metadata: definitionMetadata } : {}),
      }
    })
}

export function define<
  Parameters extends Schema.Decoder<unknown>,
  Result extends Metadata,
  R,
  ID extends string = string,
>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
  metadata?: ToolMetadata,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & {
  id: ID
  metadata?: ToolMetadata
} {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* init
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      return { id, metadata, init: wrap(id, resolved, truncate, agents, metadata) }
    }),
    { id, metadata },
  )
}

export function init<P extends Schema.Decoder<unknown>, M extends Metadata>(
  info: Info<P, M>,
): Effect.Effect<Def<P, M>> {
  return Effect.gen(function* () {
    const init = yield* info.init()
    return {
      ...init,
      id: info.id,
      ...(info.metadata ? { metadata: info.metadata } : {}),
    }
  })
}

export * as Tool from "./tool"
