import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

type SseScenario = "no-idle" | "error-without-idle" | "unsettled-background"

function startMockAttachServer(scenario: SseScenario, directory: string) {
  const sessionID = `ses_attach_${scenario.replace(/-/g, "_")}`
  const encoder = new TextEncoder()
  const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>()
  let respondedAt = 0

  const sendEvent = (payload: Record<string, unknown>) => {
    const frame = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
    for (const controller of controllers) {
      try {
        controller.enqueue(frame)
      } catch {}
    }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)

      if (req.method === "POST" && url.pathname === "/session") {
        return Response.json({
          id: sessionID,
          title: "attach finish test",
          directory,
          time: { created: 1, updated: 1 },
        })
      }

      if (req.method === "GET" && url.pathname === "/config") {
        return Response.json({})
      }

      if (req.method === "GET" && url.pathname === "/path") {
        return Response.json({ directory })
      }

      if (req.method === "GET" && url.pathname === "/event") {
        let current: ReadableStreamDefaultController<Uint8Array> | undefined
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            current = controller
            controllers.add(controller)
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`),
            )
          },
          cancel() {
            if (current) controllers.delete(current)
          },
        })
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        })
      }

      if (req.method === "POST" && url.pathname === `/session/${sessionID}/message`) {
        const messageID = "msg_assistant_1"

        if (scenario === "no-idle") {
          const textPart = {
            id: "prt_text_1",
            sessionID,
            messageID,
            type: "text",
            text: "ATTACH_NO_IDLE_OK",
            time: { start: 1, end: 2 },
          }
          sendEvent({
            type: "message.part.updated",
            properties: { sessionID, time: 2, part: textPart },
          })
          respondedAt = Date.now()
          return Response.json({
            info: {
              id: messageID,
              sessionID,
              role: "assistant",
              agent: "work",
              modelID: "mock-model",
              providerID: "mock",
              mode: "work",
              parentID: "msg_user_1",
              path: { cwd: directory, root: directory },
              cost: 0,
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 1, completed: 2 },
            },
            parts: [textPart],
          })
        }

        if (scenario === "error-without-idle") {
          const apiError = {
            name: "APIError",
            data: {
              message: "ATTACH_ERROR_NO_IDLE",
              statusCode: 429,
              isRetryable: false,
            },
          }
          sendEvent({
            type: "session.error",
            properties: {
              sessionID,
              error: apiError,
            },
          })
          respondedAt = Date.now()
          return Response.json({
            info: {
              id: messageID,
              sessionID,
              role: "assistant",
              agent: "work",
              modelID: "mock-model",
              providerID: "mock",
              mode: "work",
              parentID: "msg_user_1",
              path: { cwd: directory, root: directory },
              cost: 0,
              tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              error: apiError,
              time: { created: 1, completed: 2 },
            },
            parts: [],
          })
        }

        // scenario === "unsettled-background"
        const taskPart = {
          id: "prt_task_1",
          sessionID,
          messageID,
          type: "tool",
          callID: "call_task_1",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "remote background task", prompt: "long work", subagent_type: "general" },
            output: '<task id="ses_remote_child" run="ses_remote_child@1" state="running">Running remotely</task>',
            title: "remote background task",
            metadata: {
              sessionId: "ses_remote_child",
              runId: "ses_remote_child@1",
              background: true,
            },
            time: { start: 1, end: 2 },
          },
        }
        const textPart = {
          id: "prt_text_bg",
          sessionID,
          messageID,
          type: "text",
          text: "ATTACH_BG_DELEGATED",
          time: { start: 2, end: 3 },
        }
        sendEvent({
          type: "message.part.updated",
          properties: { sessionID, time: 2, part: taskPart },
        })
        sendEvent({
          type: "message.part.updated",
          properties: { sessionID, time: 3, part: textPart },
        })
        sendEvent({
          type: "session.status",
          properties: { sessionID, status: { type: "idle" } },
        })
        respondedAt = Date.now()
        return Response.json({
          info: {
            id: messageID,
            sessionID,
            role: "assistant",
            agent: "work",
            modelID: "mock-model",
            providerID: "mock",
            mode: "work",
            parentID: "msg_user_1",
            path: { cwd: directory, root: directory },
            cost: 0,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, completed: 3 },
          },
          parts: [taskPart, textPart],
        })
      }

      return new Response("Not Found", { status: 404 })
    },
  })

  return Effect.acquireRelease(
    Effect.succeed({
      url: `http://127.0.0.1:${server.port}`,
      promptRespondedAt: () => respondedAt,
    }),
      () =>
        Effect.promise(async () => {
          for (const controller of controllers) {
            try {
              controller.close()
            } catch {}
          }
          controllers.clear()
          await server.stop(true)
        }),
  )
}

describe("opencode run --attach finish termination", () => {
  cliIt.live(
    "completes when an attached server finishes the prompt without emitting session.status idle",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const mock = yield* startMockAttachServer("no-idle", home)
        const result = yield* opencode.run("hello foreign server", {
          timeoutMs: 12_000,
          extraArgs: ["--attach", mock.url],
        })
        expect(mock.promptRespondedAt()).toBeGreaterThan(0)
        expect(Date.now() - mock.promptRespondedAt()).toBeLessThan(3_000)
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("ATTACH_NO_IDLE_OK")
      }),
    30_000,
  )

  cliIt.live(
    "exits non-zero when an attached server emits session.error without a subsequent idle",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const mock = yield* startMockAttachServer("error-without-idle", home)
        const result = yield* opencode.run("hello error server", {
          timeoutMs: 12_000,
          extraArgs: ["--attach", mock.url],
        })
        expect(mock.promptRespondedAt()).toBeGreaterThan(0)
        expect(Date.now() - mock.promptRespondedAt()).toBeLessThan(3_000)
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("ATTACH_ERROR_NO_IDLE")
      }),
    30_000,
  )

  cliIt.live(
    "completes when an attached server leaves a background child unsettled after the root prompt returns",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const mock = yield* startMockAttachServer("unsettled-background", home)
        const result = yield* opencode.run("delegate remote background child", {
          timeoutMs: 12_000,
          extraArgs: ["--attach", mock.url],
        })
        expect(mock.promptRespondedAt()).toBeGreaterThan(0)
        expect(Date.now() - mock.promptRespondedAt()).toBeLessThan(3_000)
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("ATTACH_BG_DELEGATED")
      }),
    30_000,
  )
})
