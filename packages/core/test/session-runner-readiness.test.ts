import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { Database } from "@opencode-ai/core/database/database"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PluginInternal } from "@opencode-ai/core/plugin/internal"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { node } from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Config } from "@opencode-ai/core/config"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const projectDir = mkdtempSync(path.join(tmpdir(), "silvercode-runner-readiness-"))
const sessionID = SessionV2.ID.make("ses_runner_readiness")
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })

describe("SessionRunnerLLM readiness", () => {
  it.effect("awaits plugin readiness before streaming and settling canonical tools", () =>
    Effect.gen(function* () {
      const readyAwaited = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const streamStarted = yield* Deferred.make<void>()
      const toolStarted = yield* Deferred.make<void>()
      const executions: string[] = []
      let turns = 0
      const client = Layer.succeed(
        LLMClient.Service,
        LLMClient.Service.of({
          prepare: () => Effect.die("unused"),
          stream: (_request: LLMRequest) => {
            const events: LLMEvent[] =
              turns++ === 0
                ? [
                    LLMEvent.stepStart({ index: 0 }),
                    LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
                    LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
                    LLMEvent.finish({ reason: "tool-calls" }),
                  ]
                : [
                    LLMEvent.stepStart({ index: 0 }),
                    LLMEvent.textStart({ id: "text-final" }),
                    LLMEvent.textDelta({ id: "text-final", text: "Done" }),
                    LLMEvent.textEnd({ id: "text-final" }),
                    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                    LLMEvent.finish({ reason: "stop" }),
                  ]
            const stream = Stream.fromIterable(events)
            if (turns !== 1) return stream
            return Stream.unwrap(Deferred.succeed(streamStarted, undefined).pipe(Effect.as(stream)))
          },
          generate: () => Effect.die("unused"),
        }),
      )
      const pluginInternal = Layer.succeed(
        PluginInternal.Service,
        PluginInternal.Service.of({
          ready: Deferred.succeed(readyAwaited, undefined).pipe(Effect.andThen(Deferred.await(release))),
        }),
      )
      const permission = Layer.succeed(
        PermissionV2.Service,
        PermissionV2.Service.of({
          assert: () => Effect.die("unused"),
          ask: () => Effect.die("unused"),
          reply: () => Effect.die("unused"),
          get: () => Effect.die("unused"),
          forSession: () => Effect.die("unused"),
          list: () => Effect.die("unused"),
        }),
      )
      const echo = Layer.effectDiscard(
        ToolRegistry.Service.use((registry) =>
          registry.register({
            echo: Tool.make({
              description: "Echo text",
              input: Schema.Struct({ text: Schema.String }),
              output: Schema.Struct({ text: Schema.String }),
              toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
              execute: ({ text }) =>
                Deferred.succeed(toolStarted, undefined).pipe(
                  Effect.andThen(Effect.sync(() => executions.push(text))),
                  Effect.as({ text }),
                ),
            }),
          }),
        ),
      )
      const echoNode = makeLocationNode({
        name: "test/session-runner-readiness-tools",
        layer: echo,
        deps: [ToolRegistry.node],
      })
      const layer = AppNodeBuilder.build(LayerNode.group([Database.node, node, echoNode]), [
        [Snapshot.node, Snapshot.noopLayer],
        [LayerNodePlatform.llmClient, client],
        [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
        [SystemContextRegistry.node, AppNodeBuilder.build(SystemContextRegistry.node)],
        [Location.node, Location.boundNode({ directory: AbsolutePath.make(projectDir) })],
        [SkillGuidance.node, Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
        [
          ReferenceGuidance.node,
          Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) }),
        ],
        [PermissionV2.node, permission],
        [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
        [PluginInternal.node, pluginInternal],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ])

      yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make(projectDir), sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "readiness",
            directory: projectDir,
            title: "readiness",
            version: "test",
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)

        const runner = yield* SessionRunner.Service
        const fiber = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkScoped({ startImmediately: true }))
        // The first observable boundary must be the readiness wait, not the provider stream.
        yield* Effect.race(Deferred.await(readyAwaited), Deferred.await(streamStarted))
        expect(yield* Deferred.isDone(readyAwaited)).toBe(true)
        expect(yield* Deferred.isDone(streamStarted)).toBe(false)
        expect(yield* Deferred.isDone(toolStarted)).toBe(false)

        yield* Deferred.succeed(release, undefined)
        const exit = yield* Fiber.await(fiber)
        expect(exit._tag).toBe("Success")
        expect(yield* Deferred.isDone(toolStarted)).toBe(true)
        expect(executions).toEqual(["hello"])
      }).pipe(Effect.provide(layer))
    }),
  )
})
