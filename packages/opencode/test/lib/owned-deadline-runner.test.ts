import { expect, test } from "bun:test"
import path from "node:path"
import { collectDeadlineChild } from "./owned-deadline-child"
const cwd=path.resolve(import.meta.dir,"../..")
test("opt-in runner interrupts full provided execution and finalizes before the next Bun test",async()=>{
 for(const [fixture,next] of [
  ["owned-cooperative.ts","next Bun test sees provided layer finalized"],
  ["owned-acquisition.ts","next Bun test sees acquisition scope finalized"],
  ["owned-default.ts","next Bun test sees default-path layer finalized"],
 ]){
  const {stdout,stderr,code,timedOut}=await collectDeadlineChild([
   process.execPath,"test",path.join(import.meta.dir,"fixtures",fixture),
  ],cwd,5000)
  const output=stdout+stderr
  expect(timedOut).toBe(false)
  expect(code).toBe(1)
  expect(output).toContain("All fibers interrupted without error")
  expect(output).toContain(`(pass) ${next}`)
  expect(output).toContain("1 fail")
  expect(output).not.toContain("timed out after")
  expect(output).not.toContain("positive finite")
 }
},15000)
test("a hanging child is killed and joined before collection settles",async()=>{
 const result=await collectDeadlineChild([process.execPath,"-e","setInterval(()=>{},1000)"],cwd,80)
 expect(result.timedOut).toBe(true)
 expect(result.code).not.toBe(0)
 expect(()=>process.kill(result.pid,0)).toThrow()
},5000)
test("collection failure kills and joins the child before rejecting",async()=>{
 const original=Bun.spawn
 const sentinel=new Error("controlled collection failure")
 const events:string[]=[]
 let settle:(code:number)=>void=()=>{}
 const exited=new Promise<number>(resolve=>{settle=resolve})
 const fake={
  pid:123,exitCode:null,
  get stdout(){throw sentinel},stderr:null,exited,
  kill(){events.push("kill");setTimeout(()=>{events.push("exited");settle(1)},30)},
 }
 // Deliberately partial process double for the exceptional collection path.
 Bun.spawn=(()=>fake) as unknown as typeof Bun.spawn
 try{
  try{await collectDeadlineChild(["unused"],cwd,1000);throw new Error("expected rejection")}
  catch(error){events.push("rejected");expect(error).toBe(sentinel)}
  expect(events).toEqual(["kill","exited","rejected"])
 }finally{
  Bun.spawn=original
  settle(1)
  await exited
 }
})
