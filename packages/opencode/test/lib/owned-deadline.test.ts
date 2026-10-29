import { test, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { inflightOwnedRunCount, ownedDeadlineTest, runOwned, runWithOwnedDeadline, validateOwnedDeadline } from "./owned-deadline"
const budget = { deadlineMs: 25, hostTimeoutMs: 1000, cleanupHeadroomMs: 100 }
let flag = "original"
const events: string[] = []
const callback = ownedDeadlineTest(() => Effect.acquireUseRelease(
  Effect.sync(() => {flag="active";events.push("acquired")}),
  () => Effect.never,
  () => Effect.promise(async () => {
    events.push("finalizer-start")
    await new Promise(resolve => setTimeout(resolve, 30))
    flag="original";events.push("finalizer-end")
  }),
), budget)
test("owner deadline interrupts and joins asynchronous finalizer before callback settles", async () => {
  try {await callback();throw new Error("expected interruption")}
  catch (error) {expect(String(error)).toContain("interrupted")}
  events.push("settled")
  expect(flag).toBe("original")
  expect(events).toEqual(["acquired","finalizer-start","finalizer-end","settled"])
}, budget.hostTimeoutMs)
test("next test observes restoration", () => expect(flag).toBe("original"))
test("wall deadline interrupts TestClock sleep without advancing it", async () => {
  const result = await runWithOwnedDeadline(Effect.sleep("1 hour").pipe(Effect.provide(TestClock.layer())),budget)
  expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true)
},budget.hostTimeoutMs)
test("fast success and failure retain their values and clear timer", async () => {
  const originalSet=globalThis.setTimeout
  const originalClear=globalThis.clearTimeout
  const timers: ReturnType<typeof setTimeout>[]=[]
  const cleared: ReturnType<typeof setTimeout>[]=[]
  globalThis.setTimeout=((...args:any[])=>{const timer=Reflect.apply(originalSet,globalThis,args);timers.push(timer);return timer}) as typeof setTimeout
  globalThis.clearTimeout=((timer:any)=>{cleared.push(timer);return originalClear(timer)}) as typeof clearTimeout
  try {
    expect(await ownedDeadlineTest(()=>Effect.succeed("ok"),budget)()).toBe("ok")
    const sentinel=new Error("same failure")
    try {await ownedDeadlineTest(()=>Effect.fail(sentinel),budget)();throw new Error("expected failure")}
    catch(error){expect(error).toBe(sentinel)}
    expect(timers).toHaveLength(2)
    expect(cleared).toEqual(timers)
  } finally {globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear}
})
test("invalid or insufficient explicit budgets are rejected before execution", () => {
  for(const value of [0,-1,NaN,Infinity])for(const key of ["deadlineMs","hostTimeoutMs","cleanupHeadroomMs"]){
    expect(()=>validateOwnedDeadline({...budget,[key]:value})).toThrow()
  }
  expect(()=>validateOwnedDeadline({...budget,hostTimeoutMs:100})).toThrow("headroom")
})
test("slow finalizer may exceed deadline but is still joined",async()=>{
 const start=performance.now()
 const exit=await runWithOwnedDeadline(Effect.acquireUseRelease(Effect.void,()=>Effect.never,
  ()=>Effect.promise(()=>new Promise(r=>setTimeout(r,100)))),{deadlineMs:10,hostTimeoutMs:1000,cleanupHeadroomMs:200})
 expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
 expect(performance.now()-start).toBeGreaterThan(100)
},1000)
test("interrupting a signal-less promise does not stop its underlying work",async()=>{
 let lateWrite=false
 const exit=await runWithOwnedDeadline(Effect.promise(()=>new Promise<void>(resolve=>setTimeout(()=>{
  lateWrite=true;resolve()
 },90))),{deadlineMs:10,hostTimeoutMs:1000,cleanupHeadroomMs:100})
 expect(Exit.isFailure(exit)&&Cause.hasInterruptsOnly(exit.cause)).toBe(true)
 expect(lateWrite).toBe(false)
 await new Promise(resolve=>setTimeout(resolve,120))
 expect(lateWrite).toBe(true)
},1000)

test("wrapper snapshots explicit budget before caller mutation",async()=>{
 const mutable={deadlineMs:10,hostTimeoutMs:1000,cleanupHeadroomMs:100}
 const callback=ownedDeadlineTest(()=>Effect.never,mutable)
 mutable.deadlineMs=Infinity;mutable.hostTimeoutMs=0;mutable.cleanupHeadroomMs=-1
 await expect(callback()).rejects.toThrow("interrupted")
},1000)

test("runOwned preserves Cause.squash rethrow and clears keyed run entries on settlement",async()=>{
 expect(await runOwned(Effect.succeed(42))).toBe(42)
 expect(inflightOwnedRunCount()).toBe(0)
 const sentinel=new Error("exact cause squash failure")
 try{await runOwned(Effect.fail(sentinel));throw new Error("expected failure")}
 catch(error){expect(error).toBe(sentinel)}
 expect(inflightOwnedRunCount()).toBe(0)
 for(const eff of [Effect.fail(undefined),Effect.die(undefined)]){
  let caught=false
  let value:unknown="not-undefined"
  try{await runOwned(eff)}
  catch(error){caught=true;value=error}
  expect(caught).toBe(true)
  expect(value).toBeUndefined()
  expect(inflightOwnedRunCount()).toBe(0)
 }
 try{await runOwned(Effect.never,{deadlineMs:15,hostTimeoutMs:1000,cleanupHeadroomMs:100});throw new Error("expected interruption")}
 catch(error){expect(String(error)).toContain("interrupted")}
 expect(inflightOwnedRunCount()).toBe(0)
 let started=false
 expect(()=>runOwned(Effect.sync(()=>{started=true}),{deadlineMs:0,hostTimeoutMs:1000,cleanupHeadroomMs:100})).toThrow()
 expect(started).toBe(false)
 expect(inflightOwnedRunCount()).toBe(0)
},1000)
