import { AgentV2 } from "@opencode-ai/core/agent"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { PluginInternal } from "@opencode-ai/core/plugin/internal"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { ToolRegistry as CoreToolRegistry } from "@opencode-ai/core/tool/registry"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { WorkspaceRef } from "@/effect/instance-ref"
import * as Tool from "./tool"

/**
 * Compatibility boundary between the production V1 session loop and the canonical
 * location-scoped tool registry. The attachment implementation, storage, and permission
 * checks remain owned by core; this only translates the legacy invocation/result shape.
 */
export const AttachmentTool = Tool.define(
  "attachment",
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service

    return () =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        const workspaceID = yield* WorkspaceRef
        const ref = Location.Ref.make({
          directory: AbsolutePath.make(ctx.directory),
          workspaceID,
        })
        const locationLayer = locations.get(ref)
        const internal = yield* PluginInternal.Service.pipe(Effect.provide(locationLayer))
        const materialization = yield* CoreToolRegistry.Service.use((registry) => registry.materialize()).pipe(
          Effect.provide(locationLayer),
        )
        const definition = materialization.definitions.find((tool) => tool.name === "attachment")
        if (!definition) return yield* Effect.die(new Error("canonical attachment tool is not registered"))

        return {
          description: definition.description,
          parameters: Schema.Unknown,
          jsonSchema: definition.inputSchema,
          execute: (input: unknown, toolCtx: Tool.Context) =>
            Effect.gen(function* () {
              // The V1 loop can reach this bridge while PluginInternal.boot is still
              // reloading the agent map. Wait for that batch before canonical settlement
              // so permission resolution never sees the uninitialized deny-all fallback.
              yield* internal.ready
              const settlement = yield* materialization
                .settle({
                  sessionID: SessionSchema.ID.make(toolCtx.sessionID),
                  agent: AgentV2.ID.make(toolCtx.agent),
                  assistantMessageID: SessionMessage.ID.make(toolCtx.messageID),
                  call: {
                    type: "tool-call",
                    id: toolCtx.callID ?? `attachment-${toolCtx.messageID}`,
                    name: definition.name,
                    input,
                  },
                })
                .pipe(Effect.orDie)
              if (settlement.result.type === "error") {
                const message =
                  typeof settlement.result.value === "string"
                    ? settlement.result.value
                    : (JSON.stringify(settlement.result.value) ?? String(settlement.result.value))
                return yield* Effect.die(new Error(message))
              }

              const output =
                settlement.result.type === "content"
                  ? settlement.result.value
                      .map((part) => (part.type === "text" ? part.text : `[attachment: ${part.name ?? part.mime}]`))
                      .join("\n")
                  : typeof settlement.result.value === "string"
                    ? settlement.result.value
                    : (JSON.stringify(settlement.result.value) ?? String(settlement.result.value))
              return {
                title: definition.name,
                metadata:
                  settlement.output &&
                  typeof settlement.output.structured === "object" &&
                  settlement.output.structured !== null &&
                  !Array.isArray(settlement.output.structured)
                    ? settlement.output.structured
                    : {},
                output,
              }
            }),
        }
      })
  }),
)

export const node = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})
