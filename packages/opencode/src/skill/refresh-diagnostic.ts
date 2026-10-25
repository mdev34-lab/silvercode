import { Effect } from "effect"
type Phase = "download" | "staging-check" | "version-write" | "backup" | "promote" | "rollback" | "backup-remove" | "staging-remove"
let sequence=0
const codes=new Set(["EBUSY","EPERM","EACCES","ENOENT","EEXIST","ENOTEMPTY","EXDEV","EIO","ETIMEDOUT"])
const reasons=new Set(["NotFound","PermissionDenied","AlreadyExists","Busy","Unknown"])
export function safeRefreshFailure(error:unknown):string {
 try {
  const seen=new Set<unknown>()
  let current=error
  for(let depth=0;depth<4&&current!==undefined;depth++){
   if(current===null||typeof current!=="object"||seen.has(current))return "unknown"
   seen.add(current)
   const code=Object.getOwnPropertyDescriptor(current,"code")
   if(code&&"value"in code&&typeof code.value==="string"&&codes.has(code.value))return code.value
   const tag=Object.getOwnPropertyDescriptor(current,"_tag")
   if(tag&&"value"in tag&&typeof tag.value==="string"&&reasons.has(tag.value))return tag.value
   const cause=Object.getOwnPropertyDescriptor(current,"cause")
   const reason=Object.getOwnPropertyDescriptor(current,"reason")
   current=cause&&"value"in cause?cause.value:reason&&"value"in reason?reason.value:undefined
  }
 }catch{}
 return "unknown"
}
export function refreshDiagnostic() {
 const enabled=process.env.OPENCODE_TEST_SKILL_REFRESH_DIAGNOSTICS==="1"
 const operation=enabled?`${process.pid}-${++sequence}`:""
 const report=(phase:Phase,state:"begin"|"success"|"failure"|"incomplete",error?:unknown)=>{
  if(!enabled)return
  try{console.log("SKILL_REFRESH",JSON.stringify({operation,phase,state,...(state==="failure"?{code:safeRefreshFailure(error)}:{})}))}catch{}
 }
 return <A,E,R>(phase:Phase,effect:Effect.Effect<A,E,R>):Effect.Effect<A,E,R> => !enabled?effect:effect.pipe(
  Effect.tap(value=>Effect.sync(()=>report(phase, (phase==="download"&&Array.isArray(value)&&!value.every(Boolean))||(phase==="staging-check"&&value===false)?"incomplete":"success"))),
  Effect.tapError(error=>Effect.sync(()=>report(phase,"failure",error))),
  Effect.tapDefect(error=>Effect.sync(()=>report(phase,"failure",error))),
  (self)=>Effect.sync(()=>report(phase,"begin")).pipe(Effect.andThen(self)),
 )
}
