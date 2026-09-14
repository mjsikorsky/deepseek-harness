/** A deployment authority fixture; all Agent, inbox, and persistence operations remain native. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

export const name = 'snapshot-deployment-termination'
export const inject = ['agents', 'sessions']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - The real assembled runtime.
 * @param {{receiptPath: string}} config - Private qualification receipt location.
 */
export function apply(ctx, config) {
  let original
  let fresh
  let completed = false
  let phase = 'awaiting-turn'
  const queued = {
    role: 'user', id: crypto.randomUUID(), source: { kind: 'user' },
    content: [{ type: 'text', text: 'Retain this input for the next authorized execution.' }],
  }
  const report = (value) => { writeFileSync(config.receiptPath, JSON.stringify(value) + '\n') }
  ctx.provide('agentLifecycleSetup', {
    prepare(_agentCtx, agent, capabilities) {
      assert.equal(Object.isFrozen(capabilities), true)
      if (capabilities.parent !== undefined) {
        assert.equal(capabilities.parent.session.id, agent.session.header.parentSession)
        return
      }
      if (original === undefined) original = { agent, capabilities }
      else if (phase === 'resuming') fresh = { agent, capabilities }
    },
  })
  ctx.on('session/event', (session, event) => {
    if (session === original?.agent.session && event.type === 'turn/end') completed = true
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (!completed || status !== 'idle' || phase !== 'awaiting-turn' || original?.agent !== agent) return
    phase = 'revoking'
    agent.inbox.append('next-turn', queued)
    original.capabilities.terminate()
  })
  ctx.on('agent/disposed', async ({ agent }) => {
    try {
      if (agent === original?.agent && phase === 'revoking') {
        phase = 'resuming'
        assert.equal(ctx.agents.get(agent.id), undefined)
        const resumed = await ctx.agents.resume({ resumeSessionId: agent.id })
        assert.notEqual(resumed.agent, agent)
        assert.equal(resumed.agent.session.id, agent.session.id)
        assert.deepEqual(resumed.agent.inbox.nextTurn, [queued])
        assert.equal(fresh?.agent, resumed.agent)
        original.capabilities.terminate()
        assert.equal(ctx.agents.get(agent.id), resumed.agent)
        phase = 'closing-fresh'
        fresh.capabilities.terminate()
      } else if (agent === fresh?.agent && phase === 'closing-fresh') {
        phase = 'done'
        assert.equal(ctx.agents.get(agent.id), undefined)
        report({ sameSession: true, freshAgent: true, queuedPreserved: true, staleRevocationRejected: true, drained: true })
      }
    } catch (error) {
      phase = 'failed'
      report({ error: String(error?.stack ?? error) })
    }
  })
}
