import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter } from './mock-adapter.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function harness(adapter = new MockAdapter([])) {
  const root = await mkdtemp(join(tmpdir(), 'native-deployment-lifecycle-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  const path = join(root, 'cordis.yml')
  await writeFile(path, [...modules.keys()].map((name) => {
    const config = name === '@deepseek-ai/dsh-session-persistence-jsonl'
      ? { root: join(root, 'sessions'), compression: 'none' }
      : name === '@deepseek-ai/dsh-agent-loop' ? { agents: [] } : undefined
    return JSON.stringify({ name, ...(config === undefined ? {} : { config }) })
  }).map(row => `- ${row}`).join('\n'))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}
const seed: SessionEvent[] = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]

/** Synchronize AFTER the real JSONL append; never replace its persisted result. */
function pauseRealAppend(ctx: Context) {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const originalCreate = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (header, options) => {
    const handle = await originalCreate(header, options)
    const append = handle.append.bind(handle)
    vi.spyOn(handle, 'append').mockImplementation(async (events) => {
      await append(events)
      entered.resolve(undefined)
      await release.promise
    })
    return handle
  })
  return { entered, release }
}

describe('native deployment Agent lifecycle composition', () => {
  it.each(['revocation', 'expiry'] as const)('refuses publication after %s during real durable append', async (reason) => {
    const { ctx, adapter } = await harness()
    const id = SessionId('deployment-' + reason)
    const stopped = new AbortController()
    let deadline = Number.MAX_SAFE_INTEGER
    let cleanup = 0
    let prepared = 0
    ctx.provide('agentLifecycleSetup', {
      prepare(agentCtx, agent) {
        expect(agent.session.id).toBe(id)
        expect(ctx.sessions.get(id)).toBeUndefined()
        prepared++
        agentCtx.effect(() => () => { cleanup++ })
        return { commit() {
          stopped.signal.throwIfAborted()
          if (Date.now() >= deadline) throw new Error('lease expired')
        } }
      },
    })
    const published: string[] = []
    ctx.on('session/created', () => { published.push('session') })
    ctx.on('agent/created', () => { published.push('agent') })
    ctx.on('agent/session-start', () => { published.push('start') })
    const gate = pauseRealAppend(ctx)
    const job = ctx.agents.create({ sessionId: id, seed, agentOptions: { provider: 'mock', model: 'mock' } })
    const settled = job.then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      await Promise.race([gate.entered.promise, settled.then((result) => { if ('error' in result) throw result.error; throw new Error('Agent published before gated append') })])
      expect(prepared).toBe(1)
      expect(published).toEqual([])
      if (reason === 'revocation') stopped.abort(new Error('lease revoked'))
      else deadline = Date.now() - 1
    } finally { gate.release.resolve(undefined) }
    expect((await settled as { error?: Error }).error?.message).toContain(reason === 'expiry' ? 'lease expired' : 'lease revoked')
    expect(published).toEqual([])
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(cleanup).toBe(1)
    expect(adapter.requests).toHaveLength(0)
    // Failed publication does not erase the real durable evidence.
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try { expect((await reader.read()).events.slice(0, 2)).toEqual(seed) } finally { await reader.close() }
  })

  it('preserves the real caller preset composition and commits before announcements', async () => {
    const { ctx } = await harness()
    const fixtures = fileURLToPath(new URL('../../../preset/agent-presets/tests/fixtures/', import.meta.url))
    ctx.baseUrl = pathToFileURL(fixtures).href + '/'
    ctx.loader.internal = undefined
    await ctx.plugin(AgentPresets, { default: 'standard', roots: [{ path: join(fixtures, 'system'), trust: 'system' }], includeShippedRoot: false, includeUserRoot: false })
    const order: string[] = []
    ctx.provide('agentLifecycleSetup', { prepare(_agentCtx, agent) {
      expect(ctx.agentPresets.composedPreset(agent.ctx)).toBe('standard')
      expect(ctx.tools.schemas(agent).length).toBeGreaterThan(0)
      order.push('deployment prepared')
      return { commit() { order.push('deployment committed') } }
    } })
    ctx.on('agent/created', () => { order.push('published') })
    const handle = await ctx.agents.create({ sessionId: SessionId('native-preset'), setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, 'standard')
      order.push('caller prepared')
      return { commit() { order.push('caller committed') } }
    } })
    expect(order).toEqual(['caller prepared', 'deployment prepared', 'caller committed', 'deployment committed', 'published'])
    expect(ctx.tools.schemas(handle.agent).length).toBeGreaterThan(0)
    await handle.dispose()
  })

  it('covers the native direct configuration helper without replacing the factory', async () => {
    const { ctx, adapter } = await harness()
    let observed = 0
    ctx.provide('agentLifecycleSetup', { prepare(_agentCtx, agent) {
      observed++
      expect(agent.session.id).toBe(SessionId('configured-native'))
      throw new Error('configuration denied')
    } })
    await expect(ctx.agentLoop.create(SessionId('configured-native'))).rejects.toThrow('configuration denied')
    expect(observed).toBe(1)
    expect(ctx.agents.list()).toHaveLength(0)
    expect(adapter.requests).toHaveLength(0)
  })

  it('unregisters an idle revoked Agent, preserves its JSONL inbox, and cannot revoke a fresh incarnation', async () => {
    const { ctx } = await harness()
    const terminations: (() => void)[] = []
    let cleaned = 0
    ctx.provide('agentLifecycleSetup', { prepare(agentCtx, _agent, { terminate }) {
      terminations.push(terminate)
      agentCtx.effect(() => () => { cleaned++ })
    } })
    const id = SessionId('authority-idle')
    const first = await ctx.agents.create({ sessionId: id })
    const queued = createUserMessage({ content: [{ type: 'text', text: 'retain this input' }], source: { kind: 'user' } })
    first.agent.inbox.append('next-turn', queued)
    terminations[0]!()
    // A concurrent normal dispose joins the already-owned preserve-inbox policy.
    await first.dispose()
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(cleaned).toBe(1)
    const fresh = await ctx.agents.resume({ resumeSessionId: id })
    expect(fresh.agent).not.toBe(first.agent)
    expect(fresh.agent.inbox.nextTurn).toEqual([queued])
    terminations[0]!()
    await first.dispose()
    expect(ctx.agents.get(id)).toBe(fresh.agent)
    expect(cleaned).toBe(1)
    await fresh.dispose()
    expect(cleaned).toBe(2)
  })

  it('drains a revoked active turn durably without consuming queued work', async () => {
    const { ctx, adapter } = await harness(new MockAdapter(['hang-slow']))
    let terminate: (() => void) | undefined
    ctx.provide('agentLifecycleSetup', { prepare(_ctx, _agent, { terminate: revoke }) { terminate = revoke } })
    const id = SessionId('authority-active')
    const handle = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const queued = createUserMessage({ content: [{ type: 'text', text: 'next authorized turn' }], source: { kind: 'user' } })
    handle.agent.followup(queued)
    terminate!()
    expect(adapter.requests[0]!.signal?.aborted).toBe(true)
    await handle.dispose()
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.sessions.get(id)).toBeUndefined()
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try {
      const events = (await reader.read()).events
      const endings = events.filter(event => event.type === 'turn/end')
      expect(endings).toHaveLength(1)
      expect(endings[0]?.data.reason).toEqual({ kind: 'aborted', reason: { kind: 'disposed' } })
    } finally { await reader.close() }
    const fresh = await ctx.agents.resume({ resumeSessionId: id })
    expect(fresh.agent.inbox.nextTurn).toEqual([queued])
    expect(adapter.requests).toHaveLength(1)
    await fresh.dispose()
  })

  it('terminates from an awaited pre-step hook without awaiting its own teardown', async () => {
    const { ctx, adapter } = await harness()
    let terminated = false
    ctx.provide('agentLifecycleSetup', { prepare(agentCtx, agent, { terminate }) {
      agentCtx.on('agent/pre-step', async ({ agent: subject, signal }, next) => {
        if (subject === agent) {
          terminate()
          expect(signal.aborted).toBe(true)
          await Promise.resolve()
          terminated = true
        }
        return next()
      })
    } })
    const id = SessionId('authority-pre-step')
    const handle = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'deny before model' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(terminated).toBe(true) })
    await handle.dispose()
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(adapter.requests).toHaveLength(0)
  })


  it('observes asynchronous authority teardown failure while still removing both registries', async () => {
    const { ctx } = await harness()
    let terminate: (() => void) | undefined
    ctx.provide('agentLifecycleSetup', { prepare(_ctx, _agent, { terminate: revoke }) { terminate = revoke } })
    const originalCreate = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
    vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (header, options) => {
      const stored = await originalCreate(header, options)
      const close = stored.close.bind(stored)
      vi.spyOn(stored, 'close').mockImplementation(async () => {
        await close()
        throw new Error('injected close acknowledgement failure')
      })
      return stored
    })
    const loopFiber = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-agent-loop')?.fiber
    expect(loopFiber).toBeDefined()
    const warning = vi.spyOn(loopFiber!.ctx.logger, 'warn')
    const id = SessionId('authority-close-failure')
    const handle = await ctx.agents.create({ sessionId: id })
    terminate!()
    terminate!()
    await expect(handle.dispose()).rejects.toThrow('injected close acknowledgement failure')
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('authority teardown failed'))
    expect(warning).toHaveBeenCalledTimes(1)
  })


  it('supplies the immutable explicit native parent for create and resume, independently of ambient attribution', async () => {
    const { ctx } = await harness()
    const parent = await ctx.agents.create({ sessionId: SessionId('structural-parent') })
    const initiator = await ctx.agents.create({ sessionId: SessionId('ambient-initiator') })
    const parents: unknown[] = []
    ctx.provide('agentLifecycleSetup', { prepare(_ctx, _agent, capabilities) {
      expect(Object.isFrozen(capabilities)).toBe(true)
      parents.push(capabilities.parent)
    } })
    const id = SessionId('structural-child')
    const child = await ctx.agents.withInitiator(initiator.agent, () =>
      ctx.agents.create({ sessionId: id, seed, parentAgent: parent.agent }))
    expect(parents).toEqual([parent.agent])
    expect(ctx.agents.isOwnedBy(id, parent.agent)).toBe(true)
    await child.dispose()
    const resumed = await ctx.agents.withInitiator(initiator.agent, () =>
      ctx.agents.resume({ resumeSessionId: id, parentAgent: parent.agent }))
    expect(parents).toEqual([parent.agent, parent.agent])
    expect(ctx.agents.isOwnedBy(id, parent.agent)).toBe(true)
    await resumed.dispose();await initiator.dispose();await parent.dispose()
  })

})
