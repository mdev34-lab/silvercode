import { Session } from "@/session/session"
import { WorkFlow } from "@opencode-ai/core/work-flow"
import { Agent } from "@/agent/agent"
import { route as workRoute, clarify as clarifyWorkRoute } from "@/session/work-flow"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
}

export const QuestionTool = Tool.define<
  typeof Parameters,
  Metadata,
  Question.Service | Agent.Service | Session.Service
>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const work = yield* agents.get("work")
          const isWork = WorkFlow.ownsRole(yield* agents.list(), work, ctx.agent)
          const admission = isWork
            ? yield* workRoute(ctx.sessionID).pipe(Effect.provideService(Session.Service, sessions))
            : undefined
          if (isWork && admission?.kind === "uncertain") {
            const clarified = yield* clarifyWorkRoute(ctx.sessionID).pipe(
              Effect.provideService(Session.Service, sessions),
              Effect.provideService(Question.Service, question),
            )
            return {
              title: "Task scope clarified",
              output: `Task route: ${clarified.kind}. Follow the runtime workflow for this request.`,
              metadata: { answers: [[clarified.kind]] },
            }
          }
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const formatted = params.questions
            .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
            .join(", ")

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: {
              answers,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
