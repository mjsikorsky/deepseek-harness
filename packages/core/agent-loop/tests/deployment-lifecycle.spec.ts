import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime from '@deepseek-ai/dsh-llm'
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
async function harness() {
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
  const adapter = new MockAdapter([])
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
})
