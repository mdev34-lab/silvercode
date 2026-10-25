import { test, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { refreshDiagnostic, safeRefreshFailure } from "../../src/skill/refresh-diagnostic"
test("safe refresh failure classifier never copies arbitrary cause contents",()=>{
 for(const code of ["EBUSY","EPERM","EACCES","ENOENT","EEXIST","ENOTEMPTY","EXDEV","EIO","ETIMEDOUT"]){
  expect(safeRefreshFailure(Object.assign(new Error("SECRET"),{code}))).toBe(code)
 }
 const cycle:any={};cycle.cause=cycle
 for(const value of ["SECRET",{code:"SECRET",message:"URL_AUTH_SECRET"},cycle,new Proxy({},{getOwnPropertyDescriptor(){throw new Error("SECRET")}})])expect(safeRefreshFailure(value)).toBe("unknown")
 let reads=0
 expect(safeRefreshFailure(Object.defineProperty({},"cause",{get(){reads++;return {code:"EBUSY"}}}))).toBe("unknown")
 expect(reads).toBe(0)
})
test("diagnostics are opt-in, preserve outcomes and report boolean incompleteness",async()=>{
 const prior=process.env.OPENCODE_TEST_SKILL_REFRESH_DIAGNOSTICS
 const original=console.log
 const events:any[]=[]
 console.log=(...args:any[])=>{if(args[0]==="SKILL_REFRESH")events.push(JSON.parse(args[1]))}
 try{
  delete process.env.OPENCODE_TEST_SKILL_REFRESH_DIAGNOSTICS
  const unchanged=Effect.succeed("ok")
  expect(refreshDiagnostic()("promote",unchanged)).toBe(unchanged)
  expect(await Effect.runPromise(unchanged)).toBe("ok")
  expect(events).toHaveLength(0)
  process.env.OPENCODE_TEST_SKILL_REFRESH_DIAGNOSTICS="1"
  const trace=refreshDiagnostic()
  expect(await Effect.runPromise(trace("download",Effect.succeed([true,false])))).toEqual([true,false])
  expect(events.map(e=>e.state)).toEqual(["begin","incomplete"])
  expect(await Effect.runPromise(trace("staging-check",Effect.succeed(false)))).toBe(false)
  expect(events.at(-1).state).toBe("incomplete")
  const sentinel=Object.assign(new Error("SECRET"),{code:"EBUSY",path:"PRIVATE",stack:"STACK_SECRET"})
  const failure=await Effect.runPromiseExit(trace("promote",Effect.fail(sentinel)))
  expect(Exit.isFailure(failure)&&failure.cause.reasons.some(r=>Cause.isFailReason(r)&&r.error===sentinel)).toBe(true)
  const defect=await Effect.runPromiseExit(trace("rollback",Effect.die(sentinel)))
  expect(Exit.isFailure(defect)&&defect.cause.reasons.some(r=>Cause.isDieReason(r)&&r.defect===sentinel)).toBe(true)
  const interrupted=await Effect.runPromiseExit(trace("promote",Effect.failCause(Cause.interrupt(123))))
  expect(Exit.isFailure(interrupted)&&Cause.hasInterruptsOnly(interrupted.cause)).toBe(true)
  expect(Exit.isFailure(interrupted)&&interrupted.cause.reasons.some(r=>Cause.isInterruptReason(r)&&r.fiberId===123)).toBe(true)
  expect(events.some(e=>e.phase==="rollback"&&e.state==="failure"&&e.code==="EBUSY")).toBe(true)
  expect(JSON.stringify(events)).not.toContain("SECRET")
  expect(JSON.stringify(events)).not.toContain("PRIVATE")
  expect(events.every(e=>/^\d+-\d+$/.test(e.operation))).toBe(true)
  console.log=()=>{throw new Error("observer failure")}
  expect(await Effect.runPromise(trace("promote",Effect.succeed(7)))).toBe(7)
  const reportFailure=await Effect.runPromiseExit(trace("promote",Effect.fail(sentinel)))
  expect(Exit.isFailure(reportFailure)&&reportFailure.cause.reasons.some(r=>Cause.isFailReason(r)&&r.error===sentinel)).toBe(true)
 }finally{
  console.log=original
  if(prior===undefined)delete process.env.OPENCODE_TEST_SKILL_REFRESH_DIAGNOSTICS
  else process.env.OPENCODE_TEST_SKILL_REFRESH_DIAGNOSTICS=prior
 }
})
