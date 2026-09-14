import { describe, it, expect, vi } from 'vitest'
import { AGENT_A, setup, CLIENT_CODE } from './helpers.ts'
import { CordisDynamicPluginId, CordisDynamicPackageId, CordisDynamicPluginRunId } from '../src/index.ts'
import type { DynamicCordisRunRequest } from '../src/types.ts'
import { admitHostCode } from '../src/activation-policy.ts'
import type { CordisHostActivationPolicy, CordisHostActivationRequest, CordisHostActivationLease } from '../src/activation-policy.ts'

const HOST = 'return { name: \'admitted\', apply(ctx) { ctx.provide(\'admissionMarker\', { value: 42 }) } }'
function define(runner: Awaited<ReturnType<typeof setup>>['runner'], client = false) {
  return runner.define({ sessionId: AGENT_A.id, plugin: { kind:'new',idPrefix:'trust' },name:'Host code',purpose:'exact reviewed source',code:{ host:HOST,...client?{ client:CLIENT_CODE }:{} } })
}
// Explicit fake authority. These prove native enforcement, not camel role or signed-proof issuance.
function authority(allowed = true) {
  const revoked = new AbortController()
  const release = vi.fn()
  const seen: CordisHostActivationRequest[] = []
  const policy: CordisHostActivationPolicy = { async authorize(request) {
    seen.push(request)
    return allowed ? { expiresAt:Date.now()+30_000, signal:revoked.signal, check(){ revoked.signal.throwIfAborted() }, release } : undefined
  } }
  return { policy,revoked,release,seen }
}

describe('native Cordis exact Host activation admission',()=>{
  it('routes a Host-only model request through the native approval card API',async()=>{
    const { ctx,runner,gateway }=await setup({ requireHostActivationPolicy:true })
    const trust=authority();ctx.provide('cordisHostActivationPolicy',trust.policy)
    const item=define(runner)
    const requested=await runner.run(AGENT_A,item.pluginId,item.packageId,'run')
    expect(requested).toMatchObject({ status:'awaiting-approval' })
    expect(ctx.get('admissionMarker')).toBeUndefined();expect(trust.seen).toHaveLength(0)
    const request=gateway.events.find(([name])=>name==='cordis/request-run')![1] as DynamicCordisRunRequest
    expect(request.hasClientHalf).toBe(false)
    const started = await runner.runHostHalf(AGENT_A, item.pluginId, item.packageId, 'run', request.requestId, false)
    if (!started.ok) throw new Error(started.message)
    await runner.resolveRequestRun(request.requestId, { ok: true, pluginRunId: started.pluginRunId })
    expect(ctx.get('admissionMarker')).toEqual({ value:42 })
    expect(trust.seen[0]).toMatchObject({ sessionId:AGENT_A.id,pluginId:item.pluginId,packageId:item.packageId,hostCode:HOST })
    expect(Object.isFrozen(trust.seen[0])).toBe(true)
    expect(gateway.events).toContainEqual(['cordis/request-run-resolved',{ requestId:request.requestId,outcome:'approved' }])
    await runner.stop(AGENT_A,item.pluginId);expect(trust.release).toHaveBeenCalledTimes(1)
  })
  it.each(['missing','denied'] as const)('blocks direct panel evaluation when policy is %s',async(mode)=>{
    const { ctx,runner }=await setup({ requireHostActivationPolicy:true })
    if(mode==='denied')ctx.provide('cordisHostActivationPolicy',authority(false).policy)
    const item=define(runner)
    const answer=await runner.runHostHalf(AGENT_A,item.pluginId,item.packageId,'run',null,true)
    expect(answer.ok).toBe(false);expect(ctx.get('admissionMarker')).toBeUndefined()
  })
  it('does not extend Host trust when future Client versions were approved',async()=>{
    const { ctx,runner,gateway }=await setup({ requireHostActivationPolicy:true })
    const trust=authority();ctx.provide('cordisHostActivationPolicy',trust.policy)
    const first=define(runner,true)
    await runner.run(AGENT_A,first.pluginId,first.packageId,'run')
    const request=gateway.events.find(([name])=>name==='cordis/request-run')![1] as DynamicCordisRunRequest
    const started=await runner.runHostHalf(AGENT_A,first.pluginId,first.packageId,'run',request.requestId,true)
    if(!started.ok)throw new Error(started.message)
    await runner.resolveRequestRun(request.requestId,{ ok:true,pluginRunId:started.pluginRunId })
    const next=runner.define({ sessionId:AGENT_A.id,plugin:{ kind:'existing',pluginId:first.pluginId },name:'next',purpose:'new source',code:{ host:HOST+'\n',client:CLIENT_CODE } })
    expect(await runner.run(AGENT_A,next.pluginId,next.packageId,'update')).toMatchObject({ status:'awaiting-approval' })
    expect(trust.seen).toHaveLength(1)
    await runner.stop(AGENT_A,first.pluginId)
  })
  it('retracts an admitted run on revocation and releases its lease once',async()=>{
    const { ctx,runner }=await setup({ requireHostActivationPolicy:true })
    const trust=authority();ctx.provide('cordisHostActivationPolicy',trust.policy)
    const item=define(runner)
    expect((await runner.runHostHalf(AGENT_A,item.pluginId,item.packageId,'run',null,false)).ok).toBe(true)
    trust.revoked.abort()
    await vi.waitFor(()=>{ expect(ctx.get('admissionMarker')).toBeUndefined() })
    expect(runner.inventory()[0]?.activeRun).toBeUndefined();expect(trust.release).toHaveBeenCalledTimes(1)
  })
  it('rejects a lease revoked during acquisition before any Host evaluation',async()=>{
    const { ctx,runner }=await setup({ requireHostActivationPolicy:true })
    const trust=authority();trust.revoked.abort();ctx.provide('cordisHostActivationPolicy',trust.policy)
    const item=define(runner)
    expect((await runner.runHostHalf(AGENT_A,item.pluginId,item.packageId,'run',null,false)).ok).toBe(false)
    expect(ctx.get('admissionMarker')).toBeUndefined();expect(trust.release).toHaveBeenCalledTimes(1)
  })
  it('ends a pending async source evaluation when the exact admission expires',async()=>{
    const { ctx,runner }=await setup({ requireHostActivationPolicy:true })
    const release=vi.fn()
    ctx.provide('cordisHostActivationPolicy',{ async authorize(){
      return { expiresAt:Date.now()+35,signal:new AbortController().signal,check(){},release }
    } })
    const item=runner.define({ sessionId:AGENT_A.id,plugin:{ kind:'new',idPrefix:'slow' },name:'slow',purpose:'fixture',code:{ host:'await new Promise(() => {})' } })
    expect(await runner.runHostHalf(AGENT_A,item.pluginId,item.packageId,'run',null,false)).toMatchObject({ ok:false })
    expect(runner.inventory()[0]?.activeRun).toBeUndefined();expect(release).toHaveBeenCalledTimes(1)
  })
  it('disposes a policy admission returned after cancellation wins',async()=>{
    const lifetime=new AbortController();const pending=Promise.withResolvers<CordisHostActivationLease>();const release=vi.fn()
    const authorize=vi.fn(()=>pending.promise)
    const request={ sessionId:AGENT_A.id,pluginId:CordisDynamicPluginId('late'),packageId:CordisDynamicPackageId('late'),pluginRunId:CordisDynamicPluginRunId('late'),hostCode:HOST,name:'late',purpose:'fixture' } satisfies CordisHostActivationRequest
    const result=admitHostCode({ authorize },request,lifetime.signal,()=>{})
    await vi.waitFor(()=>{ expect(authorize).toHaveBeenCalledTimes(1) })
    lifetime.abort();await expect(result).rejects.toThrow('cancelled')
    pending.resolve({ expiresAt:Date.now()+1000,signal:new AbortController().signal,check(){},release })
    await vi.waitFor(()=>{ expect(release).toHaveBeenCalledTimes(1) })
  })
  it('checks admission again when a pending native Host fiber becomes ready',async()=>{
    const { ctx,runner }=await setup({ requireHostActivationPolicy:true })
    const trust=authority();ctx.provide('cordisHostActivationPolicy',trust.policy)
    const item=runner.define({ sessionId:AGENT_A.id,plugin:{ kind:'new',idPrefix:'wait' },name:'wait',purpose:'fixture',code:{ host:'return {name:\'waiting\',inject:[\'laterService\'],apply(ctx){ctx.provide(\'waitingMarker\',true)}}' } })
    expect((await runner.runHostHalf(AGENT_A,item.pluginId,item.packageId,'run',null,false)).ok).toBe(true)
    trust.revoked.abort();await vi.waitFor(()=>{ expect(runner.inventory()[0]?.activeRun).toBeUndefined() })
    ctx.provide('laterService',{})
    await Promise.resolve();expect(ctx.get('waitingMarker')).toBeUndefined()
  })

  it.each(['stop','undefine'] as const)('does not evaluate a late approval after native %s',async(verb)=>{
    const { ctx,runner }=await setup({ requireHostActivationPolicy:true })
    const pending=Promise.withResolvers<CordisHostActivationLease>();const authorize=vi.fn(()=>pending.promise);const release=vi.fn()
    ctx.provide('cordisHostActivationPolicy',{ authorize })
    const item=define(runner)
    const activating=runner.runHostHalf(AGENT_A,item.pluginId,item.packageId,'run',null,false)
    await vi.waitFor(()=>{ expect(authorize).toHaveBeenCalledTimes(1) })
    await runner[verb](AGENT_A,item.pluginId)
    expect(await activating).toMatchObject({ ok:false })
    pending.resolve({ expiresAt:Date.now()+1000,signal:new AbortController().signal,check(){},release })
    await vi.waitFor(()=>{ expect(release).toHaveBeenCalledTimes(1) })
    expect(ctx.get('admissionMarker')).toBeUndefined()
    if(verb==='stop')expect(runner.inventory()[0]?.latestRun?.status).toBe('stopped')
    else expect(runner.inventory()).toHaveLength(0)
  })

  it.each(['resolve-first','abort-first'] as const)('owns cleanup across same-microtask %s admission',async(order)=>{
    const lifetime=new AbortController();const pending=Promise.withResolvers<CordisHostActivationLease>();const release=vi.fn()
    const authorize=vi.fn(()=>pending.promise)
    const request={ sessionId:AGENT_A.id,pluginId:CordisDynamicPluginId('race'),packageId:CordisDynamicPackageId('race'),pluginRunId:CordisDynamicPluginRunId('race'),hostCode:HOST,name:'race',purpose:'fixture' } satisfies CordisHostActivationRequest
    const result=admitHostCode({ authorize },request,lifetime.signal,()=>{})
    await vi.waitFor(()=>{ expect(authorize).toHaveBeenCalledTimes(1) })
    const grant={ expiresAt:Date.now()+1000,signal:new AbortController().signal,check(){},release }
    if(order==='resolve-first'){pending.resolve(grant);lifetime.abort()}
    else {lifetime.abort();pending.resolve(grant)}
    await expect(result).rejects.toThrow()
    await vi.waitFor(()=>{ expect(release).toHaveBeenCalledTimes(1) })
  })

})
