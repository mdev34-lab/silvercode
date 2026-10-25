import { test, expect } from "bun:test"
import { Effect, Layer, Context } from "effect"
import { testEffectOwned } from "../effect"
class Resource extends Context.Service<Resource,{}>()("OwnedAcquisitionResource") {}
let finalized=false
const layer=Layer.effect(Resource,Effect.acquireRelease(Effect.void,()=>Effect.sync(()=>{finalized=true})).pipe(Effect.andThen(Effect.never)))
const mutableBudget={deadlineMs:25,hostTimeoutMs:1000,cleanupHeadroomMs:100}
const it=testEffectOwned(layer,mutableBudget)
mutableBudget.deadlineMs=Infinity;mutableBudget.hostTimeoutMs=0;mutableBudget.cleanupHeadroomMs=-1
it.live("deadline covers hanging layer acquisition",()=>Effect.void)
test("next Bun test sees acquisition scope finalized",()=>expect(finalized).toBe(true))
