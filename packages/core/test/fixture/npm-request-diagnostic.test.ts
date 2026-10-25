import { expect, test } from "bun:test"
import http from "node:http"
import { observeRequestOwner } from "../../src/npm-request-diagnostic"
test("request owner observer preserves calls and owns only its active lifetime", () => {
const before = http.request
const active: {dispose:()=>unknown}[]=[]
const observe = (input: Parameters<typeof observeRequestOwner>[0]) => { const value=observeRequestOwner(input); active.push(value); return value }
try {
expect(observe({enabled:false,owner:()=>undefined,report:()=>{}}).dispose()).toEqual({restored:false,conflict:false})
expect(http.request).toBe(before)
const calls: {self:unknown,args:unknown[]}[]=[]
const result={host:"127.0.0.1",path:"/@opencode-ai/plugin"}
const sentinel=new Error("original failure")
http.request=function(...args:any[]){calls.push({self:this,args});if(args[0]==="throw")throw sentinel;return result} as any
const original=http.request
const events:unknown[]=[]
const observer=observe({enabled:true,owner:()=>"alpha",report:e=>events.push(e)})
const receiver={}
const url=new URL("http://private.invalid/raw-secret")
const override={hostname:"127.0.0.1",port:1234,headers:{authorization:"SECRET"}}
const callback=()=>{}
const args=[url,override,callback]
expect(Reflect.apply(http.request,receiver,args)).toBe(result)
expect(calls[0].self).toBe(receiver)
expect(calls[0].args).toEqual(args)
expect(calls[0].args[0]).toBe(url)
expect(calls[0].args[1]).toBe(override)
expect(calls[0].args[2]).toBe(callback)
expect(JSON.stringify(override)).toBe('{"hostname":"127.0.0.1","port":1234,"headers":{"authorization":"SECRET"}}')
expect(events).toEqual([{owner:"alpha",target:"loopback",path:"plugin-package"}])
expect(()=>Reflect.apply(http.request,receiver,["throw"])).toThrow(sentinel)
expect(()=>observe({enabled:true,owner:()=>undefined,report:()=>{}})).toThrow("already installed")
expect(observer.dispose()).toEqual({restored:true,conflict:false})
expect(http.request).toBe(original)
const throwing=observe({enabled:true,owner:()=>{throw sentinel},report:()=>{throw sentinel}})
expect(Reflect.apply(http.request,receiver,[url])).toBe(result)
throwing.dispose()
const reportThrowing=observe({enabled:true,owner:()=>"beta",report:()=>{throw sentinel}})
expect(Reflect.apply(http.request,receiver,[url])).toBe(result)
reportThrowing.dispose()
const oldEvents:unknown[]=[]
const conflicted=observe({enabled:true,owner:()=>"old",report:e=>oldEvents.push(e)})
const captured=http.request
const oldReports=oldEvents.length
const later=function(this:unknown,...args:unknown[]){return Reflect.apply(captured,this,args)} as any
http.request=later
expect(conflicted.dispose()).toEqual({restored:false,conflict:true})
expect(http.request).toBe(later)
expect(Reflect.apply(http.request,receiver,[url])).toBe(result)
expect(oldEvents.length).toBe(oldReports)
const freshEvents:unknown[]=[]
const fresh=observe({enabled:true,owner:()=>"fresh",report:e=>freshEvents.push(e)})
expect(Reflect.apply(http.request,receiver,[url])).toBe(result)
expect(freshEvents).toHaveLength(1)
expect(oldEvents.length).toBe(oldReports)
fresh.dispose()
http.request=before
console.log("PASS optin/single-install/receiver-args-identity/result/errors/observer-containment/owned-restore/conflict-no-clobber")

} finally {
  for (const observer of active.reverse()) observer.dispose()
  http.request=before
}

})

test("observer assertion failure cleanup releases singleton and restores request", () => {
  const original=http.request
  let observer: ReturnType<typeof observeRequestOwner> | undefined
  expect(() => {
    try {
      observer=observeRequestOwner({enabled:true,owner:()=>undefined,report:()=>{}})
      throw new Error("simulated assertion failure")
    } finally {
      observer?.dispose()
      http.request=original
    }
  }).toThrow("simulated assertion failure")
  expect(http.request).toBe(original)
  const next=observeRequestOwner({enabled:true,owner:()=>undefined,report:()=>{}})
  try { expect(http.request).not.toBe(original) } finally { next.dispose();http.request=original }
})
