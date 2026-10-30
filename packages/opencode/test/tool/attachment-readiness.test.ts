import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { AttachmentTool } from "@/tool/attachment"
import { Truncate } from "@/tool/truncate"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LocationServiceMap, buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

describe("attachment readiness", () => {
  it.instance("waits for plugin/agent initialization before canonical settlement", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      // Hold the config-agent discovery transform inside PluginInternal.boot's State.batch.
      // The location layer is already constructed, but the agent map has not reloaded.
      const gatedFileSystem = makeGlobalNode({
        service: FSUtil.Service,
        layer: Layer.effect(
          FSUtil.Service,
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            return FSUtil.Service.of({
              ...fs,
              glob: (pattern, options) =>
                Effect.gen(function* () {
                  if (pattern === "{agent,agents}/**/*.md") {
                    yield* Deferred.succeed(entered, undefined)
                    yield* Deferred.await(release)
                  }
                  return yield* fs.glob(pattern, options)
                }),
            })
          }),
        ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
        deps: [],
      })
      const layer = AppNodeBuilder.build(
        LayerNode.group([Agent.node, Truncate.node, LocationServiceMap.node, FSUtil.node]),
        [[LocationServiceMap.node, buildLocationServiceMap([[FSUtil.node, gatedFileSystem]])]],
      )

      yield* Effect.gen(function* () {
        const attachment = yield* AttachmentTool
        const definition = yield* attachment.init()
        yield* Deferred.await(entered)
        // Invalid input keeps this ordering probe side-effect free; it must still wait
        // for readiness before reaching canonical settlement/validation.
        const settled = yield* Deferred.make<void>()
        const fiber = yield* definition
          .execute(
            { action: "save" },
            {
              sessionID: SessionID.descending(),
              messageID: MessageID.ascending(),
              agent: "work",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(
            Effect.onExit(() => Deferred.succeed(settled, undefined)),
            Effect.forkScoped({ startImmediately: true }),
          )
        expect(yield* Deferred.isDone(settled)).toBe(false)
        yield* Deferred.succeed(release, undefined)
        const exit = yield* Fiber.await(fiber)
        expect(exit._tag).toBe("Failure")
      }).pipe(Effect.provide(layer))
    }),
  )
})
