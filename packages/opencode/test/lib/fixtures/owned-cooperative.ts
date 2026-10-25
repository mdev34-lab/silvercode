import { test, expect } from "bun:test"
import { Effect, Layer, Context } from "effect"
import { testEffectOwned } from "../effect"
class Resource extends Context.Service<Resource,{value:string}>()("OwnedTestResource") {}
const events:string[]=[]
let flag="original"
const layer=Layer.effect(Resource,Effect.acquireRelease(
 Effect.sync(()=>{flag="active";events.push("acquired");return {value:"ok"}}),
 ()=>Effect.promise(async()=>{events.push("release-start");await new Promise(r=>setTimeout(r,30));flag="original";events.push("release-end")}),
))
const mutableBudget={deadlineMs:25,hostTimeoutMs:1000,cleanupHeadroomMs:100}
const it=testEffectOwned(layer,mutableBudget)
mutableBudget.deadlineMs=Infinity;mutableBudget.hostTimeoutMs=0;mutableBudget.cleanupHeadroomMs=-1
it.live("cooperative body times out after layer acquisition",()=>Effect.gen(function*(){yield* Resource;yield* Effect.never}))
test("next Bun test sees provided layer finalized",()=>{
 expect(flag).toBe("original")
 expect(events).toEqual(["acquired","release-start","release-end"])
})
