import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

import { Session as SessionNs } from "@/session/session"
import { SessionReminders, rootSession, walkToRoot } from "../../src/session/reminders"
import { PlanExitTool } from "../../src/tool/plan"
import * as Tool from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { Question } from "../../src/question"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { MessageID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { InstanceState } from "@/effect/instance-state"
import fsp from "fs/promises"
import nodePath from "path"

import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const harness = (flags: Partial<RuntimeFlags.Info>) =>
  testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        SessionNs.node,
        EventV2Bridge.node,
        SessionProjector.node,
        CrossSpawnSpawner.node,
        InstanceStore.node,
        FSUtil.node,
        RuntimeFlags.node,
      ]),
      [
        [RuntimeFlags.node, RuntimeFlags.layer(flags)],
        [
          InstanceBootstrap.node,
          Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
        ],
      ],
    ),
  )

const it = harness({ experimentalPlanMode: true })
const itOff = harness({ experimentalPlanMode: false })

const user = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const sessions = yield* SessionNs.Service
    const message = {
      info: {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        agent: "think",
        model: { providerID: "mock", modelID: "mock" },
        time: { created: Date.now() },
      },
      parts: [],
    } as unknown as SessionV1.WithParts
    yield* sessions.updateMessage(message.info as SessionV1.User)
    return message
  })

const think = { name: "think" } as Agent.Info
const work = { name: "work" } as Agent.Info

const texts = (messages: SessionV1.WithParts[]) =>
  messages.flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => (p as SessionV1.TextPart).text))

describe("rootSession", () => {
  it.instance("resolves the session itself when it has no parent", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const root = yield* sessions.create({})
      const resolved = yield* rootSession(root)
      expect(Option.isSome(resolved)).toBe(true)
      if (Option.isSome(resolved)) expect(resolved.value.id).toBe(root.id)
    }),
  )

  it.instance("walks the delegation chain to the true root", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const root = yield* sessions.create({})
      const mid = yield* sessions.create({ parentID: root.id })
      const child = yield* sessions.create({ parentID: mid.id })
      const resolved = yield* rootSession(child)
      expect(Option.isSome(resolved)).toBe(true)
      if (Option.isSome(resolved)) expect(resolved.value.id).toBe(root.id)
    }),
  )

  it.instance("resolves to none when an ancestor is missing instead of inventing an intermediate root", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const phantom = SessionID.make("ses_missing_ancestor")
      const child = yield* sessions.create({ parentID: phantom })
      const resolved = yield* rootSession(child)
      expect(Option.isNone(resolved)).toBe(true)
    }),
  )
})

describe("SessionReminders.apply plan-mode", () => {
  it.instance("resolves to none on a parent cycle instead of looping", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const a = yield* sessions.create({})
      const b = yield* sessions.create({})
      const looped = { ...a, parentID: b.id } as typeof a
      const sessionsView = {
        get: (id: typeof a.id) => Effect.succeed(id === b.id ? ({ ...b, parentID: a.id } as typeof b) : looped),
      } as unknown as SessionNs.Interface
      const resolved = yield* walkToRoot(sessionsView, looped)
      expect(Option.isNone(resolved)).toBe(true)
    }),
  )

  it.instance("names the root session plan file for a delegated think", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const root = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: root.id })
      const result = yield* SessionReminders.apply({ messages: [yield* user(child.id)], agent: think, session: child })
      const body = texts(result).join("\n")
      expect(body).toContain(root.slug)
      expect(body).not.toContain(child.slug)
    }),
  )

  it.instance("fails soft with no plan path when the ancestry is broken", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const child = yield* sessions.create({ parentID: SessionID.make("ses_missing_ancestor") })
      const result = yield* SessionReminders.apply({ messages: [yield* user(child.id)], agent: think, session: child })
      const body = texts(result).join("\n")
      expect(body).toContain("could not be resolved")
      expect(body).not.toContain(child.slug)
    }),
  )

  it.instance("emits a bare work-switch reminder without a plan path when the ancestry is broken", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const child = yield* sessions.create({ parentID: SessionID.make("ses_missing_ancestor") })
      const assistant = {
        info: {
          id: MessageID.ascending(),
          sessionID: child.id,
          role: "assistant",
          agent: "think",
          time: { created: Date.now() },
        },
        parts: [],
      } as unknown as SessionV1.WithParts
      const result = yield* SessionReminders.apply({
        messages: [assistant, yield* user(child.id)],
        agent: work,
        session: child,
      })
      const body = texts(result).join("\n")
      expect(body).not.toContain("plan file exists at")
      expect(body).not.toContain(child.slug)
    }),
  )
})

describe("living plan handoff for programming sessions", () => {
  // A runtime-stamped task delivery: only terminal-success foreground children
  // of this session in the current real request count as planning evidence.
  const taskResult = (
    sessionID: SessionID,
    requestID: string,
    subagent: string,
    overrides: { terminal?: string; background?: boolean } = {},
  ) =>
    ({
      info: { id: MessageID.ascending(), sessionID, role: "assistant", agent: "work", time: { created: Date.now() } },
      parts: [
        {
          type: "tool",
          tool: "task",
          callID: "call_1",
          state: {
            status: "completed",
            input: { subagent_type: subagent },
            output: "plan",
            title: "",
            metadata: {
              background: overrides.background ?? false,
              workFlow: { requestID, parentID: sessionID, agent: subagent, terminal: overrides.terminal ?? "success" },
            },
            time: { start: 0, end: 1 },
          },
        },
      ],
    }) as unknown as SessionV1.WithParts

  const assistantBy = (sessionID: SessionID, agent: string) =>
    ({
      info: { id: MessageID.ascending(), sessionID, role: "assistant", agent, time: { created: Date.now() } },
      parts: [],
    }) as unknown as SessionV1.WithParts

  const run = (
    messages: SessionV1.WithParts[],
    agent: Agent.Info,
    session: SessionNs.Info,
  ) => SessionReminders.apply({ messages, agent, session }).pipe(Effect.map(texts), Effect.map((t) => t.join("\n")))

  itOff.instance("tells Work to create the plan file after a delegated think when none exists", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const root = yield* sessions.create({})
      const request = yield* user(root.id)
      const body = yield* run([request, taskResult(root.id, request.info.id, "think")], work, root)
      expect(body).toContain(root.slug)
      expect(body).toContain("have the first Code step create it")
      expect(body).toContain("yourself if you hold a file-editing tool (edit, write or apply_patch)")
    }),
  )

  it.instance("experimental plan mode: Work gets the same handoff after a delegated think", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const root = yield* sessions.create({})
      const request = yield* user(root.id)
      const body = yield* run([request, taskResult(root.id, request.info.id, "think")], work, root)
      expect(body).toContain(root.slug)
      expect(body).toContain("have the first Code step create it")
    }),
  )

  itOff.instance("stays silent for Work when no think was delegated and no plan file exists", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const root = yield* sessions.create({})
      const request = yield* user(root.id)
      expect(yield* run([request, taskResult(root.id, request.info.id, "code")], work, root)).not.toContain(root.slug)
    }),
  )

  for (const [label, overrides] of [
    ["failed", { terminal: "failure" }],
    ["cancelled", { terminal: "cancelled" }],
    ["background", { background: true }],
  ] as const)
    itOff.instance(`a ${label} delegated think is not planning evidence`, () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const root = yield* sessions.create({})
        const request = yield* user(root.id)
        expect(yield* run([request, taskResult(root.id, request.info.id, "think", overrides)], work, root)).not.toContain(
          root.slug,
        )
      }),
    )

  itOff.instance("a think delegated for an earlier request does not leak into the next request", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const root = yield* sessions.create({})
      const first = yield* user(root.id)
      const second = yield* user(root.id)
      const body = yield* run([first, taskResult(root.id, first.info.id, "think"), second], work, root)
      expect(body).not.toContain(root.slug)
    }),
  )

  itOff.instance("a primary think to work switch with no plan file hands creation to Work", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const root = yield* sessions.create({})
      const body = yield* run([assistantBy(root.id, "think"), yield* user(root.id)], work, root)
      expect(body).toContain(root.slug)
      expect(body).toContain("does not exist yet")
      expect(body).toContain("have the first Code step create it")
    }),
  )

  it.instance("experimental: a primary think to work switch in a request that also delegated think keeps the switch reminder", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const root = yield* sessions.create({})
      const request = yield* user(root.id)
      const body = yield* run(
        [request, taskResult(root.id, request.info.id, "think"), assistantBy(root.id, "think")],
        work,
        root,
      )
      expect(body).toContain("operational mode has changed from plan to work")
      expect(body).toContain("does not exist yet")
      expect(body).toContain(root.slug)
    }),
  )

  const writePlan = (root: SessionNs.Info) =>
    Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      const file = SessionNs.plan(root, ctx)
      yield* Effect.promise(async () => {
        await fsp.mkdir(nodePath.dirname(file), { recursive: true })
        await fsp.writeFile(file, "- [ ] step one\n")
      })
      return file
    })

  for (const [label, harnessIt] of [
    ["default", itOff],
    ["experimental", it],
  ] as const)
    harnessIt.instance(`${label}: an existing plan file gets the scratchpad guidance without a planning stamp`, () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const root = yield* sessions.create({})
        const file = yield* writePlan(root)
        const request = yield* user(root.id)
        // A non-programming delegated Think may write the file while the task
        // result carries no workflow stamp; the file itself is the evidence.
        const body = yield* run([request, assistantBy(root.id, "work")], work, root)
        expect(body).toContain(`A plan file exists at ${file}`)
        expect(body).not.toContain("does not exist yet")
      }),
    )

  it.instance("experimental: a primary switch persists only the marker; step 2 after the file is created has no stale handoff", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const root = yield* sessions.create({})
      const request = yield* user(root.id)
      // Step 1: Think was the last assistant, no plan file yet.
      const step1 = yield* run([request, assistantBy(root.id, "think")], work, root)
      expect(step1).toContain("operational mode has changed from plan to work")
      expect(step1).toContain("does not exist yet")
      // A Code step creates the file; Step 2 reloads the persisted user message.
      const file = yield* writePlan(root)
      const reloaded = (yield* sessions.messages({ sessionID: root.id })).filter((m) => m.info.role === "user")
      expect(reloaded.length).toBe(1)
      const persisted = texts(reloaded).join("\n")
      // Only the base-behavior marker is persisted, not the live file guidance.
      expect(persisted).toContain("operational mode has changed from plan to work")
      expect(persisted).not.toContain("does not exist yet")
      const step2 = yield* run([...reloaded, assistantBy(root.id, "work")], work, root)
      expect(step2).toContain(`A plan file exists at ${file}`)
      expect(step2).not.toContain("does not exist yet")
      expect(step2.match(/operational mode has changed from plan to work/g)?.length).toBe(1)
      expect(step2.match(/A plan file exists at/g)?.length).toBe(1)
    }),
  )
})
