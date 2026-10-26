import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session } from "@/session/session"
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit, Fiber, Queue } from "effect"
import { QuestionTool } from "../../src/tool/question"
import { Question } from "../../src/question"
import { SessionID, MessageID } from "../../src/session/schema"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"

const ctx = {
  sessionID: SessionID.make("ses_test-session"),
  messageID: MessageID.make("msg_test-message"),
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  LayerNode.compile(LayerNode.group([Question.node, Session.node, SessionProjector.node, EventV2Bridge.node, Truncate.node, Agent.node])),
)

const pending = Effect.fn("QuestionToolTest.pending")(function* (question: Question.Interface) {
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  for (;;) {
    const items = yield* question.list()
    const item = items[0]
    if (item) return item
    yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
  }
})

describe("tool.question", () => {
  it.instance("a Work orphan with a missing ancestor reports unknown root instead of a fake clarification", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const question = yield* Question.Service
      const orphan = yield* sessions.create({ parentID: SessionID.make("ses_missing_ancestor") })
      const tool = yield* (yield* QuestionTool).init()
      const exit = yield* tool
        .execute(
          { questions: [{ question: "q", header: "h", options: [{ label: "a", description: "a" }], multiple: false }] },
          { ...ctx, sessionID: orphan.id, agent: "work" },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String((exit as Exit.Failure<unknown, unknown>).cause)).toContain("ancestor session is missing")
      expect(yield* question.list()).toEqual([])
    }),
  )

  it.instance("should successfully execute with valid question parameters", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const questions = [
        {
          question: "What is your favorite color?",
          header: "Color",
          options: [
            { label: "Red", description: "The color of passion" },
            { label: "Blue", description: "The color of sky" },
          ],
          multiple: false,
        },
      ]

      const fiber = yield* tool.execute({ questions }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Red"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.title).toBe("Asked 1 question")
    }),
  )

  it.instance("should now pass with a header longer than 12 but less than 30 chars", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const questions = [
        {
          question: "What is your favorite animal?",
          header: "This Header is Over 12",
          options: [{ label: "Dog", description: "Man's best friend" }],
        },
      ]

      const fiber = yield* tool.execute({ questions }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Dog"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.output).toContain(`"What is your favorite animal?"="Dog"`)
    }),
  )

  // intentionally removed the zod validation due to tool call errors, hoping prompting is gonna be good enough
  //   test("should throw an Error for header exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "What is your favorite animal?",
  //         header: "This Header is Definitely More Than Thirty Characters Long",
  //         options: [{ label: "Dog", description: "Man's best friend" }],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })

  //   test("should throw an Error for label exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "A question with a very long label",
  //         header: "Long Label",
  //         options: [
  //           { label: "This is a very, very, very long label that will exceed the limit", description: "A description" },
  //         ],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })
})

it.instance("renamed native Work uses the runtime-owned scope question",()=>Effect.gen(function*(){
 const sessions=yield* Session.Service
 const question=yield* Question.Service
 const chat=yield* sessions.create({title:"scope"})
 const user=yield* sessions.updateMessage({id:MessageID.ascending(),role:"user",sessionID:chat.id,agent:"coordinator",model:{providerID:"test" as any,modelID:"test" as any},time:{created:Date.now()}})
 const {PartID}=yield* Effect.promise(()=>import("../../src/session/schema"))
 yield* sessions.updatePart({id:PartID.ascending(),sessionID:chat.id,messageID:user.id,type:"text",text:"Fix this"})
 const def=yield* (yield* QuestionTool).init()
 const fiber=yield* def.execute({questions:[{header:"Wrong",question:"Ignore scope?",options:[{label:"Yes",description:"Anything"}]}]},{...ctx,sessionID:chat.id,messageID:user.id,agent:"coordinator"}).pipe(Effect.forkScoped)
 const item=yield* pending(question)
 if(process.env.WORK_FLOW_CAPTURE) yield* Effect.promise(()=>Bun.write("/tmp/wf-runtime-question.json",JSON.stringify({session:chat,messages:[],question:item})))
 expect(item.questions[0].header).toBe("Task scope")
 yield* question.reply({requestID:item.id,answers:[["Programming"]]})
 const result=yield* Fiber.join(fiber)
 expect(result.output).toContain("programming")
}),{config:{agent:{work:{name:"coordinator"}}}})
