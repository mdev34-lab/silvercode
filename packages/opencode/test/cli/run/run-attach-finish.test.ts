import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

type SseScenario =
  | "no-idle"
  | "error-without-idle"
  | "unsettled-background"
  | "late-frames-after-response"
  | "late-multiline-finish-dedupe"
  | "late-error-after-response"
  | "unanswered-permission-lookup"
  | "unanswered-permission-reply"

const longMultilineAnswer = [
  "ATTACH_LONG_ANSWER_START",
  Array.from({ length: 80 }, (_, index) => `Paragraph line ${index}: verified attach detail ${index}.`).join("\n"),
  "ATTACH_LONG_ANSWER_END",
].join("\n\n")

function startMockAttachServer(scenario: SseScenario, directory: string) {
  const sessionID = `ses_attach_${scenario.replace(/-/g, "_")}`
  const encoder = new TextEncoder()
  const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const pendingAborts = new Set<() => void>()
  let respondedAt = 0
  let permissionLookupCalls = 0
  let permissionReplyCalls = 0
  let resolvePermissionEntered: (() => void) | undefined
  const permissionEntered = new Promise<void>((resolve) => {
    resolvePermissionEntered = resolve
  })

  const sendEvent = (payload: Record<string, unknown>) => {
    const frame = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
    for (const controller of controllers) {
      try {
        controller.enqueue(frame)
      } catch {}
    }
  }

  const scheduleAfterResponse = (delayMs: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, delayMs)
    timer.unref?.()
    timers.add(timer)
  }

  const hangUntilClientAborts = (req: Request) =>
    new Promise<Response>((resolve) => {
      const finish = () => {
        pendingAborts.delete(finish)
        resolve(new Response(null, { status: 499 }))
      }
      if (req.signal.aborted) {
        finish()
        return
      }
      pendingAborts.add(finish)
      req.signal.addEventListener("abort", finish, { once: true })
    })

  const assistantInfo = (messageID: string, completed: number, error?: Record<string, unknown>) => ({
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
    ...(error ? { error } : {}),
    time: { created: 1, completed },
  })

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

      if (req.method === "GET" && url.pathname === "/session/ses_unowned_perm") {
        permissionLookupCalls += 1
        resolvePermissionEntered?.()
        return hangUntilClientAborts(req)
      }

      if (req.method === "POST" && url.pathname === "/permission/per_hang_1/reply") {
        permissionReplyCalls += 1
        resolvePermissionEntered?.()
        return hangUntilClientAborts(req)
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
            info: assistantInfo(messageID, 2),
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
            info: assistantInfo(messageID, 2, apiError),
            parts: [],
          })
        }

        if (scenario === "late-frames-after-response") {
          const stepStart = {
            id: "prt_step_start_late",
            sessionID,
            messageID,
            type: "step-start",
          }
          const streamedEarlyText = {
            id: "prt_text_early",
            sessionID,
            messageID,
            type: "text",
            text: "ATTACH_STREAMED_EARLY",
            time: { start: 1, end: 2 },
          }
          const lateReasoning = {
            id: "prt_reason_late",
            sessionID,
            messageID,
            type: "reasoning",
            text: "ATTACH_LATE_REASONING",
            time: { start: 2, end: 3 },
          }
          const lateTool = {
            id: "prt_tool_late",
            sessionID,
            messageID,
            type: "tool",
            callID: "call_late_1",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "echo late", description: "Run late command" },
              output: "ATTACH_LATE_TOOL_OUT",
              title: "Run late command",
              metadata: {},
              time: { start: 3, end: 4 },
            },
          }
          const lateText = {
            id: "prt_text_late",
            sessionID,
            messageID,
            type: "text",
            text: "ATTACH_LATE_TEXT_OK",
            time: { start: 4, end: 5 },
          }
          const stepFinish = {
            id: "prt_step_finish_late",
            sessionID,
            messageID,
            type: "step-finish",
            reason: "stop",
            cost: 0,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          }

          // Stream one part before the response, and delay all remaining SSE frames
          // well past 300ms AFTER the HTTP response returns to prove late output
          // is preserved without duplicating already-streamed parts.
          sendEvent({
            type: "message.part.updated",
            properties: { sessionID, time: 2, part: streamedEarlyText },
          })
          scheduleAfterResponse(600, () => {
            for (const part of [stepStart, lateReasoning, lateTool, lateText, stepFinish]) {
              sendEvent({
                type: "message.part.updated",
                properties: { sessionID, time: 5, part },
              })
            }
          })
          respondedAt = Date.now()
          return Response.json({
            info: assistantInfo(messageID, 5),
            parts: [stepStart, streamedEarlyText, lateReasoning, lateTool, lateText, stepFinish],
          })
        }

        if (scenario === "late-multiline-finish-dedupe") {
          const lateIntro = {
            id: "prt_text_intro_late",
            sessionID,
            messageID,
            type: "text",
            text: "ATTACH_LATE_INTRO",
            time: { start: 1, end: 2 },
          }
          const streamedLongAnswer = {
            id: "prt_text_long_streamed",
            sessionID,
            messageID,
            type: "text",
            text: longMultilineAnswer,
            time: { start: 2, end: 3 },
          }
          const finishOutput = `${longMultilineAnswer}\n\nATTACH_FINISH_NEW_DETAIL\n\n[effort medium | review skipped]`
          const lateFinish = {
            id: "prt_tool_finish_late",
            sessionID,
            messageID,
            type: "tool",
            callID: "call_finish_late_1",
            tool: "finish",
            state: {
              status: "completed",
              input: { reason: "success", result: `${longMultilineAnswer}\n\nATTACH_FINISH_NEW_DETAIL` },
              output: finishOutput,
              title: "Task completed",
              metadata: {},
              time: { start: 3, end: 4 },
            },
          }

          // Stream the >2000-char multiline answer before the HTTP response while
          // holding back both the earlier intro text and the trailing `finish` tool
          // part, pinning causal `lastText` alignment during `replayResponse` so
          // neither text part double-prints and `finish` still deduplicates the
          // repeated >2000-char multiline answer while keeping `ATTACH_FINISH_NEW_DETAIL`.
          sendEvent({
            type: "message.part.updated",
            properties: { sessionID, time: 3, part: streamedLongAnswer },
          })
          scheduleAfterResponse(600, () => {
            for (const part of [lateIntro, lateFinish]) {
              sendEvent({
                type: "message.part.updated",
                properties: { sessionID, time: 4, part },
              })
            }
          })
          respondedAt = Date.now()
          return Response.json({
            info: assistantInfo(messageID, 4),
            parts: [lateIntro, streamedLongAnswer, lateFinish],
          })
        }

        if (scenario === "late-error-after-response") {
          const partialText = {
            id: "prt_text_before_err",
            sessionID,
            messageID,
            type: "text",
            text: "ATTACH_PARTIAL_BEFORE_ERROR",
            time: { start: 1, end: 2 },
          }
          const apiError = {
            name: "APIError",
            data: {
              message: "ATTACH_LATE_ERROR_AFTER_RESPONSE",
              statusCode: 429,
              isRetryable: false,
            },
          }
          scheduleAfterResponse(600, () => {
            sendEvent({
              type: "message.part.updated",
              properties: { sessionID, time: 2, part: partialText },
            })
            sendEvent({
              type: "session.error",
              properties: { sessionID, error: apiError },
            })
          })
          respondedAt = Date.now()
          return Response.json({
            info: assistantInfo(messageID, 2, apiError),
            parts: [partialText],
          })
        }

        if (scenario === "unanswered-permission-lookup" || scenario === "unanswered-permission-reply") {
          const textPart = {
            id: "prt_text_perm",
            sessionID,
            messageID,
            type: "text",
            text: "ATTACH_PERM_TEARDOWN_OK",
            time: { start: 1, end: 2 },
          }
          sendEvent({
            type: "permission.asked",
            properties: {
              id: "per_hang_1",
              sessionID: scenario === "unanswered-permission-lookup" ? "ses_unowned_perm" : sessionID,
              permission: "bash",
              patterns: ["echo hi"],
              metadata: {},
              always: [],
            },
          })
          // Wait until loop() has causally entered the unanswered HTTP request
          // (client.session.get or client.permission.reply) before completing the prompt RPC.
          await permissionEntered
          respondedAt = Date.now()
          return Response.json({
            info: assistantInfo(messageID, 2),
            parts: [textPart],
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
          info: assistantInfo(messageID, 3),
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
      permissionLookupCalls: () => permissionLookupCalls,
      permissionReplyCalls: () => permissionReplyCalls,
    }),
    () =>
      Effect.promise(async () => {
        for (const timer of timers) clearTimeout(timer)
        timers.clear()
        for (const finish of pendingAborts) finish()
        pendingAborts.clear()
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
        expect(Date.now() - mock.promptRespondedAt()).toBeLessThan(1_500)
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
        expect(Date.now() - mock.promptRespondedAt()).toBeLessThan(1_500)
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
        expect(Date.now() - mock.promptRespondedAt()).toBeLessThan(1_500)
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("ATTACH_BG_DELEGATED")
      }),
    30_000,
  )

  cliIt.live(
    "preserves late reasoning, tool, step, and text output without duplication when SSE frames arrive after the response",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const mock = yield* startMockAttachServer("late-frames-after-response", home)
        const result = yield* opencode.run("late sse output", {
          timeoutMs: 12_000,
          format: "json",
          extraArgs: ["--attach", mock.url, "--thinking"],
        })
        expect(mock.promptRespondedAt()).toBeGreaterThan(0)
        expect(Date.now() - mock.promptRespondedAt()).toBeLessThan(1_500)
        opencode.expectExit(result, 0)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.filter((e) => e.type === "step_start")).toHaveLength(1)
        expect(events.filter((e) => e.type === "step_finish")).toHaveLength(1)
        expect(events.filter((e) => e.type === "reasoning")).toHaveLength(1)
        expect(events.filter((e) => e.type === "tool_use")).toHaveLength(1)
        const texts = events
          .filter((e) => e.type === "text")
          .map((e) => {
            const part = e.part
            return part && typeof part === "object" && "text" in part && typeof part.text === "string"
              ? part.text
              : undefined
          })
        expect(texts).toEqual(["ATTACH_STREAMED_EARLY", "ATTACH_LATE_TEXT_OK"])
      }),
    30_000,
  )

  cliIt.live(
    "deduplicates a late multiline finish result longer than 2000 characters without double-printing or suppressing late text",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        expect(longMultilineAnswer.length).toBeGreaterThan(2_000)
        const mock = yield* startMockAttachServer("late-multiline-finish-dedupe", home)
        const result = yield* opencode.run("late multiline finish dedupe", {
          timeoutMs: 12_000,
          extraArgs: ["--attach", mock.url],
        })
        expect(mock.promptRespondedAt()).toBeGreaterThan(0)
        expect(Date.now() - mock.promptRespondedAt()).toBeLessThan(1_500)
        opencode.expectExit(result, 0)
        expect(result.stdout.split("ATTACH_LONG_ANSWER_START")).toHaveLength(2)
        expect(result.stdout.split("ATTACH_LATE_INTRO")).toHaveLength(2)
        expect(result.stderr).toContain("Task completed")
        expect(result.stderr).toContain("ATTACH_FINISH_NEW_DETAIL")
        expect(result.stderr).toContain("[effort medium | review skipped]")
        expect(result.stderr).not.toContain("ATTACH_LONG_ANSWER_START")
        expect(result.stderr).not.toContain("ATTACH_LONG_ANSWER_END")
      }),
    30_000,
  )

  cliIt.live(
    "preserves partial output and exits non-zero when session.error SSE frame arrives after the response",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const mock = yield* startMockAttachServer("late-error-after-response", home)
        const result = yield* opencode.run("late sse error", {
          timeoutMs: 12_000,
          extraArgs: ["--attach", mock.url],
        })
        expect(mock.promptRespondedAt()).toBeGreaterThan(0)
        expect(Date.now() - mock.promptRespondedAt()).toBeLessThan(1_500)
        expect(result.exitCode).toBe(1)
        expect(result.stdout).toContain("ATTACH_PARTIAL_BEFORE_ERROR")
        expect(result.stderr).toContain("ATTACH_LATE_ERROR_AFTER_RESPONSE")
      }),
    30_000,
  )

  cliIt.live(
    "cancels an unanswered permission session lookup and reply on teardown instead of hanging",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const lookupMock = yield* startMockAttachServer("unanswered-permission-lookup", home)
        const lookupResult = yield* opencode.run("hang in permission lookup", {
          timeoutMs: 6_000,
          extraArgs: ["--attach", lookupMock.url],
        })
        expect(lookupMock.permissionLookupCalls()).toBe(1)
        expect(lookupMock.promptRespondedAt()).toBeGreaterThan(0)
        expect(Date.now() - lookupMock.promptRespondedAt()).toBeLessThan(1_500)
        opencode.expectExit(lookupResult, 0)
        expect(lookupResult.stdout).toContain("ATTACH_PERM_TEARDOWN_OK")

        const replyMock = yield* startMockAttachServer("unanswered-permission-reply", home)
        const replyResult = yield* opencode.run("hang in permission reply", {
          timeoutMs: 6_000,
          extraArgs: ["--attach", replyMock.url, "--dangerously-skip-permissions"],
        })
        expect(replyMock.permissionReplyCalls()).toBe(1)
        expect(replyMock.promptRespondedAt()).toBeGreaterThan(0)
        expect(Date.now() - replyMock.promptRespondedAt()).toBeLessThan(1_500)
        opencode.expectExit(replyResult, 0)
        expect(replyResult.stdout).toContain("ATTACH_PERM_TEARDOWN_OK")
      }),
    30_000,
  )
})
